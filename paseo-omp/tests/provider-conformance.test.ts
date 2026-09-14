import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, test } from "vitest";
import type {
  AgentClient,
  AgentPromptInput,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-sdk-types.js";
import { ompModelId } from "../server/provider/catalog";
import type { OmpModel } from "../server/provider/omp-rpc";
import { createOmpProvider } from "../server/provider/registration";

const pluginProviderModulePath = new URL(
  "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js",
  import.meta.url,
).href;
const hostRequire = createRequire(pluginProviderModulePath);
const tsxPath = createRequire(import.meta.url).resolve("tsx");
const pino = hostRequire("pino") as (options: { enabled: boolean }) => object;
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-omp.ts");
const PRIMARY_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfca";
const BRANCHED_SESSION_ID = "01a08f6b-8da9-72cb-9080-fc50139bdfcc";
const MODEL: OmpModel = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: true,
  thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" },
  contextWindow: 200_000,
  input: ["text", "image"],
};
const ALTERNATE_MODEL: OmpModel = {
  provider: "openai",
  id: "gpt-5.4",
  name: "GPT 5.4",
  reasoning: true,
  thinking: { efforts: ["low", "high"], defaultLevel: "high" },
  contextWindow: 128_000,
  input: ["text"],
};
const ALTERNATE_MODEL_ID = ompModelId(ALTERNATE_MODEL);
const MODEL_ID = ompModelId(MODEL);
const SECRET = "contract-secret-9a7f";
const roots: string[] = [];

type RegistrationWithContracts = ProviderRegistration & {
  providerOptionsSchema?: { safeParse(value: unknown): { success: boolean } };
  getCatalogCacheKey?(options: {
    scope: "global" | "workspace";
    cwd?: string;
    providerOptions?: Readonly<Record<string, unknown>>;
    settings?: Readonly<Record<string, unknown>>;
  }): Promise<string | undefined>;
  checkAvailability?(
    options: {
      scope: "global" | "workspace";
      cwd?: string;
      providerOptions?: Readonly<Record<string, unknown>>;
      settings?: Readonly<Record<string, unknown>>;
    },
    context?: { timeoutMs?: number },
  ): Promise<{ status: string; diagnostic?: string }>;
};

type HostRegistry = {
  replace(registrations: readonly ProviderRegistration[]): void;
  definitions(): Record<string, unknown>;
  clients(): Record<string, AgentClient>;
  has(provider: string): boolean;
  shutdown(): Promise<void>;
};
type HostRegistryConstructor = new (logger: object) => HostRegistry;
type FakeLogEntry =
  | { kind: "start"; pid: number; argv: string[] }
  | { kind: "command"; command: Record<string, unknown> }
  | { kind: "descendant"; pid: number }
  | { kind: "exit"; pid: number; signal: string }
  | { kind: "eof-ignored"; pid: number };

type Harness = {
  root: string;
  cwd: string;
  logPath: string;
  sessionDir: string;
  wrapperPath: string;
  registration: RegistrationWithContracts;
  registry: HostRegistry;
  client: AgentClient;
  config(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig;
  launchEnv(extra?: Record<string, string>): { env: Record<string, string> };
  close(): Promise<void>;
};

class EventLog extends Array<AgentStreamEvent> {
  readonly #waiters: Array<{
    predicate: (event: AgentStreamEvent) => boolean;
    resolve: (event: AgentStreamEvent) => void;
  }> = [];

  override push(...events: AgentStreamEvent[]): number {
    const length = super.push(...events);
    for (const event of events) {
      for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.#waiters[index];
        if (!waiter?.predicate(event)) continue;
        this.#waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
    return length;
  }

  waitFor(predicate: (event: AgentStreamEvent) => boolean): Promise<AgentStreamEvent> {
    const existing = this.find(predicate);
    if (existing) return Promise.resolve(existing);
    const pending = Promise.withResolvers<AgentStreamEvent>();
    this.#waiters.push({ predicate, resolve: pending.resolve });
    return pending.promise;
  }
}

function isTerminal(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function hasTurnId(event: AgentStreamEvent, turnId: string): boolean {
  return "turnId" in event && event.turnId === turnId;
}

type TurnRun = { turnId: string; events: AgentStreamEvent[] };

async function runTurn(
  session: AgentSession,
  prompt: AgentPromptInput,
  clientMessageId: string,
): Promise<TurnRun> {
  const events = new EventLog();
  const unsubscribe = session.subscribe((event) => events.push(event));
  try {
    const { turnId } = await session.startTurn(prompt, { clientMessageId });
    await events.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
    return { turnId, events };
  } finally {
    unsubscribe();
  }
}

async function readLog(path: string): Promise<FakeLogEntry[]> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

async function loggedCommands(harness: Harness): Promise<Record<string, unknown>[]> {
  return (await readLog(harness.logPath)).flatMap((entry) =>
    entry.kind === "command" ? [entry.command] : [],
  );
}

async function commandOfType(harness: Harness, type: string): Promise<Record<string, unknown>> {
  const command = (await loggedCommands(harness)).find((candidate) => candidate.type === type);
  if (!command) throw new Error(`Missing ${type} command in fake OMP log`);
  return command;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (processIsExecuting(pid) && Date.now() < deadline) await sleep(10);
  if (processIsExecuting(pid)) throw new Error(`Fake OMP process ${pid} did not exit`);
}

function processIsExecuting(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/stat`, "utf8");
      return status[status.lastIndexOf(")") + 2] !== "Z";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return processIsAlive(pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function createHarness(
  options: { typedApprovals?: boolean; chunkHistory?: boolean; stubbornDescendant?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "paseo-omp-conformance-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  const logPath = join(root, "fake-omp.jsonl");
  const wrapperPath = join(root, "omp");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec '${process.execPath}' --import '${tsxPath}' '${fixturePath}' "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(wrapperPath, 0o755);
  const registration = createOmpProvider({
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OMP_COMMAND: wrapperPath,
      OMP_SESSION_DIR: sessionDir,
    },
    replayTimeoutMs: 5_000,
  });
  const adapter = (await import(pluginProviderModulePath)) as unknown as {
    PluginAgentClientRegistry: HostRegistryConstructor;
  };
  const registry = new adapter.PluginAgentClientRegistry(pino({ enabled: false }));
  registry.replace([registration]);
  const client = registry.clients()[registration.id];
  if (!client) throw new Error("registered OMP client is missing");
  let closed = false;
  return {
    root,
    cwd,
    logPath,
    sessionDir,
    wrapperPath,
    registration,
    registry,
    client,
    config(overrides = {}) {
      return {
        provider: registration.id,
        cwd,
        model: MODEL_ID,
        modeId: "full",
        thinkingOptionId: "medium",
        featureValues: {},
        providerOptions: {
          params: {
            sessionDir,
            rpcTimeoutMs: 5_000,
            smolModel: "openai/gpt-5.4",
            slowModel: "anthropic/claude-sonnet-4-5",
            planModel: "anthropic/claude-sonnet-4-5",
          },
        },
        ...overrides,
      };
    },
    launchEnv(extra = {}) {
      return {
        env: {
          PASEO_OMP_FAKE_LOG: logPath,
          PASEO_OMP_FAKE_SECRET: SECRET,
          PASEO_OMP_FAKE_TYPED_APPROVALS: options.typedApprovals === false ? "0" : "1",
          ...(options.stubbornDescendant ? { PASEO_OMP_FAKE_STUBBORN_DESCENDANT: "1" } : {}),
          ...(options.chunkHistory ? { PASEO_OMP_FAKE_CHUNK_HISTORY: "1" } : {}),
          ...extra,
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await registry.shutdown();
    },
  };
}

async function writePersistedSession(harness: Harness): Promise<string> {
  const file = join(harness.sessionDir, `2026-09-12T00-00-00-000Z_${PRIMARY_SESSION_ID}.jsonl`);
  await writeFile(
    file,
    `${[
      { type: "session", version: 3, id: PRIMARY_SESSION_ID, cwd: harness.cwd },
      { type: "title", title: "Imported contract session" },
      { type: "message", message: { role: "user", content: "replayed question" } },
      { type: "message", message: { role: "assistant", content: "replayed answer" } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;
const testOnLinuxOutsideCoverage =
  process.platform === "linux" && process.env.PASEO_OMP_COVERAGE !== "1" ? test : test.skip;
const testNoCov = process.env.PASEO_OMP_COVERAGE !== "1" ? test : test.skip;
const RECOVERY_TEST =
  "recovers after subprocess death and lets registry replacement retire active sessions";

describeOnPosix("OMP plugin provider conformance through PluginAgentClientRegistry", () => {
  test("exposes catalog, profile identity, strict options, and availability", async () => {
    const harness = await createHarness();
    try {
      expect(harness.registry.has("omp-plugin")).toBe(true);
      expect(harness.registry.definitions()).toHaveProperty("omp-plugin");
      const catalog = await harness.client.fetchCatalog({
        scope: "workspace",
        cwd: harness.cwd,
        force: false,
      });
      expect(catalog).toMatchObject({
        defaultModeId: "full",
        modes: [{ id: "full" }, { id: "write" }, { id: "ask" }],
      });
      expect(catalog.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: MODEL_ID,
            provider: "omp-plugin",
            contextWindowMaxTokens: 200_000,
            defaultThinkingOptionId: "medium",
          }),
        ]),
      );
      expect(harness.registration.providerOptionsSchema?.safeParse({ command: [] }).success).toBe(
        false,
      );
      expect(
        harness.registration.providerOptionsSchema?.safeParse({
          command: [harness.wrapperPath],
          env: { PROFILE_FLAG: "enabled" },
          params: { rpcTimeoutMs: 5_000 },
        }).success,
      ).toBe(true);
      const baseKey = await harness.registration.getCatalogCacheKey?.({
        scope: "workspace",
        cwd: harness.cwd,
        providerOptions: { command: [harness.wrapperPath] },
        settings: { profile: "base" },
      });
      const changedKey = await harness.registration.getCatalogCacheKey?.({
        scope: "workspace",
        cwd: harness.cwd,
        providerOptions: { command: [harness.wrapperPath, "--profile", "alternate"] },
        settings: { profile: "alternate" },
      });
      expect(baseKey).toHaveLength(43);
      expect(changedKey).toHaveLength(43);
      expect(changedKey).not.toBe(baseKey);
      await expect(
        harness.registration.checkAvailability?.(
          {
            scope: "workspace",
            cwd: harness.cwd,
            providerOptions: { command: [harness.wrapperPath] },
          },
          { timeoutMs: 5_000 },
        ),
      ).resolves.toMatchObject({ status: "available" });
    } finally {
      await harness.close();
    }
  });

  test("forwards profile arguments and combined system prompts at the process boundary", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(
        harness.config({
          systemPrompt: "agent instruction",
          daemonAppendSystemPrompt: "daemon instruction",
          providerOptions: {
            command: [process.execPath, fixturePath, "--profile", "contract"],
            params: {
              sessionDir: harness.sessionDir,
              rpcTimeoutMs: 5_000,
              smolModel: "openai/gpt-5.4",
              slowModel: "anthropic/claude-sonnet-4-5",
              planModel: "anthropic/claude-sonnet-4-5",
            },
          },
        }),
        harness.launchEnv(),
        { persistSession: false },
      );
      const start = (await readLog(harness.logPath)).find((entry) => entry.kind === "start");
      expect(start).toBeDefined();
      if (start?.kind !== "start") throw new Error("missing fake process launch");
      expect(start.argv).toEqual(
        expect.arrayContaining([
          "--profile",
          "contract",
          "--mode",
          "rpc-ui",
          "--approval-mode",
          "yolo",
          "--no-session",
          "--append-system-prompt",
          "agent instruction\n\ndaemon instruction",
          "--session-dir",
          harness.sessionDir,
          "--smol",
          "openai/gpt-5.4",
        ]),
      );
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("routes advertised commands and manual compaction through host APIs", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      await expect(session.listCommands?.()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "compact", kind: "command" }),
          expect.objectContaining({ name: "review", kind: "command" }),
        ]),
      );

      const compact = await runTurn(session, "/compact retain the contract", "command-compact");
      expect(compact.events.filter(isTerminal)).toEqual([
        expect.objectContaining({ type: "turn_completed", turnId: compact.turnId }),
      ]);
      const review = await runTurn(session, "/review staged changes", "command-review");
      expect(
        review.events
          .flatMap((event) =>
            event.type === "timeline" && event.item.type === "assistant_message"
              ? [event.item.text]
              : [],
          )
          .join(""),
      ).toBe("FAKE_OK");

      const commands = await loggedCommands(harness);
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "compact", customInstructions: "retain the contract" }),
      );
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "prompt", message: "/review staged changes" }),
      );
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("commits model and thinking changes and rejects unsupported host configuration", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const events = new EventLog();
      const unsubscribe = session.subscribe((event) => events.push(event));
      try {
        expect(await session.getCurrentMode()).toBe("full");
        await expect(session.setMode("full")).resolves.toBeUndefined();
        if (!session.setModel || !session.setThinkingOption) {
          throw new Error("host configuration APIs are unavailable");
        }
        await session.setModel(ALTERNATE_MODEL_ID);
        await session.setThinkingOption("low");
        await expect(session.getRuntimeInfo()).resolves.toMatchObject({
          model: ALTERNATE_MODEL_ID,
          modeId: "full",
          thinkingOptionId: "low",
        });
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "model_changed",
              runtimeInfo: expect.objectContaining({ model: ALTERNATE_MODEL_ID }),
            }),
            expect.objectContaining({ type: "thinking_option_changed", thinkingOptionId: "low" }),
          ]),
        );
        await expect(session.setMode("write")).rejects.toThrow(
          "OMP approval mode cannot change live",
        );
        await expect(session.setModel("missing-model")).rejects.toThrow(
          "OMP model selection is unavailable",
        );
        await expect(session.setThinkingOption("medium")).rejects.toThrow(
          "OMP thinking level is unavailable",
        );
        const commands = await loggedCommands(harness);
        expect(commands.filter((command) => command.type === "set_model")).toHaveLength(1);
        expect(commands.filter((command) => command.type === "set_thinking_level")).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("forwards text, images, and structured attachments without changing their contract", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlPkyUAAAAASUVORK5CYII=";
      const prompt: AgentPromptInput = [
        { type: "text", text: "CONTRACT_PROMPT" },
        { type: "image", mimeType: "image/png", data: image },
        {
          type: "forge_issue",
          mimeType: "application/paseo-forge-issue",
          forge: "github",
          number: 13,
          title: "Provider conformance",
          url: "https://github.com/example/repo/issues/13",
          body: "exercise the host boundary",
        },
        {
          type: "uploaded_file",
          id: "upload-1",
          fileName: "notes.txt",
          path: join(harness.cwd, "notes.txt"),
          mimeType: "text/plain",
          size: 12,
        },
      ];
      const { events } = await runTurn(session, prompt, "prompt-contract");
      expect(events.filter(isTerminal)).toEqual([
        expect.objectContaining({ type: "turn_completed" }),
      ]);
      const command = await commandOfType(harness, "prompt");
      expect(command.message).toContain("CONTRACT_PROMPT");
      expect(command.message).toContain("GitHub Issue #13: Provider conformance");
      expect(command.message).toContain("Uploaded file: notes.txt");
      expect(command.images).toEqual([{ type: "image", mimeType: "image/png", data: image }]);
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("maps streaming text, reasoning, tools, todos, compaction, usage, and redaction", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const { events, turnId } = await runTurn(session, "CONTRACT_FULL", "full-contract");
      const timeline = events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
      expect(
        timeline
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.text)
          .join(""),
      ).toBe("Hello");
      expect(
        timeline
          .filter((item) => item.type === "reasoning")
          .map((item) => item.text)
          .join(""),
      ).toBe("Reasoning");
      expect(timeline).toContainEqual(
        expect.objectContaining({ type: "tool_call", name: "bash", status: "completed" }),
      );
      expect(timeline).toContainEqual(
        expect.objectContaining({ type: "todo", items: expect.any(Array) }),
      );
      expect(timeline.filter((item) => item.type === "compaction")).toEqual([
        expect.objectContaining({ status: "loading", trigger: "auto" }),
        expect.objectContaining({ status: "completed", trigger: "auto", preTokens: 1_234 }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          turnId,
          usage: expect.objectContaining({
            inputTokens: 900,
            outputTokens: 120,
            cachedInputTokens: 200,
            contextWindowUsedTokens: 1_234,
          }),
        }),
      );
      expect(JSON.stringify(events)).not.toContain(SECRET);
      expect(events.filter(isTerminal)).toHaveLength(1);
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("round-trips typed allow, deny, cancellation, and late responses exactly once", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(
        harness.config({ modeId: "ask" }),
        harness.launchEnv(),
        { persistSession: false },
      );
      for (const behavior of ["allow", "deny"] as const) {
        const events = new EventLog();
        const unsubscribe = session.subscribe((event) => events.push(event));
        try {
          const { turnId } = await session.startTurn(
            `CONTRACT_TYPED_PERMISSION_${behavior.toUpperCase()}`,
            { clientMessageId: `typed-${behavior}` },
          );
          const requested = await events.waitFor((event) => event.type === "permission_requested");
          if (requested.type !== "permission_requested") throw new Error("missing permission");
          expect(requested.request).toMatchObject({
            kind: "tool",
            name: "omp.bash",
            detail: { type: "shell", command: "printf approved" },
            metadata: expect.objectContaining({ redacted: true }),
          });
          expect(JSON.stringify(requested)).not.toContain(SECRET);
          await session.respondToPermission(requested.request.id, { behavior });
          await events.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
          expect(events.filter((event) => event.type === "permission_requested")).toHaveLength(1);
          expect(events.filter((event) => event.type === "permission_resolved")).toHaveLength(1);
          expect(
            events.filter((event) => isTerminal(event) && hasTurnId(event, turnId)),
          ).toHaveLength(1);
        } finally {
          unsubscribe();
        }
      }

      const canceled = new EventLog();
      const unsubscribeCanceled = session.subscribe((event) => canceled.push(event));
      try {
        const { turnId } = await session.startTurn("CONTRACT_TYPED_PERMISSION_CANCEL", {
          clientMessageId: "typed-cancel",
        });
        const requested = await canceled.waitFor((event) => event.type === "permission_requested");
        if (requested.type !== "permission_requested") throw new Error("missing permission");
        await canceled.waitFor((event) => event.type === "permission_resolved");
        await canceled.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
        await expect(
          session.respondToPermission(requested.request.id, { behavior: "allow" }),
        ).rejects.toThrow("Unknown OMP permission request");
        expect(canceled.filter((event) => event.type === "permission_requested")).toHaveLength(1);
        expect(canceled.filter((event) => event.type === "permission_resolved")).toHaveLength(1);
        expect(
          canceled.filter((event) => isTerminal(event) && hasTurnId(event, turnId)),
        ).toHaveLength(1);
      } finally {
        unsubscribeCanceled();
      }

      expect(
        (await loggedCommands(harness)).filter(
          (command) => command.type === "tool_approval_response",
        ),
      ).toEqual([
        expect.objectContaining({ id: "approval-1", approved: true }),
        expect.objectContaining({ id: "approval-2", approved: false }),
      ]);
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("round-trips fallback confirm allow, deny, cancellation, and late responses", async () => {
    const harness = await createHarness({ typedApprovals: false });
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(
        harness.config({ modeId: "ask" }),
        harness.launchEnv(),
        { persistSession: false },
      );
      for (const behavior of ["allow", "deny"] as const) {
        const events = new EventLog();
        const unsubscribe = session.subscribe((event) => events.push(event));
        try {
          const { turnId } = await session.startTurn(
            `CONTRACT_FALLBACK_PERMISSION_${behavior.toUpperCase()}`,
            { clientMessageId: `fallback-${behavior}` },
          );
          const requested = await events.waitFor((event) => event.type === "permission_requested");
          if (requested.type !== "permission_requested") throw new Error("missing permission");
          expect(requested.request).toMatchObject({
            kind: "question",
            name: "omp.confirm",
            title: "Run command",
          });
          await session.respondToPermission(requested.request.id, {
            behavior,
            selectedActionId: behavior === "allow" ? "submit" : "cancel",
          });
          await events.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
          expect(events.filter((event) => event.type === "permission_requested")).toHaveLength(1);
          expect(events.filter((event) => event.type === "permission_resolved")).toHaveLength(1);
          expect(
            events.filter((event) => isTerminal(event) && hasTurnId(event, turnId)),
          ).toHaveLength(1);
        } finally {
          unsubscribe();
        }
      }

      const canceled = new EventLog();
      const unsubscribeCanceled = session.subscribe((event) => canceled.push(event));
      try {
        const { turnId } = await session.startTurn("CONTRACT_FALLBACK_PERMISSION_CANCEL", {
          clientMessageId: "fallback-cancel",
        });
        const requested = await canceled.waitFor((event) => event.type === "permission_requested");
        if (requested.type !== "permission_requested") throw new Error("missing permission");
        await canceled.waitFor((event) => event.type === "permission_resolved");
        await canceled.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
        await expect(
          session.respondToPermission(requested.request.id, {
            behavior: "allow",
            selectedActionId: "submit",
          }),
        ).rejects.toThrow("Unknown OMP permission request");
        expect(canceled.filter((event) => event.type === "permission_requested")).toHaveLength(1);
        expect(canceled.filter((event) => event.type === "permission_resolved")).toHaveLength(1);
        expect(
          canceled.filter((event) => isTerminal(event) && hasTurnId(event, turnId)),
        ).toHaveLength(1);
      } finally {
        unsubscribeCanceled();
      }

      expect(
        (await loggedCommands(harness)).filter(
          (command) => command.type === "extension_ui_response",
        ),
      ).toEqual([
        expect.objectContaining({ id: "fallback-1", confirmed: true }),
        expect.objectContaining({ id: "fallback-2", confirmed: false }),
      ]);
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("steers and interrupts one active turn without duplicate terminals", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const events = new EventLog();
      const unsubscribe = session.subscribe((event) => events.push(event));
      try {
        const { turnId } = await session.startTurn("CONTRACT_HOLD", { clientMessageId: "hold" });
        await events.waitFor((event) => event.type === "turn_started" && hasTurnId(event, turnId));
        await expect(
          session.steerActiveTurn?.("focus now", {
            expectedTurnId: turnId,
            clientMessageId: "steer",
          }),
        ).resolves.toEqual({ status: "accepted" });
        await session.interrupt();
        await events.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
        expect(events.filter((event) => isTerminal(event) && hasTurnId(event, turnId))).toEqual([
          expect.objectContaining({ type: "turn_canceled" }),
        ]);
        const commands = await loggedCommands(harness);
        expect(commands).toContainEqual(
          expect.objectContaining({ type: "steer", message: "focus now" }),
        );
        expect(commands.filter((command) => command.type === "abort")).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("lists, imports, replays, resumes, and preserves opaque persistence", async () => {
    const harness = await createHarness({ chunkHistory: true });
    await writePersistedSession(harness);
    let imported: AgentSession | undefined;
    let resumed: AgentSession | undefined;
    try {
      const importable = await harness.client.listImportableSessions?.({ cwd: harness.cwd });
      expect(importable).toEqual([
        expect.objectContaining({
          cwd: harness.cwd,
          title: "Imported contract session",
        }),
      ]);
      const candidate = importable?.[0];
      if (!candidate || !harness.client.importSession)
        throw new Error("session import unavailable");
      const result = await harness.client.importSession(
        { providerHandleId: candidate.providerHandleId, cwd: harness.cwd },
        {
          config: harness.config(),
          storedConfig: harness.config(),
          launchContext: harness.launchEnv(),
        },
      );
      imported = result.session;
      expect(result.persistence.metadata).toEqual({
        pluginProviderPersistence: { version: 1, data: { sessionId: PRIMARY_SESSION_ID } },
      });
      expect(result.timeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            item: expect.objectContaining({ type: "user_message", text: "replayed question" }),
          }),
          expect.objectContaining({
            item: expect.objectContaining({ type: "assistant_message", text: "replayed answer" }),
          }),
        ]),
      );
      const handle = imported.describePersistence();
      if (!handle) throw new Error("missing persistence handle");
      await imported.close();
      imported = undefined;
      resumed = await harness.client.resumeSession(handle, harness.config(), harness.launchEnv());
      expect(resumed.describePersistence()).toEqual(handle);
      const starts = (await readLog(harness.logPath)).filter(
        (entry): entry is Extract<FakeLogEntry, { kind: "start" }> => entry.kind === "start",
      );
      expect(starts.at(-1)?.argv).toEqual(expect.arrayContaining(["--resume", PRIMARY_SESSION_ID]));
    } finally {
      await resumed?.close();
      await imported?.close();
      await harness.close();
    }
  });

  testNoCov("publishes child and nested child sessions before completing the root", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const { events } = await runTurn(session, "CONTRACT_CHILD", "child-contract");
      const childEvents = events.filter((event) => event.type === "provider_subagent");
      const runningChildren = childEvents.filter(
        (event) => event.event.type === "upsert" && event.event.status === "running",
      );
      expect(runningChildren).toHaveLength(2);
      const childId = runningChildren.find(
        (event) => event.event.type === "upsert" && event.event.title === "worker",
      )?.event.id;
      const grandchildId = runningChildren.find(
        (event) => event.event.type === "upsert" && event.event.title === "nested",
      )?.event.id;
      expect(childId).toMatch(/^omp:subsession:/);
      expect(grandchildId).toMatch(/^omp:subsession:/);
      expect(grandchildId).not.toBe(childId);
      expect(childEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ type: "timeline", id: grandchildId }),
          }),
          expect.objectContaining({
            event: expect.objectContaining({
              type: "upsert",
              id: grandchildId,
              status: "completed",
            }),
          }),
          expect.objectContaining({
            event: expect.objectContaining({ type: "upsert", id: childId, status: "completed" }),
          }),
        ]),
      );
      expect(events.findIndex(isTerminal)).toBeGreaterThan(
        events.findLastIndex(
          (event) =>
            event.type === "provider_subagent" &&
            event.event.type === "upsert" &&
            event.event.status === "completed",
        ),
      );
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("rewinds through the host API and atomically adopts the branched native session", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: true,
      });
      const { events } = await runTurn(session, "CONTRACT_REWIND", "rewind-source");
      const user = events.find(
        (event) => event.type === "timeline" && event.item.type === "user_message",
      );
      if (user?.type !== "timeline" || user.item.type !== "user_message" || !user.item.messageId) {
        throw new Error("missing rewindable user message");
      }
      await session.revertConversation?.({ messageId: user.item.messageId });
      expect(session.describePersistence()?.metadata).toEqual({
        pluginProviderPersistence: { version: 1, data: { sessionId: BRANCHED_SESSION_ID } },
      });
      const commands = await loggedCommands(harness);
      expect(commands).toContainEqual(
        expect.objectContaining({ type: "branch", entryId: "user-root" }),
      );
      expect(commands.filter((command) => command.type === "get_messages").length).toBeGreaterThan(
        0,
      );
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  testOnLinuxOutsideCoverage(RECOVERY_TEST, async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    let replacement: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: true,
      });
      const dying = runTurn(session, "CONTRACT_DIE", "death-turn");
      await expect(dying).resolves.toMatchObject({
        events: expect.arrayContaining([expect.objectContaining({ type: "turn_failed" })]),
      });
      const recovered = await runTurn(session, "after death", "recovered-turn");
      expect(recovered.events.filter(isTerminal)).toEqual([
        expect.objectContaining({ type: "turn_completed" }),
      ]);
      const startsBeforeReload = (await readLog(harness.logPath)).filter(
        (entry): entry is Extract<FakeLogEntry, { kind: "start" }> => entry.kind === "start",
      );
      expect(startsBeforeReload).toHaveLength(2);
      expect(startsBeforeReload[1]?.argv).toEqual(
        expect.arrayContaining(["--resume", PRIMARY_SESSION_ID]),
      );

      const oldSession = session;
      const reloadEvents = new EventLog();
      const unsubscribeOld = oldSession.subscribe((event) => reloadEvents.push(event));
      const active = await oldSession.startTurn("CONTRACT_HOLD", {
        clientMessageId: "reload-active",
      });
      await reloadEvents.waitFor(
        (event) => event.type === "turn_started" && hasTurnId(event, active.turnId),
      );
      const oldPid = startsBeforeReload.at(-1)?.pid;
      if (!oldPid) throw new Error("missing old provider process");
      const oldExited = waitForProcessExit(oldPid);
      const replacementRegistration = createOmpProvider({
        environment: {
          HOME: harness.root,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          OMP_COMMAND: harness.wrapperPath,
          OMP_SESSION_DIR: harness.sessionDir,
        },
      });
      harness.registry.replace([replacementRegistration]);
      await oldExited;
      await reloadEvents.waitFor((event) => isTerminal(event) && hasTurnId(event, active.turnId));
      expect(
        reloadEvents.filter((event) => isTerminal(event) && hasTurnId(event, active.turnId)),
      ).toHaveLength(1);
      expect(processIsExecuting(oldPid)).toBe(false);
      await expect(oldSession.startTurn("stale", { clientMessageId: "stale" })).rejects.toThrow(
        /closed|stale/i,
      );
      unsubscribeOld();
      session = undefined;

      const nextClient = harness.registry.clients()[replacementRegistration.id];
      if (!nextClient) throw new Error("replacement OMP client is missing");
      replacement = await nextClient.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const removalEvents = new EventLog();
      const unsubscribeReplacement = replacement.subscribe((event) => removalEvents.push(event));
      const removalTurn = await replacement.startTurn("CONTRACT_HOLD", {
        clientMessageId: "removal-active",
      });
      await removalEvents.waitFor(
        (event) => event.type === "turn_started" && hasTurnId(event, removalTurn.turnId),
      );
      const replacementPid = (await readLog(harness.logPath)).findLast(
        (entry) => entry.kind === "start",
      )?.pid;
      if (!replacementPid) throw new Error("missing replacement provider process");
      const replacementExited = waitForProcessExit(replacementPid);
      harness.registry.replace([]);
      await replacementExited;
      await removalEvents.waitFor(
        (event) => isTerminal(event) && hasTurnId(event, removalTurn.turnId),
      );
      expect(
        removalEvents.filter((event) => isTerminal(event) && hasTurnId(event, removalTurn.turnId)),
      ).toHaveLength(1);
      expect(processIsExecuting(replacementPid)).toBe(false);
      await expect(
        replacement.startTurn("removed", { clientMessageId: "removed" }),
      ).rejects.toThrow(/closed|stale/i);
      unsubscribeReplacement();
      replacement = undefined;
    } finally {
      await replacement?.close();
      await session?.close();
      await harness.close();
    }
  });

  if (process.platform !== "win32") {
    test("kills a stubborn descendant instead of trusting stdin EOF", async () => {
      const harness = await createHarness({ stubbornDescendant: true });
      let session: AgentSession | undefined;
      try {
        session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
          persistSession: false,
        });
        const entries = await readLog(harness.logPath);
        const leaderPid = entries.find((entry) => entry.kind === "start")?.pid;
        const descendantPid = entries.find((entry) => entry.kind === "descendant")?.pid;
        if (!leaderPid || !descendantPid) throw new Error("missing process-tree identities");
        expect(processIsExecuting(leaderPid)).toBe(true);
        expect(processIsExecuting(descendantPid)).toBe(true);

        await expect(session.close()).resolves.toBeUndefined();
        session = undefined;

        expect(processIsExecuting(leaderPid)).toBe(false);
        expect(processIsExecuting(descendantPid)).toBe(false);
      } finally {
        await session?.close();
        await harness.close();
      }
    }, 10_000);
  }

  test("accepts chunked large frames and rejects oversized prompts before IPC", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      const { events } = await runTurn(session, "CONTRACT_LARGE", "large-frame");
      const text = events
        .flatMap((event) =>
          event.type === "timeline" && event.item.type === "assistant_message"
            ? [event.item.text]
            : [],
        )
        .join("");
      expect(text.startsWith("LARGE:")).toBe(true);
      expect(text).toHaveLength(600_006);
      const promptsBefore = (await loggedCommands(harness)).filter(
        (command) => command.type === "prompt",
      ).length;
      await expect(
        session.startTurn("x".repeat(1024 * 1024 + 1), { clientMessageId: "oversized" }),
      ).rejects.toThrow("OMP prompt is too large");
      const promptsAfter = (await loggedCommands(harness)).filter(
        (command) => command.type === "prompt",
      ).length;
      expect(promptsAfter).toBe(promptsBefore);
    } finally {
      await session?.close();
      await harness.close();
    }
  });

  test("survives bounded sequential and interrupt races without duplicates, leaks, or log growth", async () => {
    const harness = await createHarness();
    let session: AgentSession | undefined;
    try {
      session = await harness.client.createSession(harness.config(), harness.launchEnv(), {
        persistSession: false,
      });
      if (!session.setThinkingOption) throw new Error("host thinking API is unavailable");
      const events = new EventLog();
      const unsubscribe = session.subscribe((event) => events.push(event));
      const completedTurnIds = new Set<string>();
      const assistantMessageIds = new Set<string>();
      for (let index = 0; index < 64; index += 1) {
        const cycleStart = events.length;
        let turnId: string;
        try {
          ({ turnId } = await session.startTurn(`SOAK_${index}`, {
            clientMessageId: `soak-${index}`,
          }));
          await events.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
          await session.setThinkingOption("medium");
        } catch (error) {
          throw new Error(`Sequential soak iteration ${index} failed`, { cause: error });
        }
        const cycle = events.slice(cycleStart);
        const terminalEvents = cycle.filter(
          (event) => isTerminal(event) && hasTurnId(event, turnId),
        );
        const assistantMessages = cycle.flatMap((event) =>
          event.type === "timeline" && event.item.type === "assistant_message"
            ? [{ id: event.item.messageId, text: event.item.text }]
            : [],
        );
        expect(terminalEvents).toEqual([
          expect.objectContaining({ type: "turn_completed", turnId }),
        ]);
        expect(assistantMessages.map((message) => message.text).join("")).toBe("FAKE_OK");
        expect(completedTurnIds.has(turnId)).toBe(false);
        completedTurnIds.add(turnId);
        for (const message of assistantMessages) {
          if (!message.id) throw new Error("missing assistant message identity");
          expect(assistantMessageIds.has(message.id)).toBe(false);
          assistantMessageIds.add(message.id);
        }
      }
      expect(completedTurnIds.size).toBe(64);
      expect(assistantMessageIds.size).toBe(64);

      const interruptedTurnIds = new Set<string>();
      for (let index = 0; index < 10; index += 1) {
        const cycleStart = events.length;
        const { turnId } = await session.startTurn("CONTRACT_HOLD", {
          clientMessageId: `race-${index}`,
        });
        await session.interrupt();
        await events.waitFor((event) => isTerminal(event) && hasTurnId(event, turnId));
        await session.setThinkingOption("medium");
        const cycle = events.slice(cycleStart);
        expect(interruptedTurnIds.has(turnId)).toBe(false);
        interruptedTurnIds.add(turnId);
        expect(cycle.filter((event) => isTerminal(event) && hasTurnId(event, turnId))).toEqual([
          expect.objectContaining({ type: "turn_canceled", turnId }),
        ]);
        expect(
          cycle
            .flatMap((event) =>
              event.type === "timeline" && event.item.type === "assistant_message"
                ? [event.item.text]
                : [],
            )
            .join(""),
        ).toBe("INTERRUPTED");
      }
      expect(interruptedTurnIds.size).toBe(10);
      const subscribedEventCount = events.length;
      unsubscribe();
      await runTurn(session, "SOAK_POST_UNSUBSCRIBE", "post-unsubscribe");
      await session.setThinkingOption("medium");
      expect(events).toHaveLength(subscribedEventCount);

      const starts = (await readLog(harness.logPath)).filter(
        (entry): entry is Extract<FakeLogEntry, { kind: "start" }> => entry.kind === "start",
      );
      expect(starts).toHaveLength(1);
      expect((await readFile(harness.logPath)).byteLength).toBeLessThan(2 * 1024 * 1024);
      const pid = starts[0]?.pid;
      if (!pid) throw new Error("missing fake process pid");
      expect(processIsAlive(pid)).toBe(true);
      await session.close();
      session = undefined;
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      await session?.close();
      await harness.close();
    }
  });
});
