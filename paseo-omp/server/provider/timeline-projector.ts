import { createHash, randomBytes } from "node:crypto";
import type {
  ProviderEvent,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { isOmpImageMimeType, isValidImagePayload, type OmpImageMimeType } from "./image";
import type { OmpMessage, OmpRpcEvent } from "./omp-rpc";
import {
  boundedJsonBytes,
  type JsonValue,
  OmpPublicDataSerializer,
  OmpPublicError,
  utf8Bytes,
} from "./security";

const STREAM_FRAME_MS = 32;
const MAX_STREAM_CONTENT_BLOCKS = 64;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_TODOS = 256;
const MAX_TURN_NATIVE_IDENTITIES = 1_024;
const MAX_REPLAY_NATIVE_IDENTITIES = 100_000;
const MAX_PUBLIC_TOOL_PAYLOAD_BYTES = 256 * 1024;
const MAX_ACTIVE_TOOL_BYTES = 4 * 1024 * 1024;
const MAX_REVERT_TARGETS = MAX_REPLAY_NATIVE_IDENTITIES;
const REVERT_TOKEN_PATTERN = /^omp-revert:[A-Za-z0-9_-]{43}$/u;
const MAX_IMAGE_ENCODED_LENGTH = 8 * 1024 * 1024;
const MAX_STREAM_TOTAL_BYTES = (MAX_IMAGE_ENCODED_LENGTH + 256) * 2;
const MAX_NATIVE_IMAGE_RESULT_BYTES = 12 * 1024 * 1024;
const MAX_RETIRED_TOOL_IDS = 1_024;

type Emit = (event: ProviderEvent) => void;
type NativeImageMimeType = Exclude<OmpImageMimeType, "image/webp">;

type NativeImage = {
  id: string;
  data: string;
  mimeType: NativeImageMimeType;
};

const UNSUPPORTED_WEBP_MESSAGE =
  "OMP image uses WebP, which is not supported on every Paseo client";

type StreamBlockKind = "assistant_message" | "reasoning" | "image";

const MAX_REPLAY_CANDIDATE_EVENTS = 512;
const MAX_REPLAY_CANDIDATE_BYTES = 4 * 1024 * 1024;
type StreamBlockSnapshot = {
  kind: StreamBlockKind;
  text: string;
  publishedText?: string;
  image?: NativeImage;
  error?: string;
};

type StreamSnapshot = {
  messageId: string;
  nativeIdentity?: string;
  published: boolean;
  retainedBytes: number;
  publishedBytes: number;
  blocks: Map<number, StreamBlockSnapshot>;
  dirtyBlocks: Set<number>;
};

type ToolSnapshot = {
  turnId: string;
  generation: number;
  publicId: string;
  nativeName: string;
  name: string;
  input: JsonValue;
  output: JsonValue;
  retainedBytes: number;
  specializedRendered: boolean;
  silent: boolean;
};

export interface OmpTimelineScheduler {
  set(callback: () => void | Promise<void>, delayMs: number): unknown;
  clear(handle: unknown): void;
}
type AssistantStreamEvent = Extract<
  OmpRpcEvent,
  { type: "message_start" | "message_update" | "message_end" }
>;

type ReplayCandidate = {
  identity: string;
  events: AssistantStreamEvent[];
  retainedBytes: number;
};
type ReplayOccurrenceQueue = {
  ordinals: number[];
  consumed: number;
};

export const defaultOmpTimelineScheduler: OmpTimelineScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type AssistantMessageEvent = Extract<
  OmpRpcEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

function assistantIdentity(message: OmpMessage): string | undefined {
  if (message.role !== "assistant") return;
  return message.entryId ?? message.responseId ?? message.id;
}
function assistantContentFingerprint(message: OmpAssistantMessage): string {
  const encoded =
    typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null);
  return createHash("sha256").update(encoded).digest("base64url");
}
function imageBlock(data: string, mimeType: string): StreamBlockSnapshot | undefined {
  if (!isValidImagePayload(data, mimeType, MAX_IMAGE_ENCODED_LENGTH)) return undefined;
  if (!isOmpImageMimeType(mimeType)) return undefined;
  if (mimeType === "image/webp") {
    return { kind: "image", text: mimeType, error: UNSUPPORTED_WEBP_MESSAGE };
  }
  return {
    kind: "image",
    text: `${mimeType}\n${data}`,
    image: {
      id: createHash("sha256")
        .update(mimeType)
        .update("\n")
        .update(data)
        .digest("base64url")
        .slice(0, 16),
      data,
      mimeType,
    },
  };
}

type OmpAssistantMessage = Extract<OmpMessage, { role: "assistant" }>;

function blockText(
  message: OmpAssistantMessage,
  contentIndex: number,
): StreamBlockSnapshot | undefined {
  if (typeof message.content === "string") {
    return contentIndex === 0 ? { kind: "assistant_message", text: message.content } : undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  const part = message.content[contentIndex];
  if (part?.type === "text") return { kind: "assistant_message", text: part.text ?? "" };
  if (part?.type === "thinking") return { kind: "reasoning", text: part.thinking ?? "" };
  if (part?.type === "image" && part.data && part.mimeType) {
    return imageBlock(part.data, part.mimeType);
  }
  return undefined;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function firstString(
  record: Record<string, JsonValue> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
function xdeviceToolName(nativeName: string, input: JsonValue): string | undefined {
  if (nativeName.toLowerCase() !== "write") return;
  const record = jsonRecord(input);
  const nestedInput = jsonRecord(record?.input) ?? record;
  const path = firstString(nestedInput, "path", "filePath");
  const match = path?.match(/^xd:\/\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,255})(?:[/?#]|$)/u);
  return match?.[1];
}
function friendlyXdeviceToolName(name: string): string {
  const routedName = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
  const words = routedName
    .replace(/[-_.]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : name;
}
function publishableHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function todoPublicId(nativeId: string | undefined, index: number): string {
  if (!nativeId) return `omp:todo:${index}`;
  const digest = createHash("sha256").update(nativeId).digest("base64url").slice(0, 12);
  return `omp:todo:${digest}`;
}

function toolResultText(value: JsonValue): string | undefined {
  if (typeof value === "string") return value;
  const result = jsonRecord(value);
  if (!result) return undefined;

  const directText = firstString(result, "output", "stdout", "text");
  if (directText) return directText;
  if (!Array.isArray(result.content)) return undefined;

  const textParts = result.content.flatMap((part) => {
    const block = jsonRecord(part);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function resultDetails(value: JsonValue): Record<string, JsonValue> | undefined {
  const envelope = jsonRecord(value);
  return jsonRecord(envelope?.details);
}

type NativeImageEnvelope = {
  images: NativeImage[];
  text?: string;
  details?: JsonValue;
};

type NativeImageResult = { image: NativeImageEnvelope; output: JsonValue } | { error: string };

function nativeImageResult(
  value: unknown,
  filter: OmpPublicDataSerializer,
): NativeImageResult | undefined {
  if (
    boundedJsonBytes(
      value,
      MAX_NATIVE_IMAGE_RESULT_BYTES,
      MAX_STREAM_CONTENT_BLOCKS,
      8 * 1024 * 1024,
      512,
    ) === Number.POSITIVE_INFINITY
  ) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("content" in value)) {
    return undefined;
  }
  if (!Array.isArray(value.content)) return undefined;
  const images: NativeImageEnvelope["images"] = [];
  const text: string[] = [];
  let textBytes = 0;
  const nonImageContent: unknown[] = [];
  for (const part of value.content) {
    if (
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      "type" in part &&
      part.type === "image"
    ) {
      if (
        !("data" in part) ||
        typeof part.data !== "string" ||
        !("mimeType" in part) ||
        typeof part.mimeType !== "string" ||
        !isValidImagePayload(part.data, part.mimeType, MAX_IMAGE_ENCODED_LENGTH) ||
        !isOmpImageMimeType(part.mimeType)
      ) {
        return undefined;
      }
      if (part.mimeType === "image/webp") return { error: UNSUPPORTED_WEBP_MESSAGE };
      images.push({
        id: createHash("sha256")
          .update(part.mimeType)
          .update("\n")
          .update(part.data)
          .digest("base64url")
          .slice(0, 16),
        data: part.data,
        mimeType: part.mimeType,
      });
      continue;
    }
    nonImageContent.push(part);
    const sanitized = filter.json(
      part,
      MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
      MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
    );
    const rendered = toolResultText(sanitized);
    if (!rendered) continue;
    const separatorBytes = text.length > 0 ? 1 : 0;
    const remainingBytes = MAX_PUBLIC_TOOL_PAYLOAD_BYTES - textBytes - separatorBytes;
    if (remainingBytes <= 0) continue;
    const bounded = filter.text(rendered, remainingBytes);
    if (!bounded) continue;
    text.push(bounded);
    textBytes += separatorBytes + utf8Bytes(bounded);
  }
  if (images.length === 0) return undefined;
  const details =
    "details" in value
      ? filter.json(value.details, MAX_PUBLIC_TOOL_PAYLOAD_BYTES, MAX_PUBLIC_TOOL_PAYLOAD_BYTES)
      : undefined;
  const output = filter.json(
    { ...value, content: nonImageContent },
    MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
    MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
  );
  return {
    image: {
      images,
      ...(text.length > 0 ? { text: text.join("\n") } : {}),
      ...(details !== undefined ? { details } : {}),
    },
    output,
  };
}

type CompactionSlot = {
  id: string;
  trigger: "auto" | "manual";
  retrying: boolean;
  action?: string;
};

export class OmpTimelineProjector {
  private readonly tools = new Map<string, ToolSnapshot>();
  private stream: StreamSnapshot | null = null;
  private flushTimer: unknown;
  private currentTurnId: string | null = null;
  private assistantSequence = 0;
  private readonly turnNativeMessageIds = new Map<string, string>();
  private nativeIdentitySaturated = false;
  private assistantIdentitySequence = 0;
  private noticeSequence = 0;
  private toolSequence = 0;
  private userSequence = 0;
  private replayTurnId: string | null = null;
  private replaySequence = 0;
  private readonly replayBoundaryOccurrences = new Map<
    string,
    Map<string, ReplayOccurrenceQueue>
  >();
  private replayBoundaryOccurrenceCount = 0;
  private readonly replayCandidates = new Map<string, ReplayCandidate>();
  private readonly replayOverflowCandidates = new Map<string, string>();
  private projectingReplay = false;
  private customSequence = 0;
  private compactionSequence = 0;
  private activeCompaction: CompactionSlot | null = null;
  private discardedCompactionEnds = 0;
  private goalItemId: string | null = null;
  private runtimeGeneration = 0;
  private readonly retiredToolCallIds = new Set<string>();
  private toolIdentitySaturated = false;
  private activeToolBytes = 0;
  private readonly revertEntryByToken = new Map<string, string>();
  private readonly revertTokenByEntry = new Map<string, string>();
  private commandText = "";
  private commandPublishedText = "";
  private closed = false;

  private readonly dataFilter: OmpPublicDataSerializer;

  constructor(
    private readonly sessionId: string,
    private readonly emit: Emit,
    private readonly scheduler: OmpTimelineScheduler = defaultOmpTimelineScheduler,
    outputRedactionValues: readonly string[] = [],
    private readonly conversationRevertEnabled = false,
    private readonly hostToolLabels: ReadonlyMap<string, string> = new Map(),
  ) {
    this.dataFilter = new OmpPublicDataSerializer(outputRedactionValues);
  }

  project(event: OmpRpcEvent, turnId: string, bypassReplayFilter = false): void {
    if (this.closed) return;
    if (
      !bypassReplayFilter &&
      !this.projectingReplay &&
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      const accepted = this.filterReplayDelivery(event, turnId);
      if (accepted === undefined) {
        // This occurrence does not match replay history; project it normally.
      } else {
        for (const buffered of accepted) this.project(buffered, turnId, true);
        return;
      }
    }
    if (
      event.type === "todo_reminder" ||
      event.type === "todo_auto_clear" ||
      event.type === "notice" ||
      event.type === "extension_ui_request" ||
      event.type === "auto_compaction_start" ||
      event.type === "auto_compaction_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "advisor_yielded"
    ) {
      this.projectPassive(event);
      return;
    }
    this.ensureTurn(turnId);
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant") return;
        if (this.stream) {
          this.flush(true);
          this.stream = null;
        }
        this.beginStream(event.message, turnId);
        this.updateAllBlocks(event.message);
        this.scheduleFlush();
        return;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId, event.assistantMessageEvent);
        this.scheduleFlush();
        return;
      case "message_end":
        if (event.message.role === "custom" || event.message.role === "bashExecution") {
          this.publishCustomMessage(event.message);
          return;
        }
        if (event.message.role !== "assistant") return;
        this.updateStream(event.message, turnId);
        this.flush(true);
        this.stream = null;
        return;
      case "tool_execution_start": {
        this.flush(true);
        if (this.toolIdentitySaturated || this.retiredToolCallIds.has(event.toolCallId)) return;
        const previous = this.tools.get(event.toolCallId);
        if (!previous && this.tools.size >= MAX_ACTIVE_TOOLS) return;
        const input = this.dataFilter.json(
          event.args,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
        );
        const retainedBytes = boundedJsonBytes(input, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
        if (
          this.activeToolBytes - (previous?.retainedBytes ?? 0) + retainedBytes >
          MAX_ACTIVE_TOOL_BYTES
        ) {
          return;
        }
        if (!previous) this.toolSequence += 1;
        const routedToolName = xdeviceToolName(event.toolName, input);
        const displayName = routedToolName
          ? (this.hostToolLabels.get(routedToolName) ?? friendlyXdeviceToolName(routedToolName))
          : event.toolName;
        const snapshot: ToolSnapshot = {
          publicId: previous?.publicId ?? `omp:tool:${this.toolSequence}`,
          nativeName: event.toolName,
          name: this.dataFilter.text(displayName, 256),
          input,
          output: null,
          retainedBytes,
          turnId,
          generation: this.runtimeGeneration,
          specializedRendered: previous?.specializedRendered ?? false,
          silent: ["ask_user", "todo"].includes(event.toolName.toLowerCase()),
        };
        this.activeToolBytes += retainedBytes - (previous?.retainedBytes ?? 0);
        this.tools.set(event.toolCallId, snapshot);
        if (!snapshot.silent) this.publishTool(snapshot, "running");
        return;
      }
      case "tool_execution_update": {
        const previous = this.tools.get(event.toolCallId);
        if (!previous) return;
        if (previous.turnId !== turnId || previous.generation !== this.runtimeGeneration) return;
        const output = this.dataFilter.json(
          event.partialResult,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
        );
        const outputBytes = boundedJsonBytes(output, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
        const inputBytes = boundedJsonBytes(previous.input, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
        const retainedBytes = inputBytes + outputBytes;
        if (this.activeToolBytes - previous.retainedBytes + retainedBytes > MAX_ACTIVE_TOOL_BYTES)
          return;
        const snapshot: ToolSnapshot = { ...previous, output, retainedBytes };
        this.activeToolBytes += retainedBytes - previous.retainedBytes;
        this.tools.set(event.toolCallId, snapshot);
        if (!snapshot.silent) this.publishTool(snapshot, "running");
        return;
      }
      case "tool_execution_end": {
        const previous = this.tools.get(event.toolCallId);
        if (!previous) return;
        if (previous.turnId !== turnId || previous.generation !== this.runtimeGeneration) return;
        const preservedImage = nativeImageResult(event.result, this.dataFilter);
        this.tools.delete(event.toolCallId);
        this.activeToolBytes -= previous.retainedBytes;
        if (preservedImage && !event.isError) {
          if ("error" in preservedImage) {
            const output = this.dataFilter.json(
              event.result,
              MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
              MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
            );
            this.publishTool({ ...previous, output }, "completed");
            this.publishImageError(`${previous.publicId}:images`, preservedImage.error);
            return;
          }
          const { image, output } = preservedImage;
          this.publishTool({ ...previous, output }, "completed");
          this.publishImages(previous.publicId, previous.name, image);
          return;
        }
        const output = this.dataFilter.json(
          event.result,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
          MAX_PUBLIC_TOOL_PAYLOAD_BYTES,
        );
        const snapshot: ToolSnapshot = { ...previous, output };
        const specializedRendered =
          previous.nativeName.toLowerCase() === "todo" && !event.isError
            ? this.publishTodoResult(snapshot)
            : snapshot.specializedRendered;
        if (snapshot.silent && (event.isError || !specializedRendered)) {
          this.publishTool(
            snapshot,
            "failed",
            event.isError
              ? snapshot.output
              : `${snapshot.name} completed without a supported native rendering`,
          );
        } else if (!snapshot.silent) {
          if (event.isError) this.publishTool(snapshot, "failed", snapshot.output);
          else this.publishTool(snapshot, "completed");
        }
        return;
      }
      case "command_output": {
        if (!event.text) return;
        const next = `${this.commandText}${event.text}`;
        if (utf8Bytes(next) > MAX_STREAM_TEXT_LENGTH) return;
        this.commandText = next;
        this.publishCommand(turnId);
        return;
      }
    }
  }

  projectPassive(event: OmpRpcEvent): void {
    if (this.closed) return;
    if (event.type === "todo_reminder" || event.type === "todo_auto_clear") {
      const todos = event.type === "todo_reminder" ? event.todos : [];
      this.publish({
        type: "todo",
        id: "omp:todos",
        items: todos.slice(0, MAX_TODOS).map((todo, index) => ({
          id: todoPublicId(todo.id, index),
          text: this.dataFilter.text(todo.content, 16_384),
          completed: todo.status === "completed" || todo.status === "abandoned",
          status:
            todo.status === "completed" || todo.status === "abandoned"
              ? "completed"
              : todo.status === "blocked"
                ? "pending"
                : todo.status,
        })),
      });
      return;
    }
    if (event.type === "goal_updated") {
      this.publishGoal(event);
      return;
    }
    if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
      this.publishAutoRetry(event);
      return;
    }
    if (event.type === "retry_fallback_applied" || event.type === "retry_fallback_succeeded") {
      this.publishRetryFallback(event);
      return;
    }
    if (event.type === "notice") {
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:notice:${this.noticeSequence}`,
        level: event.level,
        message: this.dataFilter.text(event.message, 64 * 1024),
      });
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "notify") {
      if (!event.message) return;
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:ui:${this.noticeSequence}`,
        level: event.notifyType ?? "info",
        message: this.dataFilter.text(event.message, 64 * 1024),
      });
      return;
    }
    if (event.type === "extension_ui_request" && event.method === "open_url") {
      const url = publishableHttpUrl(event.launchUrl ?? event.url);
      if (!url) return;
      this.noticeSequence += 1;
      const message = [event.instructions, url].filter(Boolean).join("\n");
      this.publish({
        type: "notification",
        id: `omp:ui:${this.noticeSequence}`,
        level: "info",
        message: this.dataFilter.text(message, 64 * 1024),
      });
      return;
    }
    if (event.type === "advisor_yielded") {
      this.noticeSequence += 1;
      this.publish({
        type: "notification",
        id: `omp:advisor:${this.noticeSequence}`,
        level: "info",
        message: "Advisor review completed",
      });
      return;
    }
    if (event.type === "auto_compaction_start" || event.type === "compaction_start") {
      const trigger = event.type === "auto_compaction_start" ? "auto" : "manual";
      const action = event.type === "auto_compaction_start" ? event.action : undefined;
      if (this.discardedCompactionEnds > 0) {
        this.discardedCompactionEnds += 1;
        return;
      }
      const active = this.activeCompaction;
      if (active?.retrying && active.trigger === trigger && active.action === action) {
        active.retrying = false;
        return;
      }
      if (active) {
        this.retireCompactions("OMP emitted overlapping compactions");
        this.discardedCompactionEnds = 2;
        return;
      }
      this.compactionSequence += 1;
      const slot: CompactionSlot = {
        id: `omp:compaction:${this.compactionSequence}`,
        trigger,
        retrying: false,
        ...(action ? { action } : {}),
      };
      this.activeCompaction = slot;
      this.publish({ type: "compaction", id: slot.id, status: "loading", trigger });
      return;
    }
    if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
      if (this.discardedCompactionEnds > 0) {
        this.discardedCompactionEnds -= 1;
        return;
      }
      const trigger = event.type === "auto_compaction_end" ? "auto" : "manual";
      const action = event.type === "auto_compaction_end" ? event.action : undefined;
      const slot = this.activeCompaction;
      if (!slot) {
        this.compactionSequence += 1;
        this.publish({
          type: "error",
          id: `omp:compaction:${this.compactionSequence}:error`,
          message: "OMP compaction ended without a matching start",
        });
        return;
      }
      if (slot.trigger !== trigger || (action !== undefined && slot.action !== action)) {
        this.retireCompactions("OMP emitted overlapping compactions");
        this.discardedCompactionEnds = 1;
        return;
      }
      if (event.willRetry) {
        slot.retrying = true;
        return;
      }
      this.activeCompaction = null;
      const result = jsonRecord(this.dataFilter.json(event.result ?? null));
      const rawPreTokens = result?.preTokens ?? result?.tokensBefore;
      const preTokens =
        typeof rawPreTokens === "number" && Number.isFinite(rawPreTokens)
          ? Math.max(0, Math.trunc(rawPreTokens))
          : undefined;
      this.publish({
        type: "compaction",
        id: slot.id,
        status: "completed",
        trigger,
        ...(preTokens !== undefined ? { preTokens } : {}),
      });
      if (event.skipped) {
        this.publish({
          type: "notification",
          id: `${slot.id}:skipped`,
          level: "warning",
          message: "OMP compaction was skipped",
        });
      }
      if (event.aborted || event.errorMessage) {
        this.publish({
          type: "error",
          id: `${slot.id}:error`,
          message: this.dataFilter.text(
            event.errorMessage ??
              (event.aborted ? "OMP compaction canceled" : "OMP compaction failed"),
            4_096,
          ),
        });
      }
    }
  }

  projectSubagent(
    event: Extract<
      OmpRpcEvent,
      { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event" }
    >,
  ): void {
    if (this.closed) return;
    switch (event.type) {
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
        return;
    }
  }

  markAskPermissionRendered(): void {
    const snapshots = [...this.tools.values()];
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = snapshots[index];
      if (snapshot?.nativeName.toLowerCase() !== "ask_user") continue;
      snapshot.specializedRendered = true;
      return;
    }
  }

  publishUser(text: string, clientMessageId: string, nativeId?: string): void {
    this.userSequence += 1;
    const nativeHash = nativeId
      ? createHash("sha256").update(nativeId).digest("base64url").slice(0, 12)
      : "local";
    const messageId = `omp:user:${this.userSequence}:${nativeHash}`;
    const revertToken =
      nativeId && this.conversationRevertEnabled ? this.revertTokenFor(nativeId) : undefined;
    this.publish({
      type: "user_message",
      id: messageId,
      messageId,
      clientMessageId,
      text: this.dataFilter.text(text),
      ...(revertToken ? { revertToken } : {}),
    });
  }

  resolveRevertToken(token: unknown): string {
    if (typeof token !== "string" || !REVERT_TOKEN_PATTERN.test(token)) {
      throw new OmpPublicError("Invalid OMP conversation rewind token");
    }
    const entryId = this.revertEntryByToken.get(token);
    if (!entryId) throw new OmpPublicError("OMP conversation rewind token is stale");
    return entryId;
  }

  resetForRewindReplay(): void {
    this.clearFlushTimer();
    this.stream = null;
    this.currentTurnId = null;
    this.assistantSequence = 0;
    this.turnNativeMessageIds.clear();
    this.nativeIdentitySaturated = false;
    this.assistantIdentitySequence = 0;
    this.toolSequence = 0;
    this.userSequence = 0;
    this.replayTurnId = null;
    this.replaySequence = 0;
    this.replayBoundaryOccurrences.clear();
    this.replayBoundaryOccurrenceCount = 0;
    this.replayCandidates.clear();
    this.replayOverflowCandidates.clear();
    this.projectingReplay = false;
    this.activeToolBytes = 0;
    this.tools.clear();
    this.commandText = "";
    this.commandPublishedText = "";
    this.revertEntryByToken.clear();
    this.revertTokenByEntry.clear();
  }

  projectReplayMessage(message: OmpMessage): void {
    if (this.closed) return;
    const nativeIdentity = assistantIdentity(message);
    this.replaySequence += 1;
    if (message.role === "user") {
      if (this.replayTurnId) this.finishTurn(this.replayTurnId);
      this.replayTurnId = `omp:replay-turn:${this.replaySequence}`;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
              .join("\n\n");
      if (text) {
        this.publishUser(
          text,
          `omp:replay-user:${this.replaySequence}`,
          message.entryId ?? message.id,
        );
      }
      return;
    }
    if (message.role === "assistant") {
      this.replayTurnId ??= `omp:replay-turn:${this.replaySequence}`;
      this.projectingReplay = true;
      try {
        this.project({ type: "message_start", message }, this.replayTurnId);
        this.project({ type: "message_end", message }, this.replayTurnId);
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type !== "toolCall" || !part.id || !part.name || part.arguments === undefined)
              continue;
            this.project(
              {
                type: "tool_execution_start",
                toolCallId: part.id,
                toolName: part.name,
                args: part.arguments,
              },
              this.replayTurnId,
            );
          }
        }
      } finally {
        this.projectingReplay = false;
      }
      if (nativeIdentity) this.rememberReplayOccurrence(nativeIdentity, message);
      return;
    }
    this.replayTurnId ??= `omp:replay-turn:${this.replaySequence}`;
    if (message.role === "toolResult") {
      if (!this.tools.has(message.toolCallId)) {
        this.project(
          {
            type: "tool_execution_start",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            args: null,
          },
          this.replayTurnId,
        );
      }
      this.project(
        {
          type: "tool_execution_end",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          result: {
            content: message.content,
            ...(message.details !== undefined ? { details: message.details } : {}),
          },
          isError: message.isError,
        },
        this.replayTurnId,
      );
      return;
    }
    if (message.role === "bashExecution") {
      const text = message.output
        ? `$ ${message.command}\n${message.output}`
        : `$ ${message.command}`;
      this.project({ type: "command_output", text }, this.replayTurnId);
      this.finishTurn(this.replayTurnId);
      this.replayTurnId = null;
    }
  }

  finishReplay(): void {
    if (this.replayTurnId) this.finishTurn(this.replayTurnId);
    this.replayTurnId = null;
  }
  acceptLiveTurn(turnId: string): void {
    const candidate = this.replayCandidates.get(turnId);
    if (candidate) {
      this.replayCandidates.delete(turnId);
      for (const event of candidate.events) this.project(event, turnId, true);
    }
    this.replayOverflowCandidates.delete(turnId);
    this.replayBoundaryOccurrences.clear();
    this.replayBoundaryOccurrenceCount = 0;
  }

  private rememberReplayOccurrence(identity: string, message: OmpAssistantMessage): void {
    if (this.replayBoundaryOccurrenceCount >= MAX_REPLAY_NATIVE_IDENTITIES) return;
    const ordinal = this.replayBoundaryOccurrenceCount;
    this.replayBoundaryOccurrenceCount += 1;
    const fingerprint = assistantContentFingerprint(message);
    const signatures = this.replayBoundaryOccurrences.get(identity) ?? new Map();
    const occurrences = signatures.get(fingerprint) ?? { ordinals: [], consumed: 0 };
    occurrences.ordinals.push(ordinal);
    signatures.set(fingerprint, occurrences);
    this.replayBoundaryOccurrences.set(identity, signatures);
  }

  private consumeReplayOccurrence(identity: string, message: OmpAssistantMessage): boolean {
    const signatures = this.replayBoundaryOccurrences.get(identity);
    if (!signatures) return false;
    const fingerprint = assistantContentFingerprint(message);
    const occurrences = signatures.get(fingerprint);
    if (!occurrences || occurrences.consumed >= occurrences.ordinals.length) return false;
    occurrences.consumed += 1;
    if (occurrences.consumed === occurrences.ordinals.length) signatures.delete(fingerprint);
    if (signatures.size === 0) this.replayBoundaryOccurrences.delete(identity);
    return true;
  }

  private filterReplayDelivery(
    event: AssistantStreamEvent,
    turnId: string,
  ): AssistantStreamEvent[] | undefined {
    if (event.message.role !== "assistant") return undefined;
    const identity = assistantIdentity(event.message);
    const overflowIdentity = this.replayOverflowCandidates.get(turnId);
    if (overflowIdentity) {
      if (identity !== overflowIdentity) {
        this.replayOverflowCandidates.delete(turnId);
        return this.filterReplayDelivery(event, turnId);
      }
      if (event.type !== "message_end") return [];
      this.replayOverflowCandidates.delete(turnId);
      return this.consumeReplayOccurrence(identity, event.message) ? [] : [event];
    }
    if (!identity || !this.replayBoundaryOccurrences.has(identity)) return undefined;
    const existing = this.replayCandidates.get(turnId);
    if (existing && existing.identity !== identity) {
      this.replayCandidates.delete(turnId);
      const next = this.filterReplayDelivery(event, turnId);
      return next === undefined ? [...existing.events, event] : [...existing.events, ...next];
    }
    const candidate = existing ?? { identity, events: [], retainedBytes: 0 };
    const eventBytes = boundedJsonBytes(event, MAX_REPLAY_CANDIDATE_BYTES);
    if (
      eventBytes === Number.POSITIVE_INFINITY ||
      candidate.events.length >= MAX_REPLAY_CANDIDATE_EVENTS ||
      candidate.retainedBytes + eventBytes > MAX_REPLAY_CANDIDATE_BYTES
    ) {
      this.replayCandidates.delete(turnId);
      if (event.type === "message_end") {
        return this.consumeReplayOccurrence(identity, event.message) ? [] : [event];
      }
      this.replayOverflowCandidates.set(turnId, identity);
      return [];
    }
    candidate.events.push(event);
    candidate.retainedBytes += eventBytes;
    this.replayCandidates.set(turnId, candidate);
    if (event.type !== "message_end") return [];
    this.replayCandidates.delete(turnId);
    return this.consumeReplayOccurrence(identity, event.message) ? [] : candidate.events;
  }

  flush(finalizeFallback = false): void {
    this.clearFlushTimer();
    if (!this.stream || this.closed || this.stream.dirtyBlocks.size === 0) return;
    const stream = this.stream;
    if (!stream.nativeIdentity && !finalizeFallback) return;
    const indexes = [...stream.dirtyBlocks].sort((left, right) => left - right);
    stream.dirtyBlocks.clear();
    for (const contentIndex of indexes) {
      const block = stream.blocks.get(contentIndex);
      if (!block?.text) continue;
      const publicText = block.kind === "image" ? block.text : this.dataFilter.text(block.text);
      if (!publicText || block.publishedText === publicText) continue;
      const nextPublishedBytes = utf8Bytes(publicText);
      if (
        stream.retainedBytes + stream.publishedBytes + nextPublishedBytes >
        MAX_STREAM_TOTAL_BYTES
      ) {
        continue;
      }
      const suffix =
        block.kind === "reasoning" ? "reasoning" : block.kind === "image" ? "image" : "text";
      const id = `${stream.messageId}:content:${contentIndex}:${suffix}`;
      if (block.kind === "reasoning") {
        this.publish({ type: "reasoning", id, text: publicText });
      } else if (block.kind === "image") {
        if (block.image) this.publishImages(id, "Assistant image", { images: [block.image] });
        else if (block.error) this.publishImageError(id, block.error);
      } else {
        this.publish({
          type: "assistant_message",
          id,
          messageId: stream.messageId,
          text: publicText,
        });
      }
      stream.publishedBytes += nextPublishedBytes;
      block.publishedText = publicText;
      stream.published = true;
    }
  }

  finishTurn(turnId: string, preserveCompactions = false): void {
    const replayCandidate = this.replayCandidates.get(turnId);
    if (replayCandidate) {
      this.replayCandidates.delete(turnId);
      for (const event of replayCandidate.events) this.project(event, turnId, true);
    }
    this.replayOverflowCandidates.delete(turnId);
    if (!preserveCompactions) this.retireCompactions("OMP compaction ended with the turn");
    if (this.currentTurnId !== turnId) return;
    this.flush(true);
    this.retireTools("OMP tool ended with the turn");
    this.publishCommand(turnId);
    this.stream = null;
    this.commandText = "";
    this.currentTurnId = null;
    this.assistantSequence = 0;
    this.turnNativeMessageIds.clear();
    this.nativeIdentitySaturated = false;
  }

  close(): void {
    this.flush(true);
    if (this.currentTurnId) this.publishCommand(this.currentTurnId);
    this.retireCompactions("OMP compaction ended when the session closed");
    this.closed = true;
    this.clearFlushTimer();
    this.stream = null;
    this.tools.clear();
    this.activeToolBytes = 0;
    this.replayCandidates.clear();
    this.replayOverflowCandidates.clear();
    this.replayBoundaryOccurrences.clear();
    this.replayBoundaryOccurrenceCount = 0;
    this.revertEntryByToken.clear();
    this.revertTokenByEntry.clear();
  }

  retireCompactions(message: string): void {
    this.discardedCompactionEnds = 0;
    const slot = this.activeCompaction;
    if (!slot) return;
    this.activeCompaction = null;
    this.publish({ type: "compaction", id: slot.id, status: "completed", trigger: slot.trigger });
    this.publish({ type: "error", id: `${slot.id}:error`, message });
  }

  resetRuntimeGeneration(message: string): void {
    this.retireCompactions(message);
    this.retireTools(message);
    this.retiredToolCallIds.clear();
    this.toolIdentitySaturated = false;
    this.runtimeGeneration += 1;
  }

  private retireTools(message: string): void {
    for (const [nativeId, snapshot] of this.tools) {
      if (!snapshot.silent || !snapshot.specializedRendered) {
        this.publishTool(snapshot, "failed", message);
      }
      if (this.retiredToolCallIds.size < MAX_RETIRED_TOOL_IDS) {
        this.retiredToolCallIds.add(nativeId);
      } else {
        this.toolIdentitySaturated = true;
      }
    }
    this.activeToolBytes = 0;
    this.tools.clear();
  }
  private ensureTurn(turnId: string): void {
    if (this.currentTurnId === turnId) return;
    if (this.currentTurnId) this.finishTurn(this.currentTurnId);
    this.currentTurnId = turnId;
    this.assistantSequence = 0;
    this.commandText = "";
    this.commandPublishedText = "";
  }

  private beginStream(message: OmpAssistantMessage, turnId: string): StreamSnapshot | null {
    this.assistantSequence += 1;
    const nativeIdentity = assistantIdentity(message);
    const messageId = nativeIdentity
      ? this.messageIdForNativeIdentity(nativeIdentity)
      : this.nextAssistantMessageId(`turn:${turnId}:${this.assistantSequence}`);
    if (!messageId) return null;
    this.stream = {
      messageId,
      ...(nativeIdentity ? { nativeIdentity } : {}),
      published: false,
      retainedBytes: 0,
      publishedBytes: 0,
      blocks: new Map(),
      dirtyBlocks: new Set(),
    };
    return this.stream;
  }
  private messageIdForNativeIdentity(nativeIdentity: string): string | undefined {
    const existing = this.turnNativeMessageIds.get(nativeIdentity);
    if (existing) return existing;
    if (
      this.nativeIdentitySaturated ||
      this.turnNativeMessageIds.size >= MAX_TURN_NATIVE_IDENTITIES
    ) {
      this.nativeIdentitySaturated = true;
      return undefined;
    }
    const messageId = this.nextAssistantMessageId(nativeIdentity);
    this.turnNativeMessageIds.set(nativeIdentity, messageId);
    return messageId;
  }

  private nextAssistantMessageId(source: string): string {
    this.assistantIdentitySequence += 1;
    const digest = createHash("sha256").update(source).digest("base64url").slice(0, 12);
    return `omp:assistant:${this.assistantIdentitySequence}:${digest}`;
  }

  private updateStream(
    message: OmpAssistantMessage,
    turnId: string,
    update?: AssistantMessageEvent,
  ): void {
    const nativeIdentity = assistantIdentity(message);
    if (this.stream && nativeIdentity && this.stream.nativeIdentity !== nativeIdentity) {
      if (!this.stream.nativeIdentity && !this.stream.published) {
        const messageId = this.messageIdForNativeIdentity(nativeIdentity);
        if (!messageId) {
          this.stream = null;
          return;
        }
        this.stream.messageId = messageId;
        this.stream.nativeIdentity = nativeIdentity;
      } else {
        this.flush();
        this.stream = null;
      }
    }
    const stream = this.stream ?? this.beginStream(message, turnId);
    if (!stream) return;
    if (update?.contentIndex !== undefined) {
      this.updateBlock(stream, message, update.contentIndex, update);
      return;
    }
    this.updateAllBlocks(message);
  }

  private updateAllBlocks(message: OmpAssistantMessage): void {
    const stream = this.stream;
    if (!stream) return;
    if (typeof message.content === "string") {
      this.setBlock(stream, 0, { kind: "assistant_message", text: message.content });
      return;
    }
    if (!Array.isArray(message.content)) return;
    const blockCount = Math.min(message.content.length, MAX_STREAM_CONTENT_BLOCKS);
    for (let index = 0; index < blockCount; index += 1) {
      const block = blockText(message, index);
      if (block) this.setBlock(stream, index, block);
    }
  }

  private updateBlock(
    stream: StreamSnapshot,
    message: OmpAssistantMessage,
    contentIndex: number,
    update: NonNullable<AssistantMessageEvent>,
  ): void {
    if (!this.isValidContentIndex(contentIndex)) return;
    const snapshot = blockText(message, contentIndex);
    if (snapshot) {
      this.setBlock(stream, contentIndex, snapshot);
      return;
    }
    const content = update.content;
    if (
      content &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      "type" in content &&
      content.type === "image" &&
      "data" in content &&
      typeof content.data === "string" &&
      "mimeType" in content &&
      typeof content.mimeType === "string"
    ) {
      const image = imageBlock(content.data, content.mimeType);
      if (image) this.setBlock(stream, contentIndex, image);
      return;
    }
    const kind = update.type.startsWith("thinking_")
      ? "reasoning"
      : update.type.startsWith("text_")
        ? "assistant_message"
        : undefined;
    if (!kind) return;
    const previous = stream.blocks.get(contentIndex);
    const eventContent = typeof content === "string" ? content : undefined;
    const text =
      eventContent ??
      (update.delta !== undefined && previous?.kind === kind
        ? `${previous.text}${update.delta}`
        : (update.delta ?? previous?.text ?? ""));
    this.setBlock(stream, contentIndex, { kind, text });
  }

  private setBlock(
    stream: StreamSnapshot,
    contentIndex: number,
    snapshot: StreamBlockSnapshot,
  ): void {
    if (!this.isValidContentIndex(contentIndex)) return;
    if (snapshot.kind === "image" && utf8Bytes(snapshot.text) > MAX_IMAGE_ENCODED_LENGTH + 256)
      return;
    const previous = stream.blocks.get(contentIndex);
    let retainedBytes = utf8Bytes(snapshot.text);
    let textBytes = snapshot.kind === "image" ? 0 : retainedBytes;
    for (const [index, block] of stream.blocks) {
      if (index === contentIndex) continue;
      const blockBytes = utf8Bytes(block.text);
      retainedBytes += blockBytes;
      if (block.kind !== "image") textBytes += blockBytes;
      if (
        retainedBytes + stream.publishedBytes > MAX_STREAM_TOTAL_BYTES ||
        textBytes > MAX_STREAM_TEXT_LENGTH
      ) {
        return;
      }
    }
    if (
      retainedBytes + stream.publishedBytes > MAX_STREAM_TOTAL_BYTES ||
      textBytes > MAX_STREAM_TEXT_LENGTH
    ) {
      return;
    }
    if (previous?.kind === snapshot.kind && previous.text === snapshot.text) return;
    stream.retainedBytes = retainedBytes;
    stream.blocks.set(contentIndex, {
      ...snapshot,
      ...(previous?.kind === snapshot.kind ? { publishedText: previous.publishedText } : {}),
    });
    stream.dirtyBlocks.add(contentIndex);
  }

  private isValidContentIndex(contentIndex: number): boolean {
    return (
      Number.isSafeInteger(contentIndex) &&
      contentIndex >= 0 &&
      contentIndex < MAX_STREAM_CONTENT_BLOCKS
    );
  }

  private publishCommand(turnId: string): void {
    if (!this.commandText) return;
    const publicText = this.dataFilter.text(this.commandText);
    if (!publicText || publicText === this.commandPublishedText) return;
    this.commandPublishedText = publicText;
    this.publish({
      type: "assistant_message",
      id: `omp:command:${turnId}`,
      messageId: `omp:command:${turnId}`,
      text: publicText,
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.scheduler.set(() => {
      this.flushTimer = undefined;
      this.flush();
    }, STREAM_FRAME_MS);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    this.scheduler.clear(this.flushTimer);
    this.flushTimer = undefined;
  }

  private revertTokenFor(entryId: string): string | undefined {
    const existing = this.revertTokenByEntry.get(entryId);
    if (existing) return existing;
    if (this.revertTokenByEntry.size >= MAX_REVERT_TARGETS) return undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let token: string;
      try {
        token = `omp-revert:${randomBytes(32).toString("base64url")}`;
      } catch {
        return undefined;
      }
      if (this.revertEntryByToken.has(token)) continue;
      this.revertTokenByEntry.set(entryId, token);
      this.revertEntryByToken.set(token, entryId);
      return token;
    }
    return undefined;
  }

  private publishCustomMessage(message: OmpMessage): void {
    if (message.display === false) return;
    const rawType = message.customType ?? message.role;
    const publicType = this.dataFilter.text(rawType, 256);
    const lowerType = rawType.toLowerCase();
    const details = jsonRecord(this.dataFilter.json(message.details ?? null));
    const nativeIdentity = message.id ?? message.entryId ?? message.responseId;
    if (!nativeIdentity) this.customSequence += 1;
    const id = nativeIdentity
      ? `omp:custom:${createHash("sha256").update(nativeIdentity).digest("base64url").slice(0, 12)}`
      : `omp:custom:${this.customSequence}`;
    const contentParts = Array.isArray(message.content) ? message.content : [];
    const imageResult = nativeImageResult(
      {
        content:
          message.role === "bashExecution"
            ? [...contentParts, ...(message.images ?? [])]
            : contentParts,
        details: message.details,
      },
      this.dataFilter,
    );
    const content =
      typeof message.content === "string"
        ? message.content
        : contentParts
            .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
            .join("\n\n");
    if (message.role === "bashExecution" || /bash|shell|python/u.test(lowerType)) {
      const command = this.dataFilter.text(
        message.command ?? firstString(details, "command", "input") ?? publicType,
      );
      const output = message.output ?? content;
      this.publish({
        type: "tool_call",
        id,
        callId: id,
        name: publicType,
        detail: {
          type: "shell",
          command,
          ...(firstString(details, "cwd") ? { cwd: firstString(details, "cwd") } : {}),
          ...(output ? { output: this.dataFilter.text(output) } : {}),
          ...(typeof message.exitCode === "number" || message.exitCode === null
            ? { exitCode: message.exitCode }
            : typeof details?.exitCode === "number"
              ? { exitCode: details.exitCode }
              : {}),
        },
        status: message.cancelled ? "canceled" : "completed",
        error: null,
      });
      if (imageResult) {
        if ("error" in imageResult) this.publishImageError(`${id}:images`, imageResult.error);
        else this.publishImages(id, publicType, imageResult.image);
      }
      return;
    }
    if (imageResult) {
      if ("error" in imageResult) this.publishImageError(`${id}:images`, imageResult.error);
      else this.publishImages(id, publicType, imageResult.image);
      return;
    }
    const advisor = lowerType.includes("advisor") || lowerType === "aside";
    const sharedSeverity = firstString(details, "severity");
    const sharedAdvisor = firstString(details, "advisor", "attribution", "name", "source");
    const noteLines = Array.isArray(details?.notes)
      ? details.notes.flatMap((note) => {
          const record = jsonRecord(note);
          const noteText =
            typeof note === "string"
              ? note
              : (firstString(record, "note", "text", "content", "message") ?? "");
          const severity = firstString(record, "severity") ?? sharedSeverity;
          const noteAdvisor =
            firstString(record, "advisor", "attribution", "name", "source") ?? sharedAdvisor;
          const prefix = [
            severity ? `[${severity}]` : undefined,
            noteAdvisor ? `[${noteAdvisor}]` : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          const line = [prefix, noteText].filter(Boolean).join(" ");
          return line ? [line] : [];
        })
      : typeof details?.notes === "string"
        ? [
            [
              sharedSeverity ? `[${sharedSeverity}]` : undefined,
              sharedAdvisor ? `[${sharedAdvisor}]` : undefined,
              details.notes,
            ]
              .filter(Boolean)
              .join(" "),
          ]
        : [];
    const advisorMetadata = [
      sharedSeverity ? `[${sharedSeverity}]` : undefined,
      sharedAdvisor ? `[${sharedAdvisor}]` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const text = [content, ...noteLines].filter(Boolean).join("\n\n") || advisorMetadata;
    if (!text && !advisor) return;
    this.publish({
      type: "tool_call",
      id,
      callId: id,
      name: publicType,
      detail: {
        type: "plain_text",
        label: advisor ? "Advisor" : publicType,
        text: this.dataFilter.text(text || "Advisor update"),
        icon: advisor ? "brain" : "sparkles",
      },
      status: "completed",
      error: null,
    });
  }

  private publishTodoResult(snapshot: ToolSnapshot): boolean {
    const phases = resultDetails(snapshot.output)?.phases;
    if (!Array.isArray(phases)) return false;
    const items: Array<{
      id: string;
      text: string;
      completed: boolean;
      status: "pending" | "in_progress" | "completed";
      activeForm?: string;
    }> = [];
    for (const phase of phases) {
      const phaseRecord = jsonRecord(phase);
      const tasks = phaseRecord?.tasks;
      if (!Array.isArray(tasks)) continue;
      const phaseName = firstString(phaseRecord, "name", "phase");
      for (const task of tasks) {
        if (items.length >= MAX_TODOS) break;
        const taskRecord = jsonRecord(task);
        const text = firstString(taskRecord, "content", "text");
        if (!text) continue;
        const status = firstString(taskRecord, "status");
        const completed = status === "completed" || status === "abandoned";
        items.push({
          id: todoPublicId(firstString(taskRecord, "id"), items.length),
          text: this.dataFilter.text(text, 16_384),
          completed,
          status: completed ? "completed" : status === "in_progress" ? "in_progress" : "pending",
          ...(phaseName ? { activeForm: this.dataFilter.text(phaseName, 256) } : {}),
        });
      }
    }
    this.publish({ type: "todo", id: "omp:todos", items });
    return true;
  }

  private toolDetail(snapshot: ToolSnapshot): ProviderToolCallDetail {
    const input = jsonRecord(snapshot.input);
    const nestedInput = jsonRecord(input?.input) ?? input;
    const output = jsonRecord(snapshot.output);
    const details = resultDetails(snapshot.output);
    const resultText = toolResultText(snapshot.output);
    const name = snapshot.nativeName.toLowerCase();
    if (xdeviceToolName(snapshot.nativeName, snapshot.input)) {
      return { type: "unknown", input: snapshot.input, output: snapshot.output };
    }
    if (["bash", "shell", "exec", "run_command"].includes(name)) {
      const exitCode = details?.exitCode ?? output?.exitCode;
      return {
        type: "shell",
        command: firstString(nestedInput, "command", "cmd") ?? snapshot.name,
        ...(firstString(nestedInput, "cwd") ? { cwd: firstString(nestedInput, "cwd") } : {}),
        ...(resultText !== undefined ? { output: resultText } : {}),
        ...(typeof exitCode === "number" || exitCode === null ? { exitCode } : {}),
      };
    }
    if (name === "read") {
      const filePath = firstString(nestedInput, "path", "filePath", "url");
      if (!filePath) return { type: "unknown", input: snapshot.input, output: snapshot.output };
      if (!/^[A-Za-z]:[\\/]/u.test(filePath) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(filePath)) {
        const url = publishableHttpUrl(filePath);
        if (!url) {
          return { type: "plain_text", label: snapshot.name, text: resultText };
        }
        return {
          type: "fetch",
          url,
          ...(resultText !== undefined ? { result: resultText } : {}),
        };
      }
      return {
        type: "read",
        filePath,
        ...(resultText !== undefined ? { content: resultText } : {}),
        ...(typeof nestedInput?.offset === "number" ? { offset: nestedInput.offset } : {}),
        ...(typeof nestedInput?.limit === "number" ? { limit: nestedInput.limit } : {}),
      };
    }
    if (name === "edit" || name === "apply_patch") {
      const perFileResults = Array.isArray(details?.perFileResults)
        ? details.perFileResults.flatMap((result) => {
            const record = jsonRecord(result);
            return record ? [record] : [];
          })
        : [];
      const filePath =
        firstString(nestedInput, "path", "filePath") ??
        firstString(details, "path", "filePath") ??
        firstString(perFileResults[0], "path", "filePath");
      if (!filePath) return { type: "unknown", input: snapshot.input, output: snapshot.output };
      const perFileDiff = perFileResults
        .flatMap((result) => {
          const diff = firstString(result, "unifiedDiff", "diff", "patch");
          return diff ? [diff] : [];
        })
        .join("\n");
      const unifiedDiff =
        firstString(details, "unifiedDiff", "diff", "patch") ??
        firstString(output, "unifiedDiff", "diff", "patch") ??
        (perFileDiff || undefined);
      return {
        type: "edit",
        filePath,
        ...(firstString(nestedInput, "oldString", "old_text")
          ? { oldString: firstString(nestedInput, "oldString", "old_text") }
          : {}),
        ...(firstString(nestedInput, "newString", "new_text")
          ? { newString: firstString(nestedInput, "newString", "new_text") }
          : {}),
        ...(unifiedDiff ? { unifiedDiff } : {}),
      };
    }
    if (name === "write") {
      const filePath = firstString(nestedInput, "path", "filePath");
      if (!filePath) return { type: "unknown", input: snapshot.input, output: snapshot.output };
      return {
        type: "write",
        filePath,
        ...(firstString(nestedInput, "content")
          ? { content: firstString(nestedInput, "content") }
          : {}),
      };
    }
    if (["grep", "glob", "search", "web_search"].includes(name)) {
      const toolName =
        name === "web_search"
          ? "web_search"
          : name === "glob"
            ? "glob"
            : name === "grep"
              ? "grep"
              : "search";
      return {
        type: "search",
        query: firstString(nestedInput, "query", "pattern", "path") ?? "",
        toolName,
        ...(resultText !== undefined ? { content: resultText } : {}),
      };
    }
    if (name === "fetch" || name === "web_fetch") {
      const url = publishableHttpUrl(firstString(nestedInput, "url"));
      if (!url) return { type: "plain_text", label: snapshot.name, text: resultText };
      return {
        type: "fetch",
        url,
        ...(firstString(nestedInput, "prompt")
          ? { prompt: firstString(nestedInput, "prompt") }
          : {}),
        ...(resultText !== undefined ? { result: resultText } : {}),
      };
    }
    if (["task", "agent", "subagent"].includes(name)) {
      return {
        type: "sub_agent",
        ...(firstString(nestedInput, "agent", "name")
          ? { subAgentType: firstString(nestedInput, "agent", "name") }
          : {}),
        ...(firstString(nestedInput, "description", "task")
          ? { description: firstString(nestedInput, "description", "task") }
          : {}),
        log: resultText ?? "",
      };
    }
    if (name === "advisor") {
      return { type: "plain_text", label: "Advisor", text: resultText, icon: "brain" };
    }
    if (name === "todo") {
      return { type: "plan", text: resultText ?? JSON.stringify(snapshot.input) };
    }
    return { type: "unknown", input: snapshot.input, output: snapshot.output };
  }

  private publishGoal(event: Extract<OmpRpcEvent, { type: "goal_updated" }>): void {
    const goal = event.goal ?? event.state?.goal;
    if (goal?.id) {
      const digest = createHash("sha256").update(goal.id).digest("base64url").slice(0, 12);
      this.goalItemId = `omp:goal:${digest}`;
    }
    const id = this.goalItemId ?? "omp:goal";
    const lines = goal
      ? [
          goal.objective || "OMP goal updated.",
          goal.status ? `Status: ${goal.status}` : undefined,
          goal.tokensUsed !== undefined ? `Tokens used: ${goal.tokensUsed}` : undefined,
          goal.tokenBudget !== undefined ? `Token budget: ${goal.tokenBudget}` : undefined,
          goal.timeUsedSeconds !== undefined ? `Time used: ${goal.timeUsedSeconds}s` : undefined,
          event.state?.mode ? `Mode: ${event.state.mode}` : undefined,
          event.state?.reason ? `Reason: ${event.state.reason}` : undefined,
        ]
      : ["OMP goal cleared.", event.state?.reason];
    this.publishStatusItem({
      id,
      name: "omp_goal_updated",
      label: goal?.status ? `OMP goal ${goal.status}` : "OMP goal updated",
      text: lines.filter((line): line is string => Boolean(line)).join("\n"),
      icon: "brain",
      status: "completed",
    });
    if (!goal) this.goalItemId = null;
  }

  private publishAutoRetry(
    event: Extract<OmpRpcEvent, { type: "auto_retry_start" | "auto_retry_end" }>,
  ): void {
    const id = `omp:auto-retry:${event.attempt}`;
    if (event.type === "auto_retry_start") {
      const delay =
        event.delayMs < 1_000
          ? `${event.delayMs}ms`
          : event.delayMs % 1_000 === 0
            ? `${event.delayMs / 1_000}s`
            : `${(event.delayMs / 1_000).toFixed(1)}s`;
      this.publishStatusItem({
        id,
        name: "omp_auto_retry",
        label: `OMP retry ${event.attempt}/${event.maxAttempts}`,
        text: `Retrying in ${delay}: ${event.errorMessage}`,
        icon: "sparkles",
        status: "running",
      });
      return;
    }
    const text = event.finalError ?? (event.success ? "Retry recovered." : "Retry failed.");
    this.publishStatusItem({
      id,
      name: "omp_auto_retry",
      label: event.success
        ? `OMP retry ${event.attempt} recovered`
        : `OMP retry ${event.attempt} failed`,
      text,
      icon: "sparkles",
      status: event.success ? "completed" : "failed",
      ...(event.success ? {} : { error: text }),
    });
  }

  private publishRetryFallback(
    event: Extract<OmpRpcEvent, { type: "retry_fallback_applied" | "retry_fallback_succeeded" }>,
  ): void {
    const role = this.dataFilter.text(event.role, MAX_PUBLIC_TOOL_PAYLOAD_BYTES);
    const digest = createHash("sha256").update(role).digest("base64url").slice(0, 12);
    const id = `omp:retry-fallback:${digest}`;
    if (event.type === "retry_fallback_applied") {
      this.publishStatusItem({
        id,
        name: "omp_retry_fallback",
        label: `OMP fallback applied for ${role}`,
        text: `${event.from} -> ${event.to}`,
        icon: "sparkles",
        status: "running",
      });
      return;
    }
    this.publishStatusItem({
      id,
      name: "omp_retry_fallback",
      label: `OMP fallback succeeded for ${role}`,
      text: `Using ${event.model}`,
      icon: "sparkles",
      status: "completed",
    });
  }

  private publishStatusItem(input: {
    id: string;
    name: string;
    label: string;
    text: string;
    icon: "brain" | "sparkles";
    status: "running" | "completed" | "failed";
    error?: string;
  }): void {
    const detail = {
      type: "plain_text" as const,
      label: this.dataFilter.text(input.label, 4_096),
      text: this.dataFilter.text(input.text, 64 * 1024),
      icon: input.icon,
    };
    if (input.status === "failed") {
      this.publish({
        type: "tool_call",
        id: input.id,
        callId: input.id,
        name: input.name,
        detail,
        status: "failed",
        error: this.dataFilter.text(input.error ?? input.text, 64 * 1024),
      });
      return;
    }
    this.publish({
      type: "tool_call",
      id: input.id,
      callId: input.id,
      name: input.name,
      detail,
      status: input.status,
      error: null,
    });
  }

  private publishImageError(id: string, message: string): void {
    this.publish({ type: "error", id: `${id}:error`, message });
  }

  private publishImages(id: string, label: string, image: NativeImageEnvelope): void {
    this.publish({
      type: "tool_call",
      id: `${id}:images`,
      callId: `${id}:images`,
      name: `${label} images`,
      detail: { type: "plain_text", label },
      metadata: { ompImageOwner: "omp", ompImage: { label, ...image } },
      status: "completed",
      error: null,
    });
  }

  private publishTool(snapshot: ToolSnapshot, status: "running" | "completed"): void;
  private publishTool(snapshot: ToolSnapshot, status: "failed", error: JsonValue): void;
  private publishTool(
    snapshot: ToolSnapshot,
    status: "running" | "completed" | "failed",
    error?: JsonValue,
  ): void {
    const detail = this.toolDetail(snapshot);
    if (status === "failed") {
      this.publish({
        type: "tool_call",
        id: snapshot.publicId,
        callId: snapshot.publicId,
        name: snapshot.name,
        detail,
        status,
        error: error ?? null,
      });
      return;
    }
    this.publish({
      type: "tool_call",
      id: snapshot.publicId,
      callId: snapshot.publicId,
      name: snapshot.name,
      detail,
      status,
      error: null,
    });
  }

  private publish(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.sessionId, item });
  }
}
