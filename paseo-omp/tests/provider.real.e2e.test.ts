import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, test } from "vitest";
import type {
  AgentClient,
  AgentSession,
} from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-sdk-types.js";
import { createOmpProvider } from "../server/provider/registration";
import { startFetchServer } from "./helpers/http-server";

const executeFile = promisify(execFile);
const pluginProviderModulePath =
  "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
const hostRequire = createRequire(new URL(pluginProviderModulePath, import.meta.url));
const pino = hostRequire("pino") as (options: { enabled: boolean }) => object;
const testReal = process.env.PASEO_OMP_REAL_E2E === "1" ? test : test.skip;
const expectedOmpVersion = process.env.PASEO_OMP_VERSION ?? "18.1.15";
const roots: string[] = [];

type HostRegistry = {
  replace(registrations: readonly ProviderRegistration[]): void;
  clients(): Record<string, AgentClient>;
  shutdown(): Promise<void>;
};
type HostRegistryConstructor = new (logger: object) => HostRegistry;

interface RealHarness {
  cwd: string;
  registry: HostRegistry;
  client: AgentClient;
  requests: Array<Record<string, unknown>>;
  modelServer: { stop(closeActiveConnections?: boolean): void };
}

function streamingResponse(frames: unknown[]): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

async function createHarness(): Promise<RealHarness> {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-real-e2e-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const requests: Array<Record<string, unknown>> = [];
  const modelServer = await startFetchServer(async (request) => {
    if (request.method === "GET") {
      return Response.json({
        object: "list",
        data: [{ id: "conformance-model", object: "model" }],
      });
    }
    const payload = (await request.json()) as Record<string, unknown>;
    requests.push(payload);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const hasToolResult = messages.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "tool",
    );
    const base = {
      id: `chatcmpl-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "conformance-model",
    };
    if (!hasToolResult) {
      return streamingResponse([
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_contract_bash",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: '{"command":"printf REAL_OMP_TOOL_OK"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    }
    return streamingResponse([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "REAL_OMP_DONE" },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ]);
  });
  await writeFile(
    join(agentDir, "models.yml"),
    `providers:\n  paseo-ci:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: conformance-model\n        name: Conformance Model\n        reasoning: false\n        input: [text, image]\n        contextWindow: 32000\n        maxTokens: 4096\n`,
  );
  const registration = createOmpProvider({
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PI_CODING_AGENT_DIR: agentDir,
    },
  });
  // Static importing the host fails on its incompatible Node/Zod declaration graph.
  const adapter = (await import(pluginProviderModulePath)) as unknown as {
    PluginAgentClientRegistry: HostRegistryConstructor;
  };
  const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
  registry.replace([registration]);
  const client = registry.clients()[registration.id];
  if (!client) throw new Error("registered OMP client is missing");
  return { cwd, registry, client, requests, modelServer };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe(`OMP ${expectedOmpVersion} real provider`, () => {
  testReal(
    `discovers the installed ${expectedOmpVersion} runtime through the core host boundary`,
    async () => {
      const { stdout } = await executeFile("omp", ["--version"], { encoding: "utf8" });
      expect(stdout.trim()).toBe(`omp/${expectedOmpVersion}`);

      const harness = await createHarness();
      try {
        await expect(harness.client.isAvailable()).resolves.toBe(true);
        const catalog = await harness.client.fetchCatalog({
          scope: "workspace",
          cwd: harness.cwd,
          force: true,
        });
        expect(catalog.models).toContainEqual(
          expect.objectContaining({
            provider: "omp-plugin",
            label: "paseo-ci/Conformance Model",
          }),
        );
        expect(catalog.defaultModeId).toBe("full");
        expect(catalog.modes.map((mode) => mode.id)).toEqual(
          expect.arrayContaining(["full", "write", "ask"]),
        );
      } finally {
        await harness.registry.shutdown();
        harness.modelServer.stop(true);
      }
    },
    60_000,
  );

  testReal(
    "runs a text and Bash tool turn without duplicate or hanging completion",
    async () => {
      const harness = await createHarness();
      let session: AgentSession | undefined;
      try {
        const catalog = await harness.client.fetchCatalog({
          scope: "workspace",
          cwd: harness.cwd,
          force: true,
        });
        const model = catalog.models.find(
          (candidate) => candidate.label === "paseo-ci/Conformance Model",
        );
        if (!model) throw new Error("OMP did not load the hermetic CI model");
        session = await harness.client.createSession(
          {
            provider: "omp-plugin",
            cwd: harness.cwd,
            model: model.id,
            modeId: "full",
            thinkingOptionId: model.defaultThinkingOptionId,
            featureValues: {},
          },
          undefined,
          { persistSession: false },
        );
        const events: Array<{ type: string; turnId?: string }> = [];
        const unsubscribe = session.subscribe((event) => events.push(event));
        try {
          const result = await session.run(
            "Use the bash tool exactly once to run `printf REAL_OMP_TOOL_OK`, then reply with exactly REAL_OMP_DONE.",
            { clientMessageId: "real-omp-tool" },
          );
          expect(result.finalText).toBe("REAL_OMP_DONE");
          expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
          expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
          expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
          expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
          expect(
            result.timeline.some(
              (item) =>
                item.type === "tool_call" &&
                item.status === "completed" &&
                item.name.toLowerCase() === "bash",
            ),
          ).toBe(true);
          expect(harness.requests).toHaveLength(2);
          expect(JSON.stringify(harness.requests[1])).toContain("REAL_OMP_TOOL_OK");
        } finally {
          unsubscribe();
        }
      } finally {
        await session?.close();
        await harness.registry.shutdown();
        harness.modelServer.stop(true);
      }
    },
    180_000,
  );

  testReal(
    "runs an oversized pasted image through the real OMP transport",
    async () => {
      const harness = await createHarness();
      let session: AgentSession | undefined;
      try {
        const catalog = await harness.client.fetchCatalog({
          scope: "workspace",
          cwd: harness.cwd,
          force: true,
        });
        const model = catalog.models.find(
          (candidate) => candidate.label === "paseo-ci/Conformance Model",
        );
        if (!model) throw new Error("OMP did not load the hermetic CI model");
        session = await harness.client.createSession(
          {
            provider: "omp-plugin",
            cwd: harness.cwd,
            model: model.id,
            modeId: "full",
            thinkingOptionId: model.defaultThinkingOptionId,
            featureValues: {},
          },
          undefined,
          { persistSession: false },
        );
        const largePng = Buffer.concat([
          Buffer.from("89504e470d0a1a0a", "hex"),
          Buffer.alloc(768 * 1024 - 8),
        ]).toString("base64");
        const result = await session.run(
          [
            { type: "text", text: "Process this pasted image." },
            { type: "image", data: largePng, mimeType: "image/png" },
          ],
          { clientMessageId: "real-omp-large-image" },
        );

        expect(result.finalText).toBe("REAL_OMP_DONE");
        expect(result.timeline.some((item) => item.type === "error")).toBe(false);
        expect(harness.requests).toHaveLength(2);
      } finally {
        await session?.close();
        await harness.registry.shutdown();
        harness.modelServer.stop(true);
      }
    },
    180_000,
  );
});
