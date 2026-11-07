import type {
  RunAssignment,
  RunNonceEntry,
  RunRecord,
} from "../../shared/schemas/run-engine/ledger";
import {
  RUN_PROTOCOL_BLOCKS,
  RUN_PROTOCOL_VERSION,
  RunDecisionBlockSchema,
  type RunProtocolBlock,
  type RunProtocolBlockName,
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunTaskDagBlockSchema,
  RunTaskReportBlockSchema,
} from "../../shared/schemas/run-engine/protocol";

/**
 * Strict-block extraction and report ownership checks. Pure: no I/O, no clock, no ledger writes.
 *
 * Extraction never guesses. A reply either carries exactly one well-formed block of the expected
 * kind, carries nothing, is rejected for a named reason, or cannot be judged ("unverifiable").
 * The last case is not "no block": a reply that was not read in full must never be reported as
 * silence, because silence triggers a repair request and an incomplete read would trigger it for
 * work that was actually reported.
 */

export const PROTOCOL_BLOCK_MAX_BYTES = 32 * 1024;
export const PROTOCOL_REPLY_MAX_BYTES = 256 * 1024;
export const PROTOCOL_MAX_PAGES = 20;
const MAX_REPORTED_ISSUES = 5;

export type ExtractRejection =
  | "multiple-blocks"
  | "mixed-kinds"
  | "unterminated-fence"
  | "oversize-block"
  | "non-json"
  | "unknown-version"
  | "schema-invalid"
  | "unexpected-kind";

export type UnverifiableReason =
  | "reply-too-large"
  | "too-many-pages"
  | "timeline-discontinuity"
  | "epoch-changed"
  | "dispatch-not-found"
  | "turn-unknown"
  | "turn-open";

export type ProtocolIssue = { path: string; message: string; expected?: string };

export type ExtractResult =
  | { status: "block"; kind: RunProtocolBlockName; block: RunProtocolBlock; bytes: number }
  | { status: "none" }
  | {
      status: "rejected";
      reason: ExtractRejection;
      kind?: RunProtocolBlockName;
      issues?: ProtocolIssue[];
    }
  | { status: "unverifiable"; reason: UnverifiableReason };

type Fence = { name: string; body: string; terminated: boolean };

const OPEN = /^ {0,3}(`{3,})([^`\r\n]*)$/u;

/**
 * Line-based fence scan. A fence only opens at the start of a line, so a ``` that sits inside a JSON
 * string is data. Fences with any other info string are skipped as whole units, which keeps a
 * protocol-looking fence quoted inside a ```json example from being picked up.
 */
function scanFences(text: string): Fence[] {
  const fences: Fence[] = [];
  const lines = text.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length) {
    const open = OPEN.exec(lines[index] ?? "");
    if (!open) {
      index += 1;
      continue;
    }
    const length = (open[1] ?? "").length;
    const name = (open[2] ?? "").trim().split(/\s+/u)[0] ?? "";
    const closing = new RegExp(`^ {0,3}\`{${length},}\\s*$`, "u");
    const body: string[] = [];
    let terminated = false;
    index += 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      index += 1;
      if (closing.test(line)) {
        terminated = true;
        break;
      }
      body.push(line);
    }
    fences.push({ name, body: body.join("\n"), terminated });
  }
  return fences;
}

const BLOCK_SCHEMAS = {
  "task-dag": RunTaskDagBlockSchema,
  "task-report": RunTaskReportBlockSchema,
  "review-report": RunReviewReportBlockSchema,
  "smoke-report": RunSmokeReportBlockSchema,
  decision: RunDecisionBlockSchema,
} as const;

function isProtocolName(name: string): name is RunProtocolBlockName {
  return (RUN_PROTOCOL_BLOCKS as readonly string[]).includes(name);
}

export function extractProtocolBlock(
  text: string,
  options: { expected?: RunProtocolBlockName | readonly RunProtocolBlockName[] } = {},
): ExtractResult {
  if (Buffer.byteLength(text, "utf8") > PROTOCOL_REPLY_MAX_BYTES) {
    return { status: "unverifiable", reason: "reply-too-large" };
  }
  const candidates = scanFences(text).filter((fence) => isProtocolName(fence.name));
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length > 1) {
    const kinds = new Set(candidates.map((fence) => fence.name));
    return { status: "rejected", reason: kinds.size > 1 ? "mixed-kinds" : "multiple-blocks" };
  }
  const [fence] = candidates;
  if (!fence || !isProtocolName(fence.name)) return { status: "none" };
  const kind = fence.name;
  if (!fence.terminated) return { status: "rejected", reason: "unterminated-fence", kind };
  const allowed =
    options.expected === undefined
      ? null
      : typeof options.expected === "string"
        ? [options.expected]
        : options.expected;
  if (allowed !== null && !allowed.includes(kind)) {
    return { status: "rejected", reason: "unexpected-kind", kind };
  }
  const bytes = Buffer.byteLength(fence.body, "utf8");
  if (bytes > PROTOCOL_BLOCK_MAX_BYTES)
    return { status: "rejected", reason: "oversize-block", kind };
  let value: unknown;
  try {
    value = JSON.parse(fence.body);
  } catch {
    return { status: "rejected", reason: "non-json", kind };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "rejected", reason: "non-json", kind };
  }
  if ("protocolVersion" in value && value.protocolVersion !== RUN_PROTOCOL_VERSION) {
    return { status: "rejected", reason: "unknown-version", kind };
  }
  const parsed = BLOCK_SCHEMAS[kind].safeParse(value);
  if (!parsed.success) {
    // Paths and generic messages only: a schema message must never echo submitted content. For a
    // wrong type the issue also names the type the schema wanted (a lower-case type word such as
    // `string`; never the submitted value), because "invalid_type" alone lets a model guess.
    const issues = parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
      const expected =
        issue.code === "invalid_type" && /^[a-z]{1,16}$/u.test(String(issue.expected))
          ? String(issue.expected)
          : undefined;
      return {
        path: issue.path.join("."),
        message: issue.code,
        ...(expected === undefined ? {} : { expected }),
      };
    });
    return { status: "rejected", reason: "schema-invalid", kind, issues };
  }
  return { status: "block", kind, block: parsed.data as RunProtocolBlock, bytes };
}

export type TimelineEntryLike = {
  item: { type: string; text?: string; messageId?: string; clientMessageId?: string };
  turnId?: string;
  seqStart: number;
  seqEnd: number;
};

export type TimelinePageLike = {
  entries: readonly TimelineEntryLike[];
  epoch: string;
  hasOlder: boolean;
  hasNewer: boolean;
  gap: boolean;
  staleCursor: boolean;
  reset: boolean;
};

export type ReplyWindow =
  | { complete: true; turnId: string; text: string; bytes: number }
  | { complete: false; reason: UnverifiableReason };

/**
 * The authorized reply is the assistant text of the turn that carries the dispatch message. Pages
 * are the canonical timeline pages the observer fetched. Any sign the read was partial (gap, stale
 * cursor, reset, epoch change, page cap, an unfinished newest page) makes the window incomplete.
 */
export function buildReplyWindow(input: {
  pages: readonly TimelinePageLike[];
  dispatchMessageId: string;
  maxPages?: number;
}): ReplyWindow {
  const maxPages = input.maxPages ?? PROTOCOL_MAX_PAGES;
  if (input.pages.length > maxPages) return { complete: false, reason: "too-many-pages" };
  const epochs = new Set(input.pages.map((page) => page.epoch));
  if (epochs.size > 1) return { complete: false, reason: "epoch-changed" };
  if (input.pages.some((page) => page.gap || page.staleCursor || page.reset)) {
    return { complete: false, reason: "timeline-discontinuity" };
  }

  const bySeq = new Map<number, TimelineEntryLike>();
  for (const page of input.pages) {
    for (const entry of page.entries) bySeq.set(entry.seqStart, entry);
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seqStart - b.seqStart);

  const dispatchIndex = entries.findIndex(
    (entry) =>
      entry.item.type === "user_message" &&
      (entry.item.messageId === input.dispatchMessageId ||
        entry.item.clientMessageId === input.dispatchMessageId),
  );
  if (dispatchIndex < 0) return { complete: false, reason: "dispatch-not-found" };
  const turnId = entries[dispatchIndex]?.turnId;
  if (turnId === undefined) return { complete: false, reason: "turn-unknown" };

  const after = entries.slice(dispatchIndex);
  const turnEntries = after.filter((entry) => entry.turnId === turnId);
  const turnEnded = after.some((entry) => entry.turnId !== undefined && entry.turnId !== turnId);
  const newest = input.pages.reduce<TimelinePageLike | null>(
    (best, page) =>
      best === null ||
      Math.max(...page.entries.map((e) => e.seqEnd), -1) >
        Math.max(...best.entries.map((e) => e.seqEnd), -1)
        ? page
        : best,
    null,
  );
  // Without a later turn as proof the turn is over, the newest page must be the end of the timeline.
  if (!turnEnded && (newest === null || newest.hasNewer)) {
    return { complete: false, reason: "turn-open" };
  }

  const text = turnEntries
    .filter((entry) => entry.item.type === "assistant_message")
    .map((entry) => entry.item.text ?? "")
    .join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PROTOCOL_REPLY_MAX_BYTES) return { complete: false, reason: "reply-too-large" };
  return { complete: true, turnId, text, bytes };
}

export type OwnershipFailure =
  | "run-mismatch"
  | "assignment-unknown"
  | "task-mismatch"
  | "attempt-mismatch"
  | "wrong-purpose"
  | "nonce-mismatch"
  | "nonce-registry-mismatch"
  | "nonce-revoked"
  | "sender-not-assignee"
  | "message-mismatch"
  | "turn-mismatch"
  | "assignment-closed"
  | "duplicate";

export type OwnershipResult =
  | { ok: true; assignment: RunAssignment; nonce: RunNonceEntry }
  | { ok: false; code: OwnershipFailure };

type ReportBlock = Extract<
  RunProtocolBlock,
  { assignmentId: string; nonce: string; taskId: string; attempt: number; runId: string }
>;

const PURPOSES_BY_KIND: Record<string, readonly RunAssignment["purpose"][]> = {
  // A reviewer or smoker may send a task-report too, but only a blocked one (it could not do its
  // job); the reducer refuses any other status from them.
  "task-report": ["member", "coordinator", "reopen", "reviewer", "smoker"],
  "review-report": ["reviewer"],
  "smoke-report": ["smoker"],
};

/**
 * Who may report, checked against the ledger and the sender the host observed, never against
 * anything the block says about itself. `observed.agentId` is the agent whose timeline held the
 * block, `observed.messageId` the dispatch message that opened the reply window.
 *
 * `duplicate` is not a failure of the sender: the same report was already accepted, so the caller
 * records the delivery as seen and changes nothing.
 */
export function verifyReportOwnership(
  record: Pick<RunRecord, "runId" | "assignments" | "nonceRegistry">,
  kind: RunProtocolBlockName,
  block: ReportBlock,
  observed: { agentId: string; messageId: string; turnId?: string },
): OwnershipResult {
  if (block.runId !== record.runId) return { ok: false, code: "run-mismatch" };
  const assignment = record.assignments.find((entry) => entry.assignmentId === block.assignmentId);
  if (!assignment) return { ok: false, code: "assignment-unknown" };
  if (assignment.taskId !== block.taskId) return { ok: false, code: "task-mismatch" };
  if (assignment.attempt !== block.attempt) return { ok: false, code: "attempt-mismatch" };
  if (!PURPOSES_BY_KIND[kind]?.includes(assignment.purpose)) {
    return { ok: false, code: "wrong-purpose" };
  }
  if (assignment.nonce !== block.nonce) return { ok: false, code: "nonce-mismatch" };
  const nonce = record.nonceRegistry.find((entry) => entry.nonce === block.nonce);
  if (
    !nonce ||
    nonce.runId !== record.runId ||
    nonce.assignmentId !== assignment.assignmentId ||
    nonce.taskId !== assignment.taskId ||
    nonce.attempt !== assignment.attempt
  ) {
    return { ok: false, code: "nonce-registry-mismatch" };
  }
  if (nonce.revokedAt !== null) return { ok: false, code: "nonce-revoked" };
  if (assignment.agentId !== observed.agentId || nonce.agentId !== observed.agentId) {
    return { ok: false, code: "sender-not-assignee" };
  }
  if (assignment.messageId !== observed.messageId) return { ok: false, code: "message-mismatch" };
  if (
    "messageId" in block &&
    typeof block.messageId === "string" &&
    block.messageId !== assignment.messageId
  ) {
    return { ok: false, code: "message-mismatch" };
  }
  if (
    observed.turnId !== undefined &&
    assignment.turnId !== null &&
    assignment.turnId !== observed.turnId
  ) {
    return { ok: false, code: "turn-mismatch" };
  }
  if (nonce.acceptedAt !== null || assignment.acceptedProof !== null) {
    return { ok: false, code: "duplicate" };
  }
  if (assignment.state === "cancelled" || assignment.state === "failed") {
    return { ok: false, code: "assignment-closed" };
  }
  return { ok: true, assignment, nonce };
}
