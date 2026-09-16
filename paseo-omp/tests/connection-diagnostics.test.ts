import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test, vi } from "vitest";
import { createOmpConnection, type OmpConnectionDiagnostic } from "../server/provider/connection";
import type { OmpRuntime } from "../server/provider/omp-rpc";

async function failedOpen(
  error: unknown,
  reportDiagnostic?: (diagnostic: OmpConnectionDiagnostic) => void,
): Promise<ProviderEvent[]> {
  const runtime: OmpRuntime = {
    supportsPersistence: false,
    async startSession() {
      throw error;
    },
    async listSessions() {
      return [];
    },
    async readPersistedSubagentTranscript() {
      throw new Error("unused");
    },
  };
  const connection = createOmpConnection(
    runtime,
    [],
    undefined,
    { HOME: "/__paseo_test_missing__", PI_CODING_AGENT_DIR: "/__paseo_test_missing__/agent" },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reportDiagnostic,
  );
  const events: ProviderEvent[] = [];
  const done = Promise.withResolvers<void>();
  connection.onEvent((event) => {
    events.push(event);
    if (event.type === "session.closed") done.resolve();
  });
  try {
    await connection.send({
      type: "session.open",
      requestId: "request-fixture",
      sessionId: "session-fixture",
      config: {
        cwd: "/__paseo_test_missing__",
        env: { API_KEY: "fabricated-env-secret" },
        systemPrompt: "fabricated-prompt-secret",
        mcpServers: {},
        persist: false,
        mode: "full",
        settings: {},
      },
      history: "skip",
    });
    await done.promise;
    return events;
  } finally {
    await connection.close();
  }
}

describe("connection failure diagnostics", () => {
  test("links generic open errors to value-safe diagnostics without forwarding error contents", async () => {
    const secret = "fabricated-error-secret";
    const error = new TypeError(secret);
    error.name = secret;
    error.stack = `${secret}\n at ${secret} (/private/${secret}:1:2)`;
    error.cause = { token: secret };
    const diagnostics: OmpConnectionDiagnostic[] = [];
    const events = await failedOpen(error, (entry) => diagnostics.push(entry));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      operation: "OMP session failed to open",
      errorClass: "TypeError",
      classification: "unexpected",
    });
    const failure = events.find((event) => event.type === "request.failed");
    const closed = events.find((event) => event.type === "session.closed");
    expect(failure).toMatchObject({
      requestId: "request-fixture",
      error: { message: `OMP session failed to open (diagnostic ${diagnostics[0]?.diagnosticId})` },
    });
    expect(closed).toMatchObject({
      error: failure?.type === "request.failed" ? failure.error : undefined,
    });
    const serialized = JSON.stringify({ diagnostics, events });
    for (const value of [
      secret,
      "fabricated-env-secret",
      "fabricated-prompt-secret",
      "/private/",
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(JSON.stringify(diagnostics)).not.toContain("request-fixture");
  });

  test("classifies the exact locally authored RPC limit failure", async () => {
    const diagnostics: OmpConnectionDiagnostic[] = [];
    await failedOpen(new Error("OMP RPC response exceeded command limits"), (entry) =>
      diagnostics.push(entry),
    );
    expect(diagnostics[0]).toMatchObject({
      errorClass: "Error",
      classification: "rpc-response-limit",
      stage: "rpc",
    });
  });

  test.each([
    ["OMP executable was not found", "spawn-not-found"],
    ["OMP executable is not runnable", "spawn-not-runnable"],
    ["OMP process could not be launched", "spawn-failed"],
  ])("attributes the safe spawn failure %s", async (message, classification) => {
    const diagnostics: OmpConnectionDiagnostic[] = [];
    await failedOpen(new Error(message), (entry) => diagnostics.push(entry));
    expect(diagnostics[0]).toMatchObject({ classification, stage: "spawn" });
  });

  test.each([
    ["code 1", { exitCode: 1 }],
    ["code 0", { exitCode: 0 }],
    ["code -1", { exitCode: -1 }],
    ["code 4294967295", { exitCode: 4294967295 }],
    ["signal SIGTERM", { signal: "SIGTERM" }],
    ["signal SIGKILL", { signal: "SIGKILL" }],
    ["signal unknown", { signal: "unknown" }],
  ])("extracts only the structured process exit %s", async (detail, fields) => {
    const diagnostics: OmpConnectionDiagnostic[] = [];
    await failedOpen(new Error(`OMP RPC process exited (${detail})`), (entry) =>
      diagnostics.push(entry),
    );
    expect(diagnostics[0]).toMatchObject({ classification: "rpc-exit", stage: "rpc", ...fields });
  });

  test.each([
    ["ENOENT", "system-error", undefined],
    ["EACCES", "system-error", undefined],
    ["EPIPE", "system-error", undefined],
    ["SQLITE_BUSY", "database-error", "storage"],
    ["SQLITE_CANTOPEN", "database-error", "storage"],
  ])("retains only the known error code %s", async (code, classification, stage) => {
    const diagnostics: OmpConnectionDiagnostic[] = [];
    const error = Object.assign(new Error("fabricated-error-secret"), { code });
    error.cause = { code: "fabricated-cause-secret" };
    const events = await failedOpen(error, (entry) => diagnostics.push(entry));
    expect(diagnostics[0]).toMatchObject({ classification, code });
    expect(diagnostics[0]?.stage).toBe(stage);
    expect(JSON.stringify({ diagnostics, events })).not.toContain("fabricated-");
  });

  test.each([
    "OMP executable was not found fabricated-secret",
    "OMP RPC process exited (code 1) fabricated-secret",
    "OMP RPC process exited (code 99999999999999999999)",
    "OMP RPC process exited (code 4294967296)",
    "OMP RPC process exited (code -2147483649)",
    "OMP RPC process exited (code 1)\n",
    "OMP RPC process exited (signal SIGTERM fabricated-secret)",
    "OMP RPC process exited (signal fabricated-secret)",
    "fabricated-secret\nOMP RPC process exited (signal SIGTERM)",
  ])("does not parse arbitrary error text: %s", async (message) => {
    const diagnostics: OmpConnectionDiagnostic[] = [];
    const error = Object.assign(new Error(message), { code: "ENOENT fabricated-secret" });
    const events = await failedOpen(error, (entry) => diagnostics.push(entry));
    expect(diagnostics[0]).toMatchObject({ classification: "unexpected" });
    expect(diagnostics[0]).not.toHaveProperty("code");
    expect(diagnostics[0]).not.toHaveProperty("exitCode");
    expect(diagnostics[0]).not.toHaveProperty("signal");
    expect(JSON.stringify({ diagnostics, events })).not.toContain("fabricated-secret");
  });

  test("does not invoke an error code getter", async () => {
    const getter = vi.fn(() => {
      throw new Error("fabricated-secret");
    });
    const error = Object.defineProperty(new Error("fabricated-secret"), "code", { get: getter });
    const diagnostics: OmpConnectionDiagnostic[] = [];
    const events = await failedOpen(error, (entry) => diagnostics.push(entry));
    expect(getter).not.toHaveBeenCalled();
    expect(diagnostics[0]).toMatchObject({ classification: "unexpected" });
    expect(JSON.stringify({ diagnostics, events })).not.toContain("fabricated-secret");
  });

  test("does not classify or forward an arbitrary extension of a known message", async () => {
    const diagnostics: OmpConnectionDiagnostic[] = [];
    await failedOpen(new Error("OMP RPC response exceeded command limits secret-value"), (entry) =>
      diagnostics.push(entry),
    );
    expect(diagnostics[0]?.classification).toBe("unexpected");
    expect(JSON.stringify(diagnostics)).not.toContain("secret-value");
  });

  test("the default sink emits the same safe structured diagnostic", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await failedOpen({ name: "secret-name", message: "secret-message", stack: "secret-stack" });
      expect(log).toHaveBeenCalledWith(
        "OMP provider failure",
        expect.objectContaining({ errorClass: "NonError", classification: "unexpected" }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-");
    } finally {
      log.mockRestore();
    }
  });

  test("a throwing sink cannot prevent the failed request from settling", async () => {
    const events = await failedOpen(new Error("secret"), () => {
      throw new Error("sink failed");
    });
    expect(events.some((event) => event.type === "request.failed")).toBe(true);
    expect(events.some((event) => event.type === "session.closed")).toBe(true);
  });
});
