import { createHash } from "node:crypto";
import { utf8ByteLength } from "../../shared/domain/design-output";
import type { DesignIssue } from "../../shared/schemas/design";
import type { DesignAttemptRecord, StoredDesignJob } from "./store";

export const TIMELINE_PAGE_LIMIT = 100;
export const TIMELINE_MAX_PAGES = 20;
export const TIMELINE_MAX_BYTES = 512 * 1024;

export type DesignTimelineItem = {
  seqStart: number;
  seqEnd: number;
  type:
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "reasoning"
    | "plugin"
    | "error"
    | "notification";
  text?: string;
  messageId?: string;
  clientMessageId?: string;
  turnId?: string | null;
  level?: "error" | "info";
};

export type DesignTimelinePage = {
  epoch: string;
  entries: readonly DesignTimelineItem[];
  hasOlder: boolean;
  hasNewer: boolean;
  gap: boolean;
  reset: boolean;
  staleCursor: boolean;
  beforeCursor: string | null;
};

export type DesignAgentRefresh = {
  status: "initializing" | "idle" | "running" | "closed" | "error" | null;
  activeTurn: boolean;
  pendingPermissionCount: number;
  lastError: string | null;
};

/** TODO(G4): replace this local port with shared/paseo/design-port.ts once the adapter lands. */
export type DesignTimelinePort = {
  refresh(agentId: string): Promise<DesignAgentRefresh>;
  refetch(input: {
    agentId: string;
    cursor: string | null;
    direction: "before";
  }): Promise<DesignTimelinePage>;
};

export type AttemptTextFact =
  | {
      status: "complete";
      text: string;
      outputHash: string;
      boundary: string;
      turnId: string | null;
    }
  | {
      status: "incomplete" | "external-input" | "running" | "error";
      issue: DesignIssue["code"];
    };

export type AttemptObservation = {
  outcome?: "completed" | "failed" | "canceled" | null;
};

function incomplete(code: DesignIssue["code"] = "DESIGN_TIMELINE_INCOMPLETE"): AttemptTextFact {
  return { status: "incomplete", issue: code };
}

function boundaryOf(attempt: DesignAttemptRecord): string {
  return createHash("sha256")
    .update(`${attempt.messageId}\n${attempt.promptHash}`, "utf8")
    .digest("hex");
}

function isUserBoundary(item: DesignTimelineItem, messageId: string | undefined): boolean {
  return (
    item.type === "user_message" &&
    messageId !== undefined &&
    (item.messageId === messageId || item.clientMessageId === messageId)
  );
}

function mergeEntries(
  current: DesignTimelineItem[],
  incoming: readonly DesignTimelineItem[],
): DesignTimelineItem[] | "overlap" {
  const merged = [...current];
  for (const entry of incoming) {
    const exact = merged.findIndex(
      (item) => item.seqStart === entry.seqStart && item.seqEnd === entry.seqEnd,
    );
    if (exact >= 0) continue;
    const contained = merged.findIndex(
      (item) => entry.seqStart <= item.seqStart && entry.seqEnd >= item.seqEnd,
    );
    if (contained >= 0) {
      merged[contained] = entry;
      continue;
    }
    const contains = merged.some(
      (item) => item.seqStart <= entry.seqStart && item.seqEnd >= entry.seqEnd,
    );
    if (contains) continue;
    const overlaps = merged.some(
      (item) => entry.seqStart <= item.seqEnd && item.seqStart <= entry.seqEnd,
    );
    if (overlaps) return "overlap";
    merged.push(entry);
  }
  return merged;
}

async function readPages(
  port: DesignTimelinePort,
  job: StoredDesignJob,
  attempt: DesignAttemptRecord,
  ignoreEpoch: boolean,
): Promise<DesignTimelineItem[] | AttemptTextFact> {
  let entries: DesignTimelineItem[] = [];
  let cursor: string | null = null;
  let bytes = 0;
  for (let page = 1; page <= TIMELINE_MAX_PAGES; page += 1) {
    const result = await port.refetch({ agentId: job.job.agentId, cursor, direction: "before" });
    if (result.gap || result.reset || result.staleCursor) return incomplete();
    if (!ignoreEpoch && attempt.epoch && result.epoch !== attempt.epoch) return incomplete();
    const merged = mergeEntries(entries, result.entries);
    if (merged === "overlap") return incomplete();
    entries = merged;
    bytes += result.entries.reduce((total, entry) => total + utf8ByteLength(entry.text ?? ""), 0);
    if (bytes > TIMELINE_MAX_BYTES || result.entries.length > TIMELINE_PAGE_LIMIT)
      return incomplete();
    if (!result.hasOlder || result.beforeCursor === null) return entries;
    cursor = result.beforeCursor;
  }
  return incomplete();
}

/**
 * Reads one attempt's assistant text. Proposal extraction stays in design-output.ts, and G6 decides
 * whether this fact changes the job. A failed or canceled hook never promotes partial JSON.
 */
export async function readAttemptText(
  port: DesignTimelinePort,
  job: StoredDesignJob,
  attempt: 1 | 2 | 3,
  observed: AttemptObservation = {},
): Promise<AttemptTextFact> {
  const recorded = job.attempts.find((item) => item.attempt === attempt);
  if (!recorded) return incomplete();
  if (observed.outcome === "failed" || observed.outcome === "canceled") {
    return { status: "error", issue: "DESIGN_AGENT_FAILED" };
  }
  const agent = await port.refresh(job.job.agentId);
  if (agent.status === null) return incomplete();
  if (
    agent.status === "initializing" ||
    agent.status === "running" ||
    agent.activeTurn ||
    agent.pendingPermissionCount > 0
  ) {
    return { status: "running", issue: "DESIGN_TIMELINE_INCOMPLETE" };
  }
  if (agent.status === "error" || agent.status === "closed") {
    return { status: "error", issue: "DESIGN_AGENT_FAILED" };
  }

  let pages = await readPages(port, job, recorded, false);
  if (!Array.isArray(pages)) {
    pages = await readPages(port, job, recorded, true);
    if (!Array.isArray(pages)) return pages;
  }
  // A missing baseline is treated as null: a new error string must never be accepted as a quiet
  // completion just because the pre-send baseline was not persisted.
  if (agent.lastError !== (recorded.lastError ?? null))
    return { status: "error", issue: "DESIGN_AGENT_FAILED" };
  const ordered = [...pages].sort(
    (left, right) => left.seqStart - right.seqStart || left.seqEnd - right.seqEnd,
  );
  const start = ordered.findIndex((item) => isUserBoundary(item, recorded.messageId));
  if (start < 0) return incomplete();
  const nextAttempt = job.attempts.find((item) => item.attempt === attempt + 1);
  const rest = ordered.slice(start + 1);
  const nextUser = rest.findIndex((item) => item.type === "user_message");
  if (
    nextUser >= 0 &&
    !isUserBoundary(
      rest[nextUser] ?? { seqStart: 0, seqEnd: 0, type: "error" },
      nextAttempt?.messageId,
    )
  ) {
    return { status: "external-input", issue: "DESIGN_EXTERNAL_INPUT" };
  }
  const bounded = nextUser < 0 ? rest : rest.slice(0, nextUser);
  if (
    bounded.some(
      (item) => item.type === "error" || (item.type === "notification" && item.level === "error"),
    )
  ) {
    return { status: "error", issue: "DESIGN_AGENT_FAILED" };
  }
  const turnIds = [...new Set(bounded.flatMap((item) => (item.turnId ? [item.turnId] : [])))];
  if (turnIds.length > 1) return incomplete();
  const turnId = turnIds[0] ?? null;
  if (recorded.turnId && turnId !== recorded.turnId) return incomplete();
  const text = bounded
    .filter((item) => item.type === "assistant_message")
    .map((item) => item.text ?? "")
    .join("");
  return {
    status: "complete",
    text,
    outputHash: createHash("sha256").update(text, "utf8").digest("hex"),
    boundary: boundaryOf(recorded),
    turnId,
  };
}
