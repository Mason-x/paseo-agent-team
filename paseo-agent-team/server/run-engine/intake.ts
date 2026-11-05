import { createHash, randomUUID } from "node:crypto";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import { type ReduceFacts, reduceRun } from "../../shared/domain/run-engine/reducer";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import type { RunAssignment, RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { RunProtocolBlock } from "../../shared/schemas/run-engine/protocol";
import type { ObserverHost, RunObserver } from "./observer";
import { type UnverifiableReason, verifyReportOwnership } from "./protocol";
import type { RunStore } from "./store";

/**
 * Report intake: turns what the host showed (a turn that ended, a reply holding one protocol block)
 * into reducer events. This is the only place that accepts a member's report; the observer judges
 * and records receipts, this commits.
 *
 * One call settles one assignment in a single store update: the dispatch is confirmed if the
 * timeline echoed it, then `turn-started`, the report, and `turn-ended` go through the reducer in
 * that order. If any step is refused nothing is committed, so a half-applied report cannot exist.
 *
 * What it will not do: guess. A reply that cannot be read completely is left for a later try; a
 * reply with no block, a rejected block or a report that is not the assignee's changes no state and
 * only records why the task is not moving. The member's artifacts stay, the claims stay, and no new
 * message is sent. Asking the member to repair the report is a separate, later piece (plan P05).
 */

export type IntakeResult =
  | { status: "run-unavailable" }
  | { status: "no-assignment" }
  | { status: "host-error" }
  | { status: "unverifiable"; reason: UnverifiableReason }
  /** The reply is complete but the host's turn_ended receipt is not recorded yet. */
  | { status: "turn-not-ended" }
  | { status: "duplicate"; assignmentId: string }
  | { status: "problem"; assignmentId: string; reason: string }
  | {
      status: "settled";
      assignmentId: string;
      kind: "task-report" | "review-report" | "smoke-report";
      taskState: string;
    };

export type IntakeOptions = {
  store: Pick<RunStore, "get" | "update" | "runsForAgent">;
  observer: Pick<RunObserver, "inspectReport">;
  host: ObserverHost;
  clock?: { now(): string };
  ids?: { uuid(): string };
  /** Called after a report was committed, so the next unit of work can be dispatched. */
  onSettled?: (runId: string) => void;
  log?: (message: string, detail?: unknown) => void;
};

const OPEN_STATES: readonly RunAssignment["state"][] = ["assigned", "in_progress"];
const SENT_STATES = ["sending", "confirmed", "outcome-unknown"];
const REPORT_PURPOSES: readonly RunAssignment["purpose"][] = [
  "member",
  "coordinator",
  "reopen",
  "reviewer",
  "smoker",
];

/** An assignment waiting for a report: open, no accepted proof, and its message has gone out. */
function awaitingReport(record: RunRecord, assignment: RunAssignment): boolean {
  if (!OPEN_STATES.includes(assignment.state) || assignment.acceptedProof !== null) return false;
  if (!REPORT_PURPOSES.includes(assignment.purpose)) return false;
  return record.outbox.some(
    (intent) =>
      intent.kind === "dispatch" &&
      intent.assignmentId === assignment.assignmentId &&
      SENT_STATES.includes(intent.state),
  );
}

export function createIntake(options: IntakeOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  const chains = new Map<string, Promise<unknown>>();

  /**
   * Facts for the reducer. A quality failure that ends in a decision needs a control nonce digest;
   * the nonce itself is not kept here, because decisions are answered by a person against the
   * decision id (plan P06), not by a block carrying the nonce.
   */
  function facts(now: string): ReduceFacts {
    return {
      now,
      // The only ids the reducer asks for are decision ids, and the ledger requires a UUID.
      newId: () => uuid(),
      newDecisionNonceDigest: () => createHash("sha256").update(uuid(), "utf8").digest("hex"),
    };
  }

  /** Writes only "why this task is not moving"; changes nothing else. */
  async function recordProblem(
    runId: string,
    assignmentId: string,
    reason: string,
  ): Promise<IntakeResult> {
    await options.store.update(runId, (current) => {
      const assignment = current.assignments.find((entry) => entry.assignmentId === assignmentId);
      if (!assignment || !awaitingReport(current, assignment)) return null;
      const noted = noteTask(current, assignment.taskId, reason, {
        now: clock.now(),
        detail: { assignmentId },
      });
      return noted.ok && noted.changed ? noted.next : null;
    });
    return { status: "problem", assignmentId, reason };
  }

  async function settleAssignment(
    runId: string,
    assignmentId: string,
    agentId: string,
  ): Promise<IntakeResult> {
    let inspected: Awaited<ReturnType<RunObserver["inspectReport"]>>;
    try {
      inspected = await options.observer.inspectReport(
        { runId, assignmentId, agentId },
        options.host,
      );
    } catch (error) {
      log(`cannot read the reply of ${agentId}`, error);
      return { status: "host-error" };
    }

    switch (inspected.status) {
      case "unknown-assignment":
        return { status: "no-assignment" };
      case "unverifiable":
        return { status: "unverifiable", reason: inspected.reason };
      case "missing":
        return recordProblem(runId, assignmentId, "report-missing");
      case "rejected":
        return recordProblem(runId, assignmentId, `report-rejected:${inspected.reason}`);
      case "report":
        break;
    }
    if (!inspected.ownership.ok) {
      if (inspected.ownership.code === "duplicate") return { status: "duplicate", assignmentId };
      return recordProblem(runId, assignmentId, `report-ownership:${inspected.ownership.code}`);
    }

    const { kind, block, turnId } = inspected;
    if (kind !== "task-report" && kind !== "review-report" && kind !== "smoke-report") {
      return recordProblem(runId, assignmentId, `report-rejected:unexpected-kind`);
    }
    const holder: { result: IntakeResult } = { result: { status: "no-assignment" } };

    await options.store.update(runId, (current) => {
      const now = clock.now();
      const assignment = current.assignments.find((entry) => entry.assignmentId === assignmentId);
      if (!assignment || !awaitingReport(current, assignment)) {
        holder.result = { status: "duplicate", assignmentId };
        return null;
      }
      // The snapshot the report was read against may be stale: judge ownership on what is stored.
      const owned = verifyReportOwnership(current, kind, block as never, {
        agentId,
        messageId: assignment.messageId,
        turnId,
      });
      if (!owned.ok) {
        holder.result =
          owned.code === "duplicate"
            ? { status: "duplicate", assignmentId }
            : { status: "problem", assignmentId, reason: `report-ownership:${owned.code}` };
        const noted =
          owned.code === "duplicate"
            ? null
            : noteTask(current, assignment.taskId, `report-ownership:${owned.code}`, {
                now,
                detail: { assignmentId },
              });
        return noted?.ok && noted.changed ? noted.next : null;
      }

      let working = current;
      // The timeline echoed the dispatch, which is the evidence an unconfirmed send was delivered.
      const intent = working.outbox.find(
        (entry) => entry.kind === "dispatch" && entry.assignmentId === assignmentId,
      );
      if (intent && (intent.state === "sending" || intent.state === "outcome-unknown")) {
        const confirmed = transitionIntent(working, intent.id, "confirmed", {
          now,
          reason: "echo",
        });
        if (confirmed.ok) working = confirmed.next;
      }

      const ended = working.eventReceipts.find(
        (receipt) =>
          receipt.kind === "turn_ended" && receipt.agentId === agentId && receipt.turnId === turnId,
      );
      if (!ended) {
        holder.result = { status: "turn-not-ended" };
        return null;
      }

      const steps: unknown[] = [];
      if (assignment.state === "assigned") {
        steps.push({ kind: "turn-started", assignmentId, agentId, turnId });
      }
      steps.push({ kind, block: block as RunProtocolBlock });
      steps.push({ kind: "turn-ended", assignmentId, endedEventKey: ended.eventKey });

      for (const step of steps) {
        const reduced = reduceRun(working, step as never, facts(now));
        if (!reduced.ok) {
          const reason = `report-refused:${String(reduced.params.reason ?? reduced.code)}`;
          holder.result = { status: "problem", assignmentId, reason };
          const noted = noteTask(current, assignment.taskId, reason, {
            now,
            detail: { assignmentId },
          });
          return noted.ok && noted.changed ? noted.next : null;
        }
        working = reduced.next;
      }
      holder.result = {
        status: "settled",
        assignmentId,
        kind,
        taskState: working.tasks.find((entry) => entry.spec.id === assignment.taskId)?.state ?? "?",
      };
      return working;
    });

    if (holder.result.status === "settled") options.onSettled?.(runId);
    return holder.result;
  }

  async function settleRun(runId: string, agentId: string): Promise<IntakeResult[]> {
    const read = await options.store.get(runId);
    if (read.status !== "ok") return [{ status: "run-unavailable" }];
    const open = read.record.assignments.filter(
      (entry) => entry.agentId === agentId && awaitingReport(read.record, entry),
    );
    if (open.length === 0) return [{ status: "no-assignment" }];
    const results: IntakeResult[] = [];
    for (const assignment of open) {
      results.push(await settleAssignment(runId, assignment.assignmentId, agentId));
    }
    return results;
  }

  return {
    /**
     * Call after a `turn_ended` was recorded for `agentId` (or after a reconcile). Safe to call any
     * number of times: an assignment that is already settled reports `duplicate` and changes
     * nothing. Calls for one Run are serialized in this process.
     */
    async settleAgent(agentId: string): Promise<IntakeResult[]> {
      const owners = await options.store.runsForAgent(agentId);
      const results: IntakeResult[] = [];
      for (const runId of owners) {
        const previous = chains.get(runId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => settleRun(runId, agentId));
        chains.set(
          runId,
          run.catch(() => undefined),
        );
        results.push(...(await run));
      }
      return results.length === 0 ? [{ status: "no-assignment" }] : results;
    },
  };
}

export type Intake = ReturnType<typeof createIntake>;
