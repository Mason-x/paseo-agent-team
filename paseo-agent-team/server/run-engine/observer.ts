import { latestSentWake } from "../../shared/domain/run-engine/plan-repair";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { REPORT_KINDS_BY_PURPOSE, replyAnchor } from "../../shared/domain/run-engine/report-repair";
import type { RunEventReceipt, RunRecord } from "../../shared/schemas/run-engine/ledger";
import type {
  RunProtocolBlock,
  RunProtocolBlockName,
} from "../../shared/schemas/run-engine/protocol";
import {
  extractProtocolBlock,
  type OwnershipResult,
  type ProtocolIssue,
  type ReplyWindow,
  type UnverifiableReason,
  verifyReportOwnership,
} from "./protocol";
import type { ReadFailure } from "./read-retry";
import type { RunStore } from "./store";

/**
 * Observation only. Nothing in this module creates an agent, sends a message, cancels, or moves a
 * task. The only write it makes is `observation-recorded` receipts, which are facts about what the
 * host reported, deduplicated by key. Reading a reply and judging a report are separate calls that
 * write nothing at all.
 */

export type ObserverHookEvent =
  | { name: "agent.turn_started"; agentId: string; turnId: string | null }
  | {
      name: "agent.turn_ended";
      agentId: string;
      turnId: string | null;
      outcome?: { kind: string };
    }
  | { name: "agent.permission_requested"; agentId: string; requestId: string }
  | { name: "agent.permission_resolved"; agentId: string; requestId: string }
  | { name: "agent.created" | "agent.closed" | "agent.archived"; agentId: string };

export type IngestResult =
  | { status: "recorded"; runId: string }
  | { status: "duplicate"; runId: string }
  | { status: "buffered"; reason: "store-not-ready" | "no-owner-yet" }
  | { status: "ignored"; reason: "no-turn-id" | "ambiguous-owner" | "no-active-run" }
  | { status: "rejected"; runId: string; reason: string };

export type ObserverHost = {
  /** Reads the canonical timeline pages for one agent and builds the reply window. Read only. */
  replyWindow(agentId: string, dispatchMessageId: string): Promise<ReplyWindow>;
};

export type ReportInspection =
  | { status: "unknown-assignment" }
  | { status: "unverifiable"; reason: UnverifiableReason }
  | { status: "missing"; turnId: string; anchor: string }
  | {
      status: "rejected";
      reason: string;
      kind?: RunProtocolBlockName;
      issues?: ProtocolIssue[];
      turnId: string;
      /** The message whose reply was read: the dispatch, or the newest repair request. */
      anchor: string;
    }
  | {
      status: "report";
      kind: RunProtocolBlockName;
      block: RunProtocolBlock;
      turnId: string;
      anchor: string;
      ownership: OwnershipResult;
    };

export type ReconcileSummary = {
  runsScanned: number;
  brokenRuns: number;
  turnsChecked: number;
  recorded: number;
  duplicates: number;
  unverifiable: number;
  hostErrors: number;
};

export type ObserverOptions = {
  store: RunStore;
  clock?: { now(): string };
  ids?: { next(): string };
  log?: (message: string, detail?: unknown) => void;
  /** Hooks that arrived before any run named their agent. Oldest are dropped past this size. */
  bufferLimit?: number;
  /** A buffered hook older than this is dropped and the observer is marked as needing a reconcile. */
  bufferTtlMs?: number;
  /** Told when reconcile could not read the reply an open assignment waits for, so it is read again. */
  onReadFailure?: (runId: string, failure: ReadFailure) => void | Promise<void>;
};

const RECEIPT_KIND = {
  "agent.turn_started": "turn_started",
  "agent.turn_ended": "turn_ended",
  "agent.permission_requested": "permission_requested",
  "agent.permission_resolved": "permission_resolved",
  "agent.created": "created",
  "agent.closed": "closed",
  "agent.archived": "archived",
} as const;

type Buffered = { event: ObserverHookEvent; at: number };

type Normalized = {
  receipt: Omit<RunEventReceipt, "seq" | "receivedAt">;
};

function normalize(event: ObserverHookEvent): Normalized | { skip: "no-turn-id" } {
  const kind = RECEIPT_KIND[event.name];
  let subject: string | null = null;
  let turnId: string | null = null;
  if (event.name === "agent.turn_started" || event.name === "agent.turn_ended") {
    if (event.turnId === null) return { skip: "no-turn-id" };
    subject = event.turnId;
    turnId = event.turnId;
  } else if (
    event.name === "agent.permission_requested" ||
    event.name === "agent.permission_resolved"
  ) {
    subject = event.requestId;
  }
  const key = `${kind}:${event.agentId}:${subject ?? "-"}`;
  const receipt: Normalized["receipt"] = {
    eventKey: key,
    kind,
    agentId: event.agentId,
    turnId,
    dedupeKey: key,
    disposition: "observed",
  };
  if (event.name === "agent.turn_ended" && event.outcome) {
    (receipt as Record<string, unknown>).outcome = event.outcome.kind;
  }
  return { receipt };
}

export type AppendedObservation =
  | { status: "appended"; next: RunRecord }
  | { status: "duplicate" }
  | { status: "rejected"; reason: string };

/**
 * The one way a receipt gets into the ledger: through the reducer's `observation-recorded`, which
 * numbers it (`seq`, `counters.observationSeq`) and drops a key it has seen. The observer uses it for
 * what the host reported, and the Engine's own settlement of a closed member's turn (`member-lost.ts`)
 * uses it too, inside its own store update, so both are counted and deduplicated the same way.
 */
export function appendObservation(
  current: RunRecord,
  receipt: Omit<RunEventReceipt, "seq" | "receivedAt">,
  received: string,
  newId: () => string,
): AppendedObservation {
  if (current.eventReceipts.some((entry) => entry.dedupeKey === receipt.dedupeKey)) {
    return { status: "duplicate" };
  }
  const reduced = reduceRun(
    current,
    {
      kind: "observation-recorded",
      receipt: { ...receipt, seq: 0, receivedAt: received } as RunEventReceipt,
    },
    { now: received, newId },
  );
  if (!reduced.ok) {
    return {
      status: "rejected",
      reason: `${reduced.code}:${String(reduced.params.reason ?? "")}`,
    };
  }
  return { status: "appended", next: reduced.next };
}

export function createRunObserver(options: ObserverOptions) {
  const store = options.store;
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  let idCounter = 0;
  const newId = options.ids ? () => options.ids?.next() ?? "" : () => `obs-${++idCounter}`;
  const log = options.log ?? (() => undefined);
  const bufferLimit = options.bufferLimit ?? 256;
  const bufferTtlMs = options.bufferTtlMs ?? 10 * 60 * 1000;
  let buffer: Buffered[] = [];
  let lost = false;

  function hold(event: ObserverHookEvent): void {
    buffer.push({ event, at: Date.parse(clock.now()) });
    while (buffer.length > bufferLimit) {
      buffer.shift();
      lost = true;
    }
  }

  async function record(
    runId: string,
    normalized: Normalized,
    received: string,
  ): Promise<IngestResult> {
    const state: { outcome: IngestResult } = { outcome: { status: "duplicate", runId } };
    await store.update(runId, (current) => {
      const appended = appendObservation(current, normalized.receipt, received, newId);
      if (appended.status === "duplicate") return null;
      if (appended.status === "rejected") {
        state.outcome = { status: "rejected", runId, reason: appended.reason };
        return null;
      }
      state.outcome = { status: "recorded", runId };
      return appended.next;
    });
    return state.outcome;
  }

  async function ingestNow(event: ObserverHookEvent): Promise<IngestResult> {
    if (!store.ready) return { status: "buffered", reason: "store-not-ready" };
    const normalized = normalize(event);
    if ("skip" in normalized) return { status: "ignored", reason: normalized.skip };
    const owners = await store.runsForAgent(event.agentId);
    if (owners.length === 0) {
      // A run is created before its members, so an agent no live run names yet can only be early
      // if some run is live (or unreadable, so its members are unknown). With none, no run could
      // ever claim it: holding it would only fill the buffer with every unrelated agent's events.
      const { entries, broken } = await store.list();
      const live = entries.some(
        (entry) => entry.lifecycle !== "finished" && entry.lifecycle !== "cancelled",
      );
      if (!live && broken.length === 0) return { status: "ignored", reason: "no-active-run" };
      return { status: "buffered", reason: "no-owner-yet" };
    }
    const [owner] = owners;
    if (owners.length > 1 || owner === undefined) {
      return { status: "ignored", reason: "ambiguous-owner" };
    }
    return record(owner, normalized, clock.now());
  }

  return {
    /**
     * One host hook. Duplicate delivery, out-of-order delivery and delivery before the run names the
     * agent are all safe: receipts are independent facts keyed by (kind, agent, turn or request).
     */
    async ingest(event: ObserverHookEvent): Promise<IngestResult> {
      const result = await ingestNow(event);
      if (result.status === "buffered") hold(event);
      return result;
    },

    /** Retries held hooks, oldest first. Call after the store is ready or a run is created. */
    async flush(): Promise<{ delivered: number; held: number; dropped: number }> {
      const pending = buffer;
      buffer = [];
      const cutoff = Date.parse(clock.now()) - bufferTtlMs;
      let delivered = 0;
      let dropped = 0;
      for (const item of pending) {
        if (item.at < cutoff) {
          dropped += 1;
          lost = true;
          continue;
        }
        const result = await ingestNow(item.event);
        if (result.status === "buffered") buffer.push(item);
        else delivered += 1;
      }
      return { delivered, held: buffer.length, dropped };
    },

    /** True once a hook was dropped (overflow or age): hooks alone can no longer be trusted. */
    get needsReconcile(): boolean {
      return lost;
    },

    get buffered(): number {
      return buffer.length;
    },

    /**
     * Fills in what hooks missed by reading the host. Records only turn_ended receipts that the
     * timeline proves; an unreadable or partial timeline is counted, never treated as "no turn".
     */
    async reconcile(host: ObserverHost, only?: { runId: string }): Promise<ReconcileSummary> {
      const summary: ReconcileSummary = {
        runsScanned: 0,
        brokenRuns: 0,
        turnsChecked: 0,
        recorded: 0,
        duplicates: 0,
        unverifiable: 0,
        hostErrors: 0,
      };
      const listed = await store.list();
      summary.brokenRuns = listed.broken.length;
      for (const entry of listed.entries) {
        if (only !== undefined && entry.runId !== only.runId) continue;
        if (entry.lifecycle === "finished" || entry.lifecycle === "cancelled") continue;
        const read = await store.get(entry.runId);
        if (read.status !== "ok") {
          summary.brokenRuns += 1;
          continue;
        }
        summary.runsScanned += 1;
        // What the Run is waiting on: each open assignment's dispatch, and, until its DAG is in,
        // the coordinator's reply to the newest plan request.
        const waiting: {
          agentId: string;
          messageId: string;
          assignment?: { taskId: string; assignmentId: string };
        }[] = [];
        for (const assignment of read.record.assignments) {
          if (assignment.state !== "assigned" && assignment.state !== "in_progress") continue;
          waiting.push({
            agentId: assignment.agentId,
            messageId: replyAnchor(read.record, assignment),
            assignment: { taskId: assignment.taskId, assignmentId: assignment.assignmentId },
          });
        }
        const lifecycle = read.record.lifecycle;
        if (lifecycle === "bootstrapping" || lifecycle === "awaiting-dag") {
          const coordinator = read.record.roster.find((seat) => seat.seatId === "coordinator");
          const plan = coordinator?.agentId
            ? latestSentWake(read.record, coordinator.agentId)
            : undefined;
          if (coordinator?.agentId && plan) {
            waiting.push({ agentId: coordinator.agentId, messageId: plan.messageId });
          }
        }
        for (const item of waiting) {
          summary.turnsChecked += 1;
          let window: ReplyWindow;
          try {
            window = await host.replyWindow(item.agentId, item.messageId);
          } catch (error) {
            summary.hostErrors += 1;
            log(`reconcile could not read ${item.agentId}`, error);
            // The coordinator's plan reply has no assignment, so it is not retried here.
            if (item.assignment !== undefined) {
              try {
                await options.onReadFailure?.(entry.runId, {
                  type: "reply",
                  agentId: item.agentId,
                  taskId: item.assignment.taskId,
                  assignmentId: item.assignment.assignmentId,
                  anchorMessageId: item.messageId,
                });
              } catch (failure) {
                log(`could not note the failed read of ${item.agentId}`, failure);
              }
            }
            continue;
          }
          if (!window.complete) {
            summary.unverifiable += 1;
            continue;
          }
          const normalized = normalize({
            name: "agent.turn_ended",
            agentId: item.agentId,
            turnId: window.turnId,
          });
          if ("skip" in normalized) continue;
          const result = await record(entry.runId, normalized, clock.now());
          if (result.status === "recorded") summary.recorded += 1;
          else if (result.status === "duplicate") summary.duplicates += 1;
        }
      }
      if (summary.unverifiable === 0 && summary.hostErrors === 0 && summary.brokenRuns === 0) {
        lost = false;
      }
      return summary;
    },

    /**
     * Reads and judges one agent's reply to one assignment without changing anything. `agentId` is
     * the agent whose timeline carried the text, as the host reported it, not what the text claims.
     */
    async inspectReport(
      input: { runId: string; assignmentId: string; agentId: string },
      host: ObserverHost,
    ): Promise<ReportInspection> {
      const read = await store.get(input.runId);
      if (read.status !== "ok") return { status: "unknown-assignment" };
      const record: RunRecord = read.record;
      const assignment = record.assignments.find(
        (entry) => entry.assignmentId === input.assignmentId,
      );
      if (!assignment) return { status: "unknown-assignment" };
      const expected = REPORT_KINDS_BY_PURPOSE[assignment.purpose] as
        | readonly RunProtocolBlockName[]
        | null;
      if (expected === null) return { status: "unknown-assignment" };
      // After a repair request went out, the report to read is the reply to that request.
      const anchor = replyAnchor(record, assignment);
      const window = await host.replyWindow(input.agentId, anchor);
      if (!window.complete) return { status: "unverifiable", reason: window.reason };
      const extracted = extractProtocolBlock(window.text, { expected });
      if (extracted.status === "unverifiable") {
        return { status: "unverifiable", reason: extracted.reason };
      }
      if (extracted.status === "none") {
        return { status: "missing", turnId: window.turnId, anchor };
      }
      if (extracted.status === "rejected") {
        return {
          status: "rejected",
          reason: extracted.reason,
          kind: extracted.kind,
          issues: extracted.issues,
          turnId: window.turnId,
          anchor,
        };
      }
      const ownership = verifyReportOwnership(
        record,
        extracted.kind,
        extracted.block as Parameters<typeof verifyReportOwnership>[2],
        { agentId: input.agentId, messageId: assignment.messageId, turnId: window.turnId },
      );
      return {
        status: "report",
        kind: extracted.kind,
        block: extracted.block,
        turnId: window.turnId,
        anchor,
        ownership,
      };
    },
  };
}

export type RunObserver = ReturnType<typeof createRunObserver>;
