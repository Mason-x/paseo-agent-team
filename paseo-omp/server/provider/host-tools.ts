import { createHash } from "node:crypto";
import type {
  ProviderMcpServerConfig,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import {
  type ConnectedMcpClient,
  type ConnectedMcpTool,
  type ConnectedMcpToolPage,
  connectMcpServer,
} from "./mcp-transport";
import {
  OMP_HOST_TOOL_FRAME_LIMIT_ERROR,
  type OmpHostToolCall,
  type OmpHostToolDefinition,
  type OmpHostToolResult,
  type OmpRuntimeSession,
  parseOmpHostToolAgentResult,
} from "./omp-rpc";
import {
  boundedJsonBytes,
  OmpCleanupFailure,
  OmpPublicError,
  truncateUtf8,
  utf8Bytes,
} from "./security";

const INTERNAL_PASEO_MCP_PATH = "/mcp/agents";
const RESERVED_PASEO_NAMESPACE = "paseo";
const MAX_MCP_SERVERS = 32;
const MAX_MCP_TOOL_PAGES = 32;
const MAX_MCP_TOOLS_PER_SERVER = 256;
const MAX_HOST_TOOLS = 256;
const MAX_HOST_TOOL_NAME_BYTES = 256;
const MAX_HOST_TOOL_LABEL_BYTES = 256;
const MAX_HOST_TOOL_DESCRIPTION_BYTES = 64 * 1024;
const MAX_HOST_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_HOST_TOOL_CATALOG_BYTES = 768 * 1024;
const MAX_HOST_TOOL_RESULT_BYTES = 12 * 1024 * 1024;
const MAX_STRUCTURED_CONTENT_FALLBACK_BYTES = 1024 * 1024;
const MAX_PENDING_HOST_TOOL_CALLS = 64;
const MAX_PENDING_HOST_TOOL_BYTES = 8 * 1024 * 1024;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 20_000;
const DEFAULT_MCP_CALL_LIFETIME_MS = 5 * 60 * 1000;
const MAX_DIRECT_BROWSER_CALLS = 4;
const BROWSER_CALL_TIMEOUT_MS = 20_000;

export type OmpMcpTool = ConnectedMcpTool;
export type OmpMcpToolPage = ConnectedMcpToolPage;
export type OmpMcpConnection = ConnectedMcpClient;

export type OmpMcpConnector = (
  name: string,
  config: ProviderMcpServerConfig,
  cwd: string,
  signal: AbortSignal,
) => Promise<OmpMcpConnection>;

export interface OmpHostToolScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_CALL_SCHEDULER: OmpHostToolScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface OmpHostToolsOpenOptions {
  connectMcp?: OmpMcpConnector;
  signal?: AbortSignal;
  initializationTimeoutMs?: number;
  callTimeoutMs?: number;
  callScheduler?: OmpHostToolScheduler;
}

type ClassifiedServer = {
  name: string;
  config: ProviderMcpServerConfig;
  internal: boolean;
  canonical: boolean;
};

type ToolTarget = {
  toolName: string;
  connection: OmpMcpConnection;
};

type PendingCall = {
  controller: AbortController;
  runtime: OmpRuntimeSession;
  generation: number;
  retainedBytes: number;
  deadline: unknown | null;
};

function safeName(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized || fallback;
}
function humanizeName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[-_.]+/gu, " ")
    .replace(/\s+/gu, " ");
  return normalized ? `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}` : "Tool";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function boundedText(value: string, maxBytes: number, fallback: string): string {
  const source = value.trim() || fallback;
  if (utf8Bytes(source) <= maxBytes) return source;
  let result = "";
  let bytes = 0;
  for (const character of source) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result || fallback;
}

function normalizedPathname(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/u, "");
  return pathname || "/";
}

function remoteUrl(config: ProviderMcpServerConfig): URL | undefined {
  if (config.type !== "http" && config.type !== "sse") return;
  try {
    return new URL(config.url);
  } catch {
    return;
  }
}

function classifyServers(config: ProviderSessionConfig): ClassifiedServer[] {
  const entries = Object.entries(config.mcpServers).map(([name, serverConfig]) => ({
    name,
    config: serverConfig,
    url: remoteUrl(serverConfig),
  }));
  const endpoints = entries.filter(
    (entry) => entry.url && normalizedPathname(entry.url) === INTERNAL_PASEO_MCP_PATH,
  );
  const daemonOrigins = new Set(endpoints.map((entry) => entry.url?.origin));
  if (daemonOrigins.size > 1) {
    throw new OmpPublicError("Paseo host tool endpoint origin is ambiguous");
  }
  const daemonOrigin = endpoints[0]?.url?.origin;
  const canonical =
    endpoints.find((entry) => entry.name === RESERVED_PASEO_NAMESPACE) ?? endpoints[0];
  const classified = entries.map((entry) => ({
    name: entry.name,
    config: entry.config,
    internal: daemonOrigin !== undefined && entry.url?.origin === daemonOrigin,
    canonical: entry === canonical,
  }));
  const internal = classified.filter((entry) => entry.internal);
  if (internal.length > 0) {
    const callerAgentId = config.env.PASEO_AGENT_ID?.trim();
    const workspaceId = config.env.PASEO_WORKSPACE_ID?.trim();
    if (!callerAgentId || !workspaceId) {
      throw new OmpPublicError(
        "Paseo host tools require caller agent and workspace identity from the plugin host",
      );
    }
    for (const entry of internal) {
      const url = remoteUrl(entry.config);
      if (url?.searchParams.get("callerAgentId") !== callerAgentId) {
        throw new OmpPublicError(
          "Paseo host tool caller identity does not match the provider session",
        );
      }
    }
  }
  return classified.sort((left, right) => {
    if (left.canonical !== right.canonical) return left.canonical ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function serverNamespaces(servers: readonly ClassifiedServer[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const server of servers) {
    if (server.canonical) continue;
    const normalized = safeName(server.name, "server");
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return new Map(
    servers.map((server) => {
      if (server.canonical) return [server.name, RESERVED_PASEO_NAMESPACE];
      const normalized = safeName(server.name, "server");
      const reserved =
        normalized === RESERVED_PASEO_NAMESPACE ||
        normalized.startsWith(`${RESERVED_PASEO_NAMESPACE}_`);
      const mustHash = reserved || (counts.get(normalized) ?? 0) > 1;
      return [server.name, mustHash ? `external_${normalized}_${digest(server.name)}` : normalized];
    }),
  );
}

function exposedToolName(server: ClassifiedServer, namespace: string, toolName: string): string {
  const tool = safeName(toolName, "tool");
  if (server.canonical) return tool;
  const unprefixed = tool.startsWith(`${namespace}_`) ? tool.slice(namespace.length + 1) : tool;
  const base = `mcp__${namespace}_${unprefixed}`;
  if (utf8Bytes(base) <= MAX_HOST_TOOL_NAME_BYTES) return base;
  const suffix = digest(`${server.name}\0${toolName}`);
  return `${base.slice(0, MAX_HOST_TOOL_NAME_BYTES - suffix.length - 1)}_${suffix}`;
}

export function validateOmpHostToolConfig(config: ProviderSessionConfig): void {
  if (Object.keys(config.mcpServers).length > MAX_MCP_SERVERS) {
    throw new OmpPublicError("OMP MCP server count exceeds the supported limit");
  }
  if (config.toolPolicy !== undefined) {
    throw new OmpPublicError(
      "OMP set_host_tools cannot preserve exact MCP policy; refusing to broaden access",
    );
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () =>
    signal.reason instanceof Error ? signal.reason : new Error("Operation was aborted");
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(reason());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function discoverMcpTools(
  connection: OmpMcpConnection,
  signal: AbortSignal,
): Promise<OmpMcpTool[]> {
  const tools: OmpMcpTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_MCP_TOOL_PAGES; pageIndex += 1) {
    const page = await abortable(connection.listTools({ signal, cursor }), signal);
    if (tools.length + page.tools.length > MAX_MCP_TOOLS_PER_SERVER) {
      throw new OmpPublicError("MCP server tool count exceeds the supported limit");
    }
    tools.push(...page.tools);
    if (!page.nextCursor) return tools;
    if (cursors.has(page.nextCursor)) {
      throw new OmpPublicError("MCP server repeated a tool-list cursor");
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new OmpPublicError("MCP server tool-list pagination exceeds the supported limit");
}

function normalizeResult(result: unknown): OmpHostToolResult["result"] {
  if (
    !result ||
    typeof result !== "object" ||
    boundedJsonBytes(
      result,
      MAX_HOST_TOOL_RESULT_BYTES,
      1_024,
      MAX_HOST_TOOL_RESULT_BYTES,
      4_096,
    ) === Number.POSITIVE_INFINITY
  ) {
    throw new Error("MCP tool returned an invalid or oversized result");
  }
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const details = record.structuredContent;
    const content =
      record.content.length === 0 && details !== undefined
        ? [
            {
              type: "text",
              text: truncateUtf8(JSON.stringify(details), MAX_STRUCTURED_CONTENT_FALLBACK_BYTES),
            },
          ]
        : record.content;
    return parseOmpHostToolAgentResult({
      content,
      ...(details !== undefined ? { details } : {}),
      ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
    });
  }
  if (Object.hasOwn(record, "toolResult")) {
    return parseOmpHostToolAgentResult({
      content: [{ type: "text", text: "MCP tool completed" }],
      details: record.toolResult,
    });
  }
  throw new Error("MCP tool returned an unsupported result");
}

function errorResult(id: string, message: string): OmpHostToolResult {
  return {
    type: "host_tool_result",
    id,
    result: {
      content: [{ type: "text", text: message }],
      details: {},
      isError: true,
    },
    isError: true,
  };
}

async function settleCleanup(promises: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "OMP MCP cleanup failed");
}
function paseoBrowserFailure(error: unknown): OmpPublicError {
  const detail = error instanceof Error ? error.message : String(error);
  if (/browser_no_host/iu.test(detail)) {
    return new OmpPublicError("No Paseo desktop browser host is connected");
  }
  if (/browser_disabled/iu.test(detail)) {
    return new OmpPublicError("Paseo browser tools are disabled on this host");
  }
  return new OmpPublicError("Paseo could not open the MCP authorization browser tab");
}

export class OmpHostToolsBridge {
  private runtime: OmpRuntimeSession | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private pendingBytes = 0;
  private generation = 0;
  private closePromise: Promise<void> | null = null;
  private fatalHandler: ((error: Error) => void) | null = null;
  private activeDirectBrowserCalls = 0;

  readonly labels: ReadonlyMap<string, string>;
  private constructor(
    private readonly connections: readonly OmpMcpConnection[],
    private readonly definitions: readonly OmpHostToolDefinition[],
    private readonly targets: ReadonlyMap<string, ToolTarget>,
    private readonly callTimeoutMs: number,
    private readonly callScheduler: OmpHostToolScheduler,
  ) {
    this.labels = new Map(definitions.map(({ name, label }) => [name, label ?? name]));
  }
  static async open(
    config: ProviderSessionConfig,
    options: OmpHostToolsOpenOptions = {},
  ): Promise<OmpHostToolsBridge> {
    validateOmpHostToolConfig(config);
    const servers = classifyServers(config);
    const namespaces = serverNamespaces(servers);
    const connectMcp = options.connectMcp ?? connectMcpServer;
    const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_MCP_CALL_LIFETIME_MS;
    if (!Number.isInteger(callTimeoutMs) || callTimeoutMs <= 0 || callTimeoutMs > 60 * 60 * 1000) {
      throw new OmpPublicError("OMP MCP call lifetime is invalid");
    }
    const callScheduler = options.callScheduler ?? DEFAULT_CALL_SCHEDULER;
    const initialization = new AbortController();
    const abortFromCaller = () => initialization.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    const timeout = setTimeout(
      () => initialization.abort(new Error("OMP MCP host tool initialization timed out")),
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
    );
    const connections: OmpMcpConnection[] = [];
    const definitions: OmpHostToolDefinition[] = [];
    const targets = new Map<string, ToolTarget>();
    try {
      for (const server of servers) {
        initialization.signal.throwIfAborted();
        const connecting = connectMcp(
          server.name,
          server.config,
          config.cwd,
          initialization.signal,
        );
        let connection: OmpMcpConnection;
        try {
          connection =
            connectMcp === connectMcpServer
              ? await connecting
              : await abortable(connecting, initialization.signal);
        } catch (error) {
          if (connectMcp !== connectMcpServer && initialization.signal.aborted) {
            const cleanup = connecting.then(
              (lateConnection) => lateConnection.close(),
              () => undefined,
            );
            throw new OmpCleanupFailure(
              "OMP MCP connection initialization was interrupted",
              cleanup,
            );
          }
          throw error;
        }
        connections.push(connection);
        const tools = (await discoverMcpTools(connection, initialization.signal)).sort(
          (left, right) => left.name.localeCompare(right.name),
        );
        const namespace = namespaces.get(server.name);
        if (!namespace) throw new Error("MCP server namespace is unavailable");
        for (const tool of tools) {
          if (
            !tool.name ||
            utf8Bytes(tool.name) > MAX_HOST_TOOL_NAME_BYTES ||
            utf8Bytes(tool.description ?? "") > MAX_HOST_TOOL_DESCRIPTION_BYTES ||
            !tool.inputSchema ||
            typeof tool.inputSchema !== "object" ||
            Array.isArray(tool.inputSchema) ||
            boundedJsonBytes(tool.inputSchema, MAX_HOST_TOOL_SCHEMA_BYTES) ===
              Number.POSITIVE_INFINITY
          ) {
            throw new Error("MCP server exposed an invalid host tool definition");
          }
          if (definitions.length >= MAX_HOST_TOOLS) {
            throw new Error("MCP servers exposed too many host tools");
          }
          let name = exposedToolName(server, namespace, tool.name);
          if (targets.has(name)) {
            const suffix = digest(`${server.name}\0${tool.name}`);
            name = `${name.slice(0, MAX_HOST_TOOL_NAME_BYTES - suffix.length - 1)}_${suffix}`;
          }
          if (targets.has(name)) throw new Error("MCP host tool names collide");
          const normalizedServerName = safeName(server.name, "server");
          const normalizedToolName = safeName(tool.name, "tool");
          const friendlyToolName = normalizedToolName.startsWith(`${normalizedServerName}_`)
            ? normalizedToolName.slice(normalizedServerName.length + 1)
            : tool.name;
          const fallbackLabel = `${humanizeName(server.name)}: ${humanizeName(friendlyToolName)}`;
          definitions.push({
            name,
            label: boundedText(tool.title ?? fallbackLabel, MAX_HOST_TOOL_LABEL_BYTES, name),
            description: boundedText(
              tool.description ?? `MCP tool from ${server.name}`,
              MAX_HOST_TOOL_DESCRIPTION_BYTES,
              "MCP tool",
            ),
            loadMode:
              server.internal || server.config.alwaysLoad === true ? "essential" : "discoverable",
            parameters: structuredClone(tool.inputSchema),
          });
          targets.set(name, { toolName: tool.name, connection });
        }
      }
      if (
        boundedJsonBytes(definitions, MAX_HOST_TOOL_CATALOG_BYTES, MAX_HOST_TOOLS, 64 * 1024) ===
        Number.POSITIVE_INFINITY
      ) {
        throw new OmpPublicError("OMP host tool catalog exceeds the RPC frame limit");
      }
      return new OmpHostToolsBridge(
        connections,
        definitions,
        targets,
        callTimeoutMs,
        callScheduler,
      );
    } catch (error) {
      const cleanupTasks = [
        ...connections.map((connection) => Promise.resolve().then(() => connection.close())),
        ...(error instanceof OmpCleanupFailure ? [error.cleanup] : []),
      ];
      const cleanup = settleCleanup(cleanupTasks);
      if (initialization.signal.aborted || error instanceof OmpCleanupFailure) {
        throw new OmpCleanupFailure("OMP MCP host tool initialization cleanup pending", cleanup);
      }
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure("OMP MCP host tool cleanup failed", cleanup);
      }
      if (error instanceof OmpPublicError) throw error;
      throw new OmpPublicError("OMP could not initialize configured MCP host tools");
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async bind(runtime: OmpRuntimeSession): Promise<void> {
    if (this.closePromise) throw new Error("OMP host tool bridge is closed");
    this.detach();
    this.runtime = runtime;
    try {
      const accepted = await runtime.setHostTools([...this.definitions]);
      const expected = this.definitions.map(({ name }) => name);
      const uniqueAccepted = new Set(accepted);
      if (
        accepted.length !== expected.length ||
        uniqueAccepted.size !== accepted.length ||
        expected.some((name) => !uniqueAccepted.has(name))
      ) {
        throw new OmpPublicError("OMP rejected the configured host tool catalog");
      }
      if (this.runtime !== runtime) {
        throw new Error("OMP runtime detached during host tool binding");
      }
    } catch (error) {
      if (this.runtime === runtime) this.detach();
      throw error;
    }
  }
  isBoundTo(runtime: OmpRuntimeSession): boolean {
    return this.runtime === runtime && this.closePromise === null;
  }

  onFatal(handler: (error: Error) => void): void {
    this.fatalHandler = handler;
  }
  async openPaseoBrowser(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new OmpPublicError("MCP authorization URL is invalid");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new OmpPublicError("MCP authorization URL is not safe to open");
    }
    if (!this.runtime || this.closePromise) {
      throw new OmpPublicError("The OMP session is not ready for browser authorization");
    }
    const target = this.targets.get("browser_new_tab");
    if (!target) {
      throw new OmpPublicError("Paseo browser tools are unavailable in this OMP session");
    }
    if (this.activeDirectBrowserCalls >= MAX_DIRECT_BROWSER_CALLS) {
      throw new OmpPublicError("Too many Paseo browser requests are already running");
    }

    this.activeDirectBrowserCalls += 1;
    const controller = new AbortController();
    const deadline = this.callScheduler.set(
      () => controller.abort(new Error("Paseo browser request timed out")),
      BROWSER_CALL_TIMEOUT_MS,
    );
    try {
      const result = normalizeResult(
        await target.connection.callTool(
          target.toolName,
          { i: "Opening MCP authorization", url },
          {
            signal: controller.signal,
            maxTotalTimeoutMs: BROWSER_CALL_TIMEOUT_MS,
            onProgress() {},
          },
        ),
      );
      if (result.isError) {
        const detail = result.content
          .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
          .join("\n");
        throw paseoBrowserFailure(new Error(detail));
      }
    } catch (error) {
      if (error instanceof OmpPublicError) throw error;
      throw paseoBrowserFailure(error);
    } finally {
      this.callScheduler.clear(deadline);
      this.activeDirectBrowserCalls -= 1;
    }
  }

  handle(
    event: OmpHostToolCall | { type: "host_tool_cancel"; id: string; targetId: string },
  ): boolean {
    if (event.type === "host_tool_cancel") {
      const pending = this.pending.get(event.targetId);
      if (pending) {
        this.releasePending(event.targetId, pending);
        pending.controller.abort(new Error("OMP host tool call cancelled"));
      }
      // OMP removes and rejects its pending host call before emitting host_tool_cancel. Sending a
      // terminal result would be orphaned; aborting and releasing host state is the full handshake.
      return true;
    }
    const runtime = this.runtime;
    if (!runtime) return true;
    const target = this.targets.get(event.toolName);
    if (!target) {
      this.sendTerminal(runtime, errorResult(event.id, "Unknown OMP host tool"));
      return true;
    }
    const retainedBytes = boundedJsonBytes(
      event.arguments,
      MAX_PENDING_HOST_TOOL_BYTES,
      1_024,
      MAX_PENDING_HOST_TOOL_BYTES,
      4_096,
    );
    if (
      this.pending.has(event.id) ||
      this.pending.size >= MAX_PENDING_HOST_TOOL_CALLS ||
      retainedBytes === Number.POSITIVE_INFINITY ||
      this.pendingBytes + retainedBytes > MAX_PENDING_HOST_TOOL_BYTES
    ) {
      this.sendTerminal(runtime, errorResult(event.id, "OMP host tool bridge is at capacity"));
      return true;
    }
    const pending: PendingCall = {
      controller: new AbortController(),
      runtime,
      generation: this.generation,
      retainedBytes,
      deadline: null,
    };
    pending.deadline = this.callScheduler.set(
      () => this.expirePending(event.id, pending),
      this.callTimeoutMs,
    );
    this.pending.set(event.id, pending);
    this.pendingBytes += retainedBytes;
    void target.connection
      .callTool(target.toolName, event.arguments, {
        signal: pending.controller.signal,
        maxTotalTimeoutMs: this.callTimeoutMs,
        onProgress: (progress) => {
          if (!this.isCurrent(event.id, pending)) return;
          if (boundedJsonBytes(progress, MAX_HOST_TOOL_RESULT_BYTES) === Number.POSITIVE_INFINITY) {
            return;
          }
          try {
            runtime.sendHostToolUpdate({
              type: "host_tool_update",
              id: event.id,
              partialResult: { content: [], details: progress },
            });
          } catch {
            // Progress is advisory. A failed update must not escape the MCP callback or settle the call.
          }
        },
      })
      .then((result) => {
        if (!this.isCurrent(event.id, pending)) return;
        let terminal: OmpHostToolResult;
        try {
          const normalized = normalizeResult(result);
          terminal = {
            type: "host_tool_result",
            id: event.id,
            result: normalized,
            ...(normalized.isError !== undefined ? { isError: normalized.isError } : {}),
          };
        } catch {
          terminal = errorResult(event.id, "MCP host tool execution failed");
        }
        this.sendTerminal(runtime, terminal, pending);
      })
      .catch(() => {
        if (!this.isCurrent(event.id, pending)) return;
        this.sendTerminal(
          runtime,
          errorResult(event.id, "MCP host tool execution failed"),
          pending,
        );
      })
      .catch(() => undefined)
      .finally(() => this.releasePending(event.id, pending));
    return true;
  }

  detach(): void {
    this.runtime = null;
    this.generation += 1;
    for (const [id, pending] of this.pending) {
      this.releasePending(id, pending);
      pending.controller.abort(new Error("OMP runtime detached"));
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeConnections();
    return this.closePromise;
  }

  private boundedTerminal(
    runtime: OmpRuntimeSession,
    result: OmpHostToolResult,
  ): OmpHostToolResult {
    const limit = runtime.maxHostToolFrameBytes ?? 1024 * 1024;
    try {
      if (Buffer.byteLength(`${JSON.stringify(result)}\n`) <= limit) return result;
    } catch {
      // Fall through to the bounded error result.
    }
    return errorResult(result.id, OMP_HOST_TOOL_FRAME_LIMIT_ERROR);
  }

  private sendTerminal(
    runtime: OmpRuntimeSession,
    result: OmpHostToolResult,
    pending?: PendingCall,
  ): void {
    const bounded = this.boundedTerminal(runtime, result);
    if (pending && !this.isCurrent(bounded.id, pending)) return;
    try {
      runtime.sendHostToolResult(bounded);
    } catch (error) {
      this.failRuntime(runtime, error);
    }
  }

  private failRuntime(runtime: OmpRuntimeSession, error: unknown): void {
    if (this.runtime !== runtime) return;
    const failure =
      error instanceof Error ? error : new Error("OMP host tool result delivery failed");
    this.detach();
    if (this.fatalHandler) this.fatalHandler(failure);
    else void runtime.close().catch(() => undefined);
  }

  private isCurrent(id: string, pending: PendingCall): boolean {
    return (
      this.pending.get(id) === pending &&
      pending.generation === this.generation &&
      pending.runtime === this.runtime &&
      !pending.controller.signal.aborted
    );
  }

  private expirePending(id: string, pending: PendingCall): void {
    if (!this.isCurrent(id, pending)) return;
    this.releasePending(id, pending);
    pending.controller.abort(new Error("OMP MCP host tool call timed out"));
    this.sendTerminal(pending.runtime, errorResult(id, "OMP MCP host tool call timed out"));
  }

  private releasePending(id: string, pending: PendingCall): void {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    this.pendingBytes -= pending.retainedBytes;
    if (pending.deadline !== null) this.callScheduler.clear(pending.deadline);
    pending.deadline = null;
  }

  private async closeConnections(): Promise<void> {
    this.detach();
    await settleCleanup(
      this.connections.map((connection) => Promise.resolve().then(() => connection.close())),
    );
  }
}

export function withOmpWorkspaceIdentity<
  T extends { agentId: string; workspaceId: string | null; env: Record<string, string> },
>(request: T): Omit<T, "env"> & { env: Record<string, string> } {
  const env: Record<string, string> = { ...request.env, PASEO_AGENT_ID: request.agentId };
  if (request.workspaceId) env.PASEO_WORKSPACE_ID = request.workspaceId;
  else delete env.PASEO_WORKSPACE_ID;
  return { ...request, env };
}
