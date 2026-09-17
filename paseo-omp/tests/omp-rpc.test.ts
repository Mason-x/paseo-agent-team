import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  buildOmpSpawnRequest,
  type OmpRpcEvent,
  OmpRpcRuntime,
  type OmpSpawnRequest,
  terminatePosixProcessTree,
} from "../server/provider/omp-rpc";

const READY_FRAME = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
} as const;
const READY_WITH_TYPED_APPROVALS = {
  ...READY_FRAME,
  features: { typedToolApprovals: 1 },
} as const;
const NATIVE_TOOL_APPROVAL_FRAME_BYTES = 64 * 1024;
const TEST_RUNTIME_ENV: NodeJS.ProcessEnv = {
  HOME: "/__paseo_omp_test_no_home__",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
  PI_CONFIG_DIR: ".omp-no-config",
};

class FakeRpcChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 424_242;
  private didClose = false;

  constructor() {
    super();
    this.stdin.once("error", () => this.close(1));
    this.stdin.once("finish", () => this.close());
  }

  kill(): boolean {
    this.close(null, "SIGTERM");
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.didClose) return;
    this.didClose = true;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  write(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  writeRaw(value: string): void {
    this.stdout.write(value);
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}
function writeChunked(child: FakeRpcChild, frame: Record<string, unknown>, chunkId: string): void {
  const payload = Buffer.from(JSON.stringify(frame));
  const parts: Buffer[] = [];
  for (let offset = 0; offset < payload.byteLength; offset += 256 * 1024) {
    parts.push(payload.subarray(offset, offset + 256 * 1024));
  }
  for (const [index, part] of parts.entries()) {
    child.write({
      type: "rpc_chunk",
      chunkId,
      index,
      count: parts.length,
      byteLength: payload.byteLength,
      data: part.toString("base64"),
    });
  }
}

function observeCommands(
  child: FakeRpcChild,
  handler: (command: Record<string, unknown>) => void,
): void {
  let buffered = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffered += String(chunk);
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      handler(JSON.parse(line) as Record<string, unknown>);
    }
  });
}

function runtimeFor(
  child: FakeRpcChild,
  launches: OmpSpawnRequest[] = [],
  requestTimeoutMs?: number,
): OmpRpcRuntime {
  return new OmpRpcRuntime({
    spawnProcess(request) {
      launches.push(request);
      return child.asChildProcess();
    },
    environment: TEST_RUNTIME_ENV,
    terminateProcessTree: () => Promise.resolve(true),
    requestTimeoutMs,
  });
}

function nextEvent(
  subscribe: (listener: (event: OmpRpcEvent) => void) => () => void,
): Promise<OmpRpcEvent> {
  const result = Promise.withResolvers<OmpRpcEvent>();
  let remove = () => {};
  remove = subscribe((event) => {
    remove();
    result.resolve(event);
  });
  return result.promise;
}

describe("OMP RPC transport", () => {
  test("accepts a bounded multi-provider model catalog without relaxing other response limits", async () => {
    const child = new FakeRpcChild();
    let oversized = false;
    const models = Array.from({ length: 53 }, (_, index) => ({
      provider: `provider-${index % 3}`,
      id: `model-${index}`,
      reasoning: true,
      thinking: {
        efforts: Array.from({ length: 16 }, (_, n) => `effort-${n}`),
        defaultLevel: "high",
      },
      input: Array.from({ length: 16 }, (_, n) => `input-${n}`),
      contextWindow: 200_000,
    }));
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "get_available_models") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: {
            models: oversized
              ? models.map((model) => ({ ...model, extra: Array(512).fill(0) }))
              : models,
          },
        });
      } else if (command.type === "get_state") {
        child.write({ type: "response", id: command.id, success: true, data: { nested: models } });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    try {
      expect(await session.getAvailableModels()).toHaveLength(53);
      await expect(session.getState()).rejects.toThrow("response exceeded command limits");
      oversized = true;
      await expect(session.getAvailableModels()).rejects.toThrow(
        "response exceeded command limits",
      );
    } finally {
      await session.close();
    }
  });

  test("sends steering and out-of-band commands with native wire shapes", async () => {
    const child = new FakeRpcChild();
    const launches: OmpSpawnRequest[] = [];
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "set_auto_compaction" || command.type === "handoff") {
        child.write({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: {},
        });
      }
    });
    const runtime = runtimeFor(child, launches);
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    expect(session.maxInputFrameBytes).toBe(READY_FRAME.maxFrameBytes);
    const promptResult = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "prompt_result", id: "prompt-1", agentInvoked: false });
    await expect(promptResult).resolves.toEqual({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    });

    const correlatedEnd = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "agent_end",
      requestId: "prompt-2",
      messages: [],
      isTerminal: true,
    });
    await expect(correlatedEnd).resolves.toEqual({
      type: "agent_end",
      requestId: "prompt-2",
      messages: [],
      isTerminal: true,
    });

    await session.steer("focus");
    await session.followUp("verify");
    await session.setAutoCompaction(false);
    await session.handoff("implement now");

    expect(launches[0]).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["--mode", "rpc-ui", "--approval-mode", "yolo"]),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "negotiate_protocol", protocolVersion: 2 }),
    );
    expect(commands).toContainEqual({
      type: "steer",
      message: "focus",
    });
    expect(commands).toContainEqual({ type: "follow_up", message: "verify" });
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "set_auto_compaction", enabled: false }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ type: "handoff", customInstructions: "implement now" }),
    );
    await session.close();
  });

  test("negotiates and correlates bounded typed tool approvals only when advertised", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2, clientCapabilities: { typedToolApprovals: 1 } },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_WITH_TYPED_APPROVALS);
    const session = await opening;
    expect(session.supportsTypedToolApprovals).toBe(true);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "negotiate_protocol",
        clientCapabilities: { typedToolApprovals: 1 },
      }),
    );

    const request = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_approval_request",
      id: "approval-1",
      toolCallId: "tool-call-1",
      toolKind: "shell",
      toolName: "bash",
      tier: "exec",
      identity: { kind: "shell", command: "git status" },
      input: { command: "git status", token: "[redacted]" },
      detail: {
        lines: ["Command: git status"],
        truncated: false,
        truncatedFields: [],
        redacted: true,
        redactedFields: ["input.token"],
      },
    });
    await expect(request).resolves.toMatchObject({
      type: "tool_approval_request",
      id: "approval-1",
      identity: { kind: "shell", command: "git status" },
    });
    await session.respondToToolApproval({
      type: "tool_approval_response",
      id: "approval-1",
      toolCallId: "tool-call-1",
      approved: true,
    });
    expect(commands).toContainEqual({
      type: "tool_approval_response",
      id: "approval-1",
      toolCallId: "tool-call-1",
      approved: true,
    });
    await session.close();
  });

  test("accepts native maximum approval identity and aggregate envelope bounds", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: 2, clientCapabilities: { typedToolApprovals: 1 } },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_WITH_TYPED_APPROVALS);
    const session = await opening;
    const metadata = [...Array.from({ length: 32 }, (_, index) => `field-${index}`), "additional"];
    const shell = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_approval_request",
      id: "max-shell",
      toolCallId: "max-shell-call",
      toolKind: "shell",
      toolName: "bash",
      tier: "exec",
      identity: { kind: "shell", command: "x".repeat(24 * 1024) },
      input: {},
      detail: {
        lines: [],
        truncated: true,
        truncatedFields: metadata,
        redacted: true,
        redactedFields: metadata,
      },
    });
    await expect(shell).resolves.toMatchObject({ type: "tool_approval_request", id: "max-shell" });

    const write = nextEvent((listener) => session.onEvent(listener));
    const aggregate = {
      type: "tool_approval_request" as const,
      id: "max-write",
      toolCallId: "max-write-call",
      toolKind: "write" as const,
      toolName: "write",
      tier: "write" as const,
      identity: { kind: "write" as const, path: "out.txt", content: "w".repeat(20 * 1024) },
      input: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`value-${index}`, "x".repeat(8 * 1024)]),
      ),
      detail: {
        lines: [],
        truncated: false,
        truncatedFields: [],
        redacted: false,
        redactedFields: [],
      },
    };
    aggregate.input.tail = "";
    aggregate.input.tail = "x".repeat(
      NATIVE_TOOL_APPROVAL_FRAME_BYTES - Buffer.byteLength(JSON.stringify(aggregate), "utf8") - 1,
    );
    expect(Buffer.byteLength(aggregate.input.tail, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(JSON.stringify(aggregate), "utf8") + 1).toBe(
      NATIVE_TOOL_APPROVAL_FRAME_BYTES,
    );
    child.write(aggregate);
    await expect(write).resolves.toMatchObject({ type: "tool_approval_request", id: "max-write" });
    const edit = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "tool_approval_request",
      id: "max-edit",
      toolCallId: "max-edit-call",
      toolKind: "edit",
      toolName: "edit",
      tier: "write",
      identity: { kind: "edit", paths: ["src/a.ts"], content: "e".repeat(20 * 1024) },
      input: {},
      detail: {
        lines: [],
        truncated: false,
        truncatedFields: [],
        redacted: false,
        redactedFields: [],
      },
    });
    await expect(edit).resolves.toMatchObject({ type: "tool_approval_request", id: "max-edit" });
    await session.close();
  });

  test("rejects above-native approval fields and cancels matching native requests", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    const canceled = Promise.withResolvers<void>();
    observeCommands(child, (command) => {
      commands.push(command);
      if (
        command.type === "tool_approval_response" &&
        commands.filter((candidate) => candidate.type === "tool_approval_response").length === 3
      ) {
        canceled.resolve();
      }
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: 2, clientCapabilities: { typedToolApprovals: 1 } },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_WITH_TYPED_APPROVALS);
    const session = await opening;
    for (const [id, toolCallId, toolKind, identity] of [
      [
        "over-shell",
        "over-shell-call",
        "shell",
        { kind: "shell", command: "x".repeat(24 * 1024 + 1) },
      ],
      [
        "over-edit",
        "over-edit-call",
        "edit",
        { kind: "edit", paths: ["a.ts"], content: "x".repeat(20 * 1024 + 1) },
      ],
      [
        "over-write",
        "over-write-call",
        "write",
        { kind: "write", path: "a.ts", content: "x".repeat(20 * 1024 + 1) },
      ],
    ] as const) {
      child.write({
        type: "tool_approval_request",
        id,
        toolCallId,
        toolKind,
        toolName: toolKind,
        tier: "write",
        identity,
        input: {},
        detail: {
          lines: [],
          truncated: false,
          truncatedFields: [],
          redacted: false,
          redactedFields: [],
        },
      });
    }
    await canceled.promise;
    expect(commands).toEqual(
      expect.arrayContaining([
        {
          type: "tool_approval_response",
          id: "over-shell",
          toolCallId: "over-shell-call",
          cancelled: true,
        },
        {
          type: "tool_approval_response",
          id: "over-edit",
          toolCallId: "over-edit-call",
          cancelled: true,
        },
        {
          type: "tool_approval_response",
          id: "over-write",
          toolCallId: "over-write-call",
          cancelled: true,
        },
      ]),
    );
    await session.close();
  });

  test("keeps typed approvals disabled for older OMP ready frames", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "ask" });
    child.write(READY_FRAME);
    const session = await opening;
    expect(session.supportsTypedToolApprovals).toBe(false);
    expect(commands.find((command) => command.type === "negotiate_protocol")).not.toHaveProperty(
      "clientCapabilities",
    );
    await session.close();
  });

  test("preserves a bounded late prompt scheduling failure after success acknowledgement", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "prompt") {
        child.write({
          type: "response",
          id: command.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        queueMicrotask(() => {
          child.write({
            type: "response",
            id: command.id,
            command: "prompt",
            success: false,
            error: "Session is already processing a prompt",
            code: "session_busy",
          });
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));
    const acknowledgement = await session.prompt("work");
    await expect(failure).resolves.toEqual({
      type: "prompt_error",
      id: acknowledgement.requestId,
      error: "Session is already processing a prompt",
      code: "session_busy",
    });
    await session.close();
  });

  test.each([
    [
      "malformed error",
      { error: { message: "unsafe" }, code: "session_busy" },
      { error: "OMP prompt scheduling failed", code: "session_busy" },
    ],
    [
      "deep malformed error",
      {
        error: Array.from({ length: 17 }).reduce<unknown>((cause) => ({ cause }), "unsafe"),
        code: "session_busy",
      },
      { error: "OMP prompt scheduling failed", code: "session_busy" },
    ],
    [
      "oversized error",
      { error: "é".repeat(2_049), code: "session_busy" },
      { error: "OMP prompt scheduling failed", code: "session_busy" },
    ],
    ["malformed code", { error: "native failure", code: 42 }, { error: "native failure" }],
    [
      "wide malformed code",
      { error: "native failure", code: Array(1_025).fill("unsafe") },
      { error: "native failure" },
    ],
    [
      "oversized code",
      { error: "native failure", code: "é".repeat(129) },
      { error: "native failure" },
    ],
  ])("sanitizes %s in late prompt scheduling failures", async (_name, rejected, expected) => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "prompt") {
        child.write({
          type: "response",
          id: command.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        queueMicrotask(() => {
          child.write({
            type: "response",
            id: command.id,
            command: "prompt",
            success: false,
            ...rejected,
          });
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));
    const acknowledgement = await session.prompt("work");
    child.write({ type: "notice", level: "info", message: "after failure" });
    await expect(failure).resolves.toEqual({
      type: "prompt_error",
      id: acknowledgement.requestId,
      ...expected,
    });
    await session.close();
  });

  test("ignores unmatched prompt failures", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const next = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "response",
      id: "unknown-prompt",
      command: "prompt",
      success: false,
      error: "Session is already processing a prompt",
      code: "session_busy",
    });
    child.write({ type: "notice", level: "info", message: "still healthy" });
    await expect(next).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });

  test("ignores a repeated success response for an accepted prompt", async () => {
    const child = new FakeRpcChild();
    let promptId: string | undefined;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "prompt") {
        promptId = command.id as string;
        child.write({
          type: "response",
          id: command.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await session.prompt("work");
    const next = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "response",
      id: promptId,
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    });
    child.write({ type: "notice", level: "info", message: "still healthy" });
    await expect(next).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    const failure = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "response",
      id: promptId,
      command: "prompt",
      success: false,
      error: "native failure",
      code: "session_busy",
    });
    await expect(failure).resolves.toEqual({
      type: "prompt_error",
      id: promptId,
      error: "native failure",
      code: "session_busy",
    });
    await session.close();
  });

  test("retains active tool correlation across agent_end", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const received: OmpRpcEvent[] = [];
    session.onEvent((event) => received.push(event));
    child.write({
      type: "tool_execution_start",
      toolCallId: "ask-1",
      toolName: "ask_user",
      args: { questions: [] },
    });
    child.write({ type: "agent_end", messages: [], isTerminal: true });
    child.write({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask_user",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await Promise.resolve();
    expect(received.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "agent_end",
      "tool_execution_end",
    ]);
    await session.close();
  });

  test("accepts current goal retry compaction and subagent events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const futureSelector = `provider/${"m".repeat(4_096)}:future-thinking`;
    const frames: OmpRpcEvent[] = [
      { type: "model_changed" },
      { type: "thinking_level_changed", thinkingLevel: "future-thinking" },
      {
        type: "retry_fallback_applied",
        from: futureSelector,
        to: futureSelector,
        role: futureSelector,
      },
      {
        type: "retry_fallback_succeeded",
        model: futureSelector,
        role: futureSelector,
      },
      {
        type: "goal_updated",
        goal: {
          id: "goal-1",
          objective: "Ship the provider",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 2_000,
          timeUsedSeconds: 42,
          createdAt: "2026-09-11T00:00:00Z",
          updatedAt: "2026-09-11T00:01:00Z",
        },
        state: { enabled: true, mode: "focused", reason: "user requested", goal: undefined },
      },
      {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 4,
        delayMs: 1_500,
        errorMessage: "rate limited",
        errorId: 429,
      },
      {
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "still rate limited",
        recoveredErrors: [{ id: 429 }],
      },
      { type: "auto_compaction_start", reason: "future", action: "future-action" },
      { type: "auto_compaction_end", aborted: false, willRetry: false },
      {
        type: "subagent_lifecycle",
        payload: {
          id: "child-1",
          agent: "scout",
          agentSource: "builtin",
          description: "Inspect protocol",
          status: "started",
          sessionFile: "/tmp/child.jsonl",
          parentToolCallId: "tool-1",
          index: 0,
          detached: false,
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "Inspect protocol",
          progress: {
            id: "child-1",
            status: "running",
            description: "Reading schemas",
            currentTool: { name: "read" },
            recentTools: [{ name: "grep" }],
            recentOutput: [{ text: "found" }],
            resolvedModel: "openai/gpt-5.4",
          },
        },
      },
      {
        type: "message_end",
        message: {
          role: "bashExecution",
          command: "pwd",
          output: "/repo",
          exitCode: 0,
          timestamp: 1,
          images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
        },
      },
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "advisor",
          content: "",
          details: {
            notes: [{ note: "Fix the race", severity: "blocker", advisor: "reviewer" }],
          },
        },
      },
      { type: "subagent_event", payload: { id: "child-1", event: { type: "agent_start" } } },
    ];

    for (const frame of frames) {
      const received = nextEvent((listener) => session.onEvent(listener));
      child.write(frame);
      await expect(received).resolves.toEqual(frame);
    }
    const afterMalformed = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "goal_updated",
      goal: { id: "goal-oversized", status: "x".repeat(257) },
    });
    child.write({ type: "notice", level: "info", message: "after malformed current event" });
    await expect(afterMalformed).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "after malformed current event",
    });
    await session.close();
  });

  test("rejects cross-kind extension UI fields", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const received: OmpRpcEvent[] = [];
    session.onEvent((event) => received.push(event));

    for (const frame of [
      {
        type: "extension_ui_request",
        id: "bad-select",
        method: "select",
        title: "Select",
        options: ["one"],
        url: "https://example.com/?token=secret",
      },
      {
        type: "extension_ui_request",
        id: "bad-confirm",
        method: "confirm",
        title: "Confirm",
        message: "Proceed?",
        launchUrl: "javascript:alert(1)",
      },
      {
        type: "extension_ui_request",
        id: "bad-input",
        method: "input",
        title: "Input",
        url: "file:///private/token",
      },
      {
        type: "extension_ui_request",
        id: "bad-editor",
        method: "editor",
        title: "Editor",
        launchUrl: "https://example.com/?code=secret",
      },
    ]) {
      child.write(frame);
    }
    child.write({ type: "notice", level: "info", message: "after invalid UI frames" });
    await Promise.resolve();
    expect(received).toEqual([
      { type: "notice", level: "info", message: "after invalid UI frames" },
    ]);
    await session.close();
  });

  test("registers essential host tools and returns host call frames", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "set_host_tools") {
        child.write({
          type: "response",
          id: command.id,
          command: "set_host_tools",
          success: true,
          data: { toolNames: ["mcp__paseo_read"] },
        });
      }
    });
    const sessionOpening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await sessionOpening;

    await expect(
      session.setHostTools([
        {
          name: "mcp__paseo_read",
          label: "Read",
          description: "Read a caller-scoped workspace file",
          loadMode: "essential",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ]),
    ).resolves.toEqual(["mcp__paseo_read"]);
    session.sendHostToolUpdate({
      type: "host_tool_update",
      id: "host-call-1",
      partialResult: { content: [], details: { progress: 1 } },
    });
    session.sendHostToolResult({
      type: "host_tool_result",
      id: "host-call-1",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await Promise.resolve();

    expect(commands).toContainEqual({
      type: "set_host_tools",
      tools: [expect.objectContaining({ name: "mcp__paseo_read", loadMode: "essential" })],
      id: expect.any(String),
    });
    expect(commands).toContainEqual({
      type: "host_tool_update",
      id: "host-call-1",
      partialResult: { content: [], details: { progress: 1 } },
    });
    expect(commands).toContainEqual({
      type: "host_tool_result",
      id: "host-call-1",
      result: { content: [{ type: "text", text: "done" }] },
    });
    await session.close();
  });

  test("subscribes to bounded subagent lifecycle, timelines, snapshots, and replay", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      } else if (command.type === "set_subagent_subscription") {
        child.write({
          type: "response",
          id: command.id,
          command: "set_subagent_subscription",
          success: true,
          data: { level: "events" },
        });
      } else if (command.type === "get_subagents") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_subagents",
          success: true,
          data: {
            subagents: [
              {
                id: "native-child",
                index: 0,
                agent: "scout",
                status: "running",
                sessionFile: "/sessions/root/native-child.jsonl",
                lastUpdate: 1,
                parentToolCallId: "task-call",
              },
            ],
          },
        });
      } else if (command.type === "get_subagent_messages") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_subagent_messages",
          success: true,
          data: {
            sessionFile: "/sessions/root/native-child.jsonl",
            fromByte: 0,
            nextByte: 10,
            reset: false,
            entries: [],
            messages: [
              {
                role: "toolResult",
                toolCallId: "nested-task",
                toolName: "task",
                content: [],
                details: { results: [{ id: "native-grandchild" }] },
              },
            ],
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await session.setSubagentSubscription("events");
    await expect(session.getSubagents()).resolves.toEqual([
      expect.objectContaining({ id: "native-child", status: "running" }),
    ]);
    await expect(session.getSubagentMessages({ subagentId: "native-child" })).resolves.toEqual(
      expect.objectContaining({
        sessionFile: "/sessions/root/native-child.jsonl",
        messages: [
          expect.objectContaining({ details: { results: [{ id: "native-grandchild" }] } }),
        ],
      }),
    );
    const frames: OmpRpcEvent[] = [
      {
        type: "subagent_lifecycle",
        payload: {
          id: "native-child",
          agent: "scout",
          status: "started",
          index: 0,
          sessionFile: "/sessions/root/native-child.jsonl",
          parentToolCallId: "task-call",
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "inspect",
          progress: { id: "native-child", status: "running", recentOutput: ["working"] },
          sessionFile: "/sessions/root/native-child.jsonl",
          parentToolCallId: "task-call",
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "native-child",
          event: {
            type: "message_end",
            message: { role: "assistant", responseId: "child-answer", content: "done" },
          },
        },
      },
    ];
    for (const frame of frames) {
      const received = nextEvent((listener) => session.onEvent(listener));
      child.write(frame);
      await expect(received).resolves.toEqual(frame);
    }
    await session.close();
  });

  test("passes an exact native session handle to OMP resume", async () => {
    const child = new FakeRpcChild();
    const launches: OmpSpawnRequest[] = [];
    const modelSelector = `${"p".repeat(256)}/${"m".repeat(256)}`;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child, launches).startSession({
      cwd: "/repo",
      mode: "full",
      resumeSessionId: "native-session-42",
      model: modelSelector,
    });
    child.write(READY_FRAME);
    const session = await opening;

    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--resume", "native-session-42"]));
    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--model", modelSelector]));
    await session.close();
  });

  test("does not release queued-write capacity when requests time out", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(true),
      environment: TEST_RUNTIME_ENV,
      requestTimeoutMs: 0,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const writeCallbacks: Array<() => void> = [];
    Object.defineProperty(child.stdin, "write", {
      configurable: true,
      value: (_chunk: unknown, callback?: () => void) => {
        if (callback) writeCallbacks.push(callback);
        return false;
      },
    });
    const largePrompt = "x".repeat(900_000);

    for (let index = 0; index < 9; index += 1) {
      await expect(session.prompt(largePrompt)).rejects.toThrow("request timed out");
    }
    await expect(session.prompt(largePrompt)).rejects.toThrow("too many pending requests");
    expect(writeCallbacks).toHaveLength(9);
    for (const callback of writeCallbacks.splice(0)) callback();
    await expect(session.prompt(largePrompt)).rejects.toThrow("request timed out");

    child.close();
    await session.close();
  });

  test("accepts image stream events and blocked todos without breaking later frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const imageEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    await expect(imageEvent).resolves.toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });

    const textEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "after image" },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });
    await expect(textEvent).resolves.toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "after image" },
      message: {
        role: "assistant",
        responseId: "response-image",
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "after image" },
        ],
      },
    });

    const todoEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "todo_reminder",
      todos: [{ id: "blocked-1", content: "Waiting", status: "blocked" }],
    });
    await expect(todoEvent).resolves.toEqual({
      type: "todo_reminder",
      todos: [{ id: "blocked-1", content: "Waiting", status: "blocked" }],
    });

    const commandsEvent = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await expect(commandsEvent).resolves.toEqual({
      type: "available_commands_update",
      commands: [{ name: "fresh-command", aliases: ["fresh"] }],
    });
    await session.close();
  });

  test("rejects incomplete ready metadata instead of guessing v1", async () => {
    const child = new FakeRpcChild();
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ type: "ready", protocolVersion: 1 });

    await expect(opening).rejects.toThrow("incomplete protocol metadata");
  });

  test("rejects a frame limit too small for a maximum-ID terminal host result", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => commands.push(command));
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ ...READY_FRAME, maxFrameBytes: 400 });

    await expect(opening).rejects.toThrow("cannot carry terminal host tool results");
    expect(commands).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  test("rejects an invalid v2 negotiation result", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 1 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);

    await expect(opening).rejects.toThrow();
  });

  test("rejects a metadata-free legacy ready frame before opening a session", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => commands.push(command));
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ type: "ready" });

    await expect(opening).rejects.toThrow("requires OMP RPC protocol v2");
    expect(commands).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  test("accepts nullable usage and sparse compaction payloads", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      const response = {
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
      };
      if (command.type === "negotiate_protocol") {
        child.write({ ...response, data: { protocolVersion: 2 } });
        return;
      }
      if (command.type === "get_state") {
        child.write({
          ...response,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "nullable-usage",
            contextUsage: { tokens: null, contextWindow: null, percent: null },
          },
        });
      } else if (command.type === "get_session_stats") {
        child.write({
          ...response,
          data: {
            tokens: { input: null, output: null, cacheRead: null },
            cost: null,
            contextUsage: null,
          },
        });
      } else if (command.type === "compact") {
        child.write({ ...response, data: {} });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const compactionEvent = nextEvent((listener) => session.onEvent(listener));

    expect(await session.getState()).toEqual(
      expect.objectContaining({
        contextUsage: { tokens: null, contextWindow: null, percent: null },
      }),
    );
    expect(await session.getSessionStats()).toEqual({
      tokens: { input: null, output: null, cacheRead: null },
      cost: null,
      contextUsage: null,
    });
    expect(await session.compact()).toEqual({});
    child.write({ type: "auto_compaction_end", aborted: false, willRetry: false });
    await expect(compactionEvent).resolves.toEqual(
      expect.objectContaining({ type: "auto_compaction_end" }),
    );
    await session.close();
  });

  test("rejects fractional and unbounded usage numerics", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      const response = {
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
      };
      if (command.type === "negotiate_protocol") {
        child.write({ ...response, data: { protocolVersion: 2 } });
        return;
      }
      if (command.type === "get_state") {
        child.write({
          ...response,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "invalid-usage",
            contextUsage: { tokens: 1.5, contextWindow: 200_000, percent: 0.1 },
          },
        });
      } else if (command.type === "get_session_stats") {
        child.write({
          ...response,
          data: {
            tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 0, cacheRead: 0 },
            cost: 0,
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.getState()).rejects.toThrow();
    await expect(session.getSessionStats()).rejects.toThrow();
    await session.close();
  });

  test("reassembles bounded v2 chunk frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_state") return;
      const payload = Buffer.from(
        JSON.stringify({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: {
            model: null,
            isStreaming: false,
            isCompacting: false,
            sessionId: "chunked",
          },
        }),
      );
      const split = Math.ceil(payload.byteLength / 2);
      const parts = [payload.subarray(0, split), payload.subarray(split)];
      for (const [index, part] of parts.entries()) {
        child.write({
          type: "rpc_chunk",
          chunkId: "chunk-1",
          index,
          count: parts.length,
          byteLength: payload.byteLength,
          data: part.toString("base64"),
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    expect(await session.getState()).toEqual(expect.objectContaining({ sessionId: "chunked" }));
    await session.close();
  });
  test("accepts tool-intensive assistant history beyond 64 content parts", async () => {
    const child = new FakeRpcChild();
    const content = Array.from({ length: 65 }, (_, index) => ({
      type: "text",
      text: `part-${index}`,
    }));
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type === "get_messages") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { messages: [{ role: "assistant", content }] },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    const [assistant] = await session.getMessages();
    expect(assistant?.role).toBe("assistant");
    expect(assistant && "content" in assistant ? assistant.content : undefined).toHaveLength(65);
    await session.close();
  });

  test("reads byte-heavy history through negotiated v2 chunking", async () => {
    const child = new FakeRpcChild();
    const text = "é".repeat(350_000);
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type === "get_messages") {
        writeChunked(
          child,
          {
            type: "response",
            id: command.id,
            success: true,
            data: {
              messages: [
                { role: "user", id: "history-user", content: text },
                {
                  role: "toolResult",
                  toolCallId: "call-1",
                  toolName: "read",
                  content: { content: [{ type: "text", text: "result" }], details: { count: 1 } },
                },
                { role: "bashExecution", command: "pwd", exitCode: 0, cancelled: false },
                { role: "assistant", id: "history-assistant", content: text },
                { role: "user", id: "history-user-2", content: text },
              ],
            },
          },
          "history-chunks",
        );
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    expect(session.canReplayHistory).toBe(true);
    const messages = await session.getMessages();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "bashExecution",
      "assistant",
      "user",
    ]);
    expect(messages[1]).toEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "call-1", toolName: "read" }),
    );
    expect(messages[2]).toEqual(expect.objectContaining({ role: "bashExecution", command: "pwd" }));
    expect(messages[2]).not.toHaveProperty("content");
    const assistant = messages[3];
    expect(assistant && "content" in assistant ? assistant.content : undefined).toHaveLength(
      350_000,
    );
    await session.close();
  });

  test("rejects an explicit v1-only ready frame before negotiation", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => commands.push(command));
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write({ ...READY_FRAME, supportedProtocolVersions: [1] });

    await expect(opening).rejects.toThrow("requires OMP RPC protocol v2");
    expect(commands).toEqual([]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  test("rejects invalid branch responses immediately and accepts the next valid response", async () => {
    const child = new FakeRpcChild();
    let branchRequestCount = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "get_branch_messages") return;
      branchRequestCount += 1;
      if (branchRequestCount === 1) {
        child.write({ type: "response", id: "unrelated-response", success: "invalid" });
        child.write({ type: "response", id: command.id, success: "invalid" });
        return;
      }
      const messageCount = branchRequestCount === 2 ? 1_025 : 1_024;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: {
          messages: Array.from({ length: messageCount }, (_, index) => ({
            entryId: `${messageCount === 1_024 ? "entry" : "bad"}-${index}`,
            text: "x",
          })),
        },
      });
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    let malformedOutcome: string | undefined;
    void session.getBranchMessages().then(
      () => {
        malformedOutcome = "resolved";
      },
      (error) => {
        malformedOutcome = error instanceof Error ? error.message : String(error);
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(malformedOutcome).toBe("OMP RPC response is invalid");
    let oversizedOutcome: string | undefined;
    void session.getBranchMessages().then(
      () => {
        oversizedOutcome = "resolved";
      },
      (error) => {
        oversizedOutcome = error instanceof Error ? error.message : String(error);
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(oversizedOutcome).toBe("OMP RPC response exceeded command limits");
    const messages = await session.getBranchMessages();
    expect(messages).toHaveLength(1_024);
    expect(messages.at(-1)).toEqual({ entryId: "entry-1023", text: "x" });
    await session.close();
  });
  test("sends bounded native branch identifiers and validates branch results", async () => {
    const child = new FakeRpcChild();
    let branchCount = 0;
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
        return;
      }
      if (command.type !== "branch") return;
      branchCount += 1;
      if (branchCount === 1) {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { text: "selected prompt", cancelled: false },
        });
      } else {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { text: 42, cancelled: false },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.branch("entry-1")).resolves.toEqual({
      text: "selected prompt",
      cancelled: false,
    });
    await expect(session.branch("entry-2")).rejects.toThrow("OMP RPC response is invalid");
    await expect(session.branch("x".repeat(257))).rejects.toThrow(
      "Invalid OMP branch entry identifier",
    );
    expect(branchCount).toBe(2);
    await session.close();
  });

  test("enforces chunked UTF-8 assistant and image boundaries without stale corruption", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const terminal = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "agent_end") terminal.resolve();
    });

    const nearText = "é".repeat((1024 * 1024) / 2);
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "text", content: nearText },
      },
      "near-text",
    );
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "oversized-text", content: `${nearText}é` },
      },
      "oversized-text",
    );
    const imageData = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.alloc(6 * 1024 * 1024 - 8),
    ]).toString("base64");
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "image", content: [] },
        assistantMessageEvent: {
          type: "image_end",
          contentIndex: 0,
          content: { type: "image", data: imageData, mimeType: "image/png" },
        },
      },
      "near-image",
    );
    writeChunked(
      child,
      {
        type: "message_update",
        message: { role: "assistant", responseId: "oversized-image", content: [] },
        assistantMessageEvent: {
          type: "image_end",
          contentIndex: 0,
          content: { type: "image", data: `${imageData}AAAA`, mimeType: "image/png" },
        },
      },
      "oversized-image",
    );
    child.write({
      type: "agent_end",
      messages: Array.from({ length: 513 }, () => ({ role: "assistant", content: "ok" })),
      messageCount: 513,
      isTerminal: true,
    });
    await terminal.promise;

    expect(events).toHaveLength(3);
    const receivedText = events[0];
    expect(
      receivedText?.type === "message_update" && receivedText.message.role === "assistant"
        ? receivedText.message.content
        : null,
    ).toBe(nearText);
    const receivedImage = events[1];
    expect(
      receivedImage?.type === "message_update" &&
        receivedImage.assistantMessageEvent?.content &&
        typeof receivedImage.assistantMessageEvent.content === "object" &&
        "data" in receivedImage.assistantMessageEvent.content
        ? receivedImage.assistantMessageEvent.content.data
        : null,
    ).toBe(imageData);
    expect(events[2]).toEqual({
      type: "agent_end",
      messageCount: 513,
      isTerminal: true,
    });
    expect(
      events.some(
        (event) =>
          event.type === "message_update" &&
          (event.message.responseId === "oversized-text" ||
            event.message.responseId === "oversized-image"),
      ),
    ).toBe(false);
    await session.close();
  });

  test("isolates malformed recognized and physical frames from later valid events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));

    child.write({ type: "notice", level: 42, message: "invalid notice" });
    child.writeRaw(`${"x".repeat(1_048_577)}\n`);
    child.write({
      type: "rpc_chunk",
      chunkId: "bad-order",
      index: 1,
      count: 2,
      byteLength: 4,
      data: "e30=",
    });
    for (let index = 0; index < 100; index += 1) {
      child.write({ type: `unknown_${index}`, detail: "API_KEY=must-not-surface" });
    }
    child.write({ type: "notice", level: "info", message: "still healthy" });

    await expect(recovered).resolves.toEqual({
      type: "notice",
      level: "info",
      message: "still healthy",
    });
    await session.close();
  });
  for (const chunking of ["same stdout chunk", "separate stdout chunks"] as const) {
    test(`isolates a complete oversized physical line from a valid frame in ${chunking}`, async () => {
      const child = new FakeRpcChild();
      observeCommands(child, (command) => {
        if (command.type === "negotiate_protocol") {
          child.write({
            type: "response",
            id: command.id,
            success: true,
            data: { protocolVersion: 2 },
          });
        }
      });
      const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
      child.write(READY_FRAME);
      const session = await opening;
      const observed: OmpRpcEvent[] = [];
      const unsubscribe = session.onEvent((event) => observed.push(event));
      const oversized = "x".repeat(1_048_577);
      const valid = JSON.stringify({ type: "notice", level: "info", message: "still healthy" });

      if (chunking === "same stdout chunk") child.writeRaw(`${oversized}\n${valid}\n`);
      else {
        child.writeRaw(`${oversized}\n`);
        child.writeRaw(`${valid}\n`);
      }

      expect(observed).toContainEqual({
        type: "notice",
        level: "info",
        message: "still healthy",
      });
      unsubscribe();
      await session.close();
    });
  }

  test("fails the runtime on a complete oversized physical frame", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));
    child.writeRaw(`${"x".repeat(12 * 1024 * 1024 + 1)}\n`);
    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP RPC frame exceeds the semantic byte limit",
    });
    await session.close();
  });

  test("preserves validated events internally while keeping stderr out of failures", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({
      cwd: "/repo",
      mode: "full",
      env: { OPENAI_API_KEY: "credential-value-1234" },
    });
    child.write(READY_FRAME);
    const session = await opening;
    const observed: OmpRpcEvent[] = [];
    const unsubscribe = session.onEvent((event) => observed.push(event));
    const notice = nextEvent((listener) => session.onEvent(listener));
    child.write({
      type: "notice",
      level: "error",
      message: "OPENAI_API_KEY=credential-value-1234 at /home/private/config",
    });
    expect(await notice).toEqual({
      type: "notice",
      level: "error",
      message: "OPENAI_API_KEY=credential-value-1234 at /home/private/config",
    });

    const exit = nextEvent((listener) => session.onEvent(listener));
    child.stderr.write("OPENAI_API_KEY=credential-value-1234 /home/private/config raw stderr");
    child.close(7);
    expect(await exit).toEqual({ type: "process_exit", error: "OMP RPC process exited (code 7)" });
    expect(observed.filter((event) => event.type === "process_exit")).toHaveLength(1);
    unsubscribe();
    await session.close();
  });

  test("preserves frame-valid tool payloads and isolates malformed events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const noticeDelivered = Promise.withResolvers<void>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "notice") noticeDelivered.resolve();
    });

    child.write({
      type: "todo_reminder",
      todos: Array.from({ length: 257 }, (_, index) => ({
        id: `todo-${index}`,
        content: "bounded",
        status: "pending",
      })),
    });
    child.write({
      type: "tool_execution_start",
      toolCallId: "large-tool",
      toolName: "read",
      args: Array.from({ length: 513 }, (_, index) => `value-${index}`),
    });
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "image", data: "%%%", mimeType: "image/png" }],
      },
      assistantMessageEvent: { type: "image_end", contentIndex: 0 },
    });
    child.write({ type: "notice", level: "warning", message: "valid after rejected frames" });
    await noticeDelivered.promise;

    expect(events).toHaveLength(2);
    const toolEvent = events[0];
    if (toolEvent?.type !== "tool_execution_start" || !Array.isArray(toolEvent.args)) {
      throw new Error("Expected preserved tool event");
    }
    expect(toolEvent.args).toHaveLength(513);
    expect(events[1]).toEqual({
      type: "notice",
      level: "warning",
      message: "valid after rejected frames",
    });
    await session.close();
  });

  test("bounds cumulative streamed text while retaining later protocol events", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const events: OmpRpcEvent[] = [];
    const recovered = Promise.withResolvers<OmpRpcEvent>();
    session.onEvent((event) => {
      events.push(event);
      if (event.type === "notice") recovered.resolve(event);
    });
    child.write({
      type: "message_start",
      message: { role: "assistant", responseId: "bounded", content: [] },
    });
    for (let index = 0; index < 5; index += 1) {
      child.write({
        type: "message_update",
        message: { role: "assistant", responseId: "bounded", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(900_000) },
      });
    }
    child.write({ type: "notice", level: "info", message: "after stream bound" });
    await recovered.promise;

    expect(events.filter((event) => event.type === "message_update")).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: "notice", level: "info", message: "after stream bound" });
    await session.close();
  });

  test("drops spoofed lifecycle and malformed permission frames", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const recovered = nextEvent((listener) => session.onEvent(listener));
    child.write({ type: "process_exit", error: "spoofed", sessionId: "other-session" });
    child.write({ type: "extension_ui_request", id: "permission", method: 42, approved: true });
    child.write({
      type: "notice",
      level: "info",
      message: "safe",
      sessionId: "other-session",
      capabilities: ["admin"],
    });

    await expect(recovered).resolves.toEqual({ type: "notice", level: "info", message: "safe" });
    await session.close();
  });

  test("builds argv-only launches with a minimal allowlisted environment", () => {
    const proxy = "https://proxy-user:proxy-pass@example.test?token=proxy-token";
    const request = buildOmpSpawnRequest(
      {
        cwd: "/repo",
        mode: "full",
        model: "provider/model; touch /tmp/not-run",
        env: {
          TEST_ENV: "explicit",
          CUSTOMER_API_KEY: "session-secret",
          OMP_NO_WEBP: "0",
        },
      },
      {
        ...TEST_RUNTIME_ENV,
        OMP_COMMAND: "/opt/omp/bin/omp",
        HOME: "/home/runner",
        HTTPS_PROXY: proxy,
        OPENAI_API_KEY: "daemon-secret",
        ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-secret",
        CLOUDFLARE_AI_GATEWAY_API_KEY: "cloudflare-secret",
        PLEXUS_API_KEY: "plexus-secret",
        UNRELATED_DAEMON_VALUE: "must-not-pass",
        NODE_OPTIONS: "--require attacker.js",
        RANDOM_TOKEN: "must-not-pass-either",
        node_options: "--require lower-case-attacker.js",
      },
    );

    expect(request.command).toBe("/opt/omp/bin/omp");
    expect(request.args).toContain("provider/model; touch /tmp/not-run");
    expect(request.env).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: "/__paseo_omp_test_no_agent_dir__",
      PI_CONFIG_DIR: ".omp-no-config",
      HOME: "/home/runner",
      HTTPS_PROXY: proxy,
      OPENAI_API_KEY: "daemon-secret",
      PLEXUS_API_KEY: "plexus-secret",
      ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-secret",
      CLOUDFLARE_AI_GATEWAY_API_KEY: "cloudflare-secret",
      OMP_NO_WEBP: "1",
      TEST_ENV: "explicit",
      CUSTOMER_API_KEY: "session-secret",
    });

    expect(request.env.UNRELATED_DAEMON_VALUE).toBeUndefined();
    expect(request.env.NODE_OPTIONS).toBeUndefined();
    expect(request.env.RANDOM_TOKEN).toBeUndefined();
    expect(request.env.node_options).toBeUndefined();
    const benignShortValues = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: { DEBUG: "1", NODE_ENV: "dev" } },
      TEST_RUNTIME_ENV,
    );
    expect(benignShortValues.env).toEqual({
      ...TEST_RUNTIME_ENV,
      DEBUG: "1",
      NODE_ENV: "dev",
      OMP_NO_WEBP: "1",
    });
    expect(
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { API_TOKEN: "x" } },
        TEST_RUNTIME_ENV,
      ).env.API_TOKEN,
    ).toBe("x");
    const fullSessionEnvironment = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`SESSION_VALUE_${index}`, "x"]),
    );
    const fullEnvironmentRequest = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: fullSessionEnvironment },
      TEST_RUNTIME_ENV,
    );
    expect(fullEnvironmentRequest.env.OMP_NO_WEBP).toBe("1");
    expect(fullEnvironmentRequest.env.SESSION_VALUE_255).toBe("x");
    for (const proxy of [
      "https://abc:long-password@example.test",
      "https://example.test?token=xyz",
    ]) {
      expect(
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", env: { HTTPS_PROXY: proxy } },
          TEST_RUNTIME_ENV,
        ).env.HTTPS_PROXY,
      ).toBe(proxy);
    }
    const benignShortProxy = "https://example.test/abc?arbitrary=xyz#abc";
    const benignProxyRequest = buildOmpSpawnRequest(
      { cwd: "/repo", mode: "full", env: { HTTPS_PROXY: benignShortProxy } },
      TEST_RUNTIME_ENV,
    );
    expect(benignProxyRequest.env.HTTPS_PROXY).toBe(benignShortProxy);
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { LD_PRELOAD: "/tmp/evil.so" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("forbidden variable");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", env: { node_options: "--require attacker.js" } },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("forbidden variable");
    for (const name of [
      "PI_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
      "PI_CONFIG_FILES",
      "PI_SHELL_PREFIX",
      "PI_BASH_NO_CI",
      "PI_BASH_NO_LOGIN",
      "PI_SUBPROCESS_CMD",
      "PI_PACKAGE_DIR",
      "PI_PROFILE",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_PROJECT_DIR",
      "PI_WORKTREE_DIR",
      "PI_SESSION_ID",
      "PI_GIT_COMMON_DIR",
      "CLAUDE_BASH_NO_CI",
      "CLAUDE_BASH_NO_LOGIN",
      "CLAUDE_CODE_SHELL_PREFIX",
      "OMP_PROFILE",
      "OMP_AUTORESEARCH_DB_DIR",
      "OMP_GITHUB_CACHE_DB",
      "OMP_WORKTREE_DIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "XDG_STATE_HOME",
      "PWD",
      "PATH",
      "HOME",
      "SHELL",
      "VISUAL",
      "EDITOR",
      "LD_PRELOAD",
      "NODE_OPTIONS",
    ].flatMap((name) => [name, name.toLowerCase()])) {
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", env: { [name]: "/tmp/redirect" } },
          TEST_RUNTIME_ENV,
        ),
      ).toThrow("forbidden variable");
    }
    expect(
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full" },
        { ...TEST_RUNTIME_ENV, OPENAI_API_KEY: "x" },
      ).env.OPENAI_API_KEY,
    ).toBe("x");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "x".repeat(64 * 1024 + 1) },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("system prompt");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", systemPrompt: "é".repeat(40_000) },
        TEST_RUNTIME_ENV,
      ),
    ).toThrow("system prompt");
    expect(() => buildOmpSpawnRequest({ cwd: "relative", mode: "full" }, TEST_RUNTIME_ENV)).toThrow(
      "absolute",
    );
  });

  test("inherits only selected daemon values and skips shadowed daemon values", () => {
    const request = buildOmpSpawnRequest(
      {
        cwd: "/repo",
        mode: "full",
        inheritEnv: ["CUSTOM_SECRET", "CUSTOM_URL", "OVERRIDDEN"],
        env: { OVERRIDDEN: "explicit-value" },
      },
      {
        ...TEST_RUNTIME_ENV,
        CUSTOM_SECRET: "selected-secret",
        CUSTOM_URL: "https://user:pass@example.test",
        OVERRIDDEN: "x",
        UNSELECTED_SECRET: "must-not-pass",
      },
    );

    expect(request.env.CUSTOM_SECRET).toBe("selected-secret");
    expect(request.env.CUSTOM_URL).toBe("https://user:pass@example.test");
    expect(request.env.OVERRIDDEN).toBe("explicit-value");
    expect(request.env.UNSELECTED_SECRET).toBeUndefined();
    expect(request.inheritedRedactionValues).toEqual([
      "selected-secret",
      "https://user:pass@example.test",
    ]);

    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", inheritEnv: ["SHORT_VALUE"] },
        { ...TEST_RUNTIME_ENV, SHORT_VALUE: "xyz" },
      ),
    ).toThrow("too short for safe redaction");
    expect(() =>
      buildOmpSpawnRequest(
        { cwd: "/repo", mode: "full", inheritEnv: ["OVERSIZED_VALUE"] },
        { ...TEST_RUNTIME_ENV, OVERSIZED_VALUE: "x".repeat(64 * 1024 + 1) },
      ),
    ).toThrow("invalid value");
    for (const name of ["NODE_OPTIONS", "node_options", "PaTh"]) {
      expect(() =>
        buildOmpSpawnRequest(
          { cwd: "/repo", mode: "full", inheritEnv: [name] },
          { ...TEST_RUNTIME_ENV, [name]: "blocked-value" },
        ),
      ).toThrow("forbidden variable");
    }
  });

  test("terminates a surviving POSIX process group after its leader exited", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    let descendantsAlive = true;
    const stopped = await terminatePosixProcessTree(
      42,
      0,
      (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") descendantsAlive = false;
        if (signal === 0 && !descendantsAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      },
      () => Promise.resolve(),
    );

    expect(stopped).toBe(true);
    expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]);
  });

  test("starts descendant cleanup once when the leader exit is observed", async () => {
    const child = new FakeRpcChild();
    const cleanup = Promise.withResolvers<boolean>();
    const cleanedPids: number[] = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree(pid) {
        cleanedPids.push(pid);
        return cleanup.promise;
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    child.close(7);
    expect(cleanedPids).toEqual([child.pid]);
    const closing = session.close();
    cleanup.resolve(true);
    await closing;
    expect(cleanedPids).toEqual([child.pid]);
  });

  test("fails pending work and starts cleanup when stdout ends before process exit", async () => {
    const child = new FakeRpcChild();
    const cleanup = Promise.withResolvers<boolean>();
    const cleanedPids: number[] = [];
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree(pid) {
        cleanedPids.push(pid);
        return cleanup.promise;
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const observed: OmpRpcEvent[] = [];
    session.onEvent((event) => observed.push(event));
    const pending = session.getState();
    const failure = nextEvent((listener) => session.onEvent(listener));

    child.stdout.end();

    await expect(pending).rejects.toThrow("output channel closed");
    await expect(failure).resolves.toEqual({
      type: "process_exit",
      error: "OMP RPC output channel closed",
    });
    expect(cleanedPids).toEqual([child.pid]);
    child.close(1);
    cleanup.resolve(true);
    await session.close();
    expect(cleanedPids).toEqual([child.pid]);
    expect(observed.filter((event) => event.type === "process_exit")).toHaveLength(1);
  });

  test("surfaces unverified process-tree cleanup", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve(false),
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.close()).rejects.toThrow("cleanup failed");
  });
  test("treats uncertain injected process-tree cleanup as unsuccessful", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => Promise.resolve("uncertain"),
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    await expect(session.close()).rejects.toThrow("cleanup failed");
  });

  test("never reports cleanup success without invoking process-tree termination", async () => {
    const child = new FakeRpcChild();
    child.stdin.removeAllListeners("finish");
    let cleanupCalls = 0;
    observeCommands(child, (command) => {
      if (command.type !== "negotiate_protocol") return;
      child.write({
        type: "response",
        id: command.id,
        success: true,
        data: { protocolVersion: 2 },
      });
    });
    const runtime = new OmpRpcRuntime({
      spawnProcess: () => child.asChildProcess(),
      terminateProcessTree: () => {
        cleanupCalls += 1;
        return Promise.resolve(true);
      },
      environment: TEST_RUNTIME_ENV,
    });
    const opening = runtime.startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;

    await expect(session.close()).rejects.toThrow("did not close after tree cleanup");
    expect(cleanupCalls).toBe(1);
  });

  if (process.platform !== "win32") {
    test("leader exit fails a prompt and permits recovery while a descendant holds stdio", async () => {
      const script = `
        const { spawn } = require("node:child_process");
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: false,
          stdio: ["ignore", "inherit", "inherit"],
        });
        descendant.unref();
        process.stdout.write(JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledFrameBytes: 67108864,
        }) + "\\n");
        let input = "";
        process.stdin.on("data", chunk => {
          input += String(chunk);
          while (true) {
            const newline = input.indexOf("\\n");
            if (newline < 0) return;
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            if (!line) continue;
            const command = JSON.parse(line);
            if (command.type === "negotiate_protocol") {
              process.stdout.write(JSON.stringify({
                type: "response",
                id: command.id,
                command: "negotiate_protocol",
                success: true,
                data: { protocolVersion: 2 },
              }) + "\\n");
              continue;
            }
            if (command.type === "prompt") process.exit(7);
            if (command.type !== "get_state") continue;
            process.stdout.write(JSON.stringify({ type: "notice", level: "info", message: String(descendant.pid) }) + "\\n");
            process.stdout.write(JSON.stringify({
              type: "response",
              id: command.id,
              success: true,
              data: { model: null, isStreaming: false, isCompacting: false, sessionId: "tree" },
            }) + "\\n");
          }
        });
        process.stdin.on("end", () => process.exit(0));
      `;
      let leader: ChildProcessWithoutNullStreams | null = null;
      const runtime = new OmpRpcRuntime({
        spawnProcess(request) {
          leader = spawn(process.execPath, ["-e", script], {
            cwd: request.cwd,
            env: request.env,
            detached: request.detached,
            stdio: ["pipe", "pipe", "pipe"],
          });
          return leader;
        },
        environment: TEST_RUNTIME_ENV,
      });
      const procfsAvailable = (() => {
        try {
          readFileSync("/proc/self/stat", "utf8");
          return true;
        } catch {
          return false;
        }
      })();
      const descendantIsExecuting = (pid: number) => {
        try {
          if (procfsAvailable) {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const stateOffset = stat.lastIndexOf(")") + 2;
            return stat[stateOffset] !== "Z";
          }
          process.kill(pid, 0);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ESRCH") return false;
          throw error;
        }
      };
      const waitUntilStopped = async (pid: number) => {
        const deadline = Date.now() + 2_000;
        while (descendantIsExecuting(pid) && Date.now() < deadline) await sleep(10);
        return !descendantIsExecuting(pid);
      };
      const descendantPids: number[] = [];
      try {
        const session = await runtime.startSession({ cwd: process.cwd(), mode: "full" });
        const descendantPidEvent = nextEvent((listener) => session.onEvent(listener));
        await session.getState();
        const notice = await descendantPidEvent;
        if (notice.type !== "notice") throw new Error("Expected descendant PID notice");
        descendantPids.push(Number(notice.message));
        if (!leader) throw new Error("Expected OMP leader process");
        const leaderExit = once(leader, "exit");
        const promptOutcome = session.prompt("work").then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        );
        expect(
          await Promise.race([leaderExit.then(() => true), sleep(2_000).then(() => false)]),
        ).toBe(true);
        expect(await Promise.race([promptOutcome, sleep(2_000).then(() => "timed out")])).toContain(
          "exited",
        );
        await session.close();
        expect(await waitUntilStopped(descendantPids[0] as number)).toBe(true);

        const recovered = await runtime.startSession({
          cwd: process.cwd(),
          mode: "full",
          resumeSessionId: "tree-session",
        });
        const recoveredPidEvent = nextEvent((listener) => recovered.onEvent(listener));
        await recovered.getState();
        const recoveredNotice = await recoveredPidEvent;
        if (recoveredNotice.type !== "notice") throw new Error("Expected recovered descendant PID");
        descendantPids.push(Number(recoveredNotice.message));
        await recovered.close();
        expect(await waitUntilStopped(descendantPids[1] as number)).toBe(true);
      } finally {
        for (const pid of descendantPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    });
  }

  test("fails the session once when child stdin closes with EPIPE", async () => {
    const child = new FakeRpcChild();
    observeCommands(child, (command) => {
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const failure = nextEvent((listener) => session.onEvent(listener));

    child.stdin.destroy(new Error("EPIPE"));

    const event = await failure;
    expect(event.type).toBe("process_exit");
    await expect(session.steer("after-close")).rejects.toThrow();
    await session.close();
  });

  test("writes extension UI responses without waiting for an RPC response", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "get_available_commands") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_available_commands",
          success: true,
          data: {
            commands: [{ name: "help", description: "Help", input: null, source: "builtin" }],
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const received: OmpRpcEvent[] = [];
    session.onEvent((event) => received.push(event));
    child.write({
      type: "extension_ui_request",
      id: "ui-select",
      method: "select",
      title: "Target",
      options: ["Preview", "Production"],
      optionDetails: [{ description: "Safe" }, { description: "Live" }],
    });
    child.write({
      type: "auto_compaction_start",
      reason: "threshold",
      action: "context-full",
    });
    await Promise.resolve();
    expect(received).toEqual([
      {
        type: "extension_ui_request",
        id: "ui-select",
        method: "select",
        title: "Target",
        options: ["Preview", "Production"],
        optionDetails: [{ description: "Safe" }, { description: "Live" }],
      },
      {
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      },
    ]);
    child.write({ type: "compaction_start" });
    child.write({
      type: "compaction_end",
      aborted: false,
      willRetry: false,
      skipped: true,
    });
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "bad-image",
        content: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
      },
      assistantMessageEvent: {
        type: "metadata",
        contentIndex: 0,
        content: { type: "image", data: "not-base64", mimeType: "image/png" },
      },
    });
    const encodedSecret = Buffer.from("arbitrary secret bytes").toString("base64");
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "secret-image",
        content: [{ type: "image", data: encodedSecret, mimeType: "image/png" }],
      },
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: encodedSecret, mimeType: "image/png" },
      },
    });
    await Promise.resolve();
    expect(received).toContainEqual({ type: "compaction_start" });
    expect(received).toContainEqual({
      type: "compaction_end",
      aborted: false,
      willRetry: false,
      skipped: true,
    });
    expect(received.some((event) => event.type === "message_update")).toBe(false);
    await expect(session.getAvailableCommands()).resolves.toEqual([
      { name: "help", description: "Help", input: null, source: "builtin" },
    ]);

    await session.respondToExtensionUi({
      type: "extension_ui_response",
      id: "ui-select",
      value: "Production",
    });
    expect(commands).toContainEqual({
      type: "extension_ui_response",
      id: "ui-select",
      value: "Production",
    });
    await session.close();
  });

  test("bounds stalled one-way writes and rejects them on close", async () => {
    const start = async (timeoutMs: number) => {
      const child = new FakeRpcChild();
      observeCommands(child, (command) => {
        if (command.type === "negotiate_protocol") {
          child.write({
            type: "response",
            id: command.id,
            command: "negotiate_protocol",
            success: true,
            data: { protocolVersion: 2 },
          });
        }
      });
      const opening = runtimeFor(child, [], timeoutMs).startSession({ cwd: "/repo", mode: "full" });
      child.write(READY_FRAME);
      const session = await opening;
      Object.defineProperty(child.stdin, "write", { value: () => true });
      return { child, session };
    };

    const timed = await start(10);
    await expect(
      timed.session.respondToExtensionUi({
        type: "extension_ui_response",
        id: "timed",
        value: "answer",
      }),
    ).rejects.toThrow("OMP RPC write timed out");
    await timed.session.close();

    const closing = await start(10_000);
    const pending = closing.session.respondToExtensionUi({
      type: "extension_ui_response",
      id: "closing",
      value: "answer",
    });
    await closing.session.close();
    await expect(pending).rejects.toThrow("OMP RPC process was closed");

    const saturated = await start(10_000);
    const pendingWrites = Array.from({ length: 256 }, (_, index) =>
      saturated.session.respondToExtensionUi({
        type: "extension_ui_response",
        id: `pending-${index}`,
        value: "answer",
      }),
    );
    const settledWrites = Promise.allSettled(pendingWrites);
    await expect(
      saturated.session.respondToExtensionUi({
        type: "extension_ui_response",
        id: "overflow",
        value: "answer",
      }),
    ).rejects.toThrow("OMP RPC has too many pending writes");
    await saturated.session.close();
    expect((await settledWrites).every((result) => result.status === "rejected")).toBe(true);
  });
});
