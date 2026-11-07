import { createHash, randomUUID } from "node:crypto";
import { openLimboDecision } from "../../shared/domain/run-engine/decision-answer";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import {
  compileRepairRequest,
  REPAIR_REQUEST_VERSION,
} from "../../shared/domain/run-engine/engine-prompts";
import { type ReduceFacts, reduceRun } from "../../shared/domain/run-engine/reducer";
import {
  type RepairIssue,
  requestReportRepair,
  settleRepairs,
} from "../../shared/domain/run-engine/report-repair";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import type { RunAssignment, RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { RunProtocolBlock } from "../../shared/schemas/run-engine/protocol";
import { sha256Hex } from "./digest";
import { payloadHash } from "./effects";
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
 * message is sent. Asking the member to repair the report is opt-in (`options.repair`): a missing or
 * refused block then gets a bounded number of repair requests (`report-repair.ts`) before the task is
 * left waiting as above.
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
  /**
   * Turns on report repair. `send` runs the outbox of the Run after a repair request was committed
   * (the intake itself sends nothing). Without it a bad report only leaves its reason on the task.
   */
  repair?: { send(runId: string): Promise<unknown> };
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

  /**
   * Writes "why this task is not moving". With repair on, a report that is missing or refused by
   * the parser also gets a repair request, once per message that was read and within the budget; the
   * request is committed with the reason, and sent after the commit.
   *
   * When nothing more can be asked for (the repair budget is spent, repair is off, the turn did not end
   * well, or the problem is not one a repeat could fix) and the turn that was read is known to have
   * ended, the producer's attempt has nobody to wait for: the same commit opens the decision a person
   * answers (`openLimboDecision`). The task keeps its state; nothing is released.
   */
  async function recordProblem(
    runId: string,
    assignmentId: string,
    reason: string,
    repairable?: { anchor: string; turnId: string; issues: readonly RepairIssue[] },
    readTurnId?: string,
  ): Promise<IntakeResult> {
    let requested = false;
    let open = false;
    await options.store.update(runId, (current) => {
      const assignment = current.assignments.find((entry) => entry.assignmentId === assignmentId);
      if (!assignment || !awaitingReport(current, assignment)) return null;
      const now = clock.now();
      // Nothing left to ask for. A problem a repeat could fix stays open until the budget says no.
      // Part of the same opt-in as the repair itself: without `options.repair` nothing here is new.
      let terminal = options.repair !== undefined && repairable === undefined;
      if (repairable !== undefined && options.repair !== undefined) {
        // Only a turn that ended on its own can be asked again; a turn that failed or was
        // interrupted is a host problem, and a repair would not fix it.
        const ended = current.eventReceipts.find(
          (receipt) =>
            receipt.kind === "turn_ended" &&
            receipt.agentId === assignment.agentId &&
            receipt.turnId === repairable.turnId,
        );
        if (ended === undefined) {
          // The reply being read belongs to a turn that is still running (a repeated hook for the
          // previous turn reads the newest repair's window): nothing to judge, nothing to note.
          open = true;
          return null;
        }
        const outcome = (ended as { outcome?: unknown } | undefined)?.outcome;
        if (outcome === undefined || outcome === "completed") {
          const draft = requestReportRepair(current, {
            assignmentId,
            anchor: repairable.anchor,
            reason,
            issues: repairable.issues,
            intentId: `intent-repair-${uuid().replace(/-/gu, "").slice(0, 12)}`,
            messageId: uuid(),
            payloadHash: "0".repeat(64),
            templateVersion: REPAIR_REQUEST_VERSION,
            now,
          });
          if (draft.ok) {
            const intent = draft.next.outbox.at(-1);
            const text = intent?.kind === "wake" ? compileRepairRequest(intent, draft.next) : null;
            if (intent !== undefined && text !== null) {
              intent.payloadHash = payloadHash(text);
              requested = true;
              return draft.next;
            }
          } else {
            terminal = draft.code === "limit-reached";
          }
        } else {
          terminal = true;
        }
      }
      const noted = noteTask(current, assignment.taskId, reason, {
        now,
        detail: { assignmentId },
      });
      let next = noted.ok && noted.changed ? noted.next : current;
      const turnId = repairable?.turnId ?? readTurnId;
      if (terminal && turnId !== undefined) {
        const opened = openLimboDecision(next, {
          taskId: assignment.taskId,
          assignmentId,
          reason,
          turnId,
          decisionId: uuid(),
          controlNonceDigest: sha256Hex(uuid()),
          now,
        });
        if (opened.changed) next = opened.next;
      }
      return next === current ? null : next;
    });
    if (open) return { status: "turn-not-ended" };
    if (requested) {
      try {
        await options.repair?.send(runId);
      } catch (error) {
        log(`repair request for ${assignmentId} could not be sent`, error);
      }
    }
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
        return recordProblem(runId, assignmentId, "report-missing", {
          anchor: inspected.anchor,
          turnId: inspected.turnId,
          issues: [],
        });
      case "rejected":
        return recordProblem(runId, assignmentId, `report-rejected:${inspected.reason}`, {
          anchor: inspected.anchor,
          turnId: inspected.turnId,
          issues: inspected.issues ?? [],
        });
      case "report":
        break;
    }
    if (!inspected.ownership.ok) {
      if (inspected.ownership.code === "duplicate") return { status: "duplicate", assignmentId };
      return recordProblem(
        runId,
        assignmentId,
        `report-ownership:${inspected.ownership.code}`,
        undefined,
        inspected.turnId,
      );
    }

    const { kind, block, turnId } = inspected;
    if (kind !== "task-report" && kind !== "review-report" && kind !== "smoke-report") {
      return recordProblem(
        runId,
        assignmentId,
        `report-rejected:unexpected-kind`,
        undefined,
        turnId,
      );
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
      // The repair requests of this assignment are answered now; they leave the outbox like the
      // plan request does, so a confirmed message cannot keep the Run from finishing.
      working = settleRepairs(working, assignmentId, now);
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
