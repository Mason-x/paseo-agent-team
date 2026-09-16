import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { isValidImagePayload } from "./image";
import { boundedJsonBytes, OmpCleanupFailure, OmpPublicError, utf8Bytes } from "./security";
import {
  listOmpSessionDescriptors,
  type OmpSessionDescriptor,
  type OmpSessionListOptions,
  readOmpPersistedSubagentTranscript,
  validateNativeSessionId,
} from "./session-descriptors";
import type { OmpOutputRedaction } from "./settings";

const READY_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PROCESS_STOP_TIMEOUT_MS = 750;
const CHUNK_STALE_MS = 30_000;
const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ENCODED_CHUNK_BYTES = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEMANTIC_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_CHUNK_COUNT = MAX_REASSEMBLED_FRAME_BYTES / MAX_CHUNK_BYTES;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_MODEL_SELECTOR_BYTES = MAX_NAME_LENGTH * 2 + 1;
const MAX_CONFIG_EVENT_TEXT_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_STREAM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_SYSTEM_PROMPT_LENGTH = 64 * 1024;
const MAX_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
const MAX_TOOL_PAYLOAD_LENGTH = 256 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_HOST_TOOLS = 256;
const MAX_TOOL_APPROVAL_FRAME_BYTES = 64 * 1024;
const MAX_TOOL_APPROVAL_STRING_BYTES = 8 * 1024;
const MAX_TOOL_APPROVAL_COLLECTION_ITEMS = 32;
const MAX_TOOL_APPROVAL_INPUT_NODES = 256;
const MAX_TOOL_APPROVAL_DEPTH = 4;
const MAX_TOOL_APPROVAL_ID_BYTES = 512;
const MAX_TOOL_APPROVAL_NAME_BYTES = 256;
const MAX_TOOL_APPROVAL_DETAIL_LINES = 16;
const MAX_TOOL_APPROVAL_DETAIL_BYTES = 2 * 1024;
const MAX_TOOL_APPROVAL_METADATA_FIELDS = 33;
const MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES = 64;
const MAX_TOOL_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_TOOL_APPROVAL_PATH_BYTES = 4 * 1024;
const MAX_TOOL_APPROVAL_CONTENT_BYTES = 20 * 1024;
type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_ONE_WAY_WRITES = 256;
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_PARTS = 4_096;
const MAX_ARRAY_ITEMS = 512;
const MAX_CONTENT_PARTS = 64;
const MAX_TODOS = 256;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_VALUE_LENGTH = 64 * 1024;
const MAX_ENV_TOTAL_LENGTH = 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const WINDOWS_DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_COST_USD = 1_000_000_000;
const MAX_RPC_ERROR_BYTES = 4_096;
const MAX_RPC_ERROR_CODE_BYTES = 256;
const PROMPT_SCHEDULING_FAILURE = "OMP prompt scheduling failed";
const MAX_CONTEXT_PERCENT = 1_000_000;
function boundedJsonString(maxBytes: number, minBytes = 0) {
  return z.string().refine((value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
    return bytes >= minBytes && bytes <= maxBytes;
  });
}
function isBoundedToolApprovalId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}

export const OMP_HOST_TOOL_FRAME_LIMIT_ERROR =
  "MCP host tool result exceeds the OMP RPC frame limit";
const MIN_HOST_TOOL_RESULT_FRAME_BYTES = Buffer.byteLength(
  `${JSON.stringify({
    type: "host_tool_result",
    id: "\0".repeat(MAX_ID_LENGTH),
    result: {
      content: [{ type: "text", text: OMP_HOST_TOOL_FRAME_LIMIT_ERROR }],
      details: {},
      isError: true,
    },
    isError: true,
  })}\n`,
);
function boundedString(maxBytes: number, minBytes = 0) {
  return z.string().refine((value) => {
    const bytes = utf8Bytes(value);
    return bytes >= minBytes && bytes <= maxBytes;
  });
}

const IDENTIFIER = boundedString(MAX_ID_LENGTH, 1);
const NAME = boundedString(MAX_NAME_LENGTH, 1);
const OMP_PROVIDER_NAME = NAME.refine((provider) => !provider.includes("/"));
const TEXT = boundedString(MAX_TEXT_LENGTH);
const OmpThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isBoundedJson(
  value: unknown,
  maxBytes = MAX_TOOL_PAYLOAD_LENGTH,
  maxItems = MAX_ARRAY_ITEMS,
  maxNodes = 2_048,
): boolean {
  return (
    boundedJsonBytes(value, maxBytes, maxItems, maxBytes, maxNodes) !== Number.POSITIVE_INFINITY
  );
}

const OmpContentPartSchema = z
  .object({
    type: NAME,
    text: TEXT.optional(),
    thinking: TEXT.optional(),
    data: boundedString(MAX_IMAGE_DATA_LENGTH).optional(),
    mimeType: boundedString(128).optional(),
    id: IDENTIFIER.optional(),
    name: NAME.optional(),
    arguments: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_TOOL_PAYLOAD_LENGTH, 1_024, 4_096))
      .optional(),
  })
  .superRefine((part, context) => {
    if (part.type === "toolCall" && (!part.id || !part.name || part.arguments === undefined)) {
      context.addIssue({ code: "custom", message: "invalid tool call payload" });
      return;
    }
    if (part.type !== "image") return;
    if (
      part.data === undefined ||
      part.mimeType === undefined ||
      !isValidImagePayload(part.data, part.mimeType, MAX_IMAGE_DATA_LENGTH)
    ) {
      context.addIssue({ code: "custom", message: "invalid image payload" });
    }
  });
const OmpDisplayContentSchema = z.union([
  TEXT,
  z.array(OmpContentPartSchema).max(MAX_CONTENT_PARTS),
]);
const OmpImageArraySchema = z
  .array(OmpContentPartSchema)
  .max(MAX_CONTENT_PARTS)
  .superRefine((parts, context) => {
    if (parts.some((part) => part.type !== "image")) {
      context.addIssue({ code: "custom", message: "invalid image collection" });
    }
  });
const OmpMessageIdentityShape = {
  id: IDENTIFIER.optional(),
  entryId: IDENTIFIER.optional(),
  responseId: IDENTIFIER.optional(),
  images: OmpImageArraySchema.optional(),
  timestamp: z.number().finite().optional(),
  details: z
    .unknown()
    .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 4_096))
    .optional(),
};
type OmpContentPart = z.infer<typeof OmpContentPartSchema>;
type OmpMessageIdentity = {
  id?: string;
  entryId?: string;
  responseId?: string;
  images?: OmpContentPart[];
  timestamp?: number;
  details?: unknown;
  display?: boolean;
  customType?: string;
  content?: unknown;
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
};
export type OmpMessage = OmpMessageIdentity &
  (
    | {
        role: "assistant";
        content?: string | OmpContentPart[];
        errorMessage?: string | null;
        stopReason?: string;
      }
    | { role: "user"; content: string | OmpContentPart[] }
    | {
        role: "toolResult";
        toolCallId: string;
        toolName: string;
        content: unknown;
        details?: unknown;
        isError?: boolean;
      }
    | {
        role: "bashExecution";
        command: string;
        output?: string;
        exitCode?: number | null;
        cancelled?: boolean;
        truncated?: boolean;
      }
    | { role: "custom"; customType?: string; content?: unknown; display?: boolean }
  );

const OmpMessageSchema: z.ZodType<OmpMessage> = z.union([
  z.object({
    role: z.literal("assistant"),
    content: OmpDisplayContentSchema.optional(),
    ...OmpMessageIdentityShape,
    errorMessage: boundedString(4_096).nullable().optional(),
    stopReason: boundedString(64).optional(),
  }),
  z.object({
    role: z.literal("user"),
    content: OmpDisplayContentSchema,
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    content: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 8_192)),
    isError: z.boolean().optional(),
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("bashExecution"),
    command: TEXT,
    output: TEXT.optional(),
    exitCode: z.number().int().nullable().optional(),
    cancelled: z.boolean().optional(),
    truncated: z.boolean().optional(),
    ...OmpMessageIdentityShape,
  }),
  z.object({
    role: z.literal("custom"),
    customType: NAME.optional(),
    content: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 8_192))
      .optional(),
    display: z.boolean().optional(),
    ...OmpMessageIdentityShape,
  }),
]);

const OmpAssistantMessageEventSchema = z
  .object({
    type: NAME,
    contentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CONTENT_PARTS - 1)
      .optional(),
    delta: TEXT.optional(),
    content: z
      .unknown()
      .refine((value) => isBoundedJson(value, MAX_IMAGE_DATA_LENGTH + 1_024))
      .optional(),
  })
  .superRefine((event, context) => {
    const content = event.content;
    const imageLike =
      content !== null &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      "type" in content &&
      content.type === "image";
    if (!event.type.startsWith("image_") && !imageLike) return;
    const image = OmpContentPartSchema.safeParse(content);
    if (!image.success || image.data.type !== "image") {
      context.addIssue({ code: "custom", message: "invalid image event" });
    }
  });

const OmpAvailableCommandSchema = z.object({
  name: NAME,
  aliases: z.array(NAME).max(32).optional(),
  description: boundedString(4_096).optional(),
  input: z
    .object({ hint: boundedString(1_024).optional() })
    .nullable()
    .optional(),
  subcommands: z
    .array(
      z.object({
        name: NAME,
        description: boundedString(4_096).optional(),
        usage: boundedString(1_024).optional(),
      }),
    )
    .max(128)
    .optional(),
  source: boundedString(64).optional(),
});
const OmpModelSchema = z.object({
  provider: OMP_PROVIDER_NAME,
  id: NAME,
  name: boundedString(MAX_NAME_LENGTH).optional(),
  reasoning: z.boolean().optional(),
  thinking: z
    .object({
      efforts: z.array(boundedString(32)).max(16).optional(),
      defaultLevel: boundedString(32).optional(),
    })
    .optional(),
  input: z.array(NAME).max(16).optional(),
  contextWindow: z.number().int().nonnegative().max(100_000_000).nullable().optional(),
});
const TokenCountSchema = z.number().int().nonnegative().max(MAX_TOKEN_COUNT);
const OptionalTokenCountSchema = TokenCountSchema.nullable().optional();
const OptionalCostSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(MAX_COST_USD)
  .nullable()
  .optional();
const OmpContextUsageSchema = z.object({
  tokens: OptionalTokenCountSchema,
  contextWindow: TokenCountSchema.max(100_000_000).nullable().optional(),
  percent: z.number().finite().nonnegative().max(MAX_CONTEXT_PERCENT).nullable().optional(),
});
const OmpSessionStatsSchema = z.object({
  userMessages: OptionalTokenCountSchema,
  assistantMessages: OptionalTokenCountSchema,
  toolCalls: OptionalTokenCountSchema,
  toolResults: OptionalTokenCountSchema,
  totalMessages: OptionalTokenCountSchema,
  tokens: z
    .object({
      input: OptionalTokenCountSchema,
      output: OptionalTokenCountSchema,
      reasoning: OptionalTokenCountSchema,
      cacheRead: OptionalTokenCountSchema,
      cacheWrite: OptionalTokenCountSchema,
      total: OptionalTokenCountSchema,
    })
    .nullable()
    .optional(),
  cost: OptionalCostSchema,
  premiumRequests: OptionalTokenCountSchema,
  credits: z
    .object({
      cost: OptionalCostSchema,
      committedCost: OptionalCostSchema,
      acuCost: OptionalCostSchema,
    })
    .nullable()
    .optional(),
  routedModels: z.record(NAME, OptionalTokenCountSchema).nullable().optional(),
  contextUsage: OmpContextUsageSchema.nullable().optional(),
});
const OmpCompactionResultSchema = z.object({
  tokensBefore: OptionalTokenCountSchema,
  preTokens: OptionalTokenCountSchema,
});
const OmpSessionStateSchema = z.object({
  model: OmpModelSchema.nullable().optional(),
  thinkingLevel: OmpThinkingLevelSchema.optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  sessionId: IDENTIFIER,
  autoCompactionEnabled: z.boolean().optional(),
  contextUsage: OmpContextUsageSchema.nullable().optional(),
  sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
});
const OmpReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.number().int().positive().max(16).optional(),
  supportedProtocolVersions: z.array(z.number().int().positive().max(16)).max(8).optional(),
  maxFrameBytes: z.number().int().positive().optional(),
  maxReassembledFrameBytes: z.number().int().positive().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});
const OmpResponseFrameSchema = z.object({
  type: z.literal("response"),
  id: IDENTIFIER,
  success: z.boolean(),
  data: z.unknown().optional(),
  error: boundedString(MAX_RPC_ERROR_BYTES).optional(),
  code: boundedString(MAX_RPC_ERROR_CODE_BYTES, 1).optional(),
});
const OmpChunkFrameSchema = z.object({
  type: z.literal("rpc_chunk"),
  chunkId: IDENTIFIER,
  index: z.number().int().nonnegative(),
  count: z.number().int().positive().max(MAX_CHUNK_COUNT),
  byteLength: z.number().int().nonnegative().max(MAX_REASSEMBLED_FRAME_BYTES),
  data: boundedString(MAX_ENCODED_CHUNK_BYTES),
});
const JsonObjectSchema = z.record(z.string(), z.unknown());
const BoundedToolPayloadSchema = z
  .unknown()
  .refine((value) => isBoundedJson(value, MAX_SEMANTIC_FRAME_BYTES, 1_024, 4_096));
const OmpHostToolDefinitionSchema = z.object({
  name: NAME,
  label: NAME.optional(),
  description: boundedString(MAX_TEXT_LENGTH),
  loadMode: z.enum(["essential", "discoverable"]).optional(),
  parameters: JsonObjectSchema,
});
const OmpHostToolCallSchema = z.object({
  type: z.literal("host_tool_call"),
  id: IDENTIFIER,
  toolCallId: IDENTIFIER,
  toolName: NAME,
  arguments: JsonObjectSchema,
});
const OmpHostToolCancelSchema = z.object({
  type: z.literal("host_tool_cancel"),
  id: IDENTIFIER,
  targetId: IDENTIFIER,
});
const OmpHostToolContentSchema = z.object({ type: NAME, text: TEXT.optional() }).passthrough();
const OmpHostToolAgentResultSchema = z.object({
  content: z.array(OmpHostToolContentSchema).max(MAX_ARRAY_ITEMS),
  details: BoundedToolPayloadSchema.optional(),
  isError: z.boolean().optional(),
});
const OmpHostToolResultSchema = z.object({
  type: z.literal("host_tool_result"),
  id: IDENTIFIER,
  result: OmpHostToolAgentResultSchema,
  isError: z.boolean().optional(),
});
const OmpHostToolUpdateSchema = z.object({
  type: z.literal("host_tool_update"),
  id: IDENTIFIER,
  partialResult: OmpHostToolAgentResultSchema,
});
const OmpToolApprovalIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), command: boundedJsonString(24 * 1024, 1) }).strict(),
  z
    .object({
      kind: z.literal("edit"),
      paths: z.array(boundedJsonString(MAX_TOOL_APPROVAL_PATH_BYTES, 1)).min(1).max(16),
      content: boundedJsonString(MAX_TOOL_APPROVAL_CONTENT_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("write"),
      path: boundedJsonString(MAX_TOOL_APPROVAL_PATH_BYTES, 1),
      content: boundedJsonString(MAX_TOOL_APPROVAL_CONTENT_BYTES),
    })
    .strict(),
  z.object({ kind: z.literal("other") }).strict(),
]);
type OmpToolApprovalValue =
  | string
  | number
  | boolean
  | null
  | OmpToolApprovalValue[]
  | { [key: string]: OmpToolApprovalValue };
const OmpToolApprovalValueSchema: z.ZodType<OmpToolApprovalValue> = z.lazy(() =>
  z.union([
    boundedString(MAX_TOOL_APPROVAL_STRING_BYTES),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(OmpToolApprovalValueSchema).max(MAX_TOOL_APPROVAL_COLLECTION_ITEMS),
    z.record(boundedString(128, 1), OmpToolApprovalValueSchema),
  ]),
);
function approvalInputWithinBounds(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_TOOL_APPROVAL_INPUT_NODES) return false;
    if (current.value === null || typeof current.value !== "object") continue;
    if (current.depth >= MAX_TOOL_APPROVAL_DEPTH) return false;
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}
const OmpToolApprovalRequestSchema = z
  .object({
    type: z.literal("tool_approval_request"),
    id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    toolKind: z.enum(["shell", "edit", "write", "other"]),
    toolName: boundedString(MAX_TOOL_APPROVAL_NAME_BYTES, 1),
    tier: z.enum(["read", "write", "exec"]),
    identity: OmpToolApprovalIdentitySchema,
    input: z
      .record(boundedString(128, 1), OmpToolApprovalValueSchema)
      .refine(approvalInputWithinBounds),
    detail: z
      .object({
        lines: z
          .array(boundedString(MAX_TOOL_APPROVAL_DETAIL_BYTES))
          .max(MAX_TOOL_APPROVAL_DETAIL_LINES),
        truncated: z.boolean(),
        truncatedFields: z
          .array(boundedString(MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES))
          .max(MAX_TOOL_APPROVAL_METADATA_FIELDS),
        redacted: z.boolean(),
        redactedFields: z
          .array(boundedString(MAX_TOOL_APPROVAL_METADATA_FIELD_BYTES))
          .max(MAX_TOOL_APPROVAL_METADATA_FIELDS),
        reason: boundedString(MAX_TOOL_APPROVAL_DETAIL_BYTES).optional(),
        providerSafetyChecks: z
          .array(boundedString(MAX_TOOL_APPROVAL_DETAIL_BYTES))
          .max(MAX_TOOL_APPROVAL_DETAIL_LINES)
          .optional(),
      })
      .strict(),
    timeout: z.number().finite().nonnegative().max(MAX_TOOL_APPROVAL_TIMEOUT_MS).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.toolKind !== request.identity.kind) {
      context.addIssue({ code: "custom", message: "tool approval identity kind mismatch" });
    }
    if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > MAX_TOOL_APPROVAL_FRAME_BYTES) {
      context.addIssue({ code: "custom", message: "tool approval request exceeds bounds" });
    }
  });
const OmpToolApprovalCancelSchema = z
  .object({
    type: z.literal("tool_approval_cancel"),
    id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    targetId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
    toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
  })
  .strict();
const OmpToolApprovalResponseSchema = z.union([
  z
    .object({
      type: z.literal("tool_approval_response"),
      id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      approved: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_approval_response"),
      id: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      toolCallId: boundedString(MAX_TOOL_APPROVAL_ID_BYTES, 1),
      cancelled: z.literal(true),
      timedOut: z.boolean().optional(),
    })
    .strict(),
]);
const OmpAgentEndEnvelopeSchema = z.object({
  type: z.literal("agent_end"),
  messageCount: z.number().int().nonnegative().optional(),
  isTerminal: z.boolean().optional(),
});
const OmpCompactionStartSchema = z.object({
  type: z.literal("compaction_start"),
  reason: boundedString(4_096).optional(),
});
const OmpCompactionEndSchema = z.object({
  type: z.literal("compaction_end"),
  reason: boundedString(4_096).optional(),
  result: BoundedToolPayloadSchema.optional(),
  aborted: z.boolean().optional(),
  willRetry: z.boolean().optional(),
  errorMessage: boundedString(4_096).optional(),
  skipped: z.boolean().optional(),
});
const OmpAgentSessionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({
    type: z.literal("agent_end"),
    messages: z.array(OmpMessageSchema).max(MAX_ARRAY_ITEMS).optional(),
    messageCount: z.number().int().nonnegative().optional(),
    isTerminal: z.boolean().optional(),
  }),
  z.object({ type: z.literal("turn_start") }),
  z.object({ type: z.literal("turn_end") }),
  z.object({ type: z.literal("message_start"), message: OmpMessageSchema }),
  z.object({
    type: z.literal("message_update"),
    message: OmpMessageSchema,
    assistantMessageEvent: OmpAssistantMessageEventSchema.optional(),
  }),
  z.object({ type: z.literal("message_end"), message: OmpMessageSchema }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    args: BoundedToolPayloadSchema,
  }),
  z.object({
    type: z.literal("tool_execution_update"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    args: BoundedToolPayloadSchema.optional(),
    partialResult: BoundedToolPayloadSchema,
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: IDENTIFIER,
    toolName: NAME,
    result: BoundedToolPayloadSchema,
    isError: z.boolean().optional(),
  }),
  OmpCompactionStartSchema,
  OmpCompactionEndSchema,
]);
const OmpGoalSchema = z.object({
  id: IDENTIFIER.optional(),
  objective: TEXT.optional(),
  status: boundedString(256).optional(),
  tokenBudget: z.number().finite().nonnegative().optional(),
  tokensUsed: z.number().finite().nonnegative().optional(),
  timeUsedSeconds: z.number().finite().nonnegative().optional(),
  createdAt: boundedString(128).optional(),
  updatedAt: boundedString(128).optional(),
});
const OmpGoalModeStateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: boundedString(256).optional(),
  reason: boundedString(4_096).optional(),
  goal: OmpGoalSchema.optional(),
});
const OmpSubagentStatusSchema = z.enum([
  "pending",
  "running",
  "started",
  "completed",
  "failed",
  "aborted",
]);
const OmpSubagentLifecyclePayloadSchema = z.object({
  id: IDENTIFIER,
  agent: NAME,
  agentSource: NAME.optional(),
  description: boundedString(64 * 1024).optional(),
  status: OmpSubagentStatusSchema,
  sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
  parentToolCallId: IDENTIFIER.optional(),
  index: z.number().int().nonnegative().max(10_000),
  detached: z.boolean().optional(),
});
const OmpSubagentProgressSchema = z.object({
  id: IDENTIFIER,
  status: OmpSubagentStatusSchema,
  description: boundedString(64 * 1024).optional(),
  currentTool: BoundedToolPayloadSchema.optional(),
  recentTools: z.array(BoundedToolPayloadSchema).max(64).optional(),
  recentOutput: z.array(BoundedToolPayloadSchema).max(128).optional(),
  resolvedModel: NAME.optional(),
});
const OmpSubagentProgressPayloadSchema = z.object({
  index: z.number().int().nonnegative().max(10_000),
  agent: NAME,
  agentSource: NAME.optional(),
  task: TEXT,
  parentToolCallId: IDENTIFIER.optional(),
  assignment: TEXT.optional(),
  progress: OmpSubagentProgressSchema,
  sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
  detached: z.boolean().optional(),
});
const ExtensionUiBase = { type: z.literal("extension_ui_request"), id: IDENTIFIER };
const OmpExtensionUiRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("select"),
      title: boundedString(4_096),
      options: z.array(boundedString(4_096)).min(1).max(128),
      optionDetails: z
        .array(z.object({ description: boundedString(16_384).optional() }).strict())
        .max(128)
        .optional(),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict()
    .superRefine((request, context) => {
      if (request.optionDetails && request.optionDetails.length !== request.options.length) {
        context.addIssue({ code: "custom", message: "invalid extension UI request" });
      }
    }),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("confirm"),
      title: boundedString(4_096),
      message: boundedString(64 * 1024),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("input"),
      title: boundedString(4_096),
      placeholder: boundedString(4_096).optional(),
      prefill: TEXT.optional(),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("editor"),
      title: boundedString(4_096),
      prefill: TEXT.optional(),
      promptStyle: z.boolean().optional(),
      timeout: z.number().nonnegative().finite().optional(),
    })
    .strict(),
  z.object({ ...ExtensionUiBase, method: z.literal("cancel"), targetId: IDENTIFIER }).strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("notify"),
      message: boundedString(64 * 1024),
      notifyType: z.enum(["info", "warning", "error"]).optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("setStatus"),
      statusKey: NAME,
      statusText: boundedString(16_384).optional(),
    })
    .strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("setWidget"),
      widgetKey: NAME,
      widgetLines: z.array(boundedString(16_384)).max(128).optional(),
      widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
    })
    .strict(),
  z
    .object({ ...ExtensionUiBase, method: z.literal("setTitle"), title: boundedString(4_096) })
    .strict(),
  z.object({ ...ExtensionUiBase, method: z.literal("set_editor_text"), text: TEXT }).strict(),
  z
    .object({
      ...ExtensionUiBase,
      method: z.literal("open_url"),
      url: boundedString(16_384),
      launchUrl: boundedString(16_384).optional(),
      instructions: boundedString(64 * 1024).optional(),
    })
    .strict(),
]);
const OmpRuntimeEventSchema = z.discriminatedUnion("type", [
  ...OmpAgentSessionEventSchema.options,
  z.object({
    type: z.literal("subagent_lifecycle"),
    payload: OmpSubagentLifecyclePayloadSchema,
  }),
  z.object({
    type: z.literal("subagent_progress"),
    payload: OmpSubagentProgressPayloadSchema,
  }),
  z.object({
    type: z.literal("subagent_event"),
    payload: z.object({ id: IDENTIFIER, event: OmpAgentSessionEventSchema }),
  }),
  z.object({
    type: z.literal("todo_reminder"),
    todos: z
      .array(
        z.object({
          id: IDENTIFIER.optional(),
          content: boundedString(16_384),
          status: z.enum(["pending", "in_progress", "blocked", "completed", "abandoned"]),
        }),
      )
      .max(MAX_TODOS),
  }),
  z.object({ type: z.literal("model_changed") }),
  z.object({
    type: z.literal("thinking_level_changed"),
    thinkingLevel: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES).optional(),
  }),
  z.object({
    type: z.literal("goal_updated"),
    goal: OmpGoalSchema.nullable().optional(),
    state: OmpGoalModeStateSchema.optional(),
  }),
  z.object({
    type: z.literal("auto_retry_start"),
    attempt: z.number().int().nonnegative().safe(),
    maxAttempts: z.number().int().positive().safe(),
    delayMs: z.number().int().nonnegative().safe(),
    errorMessage: boundedString(64 * 1024),
    errorId: z.number().int().safe().optional(),
  }),
  z.object({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    attempt: z.number().int().nonnegative().safe(),
    finalError: boundedString(64 * 1024).optional(),
    recoveredErrors: BoundedToolPayloadSchema.optional(),
  }),
  z.object({
    type: z.literal("retry_fallback_applied"),
    from: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
    to: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
    role: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
  }),
  z.object({
    type: z.literal("retry_fallback_succeeded"),
    model: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
    role: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
  }),
  z.object({ type: z.literal("todo_auto_clear") }),
  z.object({
    type: z.literal("auto_compaction_start"),
    reason: boundedString(4_096),
    action: boundedString(MAX_CONFIG_EVENT_TEXT_BYTES),
  }),
  z.object({
    type: z.literal("auto_compaction_end"),
    action: NAME.optional(),
    result: OmpCompactionResultSchema.nullable().optional(),
    aborted: z.boolean().optional(),
    willRetry: z.boolean().optional(),
    errorMessage: boundedString(64 * 1024).optional(),
    skipped: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("available_commands_update"),
    commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
  }),
  z.object({
    type: z.literal("notice"),
    id: IDENTIFIER.optional(),
    level: z.enum(["info", "warning", "error"]),
    message: boundedString(64 * 1024),
    source: boundedString(MAX_NAME_LENGTH).optional(),
  }),
  z.object({ type: z.literal("command_output"), text: TEXT.optional() }),
  OmpExtensionUiRequestSchema,
  z.object({
    type: z.literal("prompt_result"),
    id: IDENTIFIER.optional(),
    agentInvoked: z.boolean(),
  }),
  OmpHostToolCallSchema,
  OmpHostToolCancelSchema,
  OmpToolApprovalRequestSchema,
  OmpToolApprovalCancelSchema,
  z.object({ type: z.literal("advisor_yielded") }),
]);
const OmpModelsResultSchema = z.object({
  models: z.array(OmpModelSchema).min(1).max(256),
});
const OmpPromptAckSchema = z.object({ agentInvoked: z.boolean().optional() }).optional();
const OmpAvailableCommandsResultSchema = z.object({
  commands: z.array(OmpAvailableCommandSchema).max(MAX_ARRAY_ITEMS),
});
const OmpBranchMessagesResultSchema = z.object({
  messages: z.array(z.object({ entryId: IDENTIFIER, text: TEXT })).max(1_024),
});
const OmpBranchResultSchema = z.object({ text: TEXT, cancelled: z.boolean() });
const OmpMessagesResultSchema = z.object({
  messages: z.array(OmpMessageSchema).max(100_000),
});
const OmpSubagentsResultSchema = z.object({
  subagents: z
    .array(
      z.object({
        id: IDENTIFIER,
        index: z.number().int().nonnegative().max(10_000),
        agent: NAME,
        agentSource: NAME.optional(),
        description: TEXT.optional(),
        status: OmpSubagentStatusSchema,
        task: TEXT.optional(),
        assignment: TEXT.optional(),
        sessionFile: boundedString(MAX_PATH_LENGTH).optional(),
        lastUpdate: z.number().finite().nonnegative(),
        parentToolCallId: IDENTIFIER.optional(),
      }),
    )
    .max(1_024),
});
const OmpSubagentMessagesResultSchema = z.object({
  sessionFile: boundedString(MAX_PATH_LENGTH),
  fromByte: z.number().int().nonnegative(),
  nextByte: z.number().int().nonnegative(),
  reset: z.boolean(),
  messages: z.array(OmpMessageSchema).max(100_000),
});
const ProtocolNegotiationResultSchema = z.object({
  protocolVersion: z.literal(2),
  clientCapabilities: z.object({ typedToolApprovals: z.literal(1).optional() }).optional(),
});

export type OmpModel = z.infer<typeof OmpModelSchema>;
export type OmpSessionState = z.infer<typeof OmpSessionStateSchema>;
export type OmpSessionStats = z.infer<typeof OmpSessionStatsSchema>;
export type OmpCompactionResult = z.infer<typeof OmpCompactionResultSchema>;
export type OmpHostToolDefinition = z.infer<typeof OmpHostToolDefinitionSchema>;
export type OmpHostToolCall = z.infer<typeof OmpHostToolCallSchema>;
export type OmpHostToolResult = z.infer<typeof OmpHostToolResultSchema>;
export type OmpHostToolUpdate = z.infer<typeof OmpHostToolUpdateSchema>;
export type OmpToolApprovalRequest = z.infer<typeof OmpToolApprovalRequestSchema>;
export type OmpToolApprovalCancel = z.infer<typeof OmpToolApprovalCancelSchema>;
export type OmpToolApprovalResponse = z.infer<typeof OmpToolApprovalResponseSchema>;
export function parseOmpHostToolAgentResult(value: unknown): OmpHostToolResult["result"] {
  return OmpHostToolAgentResultSchema.parse(value);
}
export type OmpRpcEvent =
  | z.infer<typeof OmpRuntimeEventSchema>
  | { type: "prompt_error"; id: string; error: string; code?: string }
  | { type: "process_exit"; error: string };
export type OmpAgentSessionEvent = z.infer<typeof OmpAgentSessionEventSchema>;
export type OmpSubagentSnapshot = z.infer<typeof OmpSubagentsResultSchema>["subagents"][number];
export type OmpSubagentEvent = Extract<
  z.infer<typeof OmpRuntimeEventSchema>,
  { type: "subagent_lifecycle" | "subagent_progress" | "subagent_event" }
>;
export interface OmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: OmpMessage[];
}
export interface OmpPersistedSubagentMessages {
  sessionFile: string;
  nativeSessionId: string;
  byteLength: number;
  messages: OmpMessage[];
}

export interface OmpStartOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  outputRedaction?: OmpOutputRedaction;
  inheritEnv?: readonly string[];
  /** Server-owned environment source; tests provide isolated roots instead of ambient process.env. */
  environment?: NodeJS.ProcessEnv;
  command?: readonly string[];
  model?: string;
  mode?: "full" | "write" | "ask";
  thinkingOption?: string;
  systemPrompt?: string;
  roleModels?: Readonly<{ smol?: string; slow?: string; plan?: string }>;
  tools?: readonly string[];
  sessionDir?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Resume this exact native OMP session; never use this to start a new conversation. */
  resumeSessionId?: string;
  noSession?: boolean;
  signal?: AbortSignal;
}

export type OmpAvailableCommand = z.infer<typeof OmpAvailableCommandSchema>;
export type OmpImage = { type: "image"; data: string; mimeType: string };
export type OmpExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

export interface OmpRuntimeSession {
  readonly maxHostToolFrameBytes?: number;
  /** Maximum bytes accepted for one unchunked stdin JSONL frame, including its newline. */
  readonly maxInputFrameBytes?: number;
  readonly supportsTypedToolApprovals: boolean;
  onEvent(listener: (event: OmpRpcEvent) => void): () => void;
  getState(): Promise<OmpSessionState>;
  getSessionStats(): Promise<OmpSessionStats>;
  getAvailableModels(): Promise<OmpModel[]>;
  getAvailableCommands(): Promise<OmpAvailableCommand[]>;
  setSubagentSubscription(level: "events"): Promise<void>;
  readonly inheritedRedactionValues?: readonly string[];
  getSubagents(): Promise<OmpSubagentSnapshot[]>;
  getSubagentMessages(selector: {
    subagentId?: string;
    sessionFile?: string;
  }): Promise<OmpSubagentMessagesResult>;
  prompt(
    message: string,
    images?: readonly OmpImage[],
    onAccepted?: () => void,
  ): Promise<{ requestId: string; agentInvoked?: boolean }>;
  compact(customInstructions?: string): Promise<OmpCompactionResult>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: string): Promise<void>;
  steer(message: string, images?: readonly OmpImage[]): Promise<void>;
  followUp(message: string, images?: readonly OmpImage[]): Promise<void>;
  handoff(customInstructions?: string): Promise<void>;
  respondToExtensionUi(response: OmpExtensionUiResponse): Promise<void>;
  respondToToolApproval(response: OmpToolApprovalResponse): Promise<void>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  branch(entryId: string): Promise<{ text: string; cancelled: boolean }>;
  readonly canReplayHistory: boolean;
  getMessages(): Promise<OmpMessage[]>;
  abort(): Promise<void>;
  setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpHostToolResult): void;
  sendHostToolUpdate(update: OmpHostToolUpdate): void;
  close(): Promise<void>;
}

export interface OmpRuntime {
  readonly supportsPersistence: boolean;
  startSession(options: OmpStartOptions): Promise<OmpRuntimeSession>;
  listSessions(options: OmpSessionListOptions): Promise<OmpSessionDescriptor[]>;
  readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSubagentMessages>;
}

export interface OmpSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  inheritedRedactionValues: string[];
}

export interface OmpRpcRuntimeOptions {
  spawnProcess?: (request: OmpSpawnRequest) => ChildProcessWithoutNullStreams;
  terminateProcessTree?: (pid: number) => Promise<boolean | "uncertain">;
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  listSessions?: (
    options: OmpSessionListOptions,
  ) => OmpSessionDescriptor[] | Promise<OmpSessionDescriptor[]>;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: TimerHandle;
  command: string;
  beforeResolve?: (value: unknown) => void;
};
type StartedRequest = { id: string; promise: Promise<unknown> };

type ReadyFrame = z.infer<typeof OmpReadyFrameSchema>;
type ChunkFrame = z.infer<typeof OmpChunkFrameSchema>;

type ChunkState = {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
  receivedBytes: number;
  timer: TimerHandle;
};

// The daemon contributes only process/runtime discovery variables plus provider authentication
// families. Session-scoped values are explicit host input and are overlaid after rejecting loader
// and executable-resolution controls; this keeps provider credentials available without copying
const INHERITED_RUNTIME_ENV: Readonly<Record<string, true>> = {
  ALL_PROXY: true,
  APPDATA: true,
  COLORTERM: true,
  HOME: true,
  HTTPS_PROXY: true,
  HTTP_PROXY: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LOCALAPPDATA: true,
  LOGNAME: true,
  NO_PROXY: true,
  OMP_PROFILE: true,
  PATH: true,
  PATHEXT: true,
  PI_CODING_AGENT_DIR: true,
  PI_CONFIG_DIR: true,
  PI_PROFILE: true,
  SHELL: true,
  SSH_AUTH_SOCK: true,
  SSL_CERT_DIR: true,
  SSL_CERT_FILE: true,
  SYSTEMROOT: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  TZ: true,
  USER: true,
  USERPROFILE: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
  XDG_RUNTIME_DIR: true,
};
const INHERITED_PROVIDER_AUTH_ENV: Readonly<Record<string, true>> = {
  AI_GATEWAY_API_KEY: true,
  AIAND_API_KEY: true,
  ALIBABA_CODING_PLAN_API_KEY: true,
  ALIBABA_TOKEN_PLAN_API_KEY: true,
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_FOUNDRY_API_KEY: true,
  ANTHROPIC_OAUTH_TOKEN: true,
  AWS_ACCESS_KEY_ID: true,
  AWS_DEFAULT_REGION: true,
  AWS_PROFILE: true,
  AWS_REGION: true,
  AWS_SECRET_ACCESS_KEY: true,
  AWS_SESSION_TOKEN: true,
  AZURE_CLIENT_ID: true,
  AZURE_CLIENT_SECRET: true,
  AZURE_OPENAI_API_KEY: true,
  AZURE_OPENAI_ENDPOINT: true,
  AZURE_TENANT_ID: true,
  BAILIAN_TOKEN_PLAN_API_KEY: true,
  BASETEN_API_KEY: true,
  CEREBRAS_API_KEY: true,
  CHARM_HYPER_API_KEY: true,
  CLINE_API_KEY: true,
  CLOUDFLARE_AI_GATEWAY_API_KEY: true,
  COHERE_API_KEY: true,
  COMMAND_CODE_API_KEY: true,
  COREWEAVE_API_KEY: true,
  CURSOR_ACCESS_TOKEN: true,
  DEEPINFRA_API_KEY: true,
  DEEPSEEK_API_KEY: true,
  DEVIN_API_KEY: true,
  FIREPASS_API_KEY: true,
  FIREWORKS_API_KEY: true,
  FUGU_API_KEY: true,
  GEMINI_API_KEY: true,
  GMI_API_KEY: true,
  GOOGLE_API_KEY: true,
  GOOGLE_APPLICATION_CREDENTIALS: true,
  GROQ_API_KEY: true,
  HF_TOKEN: true,
  HUGGINGFACE_HUB_TOKEN: true,
  LLAMA_CPP_API_KEY: true,
  LM_STUDIO_API_KEY: true,
  META_API_KEY: true,
  MINIMAX_API_KEY: true,
  MINIMAX_CODE_API_KEY: true,
  MINIMAX_CODE_CN_API_KEY: true,
  MISTRAL_API_KEY: true,
  MODEL_API_KEY: true,
  MOONSHOT_API_KEY: true,
  NANO_GPT_API_KEY: true,
  NVIDIA_API_KEY: true,
  NOVITA_API_KEY: true,
  OLLAMA_API_KEY: true,
  OLLAMA_CLOUD_API_KEY: true,
  OLLAMA_HOST: true,
  OMP_AUTH_BROKER_TOKEN: true,
  OMP_AUTH_BROKER_URL: true,
  OPENCODE_API_KEY: true,
  OPENAI_API_KEY: true,
  OPENAI_CODEX_OAUTH_TOKEN: true,
  OPENROUTER_API_KEY: true,
  PLEXUS_API_KEY: true,
  QIANFAN_API_KEY: true,
  QWEN_OAUTH_TOKEN: true,
  QWEN_PORTAL_API_KEY: true,
  SAKANA_API_KEY: true,
  SILICONFLOW_API_KEY: true,
  SILICONFLOW_CN_API_KEY: true,
  SYNTHETIC_API_KEY: true,
  TOGETHER_API_KEY: true,
  UMANS_AI_CODING_PLAN_API_KEY: true,
  VENICE_API_KEY: true,
  VLLM_API_KEY: true,
  WAFER_SERVERLESS_API_KEY: true,
  WANDB_API_KEY: true,
  XAI_API_KEY: true,
  XAI_OAUTH_TOKEN: true,
  XIAOMI_API_KEY: true,
  XIAOMI_TOKEN_PLAN_AMS_API_KEY: true,
  XIAOMI_TOKEN_PLAN_CN_API_KEY: true,
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: true,
  YOLO_AUTO_API_KEY: true,
  ZAI_API_KEY: true,
  ZENMUX_API_KEY: true,
  ZHIPU_API_KEY: true,
};
const BLOCKED_SESSION_ENV =
  /^(?:BASH_ENV|BUN_INSTALL.*|BUN_OPTIONS|CLASSPATH|CLAUDE_BASH_NO_CI|CLAUDE_BASH_NO_LOGIN|CLAUDE_CODE_SHELL_PREFIX|DYLD_.*|EDITOR|ELECTRON_RUN_AS_NODE|ENV|GEM_HOME|GEM_PATH|GIT_CONFIG.*|GIT_SSH_COMMAND|HOME|JAVA_TOOL_OPTIONS|LD_.*|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_.*|OMP_AUTORESEARCH_DB_DIR|OMP_COMMAND|OMP_GITHUB_CACHE_DB|OMP_PROFILE|OMP_WORKTREE_DIR|PATH|PATHEXT|PERL5LIB|PERL5OPT|PI_BASH_NO_CI|PI_BASH_NO_LOGIN|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_CONFIG_DIR|PI_CONFIG_FILES|PI_GIT_COMMON_DIR|PI_PACKAGE_DIR|PI_PROFILE|PI_PROJECT_DIR|PI_SESSION_ID|PI_SHELL_PREFIX|PI_SUBPROCESS_CMD|PI_WORKTREE_DIR|PWD|PYTHONHOME|PYTHONINSPECT|PYTHONPATH|PYTHONSTARTUP|RUBYLIB|RUBYOPT|SHELL|SYSTEMROOT|USERPROFILE|VISUAL|XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|XDG_STATE_HOME|_JAVA_OPTIONS)$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

function validateBoundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) === 0 ||
    utf8Bytes(value) > maxBytes ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid OMP ${field}`);
  }
  return value;
}

function inheritedEnvironmentNames(inheritEnv: readonly string[] | undefined): ReadonlySet<string> {
  if (inheritEnv === undefined) return new Set();
  if (!Array.isArray(inheritEnv)) {
    throw new Error("OMP inherited environment names are invalid");
  }
  if (inheritEnv.length > MAX_ENV_ENTRIES) {
    throw new Error("OMP inherited environment has too many entries");
  }
  const names = new Set<string>();
  for (const name of inheritEnv) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      throw new Error("OMP inherited environment contains an invalid name");
    }
    if (BLOCKED_SESSION_ENV.test(name.toUpperCase())) {
      throw new Error("OMP inherited environment contains a forbidden variable");
    }
    names.add(name);
  }
  return names;
}

function buildOmpEnvironment(
  sessionEnv: Readonly<Record<string, string>> | undefined,
  inheritEnv: readonly string[] | undefined,
  sourceEnv: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; inheritedRedactionValues: string[] } {
  if (
    sessionEnv !== undefined &&
    (sessionEnv === null || typeof sessionEnv !== "object" || Array.isArray(sessionEnv))
  ) {
    throw new Error("OMP session environment is invalid");
  }
  const explicitlyInherited = inheritedEnvironmentNames(inheritEnv);
  const explicitlyInheritedNormalized = new Set(
    [...explicitlyInherited].map((name) => name.toUpperCase()),
  );
  const explicitNames = new Set(Object.keys(sessionEnv ?? {}).map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  const inheritedRedactionValues: string[] = [];
  let totalBytes = 0;
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value === undefined || name.toUpperCase() === "OMP_COMMAND") continue;
    const normalizedName = name.toUpperCase();
    const isRuntime =
      process.platform === "win32"
        ? normalizedName in INHERITED_RUNTIME_ENV
        : name in INHERITED_RUNTIME_ENV;
    const isProviderAuth =
      process.platform === "win32"
        ? normalizedName in INHERITED_PROVIDER_AUTH_ENV
        : name in INHERITED_PROVIDER_AUTH_ENV;
    const isExplicitlyInherited =
      process.platform === "win32"
        ? explicitlyInheritedNormalized.has(normalizedName)
        : explicitlyInherited.has(name);
    if (!isRuntime && !isProviderAuth && !isExplicitlyInherited) continue;
    if (explicitNames.has(normalizedName)) continue;
    const valueBytes = utf8Bytes(value);
    if (!ENV_NAME.test(name) || valueBytes > MAX_ENV_VALUE_LENGTH || value.includes("\0")) {
      if (isExplicitlyInherited) {
        throw new Error("OMP inherited environment contains an invalid value");
      }
      continue;
    }
    if (isExplicitlyInherited && valueBytes > 0 && valueBytes < 4) {
      throw new OmpPublicError("OMP inherited environment value is too short for safe redaction");
    }
    totalBytes += utf8Bytes(name) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_LENGTH) {
      throw new Error("OMP inherited environment is too large");
    }
    env[name] = value;
    if (isExplicitlyInherited && valueBytes > 0) inheritedRedactionValues.push(value);
  }
  let entryCount = 0;
  for (const name in sessionEnv ?? {}) {
    if (!Object.hasOwn(sessionEnv ?? {}, name)) continue;
    entryCount += 1;
    if (entryCount > MAX_ENV_ENTRIES)
      throw new Error("OMP session environment has too many entries");
    const value = (sessionEnv as Readonly<Record<string, string>>)[name];
    const normalizedName = name.toUpperCase();
    if (!ENV_NAME.test(name) || BLOCKED_SESSION_ENV.test(normalizedName)) {
      throw new Error("OMP session environment contains a forbidden variable");
    }
    if (
      typeof value !== "string" ||
      utf8Bytes(value) > MAX_ENV_VALUE_LENGTH ||
      value.includes("\0")
    ) {
      throw new Error("OMP session environment contains an invalid value");
    }
    const valueBytes = utf8Bytes(value);
    totalBytes += utf8Bytes(name) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_LENGTH) throw new Error("OMP session environment is too large");
    for (const inheritedName of Object.keys(env)) {
      if (inheritedName !== name && inheritedName.toUpperCase() === normalizedName) {
        delete env[inheritedName];
      }
    }
    env[name] = value;
  }
  return { env, inheritedRedactionValues };
}

export function buildOmpSpawnRequest(
  options: OmpStartOptions,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): OmpSpawnRequest {
  const environmentSource = options.environment ?? sourceEnv;
  const cwd = validateBoundedText(options.cwd, "working directory", MAX_PATH_LENGTH);
  if (!isAbsolute(cwd)) throw new Error("OMP working directory must be absolute");
  const commandPrefix = options.command ?? [environmentSource.OMP_COMMAND ?? "omp"];
  if (commandPrefix.length === 0) throw new Error("Invalid OMP command");
  const [rawCommand, ...rawPrefixArgs] = commandPrefix;
  const command = validateBoundedText(rawCommand, "command", MAX_PATH_LENGTH);
  const args = rawPrefixArgs.map((argument) =>
    validateBoundedText(argument, "command argument", MAX_PATH_LENGTH),
  );
  if (/[\r\n]/u.test(command)) throw new Error("Invalid OMP command");
  const mode = options.mode ?? "full";
  if (mode !== "full" && mode !== "write" && mode !== "ask") throw new Error("Invalid OMP mode");
  const approvalMode = mode === "full" ? "yolo" : mode === "write" ? "write" : "always-ask";
  if (!args.some((argument) => argument === "--mode" || argument.startsWith("--mode="))) {
    args.push("--mode", "rpc-ui");
  }
  args.push("--approval-mode", approvalMode);
  if (options.tools) {
    if (options.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", options.tools.join(","));
  }
  if (options.model !== undefined) {
    args.push("--model", validateBoundedText(options.model, "model", MAX_MODEL_SELECTOR_BYTES));
  }
  if (options.thinkingOption !== undefined) {
    const thinking = OmpThinkingLevelSchema.safeParse(options.thinkingOption);
    if (!thinking.success) throw new Error("Invalid OMP thinking option");
    args.push("--thinking", thinking.data);
  }
  if (options.roleModels?.smol) {
    args.push(
      "--smol",
      validateBoundedText(options.roleModels.smol, "smol model", MAX_MODEL_SELECTOR_BYTES),
    );
  }
  if (options.roleModels?.slow) {
    args.push(
      "--slow",
      validateBoundedText(options.roleModels.slow, "slow model", MAX_MODEL_SELECTOR_BYTES),
    );
  }
  if (options.roleModels?.plan) {
    args.push(
      "--plan",
      validateBoundedText(options.roleModels.plan, "plan model", MAX_MODEL_SELECTOR_BYTES),
    );
  }
  if (options.sessionDir !== undefined) {
    args.push(
      "--session-dir",
      validateBoundedText(options.sessionDir, "session directory", MAX_PATH_LENGTH),
    );
  }
  if (options.resumeSessionId !== undefined) {
    args.push("--resume", validateNativeSessionId(options.resumeSessionId));
  }
  if (options.noSession) args.push("--no-session");
  const systemPrompt = options.systemPrompt?.trim();
  if (systemPrompt) {
    args.push(
      "--append-system-prompt",
      validateBoundedText(systemPrompt, "system prompt", MAX_SYSTEM_PROMPT_LENGTH),
    );
  }
  const { env, inheritedRedactionValues } = buildOmpEnvironment(
    options.env,
    options.inheritEnv,
    environmentSource,
  );
  env.OMP_NO_WEBP = "1";
  return {
    command,
    args,
    cwd,
    env,
    inheritedRedactionValues,
    detached: process.platform !== "win32",
  };
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const result = Promise.withResolvers<T>();
  const timer = setTimeout(() => result.reject(new Error(message)), timeoutMs);
  promise.then(
    (value) => {
      clearTimeout(timer);
      result.resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      result.reject(error);
    },
  );
  return result.promise;
}

function waitMs(ms: number): Promise<void> {
  const result = Promise.withResolvers<void>();
  setTimeout(result.resolve, ms);
  return result.promise;
}

function processIsGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

function isConfirmedNoProcessSpawnFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

/**
 * Terminates the detached process group created for OMP. This covers descendants that remain in
 * that group after the leader exits; descendants that deliberately re-parent into another process
 * group are outside this transport's containment boundary.
 */
export async function terminatePosixProcessTree(
  pid: number,
  graceMs: number,
  signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void = process.kill,
  wait: (ms: number) => Promise<void> = waitMs,
): Promise<boolean> {
  try {
    signalProcess(-pid, 0);
  } catch (error) {
    return processIsGone(error);
  }
  try {
    signalProcess(-pid, "SIGTERM");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
  } catch (error) {
    return processIsGone(error);
  }
  try {
    signalProcess(-pid, "SIGKILL");
  } catch (error) {
    if (!processIsGone(error)) return false;
  }
  await wait(graceMs);
  try {
    signalProcess(-pid, 0);
    return false;
  } catch (error) {
    return processIsGone(error);
  }
}

type ProcessTreeCleanup = "verified" | "uncertain" | "failed";

async function stopWindowsTree(pid: number): Promise<ProcessTreeCleanup> {
  const result = Promise.withResolvers<ProcessTreeCleanup>();
  const systemRoot = process.env.SystemRoot ?? WINDOWS_DEFAULT_SYSTEM_ROOT;
  let taskkill: ChildProcessWithoutNullStreams;
  try {
    taskkill = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { SystemRoot: systemRoot },
      },
    );
  } catch {
    return "failed";
  }
  taskkill.stdout.resume();
  taskkill.stderr.resume();
  let settled = false;
  let deadline: TimerHandle | undefined;
  let finalDeadline: TimerHandle | undefined;
  const finish = (outcome: ProcessTreeCleanup) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(finalDeadline);
    result.resolve(outcome);
  };
  deadline = setTimeout(() => {
    taskkill.kill("SIGKILL");
    finalDeadline = setTimeout(() => finish("failed"), PROCESS_STOP_TIMEOUT_MS);
  }, PROCESS_STOP_TIMEOUT_MS);
  taskkill.once("error", () => finish("failed"));
  taskkill.once("close", (code, signal) => {
    finish(
      code === 0 && signal === null
        ? "verified"
        : code === 128 && signal === null
          ? "uncertain"
          : "failed",
    );
  });
  return result.promise;
}

export async function terminateSpawnedProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "win32") return (await stopWindowsTree(pid)) === "verified";
  return await terminatePosixProcessTree(pid, PROCESS_STOP_TIMEOUT_MS);
}

class OmpRpcProcess {
  readonly ready: Promise<ReadyFrame>;
  readonly inheritedRedactionValues: readonly string[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: OmpRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queuedWrites = new Map<string, number>();
  private readonly pendingOneWayWrites = new Map<
    string,
    { reject(error: Error): void; timer: TimerHandle }
  >();
  private readonly acceptedPromptIds = new Set<string>();
  private readonly exitPromise: Promise<void>;
  private readonly resolveExit: () => void;
  private readonly resolveReady: (frame: ReadyFrame) => void;
  private readonly rejectReady: (error: Error) => void;
  private readonly terminateProcessTree: (pid: number) => Promise<ProcessTreeCleanup>;
  private readonly streamedBlocks = new Map<number, string>();
  private readonly activeToolCallIds = new Set<string>();
  private pendingWriteBytes = 0;
  private commandTextLength = 0;
  private lineParts: Buffer[] = [];
  private lineBytes = 0;
  private discardingLine = false;
  private discardedLineBytes = 0;
  private chunk: ChunkState | null = null;
  private physicalFrameLimit = MAX_PHYSICAL_FRAME_BYTES;
  private reassembledFrameLimit = MAX_REASSEMBLED_FRAME_BYTES;
  private closed = false;
  private exited = false;
  private fatalError: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private treeCleanupPromise: Promise<ProcessTreeCleanup> | null = null;
  private spawnFailedWithoutProcess = false;
  private readyReceived = false;
  private outputSettled = false;

  constructor(
    options: OmpStartOptions,
    spawnProcess?: OmpRpcRuntimeOptions["spawnProcess"],
    terminateProcessTree?: OmpRpcRuntimeOptions["terminateProcessTree"],
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    const ready = Promise.withResolvers<ReadyFrame>();
    this.rejectReady = ready.reject;
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    const request = buildOmpSpawnRequest(options);
    this.inheritedRedactionValues = request.inheritedRedactionValues;
    this.terminateProcessTree = terminateProcessTree
      ? async (pid) => {
          const outcome = await terminateProcessTree(pid);
          return outcome === true ? "verified" : outcome === "uncertain" ? "uncertain" : "failed";
        }
      : async (pid) =>
          process.platform === "win32"
            ? stopWindowsTree(pid)
            : (await terminatePosixProcessTree(pid, PROCESS_STOP_TIMEOUT_MS))
              ? "verified"
              : "failed";
    try {
      this.child = spawnProcess
        ? spawnProcess(request)
        : spawn(request.command, request.args, {
            cwd: request.cwd,
            env: request.env,
            detached: request.detached,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      throw new Error(
        code === "ENOENT"
          ? "OMP executable was not found"
          : code === "EACCES" || code === "EPERM"
            ? "OMP executable is not runnable"
            : "OMP process could not be launched",
      );
    }
    this.child.stdout.on("data", (chunk: Buffer | string) => this.receiveData(chunk));
    this.child.stdout.once("end", () => this.handleStdoutEnd());
    this.child.stderr.on("data", () => {
      // Stderr is intentionally drained and discarded. It may contain credentials or paths.
    });
    this.child.stdin.on("error", () => {
      this.fail(new Error("OMP RPC input channel failed"));
    });
    const exited = Promise.withResolvers<void>();
    this.exitPromise = exited.promise;
    this.resolveExit = exited.resolve;
    this.child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    this.child.once("close", () => this.settleOutput());
    this.child.once("error", (cause) => {
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (this.child.pid === undefined && isConfirmedNoProcessSpawnFailure(cause)) {
        this.spawnFailedWithoutProcess = true;
      }
      this.fail(
        new Error(
          code === "ENOENT"
            ? "OMP executable was not found"
            : code === "EACCES" || code === "EPERM"
              ? "OMP executable is not runnable"
              : "OMP process could not be launched",
        ),
      );
    });
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    void this.startTreeCleanup();
    const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
    const error = new Error(`OMP RPC process exited (${detail})`);
    this.rejectReady(error);
    this.failPending(error);
    this.resolveExit();
    if (!this.closed && !this.fatalError) this.fail(error);
  }

  private handleStdoutEnd(): void {
    this.settleOutput();
    if (!this.exited && !this.closed) this.fail(new Error("OMP RPC output channel closed"));
  }

  private settleOutput(): void {
    if (this.outputSettled) return;
    this.outputSettled = true;
    if (this.lineBytes > 0 || this.discardingLine) this.recordProtocolViolation();
    this.lineParts = [];
    this.lineBytes = 0;
    this.discardingLine = false;
    this.discardedLineBytes = 0;
  }

  get outboundFrameLimit(): number {
    return this.physicalFrameLimit;
  }

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyReadyLimits(frame: ReadyFrame): void {
    if (frame.maxFrameBytes !== undefined) this.physicalFrameLimit = frame.maxFrameBytes;
    if (frame.maxReassembledFrameBytes !== undefined) {
      this.reassembledFrameLimit = frame.maxReassembledFrameBytes;
    }
  }

  startRequest(
    command: Record<string, unknown>,
    timeoutMs: number | null = this.requestTimeoutMs,
    beforeResolve?: (value: unknown) => void,
  ): StartedRequest {
    const id = randomUUID();
    if (this.fatalError) return { id, promise: Promise.reject(this.fatalError) };
    if (this.closed || this.exited || !this.child.stdin.writable) {
      return { id, promise: Promise.reject(new Error("OMP RPC process is closed")) };
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(`${JSON.stringify({ ...command, id })}\n`);
    } catch {
      return { id, promise: Promise.reject(new Error("OMP RPC request could not be encoded")) };
    }
    if (payload.byteLength > this.physicalFrameLimit) {
      return {
        id,
        promise: Promise.reject(new Error("OMP RPC request exceeds the negotiated frame limit")),
      };
    }
    if (
      this.pending.size >= MAX_PENDING_REQUESTS ||
      this.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES
    ) {
      return { id, promise: Promise.reject(new Error("OMP RPC has too many pending requests")) };
    }
    const result = Promise.withResolvers<unknown>();
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            result.reject(new Error("OMP RPC request timed out"));
          }, timeoutMs);
    this.pending.set(id, {
      resolve: result.resolve,
      reject: result.reject,
      timer,
      command: typeof command.type === "string" ? command.type : "unknown",
      ...(beforeResolve ? { beforeResolve } : {}),
    });
    this.queuedWrites.set(id, payload.byteLength);
    this.pendingWriteBytes += payload.byteLength;
    try {
      this.child.stdin.write(payload, (cause) => {
        this.releaseQueuedWrite(id);
        if (cause) this.fail(new Error("OMP RPC input channel failed"));
      });
    } catch {
      this.releaseQueuedWrite(id);
      this.fail(new Error("OMP RPC input channel failed"));
    }
    return { id, promise: result.promise };
  }

  request(
    command: Record<string, unknown>,
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(frame: OmpHostToolResult | OmpHostToolUpdate): void {
    if (this.fatalError) throw this.fatalError;
    if (this.closed || this.exited || !this.child.stdin.writable) {
      throw new Error("OMP RPC process is closed");
    }
    const parsed =
      frame.type === "host_tool_result"
        ? OmpHostToolResultSchema.parse(frame)
        : OmpHostToolUpdateSchema.parse(frame);
    const payload = Buffer.from(`${JSON.stringify(parsed)}\n`);
    if (payload.byteLength > this.physicalFrameLimit) {
      throw new Error("OMP host tool frame exceeds the negotiated frame limit");
    }
    if (this.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES) {
      throw new Error("OMP RPC has too many pending writes");
    }
    const writeId = randomUUID();
    this.queuedWrites.set(writeId, payload.byteLength);
    this.pendingWriteBytes += payload.byteLength;
    try {
      this.child.stdin.write(payload, (cause) => {
        this.releaseQueuedWrite(writeId);
        if (cause) this.fail(new Error("OMP RPC input channel failed"));
      });
    } catch {
      this.releaseQueuedWrite(writeId);
      this.fail(new Error("OMP RPC input channel failed"));
      throw new Error("OMP RPC input channel failed");
    }
  }

  sendFrame(frame: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.closed || this.exited || !this.child.stdin.writable) {
      return Promise.reject(new Error("OMP RPC process is closed"));
    }
    let payload: Buffer;
    try {
      payload = Buffer.from(`${JSON.stringify(frame)}\n`);
    } catch {
      return Promise.reject(new Error("OMP RPC frame could not be encoded"));
    }
    if (payload.byteLength > this.physicalFrameLimit) {
      return Promise.reject(new Error("OMP RPC frame exceeds the negotiated frame limit"));
    }
    if (
      this.pendingOneWayWrites.size >= MAX_PENDING_ONE_WAY_WRITES ||
      this.pendingWriteBytes + payload.byteLength > MAX_PENDING_WRITE_BYTES
    ) {
      return Promise.reject(new Error("OMP RPC has too many pending writes"));
    }
    const token = randomUUID();
    const written = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      if (!this.pendingOneWayWrites.delete(token)) return;
      this.releaseQueuedWrite(token);
      const error = new Error("OMP RPC write timed out");
      written.reject(error);
      this.fail(error);
    }, timeoutMs);
    this.pendingOneWayWrites.set(token, { reject: written.reject, timer });
    this.queuedWrites.set(token, payload.byteLength);
    this.pendingWriteBytes += payload.byteLength;
    try {
      this.child.stdin.write(payload, (cause) => {
        const pending = this.pendingOneWayWrites.get(token);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingOneWayWrites.delete(token);
        this.releaseQueuedWrite(token);
        if (cause) {
          const error = new Error("OMP RPC input channel failed");
          written.reject(error);
          this.fail(error);
        } else {
          written.resolve();
        }
      });
    } catch {
      clearTimeout(timer);
      this.pendingOneWayWrites.delete(token);
      this.releaseQueuedWrite(token);
      const error = new Error("OMP RPC input channel failed");
      written.reject(error);
      this.fail(error);
    }
    return written.promise;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeProcess();
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    this.closed = true;
    this.clearChunk();
    this.failPending(new Error("OMP RPC process was closed"));
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        // Continue to process-tree cleanup when the input channel is already closed.
      }
    }
    const cleanupPromise = this.startTreeCleanup();
    const cleanup = await cleanupPromise;
    if (cleanup !== "verified") throw new Error("OMP RPC process tree cleanup failed");
    if (
      !this.spawnFailedWithoutProcess &&
      !this.exited &&
      !(await this.waitForExit(PROCESS_STOP_TIMEOUT_MS))
    ) {
      throw new Error("OMP RPC process did not close after tree cleanup");
    }
  }

  private startTreeCleanup(): Promise<ProcessTreeCleanup> {
    if (this.treeCleanupPromise) return this.treeCleanupPromise;
    const pid = this.child.pid;
    this.treeCleanupPromise = (
      pid === undefined
        ? Promise.resolve<ProcessTreeCleanup>(
            this.spawnFailedWithoutProcess ? "verified" : "uncertain",
          )
        : this.terminateProcessTree(pid)
    ).catch(() => "failed");
    return this.treeCleanupPromise;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const timeout = Promise.withResolvers<false>();
    const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
    try {
      return await Promise.race([this.exitPromise.then(() => true), timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private receiveData(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 10) continue;
      const part = bytes.subarray(start, index);
      if (this.discardingLine) {
        this.discardedLineBytes += part.byteLength;
        if (this.discardedLineBytes > MAX_SEMANTIC_FRAME_BYTES) {
          this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
          return;
        }
        this.resetDiscardedLine();
      } else {
        this.appendLinePart(part);
        if (this.fatalError) return;
        if (this.discardingLine) this.resetDiscardedLine();
        else this.completeLine();
      }
      start = index + 1;
    }
    if (start >= bytes.length) return;
    const trailing = bytes.subarray(start);
    if (this.discardingLine) {
      this.discardedLineBytes += trailing.byteLength;
      if (this.discardedLineBytes > MAX_SEMANTIC_FRAME_BYTES) {
        this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      }
    } else {
      this.appendLinePart(trailing);
    }
  }

  private resetDiscardedLine(): void {
    this.discardingLine = false;
    this.discardedLineBytes = 0;
    this.lineParts = [];
    this.lineBytes = 0;
  }

  private appendLinePart(part: Buffer): void {
    if (part.byteLength === 0) return;
    const nextBytes = this.lineBytes + part.byteLength;
    if (nextBytes > MAX_SEMANTIC_FRAME_BYTES) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    if (this.lineParts.length >= MAX_LINE_PARTS || nextBytes > this.physicalFrameLimit) {
      this.discardedLineBytes = nextBytes;
      this.lineParts = [];
      this.lineBytes = 0;
      this.discardingLine = true;
      this.recordProtocolViolation();
      return;
    }
    this.lineParts.push(part);
    this.lineBytes = nextBytes;
  }

  private completeLine(): void {
    if (this.lineBytes === 0) return;
    const line = Buffer.concat(this.lineParts, this.lineBytes);
    this.lineParts = [];
    this.lineBytes = 0;
    const payload = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    if (payload.byteLength > MAX_SEMANTIC_FRAME_BYTES) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      this.recordProtocolViolation();
      return;
    }
    if (this.receiveKnownResponse(decoded)) return;
    if (this.receiveDegradedAgentEnd(decoded, true)) return;
    if (
      boundedJsonBytes(decoded, MAX_SEMANTIC_FRAME_BYTES, 1_024, MAX_IMAGE_DATA_LENGTH, 4_096) ===
      Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation();
      return;
    }
    const frame = JsonObjectSchema.safeParse(decoded);
    if (!frame.success) {
      this.recordProtocolViolation();
      return;
    }
    this.receiveFrame(frame.data);
  }

  private receiveChunk(frame: ChunkFrame): void {
    if (
      frame.byteLength > MAX_SEMANTIC_FRAME_BYTES &&
      ![...this.pending.values()].some(
        (pending) =>
          pending.command === "get_messages" || pending.command === "get_subagent_messages",
      )
    ) {
      this.fail(new Error("OMP RPC frame exceeds the semantic byte limit"));
      return;
    }
    if (
      frame.index >= frame.count ||
      frame.byteLength > this.reassembledFrameLimit ||
      frame.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.data)
    ) {
      this.rejectChunk();
      return;
    }
    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.byteLength > MAX_CHUNK_BYTES) {
      this.rejectChunk();
      return;
    }
    if (!this.chunk) {
      if (frame.index !== 0) {
        this.rejectChunk();
        return;
      }
      this.chunk = {
        id: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        parts: [],
        receivedBytes: 0,
        timer: setTimeout(() => this.rejectChunk(), CHUNK_STALE_MS),
      };
    }
    const chunk = this.chunk;
    if (
      chunk.id !== frame.chunkId ||
      chunk.count !== frame.count ||
      chunk.byteLength !== frame.byteLength ||
      chunk.parts.length !== frame.index ||
      chunk.receivedBytes + decoded.byteLength > chunk.byteLength ||
      chunk.receivedBytes + decoded.byteLength > this.reassembledFrameLimit
    ) {
      this.rejectChunk();
      return;
    }
    chunk.parts.push(decoded);
    chunk.receivedBytes += decoded.byteLength;
    if (chunk.parts.length !== chunk.count) return;
    if (chunk.receivedBytes !== chunk.byteLength) {
      this.rejectChunk();
      return;
    }
    const reassembled = Buffer.concat(chunk.parts, chunk.receivedBytes);
    this.clearChunk();
    let decodedFrame: unknown;
    try {
      decodedFrame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reassembled));
    } catch {
      this.recordProtocolViolation();
      return;
    }
    if (this.receiveKnownResponse(decodedFrame)) return;
    if (this.receiveDegradedAgentEnd(decodedFrame, true)) return;
    if (
      boundedJsonBytes(
        decodedFrame,
        MAX_SEMANTIC_FRAME_BYTES,
        1_024,
        MAX_IMAGE_DATA_LENGTH,
        4_096,
      ) === Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation();
      return;
    }
    const frameObject = JsonObjectSchema.safeParse(decodedFrame);
    if (!frameObject.success) {
      this.recordProtocolViolation();
      return;
    }
    this.receiveFrame(frameObject.data);
  }

  private receiveKnownResponse(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (
      frame.type !== "response" ||
      typeof frame.id !== "string" ||
      (!this.pending.has(frame.id) && !this.acceptedPromptIds.has(frame.id))
    ) {
      return false;
    }
    this.receiveResponse(frame);
    return true;
  }

  private receiveResponse(frame: Record<string, unknown>): void {
    const rawId = typeof frame.id === "string" ? frame.id : undefined;
    const knownPending = rawId ? this.pending.get(rawId) : undefined;
    const response = OmpResponseFrameSchema.safeParse(frame);
    if (!response.success) {
      if (rawId && knownPending) {
        this.takePending(rawId)?.reject(new Error("OMP RPC response is invalid"));
      } else if (!rawId || !this.emitAcceptedPromptFailure(rawId, frame)) {
        this.recordProtocolViolation();
      }
      return;
    }
    const pending = this.pending.get(response.data.id);
    if (!pending) {
      if (!response.data.success) {
        this.emitAcceptedPromptFailure(response.data.id, response.data);
      }
      return;
    }
    const isBranchHistory = pending.command === "get_branch_messages";
    const isHistory =
      pending.command === "get_messages" || pending.command === "get_subagent_messages";
    const responseItemLimit = isBranchHistory ? 1_024 : isHistory ? 100_000 : MAX_ARRAY_ITEMS;
    const responseByteLimit =
      isBranchHistory || isHistory
        ? Math.min(MAX_REASSEMBLED_FRAME_BYTES, this.reassembledFrameLimit)
        : 2 * 1024 * 1024;
    // A model catalog contains up to 256 structured models, so its aggregate
    // node budget must exceed the small state/command-response budget.
    const responseNodeLimit = isBranchHistory
      ? 4_096
      : isHistory
        ? 400_000
        : pending.command === "get_available_models"
          ? 16_384
          : 2_048;
    if (
      boundedJsonBytes(
        frame,
        responseByteLimit,
        responseItemLimit,
        MAX_IMAGE_DATA_LENGTH,
        responseNodeLimit,
      ) === Number.POSITIVE_INFINITY
    ) {
      this.takePending(response.data.id)?.reject(
        new Error("OMP RPC response exceeded command limits"),
      );
      return;
    }
    const settled = this.takePending(response.data.id);
    if (!settled) return;
    if (response.data.success) {
      try {
        settled.beforeResolve?.(response.data.data);
        if (settled.command === "prompt") {
          if (this.acceptedPromptIds.size >= MAX_PENDING_REQUESTS) {
            const oldest = this.acceptedPromptIds.values().next().value;
            if (oldest !== undefined) this.acceptedPromptIds.delete(oldest);
          }
          this.acceptedPromptIds.add(response.data.id);
        }
        settled.resolve(response.data.data);
      } catch {
        settled.reject(new Error("OMP RPC response is invalid"));
      }
    } else {
      settled.reject(new Error("OMP RPC request failed"));
    }
  }

  private emitAcceptedPromptFailure(id: string, frame: Record<string, unknown>): boolean {
    if (frame.success !== false || !this.acceptedPromptIds.delete(id)) return false;
    const error = typeof frame.error === "string" ? frame.error : undefined;
    const nativeError =
      error && utf8Bytes(error) <= MAX_RPC_ERROR_BYTES ? error : PROMPT_SCHEDULING_FAILURE;
    const code = typeof frame.code === "string" ? frame.code : undefined;
    const nativeCode = code && utf8Bytes(code) <= MAX_RPC_ERROR_CODE_BYTES ? code : undefined;
    this.emit({
      type: "prompt_error",
      id,
      error: nativeError,
      ...(nativeCode ? { code: nativeCode } : {}),
    });
    return true;
  }

  private takePending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private releaseQueuedWrite(id: string): void {
    const bytes = this.queuedWrites.get(id);
    if (bytes === undefined) return;
    this.queuedWrites.delete(id);
    this.pendingWriteBytes -= bytes;
  }

  private receiveDegradedAgentEnd(value: unknown, onlyUnsafePayload: boolean): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (frame.type !== "agent_end") return false;
    const envelope = OmpAgentEndEnvelopeSchema.safeParse(frame);
    if (!envelope.success) {
      this.fail(new Error("OMP emitted invalid terminal metadata"));
      return true;
    }
    const messagesAreSafe =
      frame.messages === undefined ||
      (Array.isArray(frame.messages) &&
        frame.messages.length <= MAX_ARRAY_ITEMS &&
        boundedJsonBytes(
          frame.messages,
          MAX_SEMANTIC_FRAME_BYTES,
          MAX_ARRAY_ITEMS,
          MAX_TEXT_LENGTH,
          4_096,
        ) !== Number.POSITIVE_INFINITY);
    const payloadIsSafe =
      messagesAreSafe &&
      boundedJsonBytes(frame, MAX_SEMANTIC_FRAME_BYTES, 1_024, MAX_IMAGE_DATA_LENGTH, 4_096) !==
        Number.POSITIVE_INFINITY;
    if (onlyUnsafePayload && payloadIsSafe) return false;
    if (envelope.data.isTerminal === false) {
      this.fail(new Error("OMP emitted an invalid nonterminal agent_end payload"));
      return true;
    }
    const observedCount = Array.isArray(frame.messages)
      ? frame.messages.length
      : Object.hasOwn(frame, "messages")
        ? 1
        : undefined;
    const messageCount = Math.max(envelope.data.messageCount ?? 0, observedCount ?? 0, 1);
    this.emit({
      ...envelope.data,
      messageCount,
    });
    this.streamedBlocks.clear();
    this.commandTextLength = 0;
    return true;
  }

  private receiveFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" && frame.type.length <= 64 ? frame.type : null;
    if (!type) {
      this.recordProtocolViolation();
      return;
    }
    if (this.receiveDegradedAgentEnd(frame, true)) return;
    if (
      boundedJsonBytes(frame, MAX_SEMANTIC_FRAME_BYTES, 1_024, MAX_IMAGE_DATA_LENGTH, 4_096) ===
      Number.POSITIVE_INFINITY
    ) {
      this.recordProtocolViolation();
      return;
    }
    if (type === "rpc_chunk") {
      const chunk = OmpChunkFrameSchema.safeParse(frame);
      if (!chunk.success) this.rejectChunk();
      else this.receiveChunk(chunk.data);
      return;
    }
    if (this.chunk) {
      this.clearChunk();
      this.recordProtocolViolation();
    }
    if (type === "rpc_frame_error") {
      this.recordProtocolViolation();
      return;
    }
    if (type === "ready") {
      if (this.readyReceived) {
        this.recordProtocolViolation();
        return;
      }
      const ready = OmpReadyFrameSchema.safeParse(frame);
      if (!ready.success) {
        this.recordProtocolViolation();
      } else {
        this.readyReceived = true;
        this.resolveReady(ready.data);
      }
      return;
    }
    if (type === "response") {
      this.receiveResponse(frame);
      return;
    }
    const event = OmpRuntimeEventSchema.safeParse(frame);
    if (!event.success) {
      this.rejectMatchingToolApproval(frame);
      if (type === "agent_end" && this.receiveDegradedAgentEnd(frame, false)) return;
      this.recordProtocolViolation();
      return;
    }
    if (!this.acceptEventState(event.data)) {
      this.recordProtocolViolation();
      return;
    }
    this.emit(event.data);
    if (event.data.type === "prompt_result" && event.data.id) {
      this.acceptedPromptIds.delete(event.data.id);
    }
    if (
      event.data.type === "message_end" ||
      event.data.type === "turn_end" ||
      event.data.type === "agent_end"
    ) {
      this.streamedBlocks.clear();
    }
    if (event.data.type === "turn_end") {
      this.commandTextLength = 0;
      this.activeToolCallIds.clear();
    }
  }

  private rejectMatchingToolApproval(frame: Record<string, unknown>): void {
    if (frame.type !== "tool_approval_request") return;
    const { id, toolCallId } = frame;
    if (!isBoundedToolApprovalId(id) || !isBoundedToolApprovalId(toolCallId)) return;
    void this.sendFrame({
      type: "tool_approval_response",
      id,
      toolCallId,
      cancelled: true,
    }).catch(() => this.fail(new Error("OMP rejected tool approval could not be canceled")));
  }

  private acceptEventState(event: z.infer<typeof OmpRuntimeEventSchema>): boolean {
    if (event.type === "turn_start") {
      this.streamedBlocks.clear();
      this.commandTextLength = 0;
      this.activeToolCallIds.clear();
      return true;
    }
    if (event.type === "command_output") {
      const nextLength = this.commandTextLength + utf8Bytes(event.text ?? "");
      if (nextLength > MAX_STREAM_TEXT_LENGTH) return false;
      this.commandTextLength = nextLength;
      return true;
    }
    if (event.type === "tool_execution_start") {
      if (
        !this.activeToolCallIds.has(event.toolCallId) &&
        this.activeToolCallIds.size >= MAX_ACTIVE_TOOLS
      ) {
        return false;
      }
      this.activeToolCallIds.add(event.toolCallId);
      return true;
    }
    if (event.type === "tool_execution_update") {
      return this.activeToolCallIds.has(event.toolCallId);
    }
    if (event.type === "tool_execution_end") {
      if (!this.activeToolCallIds.has(event.toolCallId)) return false;
      this.activeToolCallIds.delete(event.toolCallId);
      return true;
    }
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    ) {
      return true;
    }
    if (event.message.role !== "assistant") return true;
    const nextBlocks =
      event.type === "message_start" ? new Map<number, string>() : new Map(this.streamedBlocks);
    const content = event.message.content;
    if (typeof content === "string") {
      nextBlocks.set(0, content);
    } else if (Array.isArray(content)) {
      for (const [index, part] of content.entries()) {
        const text =
          part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : undefined;
        if (text !== undefined) nextBlocks.set(index, text);
      }
    }
    const update = event.type === "message_update" ? event.assistantMessageEvent : undefined;
    if (
      update?.contentIndex !== undefined &&
      update.delta !== undefined &&
      (content === undefined ||
        (Array.isArray(content) && content[update.contentIndex] === undefined))
    ) {
      const current = nextBlocks.get(update.contentIndex) ?? "";
      nextBlocks.set(update.contentIndex, `${current}${update.delta}`);
    }
    let totalLength = 0;
    for (const text of nextBlocks.values()) {
      totalLength += utf8Bytes(text);
      if (totalLength > MAX_STREAM_TEXT_LENGTH) return false;
    }
    this.streamedBlocks.clear();
    for (const [index, text] of nextBlocks) this.streamedBlocks.set(index, text);
    return true;
  }

  private rejectChunk(): void {
    this.clearChunk();
    this.recordProtocolViolation();
  }

  private recordProtocolViolation(): void {
    // Malformed bounded frames are isolated so the following frame starts from clean state.
  }

  private fail(error: Error): void {
    if (this.fatalError || this.closed) return;
    this.fatalError = error;
    this.rejectReady(error);
    this.failPending(error);
    this.emit({ type: "process_exit", error: error.message });
    void this.close().catch(() => undefined);
  }

  private clearChunk(): void {
    const chunk = this.chunk;
    if (chunk) clearTimeout(chunk.timer);
    this.chunk = null;
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingOneWayWrites.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.acceptedPromptIds.clear();
    this.pendingOneWayWrites.clear();
    this.queuedWrites.clear();
    this.pendingWriteBytes = 0;
  }

  private emit(event: OmpRpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function validateReadyMetadata(frame: ReadyFrame): void {
  const metadata = [
    frame.protocolVersion,
    frame.supportedProtocolVersions,
    frame.maxFrameBytes,
    frame.maxReassembledFrameBytes,
  ];
  if (metadata.every((value) => value === undefined)) {
    throw new OmpPublicError("OMP provider requires OMP RPC protocol v2");
  }
  if (metadata.some((value) => value === undefined)) {
    throw new Error("OMP ready frame contains incomplete protocol metadata");
  }
  if (
    frame.protocolVersion !== 1 ||
    !frame.supportedProtocolVersions?.includes(1) ||
    !frame.maxFrameBytes ||
    frame.maxFrameBytes > MAX_PHYSICAL_FRAME_BYTES ||
    !frame.maxReassembledFrameBytes ||
    frame.maxReassembledFrameBytes > MAX_REASSEMBLED_FRAME_BYTES ||
    frame.maxReassembledFrameBytes < frame.maxFrameBytes
  ) {
    throw new Error("OMP ready frame advertises unsupported protocol limits");
  }
  if (frame.maxFrameBytes < MIN_HOST_TOOL_RESULT_FRAME_BYTES) {
    throw new Error("OMP ready frame cannot carry terminal host tool results");
  }
  if (!frame.supportedProtocolVersions.includes(2)) {
    throw new OmpPublicError("OMP provider requires OMP RPC protocol v2");
  }
}

class OmpRpcSession implements OmpRuntimeSession {
  get maxHostToolFrameBytes(): number {
    return this.process.outboundFrameLimit;
  }
  get maxInputFrameBytes(): number {
    return this.process.outboundFrameLimit;
  }

  constructor(
    private readonly process: OmpRpcProcess,
    private readonly removeAbortListener: () => void,
    readonly canReplayHistory: boolean,
    readonly inheritedRedactionValues: readonly string[],
    readonly supportsTypedToolApprovals: boolean,
  ) {}

  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    return this.process.onEvent(listener);
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.process.request({ type: "get_state" }));
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    return OmpSessionStatsSchema.parse(await this.process.request({ type: "get_session_stats" }));
  }

  async compact(customInstructions?: string): Promise<OmpCompactionResult> {
    const instructions =
      customInstructions === undefined
        ? undefined
        : validateBoundedText(customInstructions, "compaction instructions", MAX_TEXT_LENGTH);
    return OmpCompactionResultSchema.parse(
      await this.process.request(
        {
          type: "compact",
          ...(instructions ? { customInstructions: instructions } : {}),
        },
        null,
      ),
    );
  }
  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.process.request({ type: "set_auto_compaction", enabled });
  }

  async getAvailableModels(): Promise<OmpModel[]> {
    const result = OmpModelsResultSchema.parse(
      await this.process.request({ type: "get_available_models" }),
    );
    if (result.models.length === 0) throw new Error("OMP reported no available models");
    return result.models;
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    const safeProvider = validateBoundedText(provider, "model provider", MAX_NAME_LENGTH);
    const safeModelId = validateBoundedText(modelId, "model identifier", MAX_NAME_LENGTH);
    return OmpModelSchema.parse(
      await this.process.request({
        type: "set_model",
        provider: safeProvider,
        modelId: safeModelId,
      }),
    );
  }

  async setThinkingLevel(level: string): Promise<void> {
    const parsed = OmpThinkingLevelSchema.parse(level);
    await this.process.request({ type: "set_thinking_level", level: parsed });
  }

  async getAvailableCommands(): Promise<OmpAvailableCommand[]> {
    const result = OmpAvailableCommandsResultSchema.parse(
      await this.process.request({ type: "get_available_commands" }),
    );
    return result.commands;
  }
  async setSubagentSubscription(level: "events"): Promise<void> {
    await this.process.request({ type: "set_subagent_subscription", level });
  }

  async getSubagents(): Promise<OmpSubagentSnapshot[]> {
    return OmpSubagentsResultSchema.parse(await this.process.request({ type: "get_subagents" }))
      .subagents;
  }

  async getSubagentMessages(selector: {
    subagentId?: string;
    sessionFile?: string;
  }): Promise<OmpSubagentMessagesResult> {
    const subagentId = selector.subagentId
      ? validateBoundedText(selector.subagentId, "subagent identifier", MAX_ID_LENGTH)
      : undefined;
    const sessionFile = selector.sessionFile
      ? validateBoundedText(selector.sessionFile, "subagent transcript", MAX_PATH_LENGTH)
      : undefined;
    if ((subagentId ? 1 : 0) + (sessionFile ? 1 : 0) !== 1) {
      throw new OmpPublicError("OMP subagent history requires one transcript selector");
    }
    return OmpSubagentMessagesResultSchema.parse(
      await this.process.request({
        type: "get_subagent_messages",
        ...(subagentId ? { subagentId } : { sessionFile }),
      }),
    );
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const result = OmpBranchMessagesResultSchema.parse(
      await this.process.request({ type: "get_branch_messages" }),
    );
    return result.messages;
  }
  async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const safeEntryId = validateBoundedText(entryId, "branch entry identifier", MAX_ID_LENGTH);
    const result = OmpBranchResultSchema.safeParse(
      await this.process.request({ type: "branch", entryId: safeEntryId }),
    );
    if (!result.success) throw new Error("OMP RPC response is invalid");
    return result.data;
  }

  async getMessages(): Promise<OmpMessage[]> {
    if (!this.canReplayHistory) {
      throw new Error("OMP history replay requires negotiated RPC protocol v2");
    }
    const result = OmpMessagesResultSchema.parse(
      await this.process.request({ type: "get_messages" }),
    );
    return result.messages;
  }

  async setHostTools(tools: readonly OmpHostToolDefinition[]): Promise<string[]> {
    const safeTools = z.array(OmpHostToolDefinitionSchema).max(MAX_HOST_TOOLS).parse(tools);
    if (safeTools.length === 0) return [];
    const result = z
      .object({ toolNames: z.array(NAME).max(MAX_HOST_TOOLS).optional() })
      .parse(await this.process.request({ type: "set_host_tools", tools: safeTools }));
    return result.toolNames ?? [];
  }

  sendHostToolResult(result: OmpHostToolResult): void {
    this.process.send(result);
  }

  sendHostToolUpdate(update: OmpHostToolUpdate): void {
    this.process.send(update);
  }

  async prompt(
    message: string,
    images: readonly OmpImage[] = [],
    onAccepted?: () => void,
  ): Promise<{ requestId: string; agentInvoked?: boolean }> {
    const safeMessage = validateBoundedText(message, "prompt", MAX_TEXT_LENGTH);
    let acknowledgement: z.infer<typeof OmpPromptAckSchema> | undefined;
    const request = this.process.startRequest(
      { type: "prompt", message: safeMessage, ...(images.length > 0 ? { images } : {}) },
      undefined,
      (value) => {
        acknowledgement = OmpPromptAckSchema.parse(value) ?? {};
        onAccepted?.();
      },
    );
    await request.promise;
    return { requestId: request.id, ...acknowledgement };
  }

  async steer(message: string, images: readonly OmpImage[] = []): Promise<void> {
    const safeMessage = validateBoundedText(message, "steer", MAX_TEXT_LENGTH);
    await this.process.sendFrame({
      type: "steer",
      message: safeMessage,
      ...(images.length > 0 ? { images } : {}),
    });
  }
  async followUp(message: string, images: readonly OmpImage[] = []): Promise<void> {
    const safeMessage = validateBoundedText(message, "follow-up", MAX_TEXT_LENGTH);
    await this.process.sendFrame({
      type: "follow_up",
      message: safeMessage,
      ...(images.length > 0 ? { images } : {}),
    });
  }

  async handoff(customInstructions?: string): Promise<void> {
    const instructions =
      customInstructions === undefined
        ? undefined
        : validateBoundedText(customInstructions, "handoff instructions", MAX_TEXT_LENGTH);
    await this.process.request({
      type: "handoff",
      ...(instructions ? { customInstructions: instructions } : {}),
    });
  }

  respondToExtensionUi(response: OmpExtensionUiResponse): Promise<void> {
    return this.process.sendFrame(response);
  }
  respondToToolApproval(response: OmpToolApprovalResponse): Promise<void> {
    return this.process.sendFrame(OmpToolApprovalResponseSchema.parse(response));
  }

  async abort(): Promise<void> {
    await this.process.request({ type: "abort", clearQueue: true, reason: "Interrupted in Paseo" });
  }

  async close(): Promise<void> {
    this.removeAbortListener();
    await this.process.close();
  }
}

export class OmpRpcRuntime implements OmpRuntime {
  readonly supportsPersistence = true;
  constructor(private readonly options: OmpRpcRuntimeOptions = {}) {}
  listSessions(options: OmpSessionListOptions): Promise<OmpSessionDescriptor[]> {
    return Promise.resolve(
      this.options.listSessions?.(options) ??
        listOmpSessionDescriptors(options, this.options.environment ?? process.env),
    );
  }
  async readPersistedSubagentTranscript(options: {
    parentSessionFile: string;
    childTranscriptId: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<OmpPersistedSubagentMessages> {
    const transcript = await readOmpPersistedSubagentTranscript(
      options.parentSessionFile,
      options.childTranscriptId,
      options.cwd,
      options.signal,
    );
    return {
      ...transcript,
      messages: z.array(OmpMessageSchema).max(100_000).parse(transcript.messages),
    };
  }

  async startSession(options: OmpStartOptions): Promise<OmpRuntimeSession> {
    options.signal?.throwIfAborted();
    const effectiveOptions = {
      ...options,
      environment: options.environment ?? this.options.environment,
    };
    const process = new OmpRpcProcess(
      effectiveOptions,
      this.options.spawnProcess,
      this.options.terminateProcessTree,
      options.requestTimeoutMs ?? this.options.requestTimeoutMs,
    );
    const abort = () => void process.close().catch(() => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    const removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    try {
      const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
      const ready = await waitWithTimeout(
        process.ready,
        readyTimeoutMs,
        `OMP RPC did not become ready within ${readyTimeoutMs}ms`,
      );
      validateReadyMetadata(ready);
      process.applyReadyLimits(ready);
      options.signal?.throwIfAborted();
      const advertiseTypedToolApprovals = ready.features?.typedToolApprovals === 1;
      const negotiation = ProtocolNegotiationResultSchema.parse(
        await process.request({
          type: "negotiate_protocol",
          protocolVersion: 2,
          ...(advertiseTypedToolApprovals
            ? { clientCapabilities: { typedToolApprovals: 1 as const } }
            : {}),
        }),
      );
      options.signal?.throwIfAborted();
      return new OmpRpcSession(
        process,
        removeAbortListener,
        true,
        process.inheritedRedactionValues,
        advertiseTypedToolApprovals && negotiation.clientCapabilities?.typedToolApprovals === 1,
      );
    } catch (error) {
      removeAbortListener();
      const cleanup = process.close();
      try {
        await cleanup;
      } catch {
        throw new OmpCleanupFailure("OMP runtime startup cleanup failed", cleanup);
      }
      throw error;
    }
  }
}
