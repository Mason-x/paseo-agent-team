import { randomUUID } from "node:crypto";
import {
  CANCEL_COMPLETED_EVENT,
  CANCEL_PENDING_ALERT,
  CANCEL_REQUEST_EVENT,
  CANCEL_TASK_REASON,
  cancelPending,
  planCancelFinish,
  readCancelRequest,
  withCancelRequest,
} from "../../shared/domain/run-engine/cancel-request";
import { answerDecision } from "../../shared/domain/run-engine/decision-answer";
import {
  compilePlanRequest,
  PLAN_REPLAN_VERSION,
} from "../../shared/domain/run-engine/engine-prompts";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { requestReplan } from "../../shared/domain/run-engine/replan";
import { raiseAlert, resolveAlerts } from "../../shared/domain/run-engine/run-alert";
import { RUN_CONTRACT_VERSION, type RunIssueView } from "../../shared/schemas/run-engine/rpc";
import type {
  RunActionCode,
  RunCancelInput,
  RunCancelOutput,
  RunDecideInput,
  RunDecideOutput,
  RunKickInput,
  RunKickOutput,
  RunLifecycleInput,
  RunLifecycleOutput,
  RunReplanInput,
  RunReplanOutput,
} from "../../shared/schemas/run-engine/rpc-actions";
import { alertIdFor, sha256Hex } from "./digest";
import type { EngineDriver } from "./driver";
import { payloadHash } from "./effects";
import { planLifecycleMove } from "./lifecycle";
import type { RunStore } from "./store";

/** The audit event of a pause or resume; its `requestId` is how a repeat is recognised. */
export const LIFECYCLE_REQUEST_EVENT = "run-control-requested";

/**
 * The Run Engine's writing RPCs (P06): `replan`, `decide` and `kick`, and `pause` and `resume` (A3). A person asks; the ledger
 * decides. Each write is ONE store update that reads the Run, asks a pure function whether the request
 * is allowed and what it changes, checks the ledger invariants on the result, and commits or changes
 * nothing. The handler sends no message itself: after a commit it asks the driver to push the Run on
 * (settle, send what was prepared, dispatch), in the background, so an answer does not wait for a
 * model or a host call and a lost push is picked up by the next recovery.
 *
 * Every refusal is an answer with a code (`status: "rejected"`), never a thrown error, and every answer
 * carries only counts, ids and short codes: no nonce, prompt, outbox argument or event payload.
 */

export type RunControlOptions = {
  store: Pick<RunStore, "get" | "update" | "ready">;
  /** Initializes the ledger on demand; resolves with `store.ready` possibly still false. */
  ensureReady(): Promise<void>;
  driver: Pick<EngineDriver, "retryRun">;
  clock?: { now(): string };
  ids?: { uuid(): string };
  log?: (message: string, detail?: unknown) => void;
};

type Params = Record<string, string | number | boolean>;

function issue(
  code: RunActionCode,
  params: Params = {},
  action: RunIssueView["action"] = "none",
): RunIssueView {
  return { code, severity: "error", path: [], params, action };
}

const BASE = { runContractVersion: RUN_CONTRACT_VERSION } as const;

/** What went wrong with the Run itself, before any rule about the request. */
type Loaded = { ok: true } | { ok: false; issue: RunIssueView };

/** A refusal found inside the update: a code and the few facts that go with it. */
type Refused = { code: RunActionCode; params: Params; action: RunIssueView["action"] };

function refused(
  code: RunActionCode,
  params: Params = {},
  action: RunIssueView["action"] = "none",
) {
  return { code, params, action } satisfies Refused;
}

export function createRunControl(options: RunControlOptions) {
  const { store } = options;
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  const pending = new Set<Promise<unknown>>();

  async function load(runId: string): Promise<Loaded> {
    await options.ensureReady();
    if (!store.ready) return { ok: false, issue: issue("run-missing", {}, "retry") };
    const read = await store.get(runId);
    switch (read.status) {
      case "ok":
        return { ok: true };
      case "missing":
        return { ok: false, issue: issue("run-missing", {}, "refresh") };
      case "unknown-version":
        return { ok: false, issue: issue("run-unknown-version", {}, "inspect") };
      default:
        return { ok: false, issue: issue("run-corrupt", {}, "inspect") };
    }
  }

  /** Pushes the Run on after a commit, without making the caller wait. Never throws. */
  function push(runId: string): void {
    const run = options.driver
      .retryRun(runId, { afterWrite: true })
      .catch((error: unknown) => log(`engine could not push ${runId} after a control`, error))
      .finally(() => {
        pending.delete(run);
      });
    pending.add(run);
  }

  const revisionOf = (written: Awaited<ReturnType<RunStore["update"]>>): number =>
    written.status === "committed" ? written.record.revision : written.revision;

  /**
   * One pause or resume. The checks run in a fixed order, as in every write here: find a request with
   * this id first (the same request is answered `replayed`, a different one under the same id is
   * `request-id-reused`), then the revision the caller saw, then the lifecycle. The lifecycle change is
   * the reducer's own event (`planLifecycleMove`); the audit event written with it carries the request
   * id so a repeat is recognised, and nothing else (no nonce, no text of a message).
   */
  async function lifecycleRequest(
    action: "pause" | "resume",
    input: RunLifecycleInput,
  ): Promise<RunLifecycleOutput> {
    const loaded = await load(input.runId);
    if (!loaded.ok) {
      return { ...BASE, status: "rejected", revision: 0, lifecycle: null, issues: [loaded.issue] };
    }
    const reason = input.reason.slice(0, 200);
    const outcome: {
      refused?: Refused;
      replayed?: boolean;
      applied?: boolean;
      lifecycle: string | null;
    } = { lifecycle: null };
    let written: Awaited<ReturnType<RunStore["update"]>>;
    try {
      written = await store.update(input.runId, (current) => {
        outcome.lifecycle = current.lifecycle;
        const prior = current.events.find(
          (event) =>
            event.kind === LIFECYCLE_REQUEST_EVENT && event.payload.requestId === input.requestId,
        );
        if (prior !== undefined) {
          if (prior.payload.action === action && prior.payload.reason === reason) {
            outcome.replayed = true;
          } else {
            outcome.refused = refused("request-id-reused");
          }
          return null;
        }
        if (current.revision !== input.expectedRevision) {
          outcome.refused = refused("revision-conflict", { current: current.revision }, "refresh");
          return null;
        }
        // A cancellation that was asked for decides what happens to the Run: nobody resumes it.
        if (cancelPending(current)) {
          outcome.refused = refused("cancel-pending");
          return null;
        }
        const plan = planLifecycleMove(
          current,
          action === "pause" ? "run-paused" : "run-resumed",
          clock.now(),
        );
        if (!plan.ok) {
          outcome.refused = refused("lifecycle-not-allowed", { lifecycle: current.lifecycle });
          return null;
        }
        const next = plan.next;
        const seq = next.counters.eventsThroughSeq + 1;
        next.counters.eventsThroughSeq = seq;
        next.events.push({
          seq,
          kind: LIFECYCLE_REQUEST_EVENT,
          at: clock.now(),
          payload: { requestId: input.requestId, action, reason },
        });
        const checked = checkLedgerInvariants(next);
        if (!checked.ok) {
          outcome.refused = refused(
            "ledger-refused",
            { invariant: checked.violations[0]?.invariant ?? "?" },
            "inspect",
          );
          return null;
        }
        outcome.applied = true;
        outcome.lifecycle = next.lifecycle;
        return next;
      });
    } catch (error) {
      log(`${action} of ${input.runId} could not be written`, error);
      return {
        ...BASE,
        status: "rejected",
        revision: 0,
        lifecycle: null,
        issues: [issue("ledger-refused", {}, "retry")],
      };
    }
    const revision = revisionOf(written);
    if (outcome.refused) {
      const { code, params, action: next } = outcome.refused;
      return {
        ...BASE,
        status: "rejected",
        revision,
        lifecycle: outcome.lifecycle,
        issues: [issue(code, params, next)],
      };
    }
    if (outcome.replayed) {
      return { ...BASE, status: "replayed", revision, lifecycle: outcome.lifecycle, issues: [] };
    }
    // A pause moves nothing on; a resume asks the driver to settle, send what was held and dispatch.
    if (action === "resume") push(input.runId);
    return { ...BASE, status: "applied", revision, lifecycle: outcome.lifecycle, issues: [] };
  }

  /**
   * Cancels the whole Run, later: the request is written, new dispatches stop (the Run is paused), and
   * the cancellation is finished by `cancel.ts` once every running turn is proven ended. A Run that has
   * no task yet is cancelled in the same commit. Nothing is sent, archived or interrupted. The checks run
   * in the usual order: a repeat of this request first, then the revision, then what the Run allows.
   */
  async function cancelRequest(input: RunCancelInput): Promise<RunCancelOutput> {
    const loaded = await load(input.runId);
    if (!loaded.ok) {
      return {
        ...BASE,
        status: "rejected",
        revision: 0,
        lifecycle: null,
        waiting: null,
        issues: [loaded.issue],
      };
    }
    const outcome: {
      refused?: Refused;
      replayed?: boolean;
      applied?: boolean;
      lifecycle: string | null;
      waiting: RunCancelOutput["waiting"];
    } = { lifecycle: null, waiting: null };
    let written: Awaited<ReturnType<RunStore["update"]>>;
    try {
      written = await store.update(input.runId, (current) => {
        outcome.lifecycle = current.lifecycle;
        const existing = readCancelRequest(current);
        if (existing.kind === "valid" && existing.value.requestId === input.requestId) {
          if (existing.value.reason === input.reason) outcome.replayed = true;
          else outcome.refused = refused("request-id-reused");
          return null;
        }
        if (
          existing.kind === "invalid" ||
          (existing.kind === "valid" && existing.value.completedAt === null)
        ) {
          outcome.refused = refused("cancel-pending");
          return null;
        }
        if (current.revision !== input.expectedRevision) {
          outcome.refused = refused("revision-conflict", { current: current.revision }, "refresh");
          return null;
        }
        if (current.lifecycle === "finished" || current.lifecycle === "cancelled") {
          outcome.refused = refused("lifecycle-not-allowed", { lifecycle: current.lifecycle });
          return null;
        }
        if (current.launch.state === "preparing" || current.launch.state === "creating") {
          outcome.refused = refused("launch-in-progress", {}, "retry");
          return null;
        }
        const now = clock.now();
        const request = {
          version: 1 as const,
          requestId: input.requestId,
          reason: input.reason,
          requestedAt: now,
          completedAt: null as string | null,
        };
        let next = withCancelRequest(current, request);
        const audit = (kind: string, payload: Record<string, unknown>) => {
          const seq = next.counters.eventsThroughSeq + 1;
          next.counters.eventsThroughSeq = seq;
          next.events.push({ seq, kind, at: now, payload });
          next.updatedAt = now;
        };
        audit(CANCEL_REQUEST_EVENT, {
          requestId: input.requestId,
          reason: input.reason.slice(0, 200),
        });
        // No new work starts from here on.
        if (next.lifecycle === "active") {
          const paused = planLifecycleMove(next, "run-paused", now);
          if (!paused.ok) {
            outcome.refused = refused("lifecycle-not-allowed", { lifecycle: next.lifecycle });
            return null;
          }
          next = paused.next;
        }
        next = raiseAlert(
          next,
          {
            alertId: alertIdFor(CANCEL_PENDING_ALERT),
            severity: "warning",
            summary: CANCEL_PENDING_ALERT,
          },
          now,
        ).next;
        let done = false;
        if (next.lifecycle === "bootstrapping" || next.lifecycle === "awaiting-dag") {
          // No task, no assignment, no claim: there is nothing to wait for.
          const cancelled = reduceRun(
            next,
            {
              kind: "run-cancelled",
              reason: CANCEL_TASK_REASON,
              controlNonceDigest: sha256Hex(uuid()),
              cancelIntents: [],
              preparedCancelIntents: [],
            },
            { now, newId: () => uuid() },
          );
          if (!cancelled.ok) {
            outcome.refused = refused("ledger-refused", { invariant: "run-cancelled" }, "inspect");
            return null;
          }
          next = withCancelRequest(cancelled.next, { ...request, completedAt: now });
          next = resolveAlerts(next, (alert) => alert.summary === CANCEL_PENDING_ALERT, now).next;
          audit(CANCEL_COMPLETED_EVENT, { requestId: input.requestId, tasks: 0 });
          done = true;
        }
        const checked = checkLedgerInvariants(next);
        if (!checked.ok) {
          outcome.refused = refused(
            "ledger-refused",
            { invariant: checked.violations[0]?.invariant ?? "?" },
            "inspect",
          );
          return null;
        }
        if (!done) {
          const plan = planCancelFinish(next, "assume-idle");
          outcome.waiting =
            plan.kind === "wait"
              ? { turns: plan.turns, deliveries: plan.deliveries }
              : { turns: 0, deliveries: 0 };
        }
        outcome.applied = true;
        outcome.lifecycle = next.lifecycle;
        return next;
      });
    } catch (error) {
      log(`cancel of ${input.runId} could not be written`, error);
      return {
        ...BASE,
        status: "rejected",
        revision: 0,
        lifecycle: null,
        waiting: null,
        issues: [issue("ledger-refused", {}, "retry")],
      };
    }
    const revision = revisionOf(written);
    if (outcome.refused) {
      const { code, params, action } = outcome.refused;
      return {
        ...BASE,
        status: "rejected",
        revision,
        lifecycle: outcome.lifecycle,
        waiting: null,
        issues: [issue(code, params, action)],
      };
    }
    if (outcome.replayed) {
      return {
        ...BASE,
        status: "replayed",
        revision,
        lifecycle: outcome.lifecycle,
        waiting: null,
        issues: [],
      };
    }
    // The cancellation is finished by the driver's pass: ask it to look now.
    push(input.runId);
    return {
      ...BASE,
      status: "applied",
      revision,
      lifecycle: outcome.lifecycle,
      waiting: outcome.waiting,
      issues: [],
    };
  }

  return {
    /**
     * Asks the coordinator for a new plan. Only a Run that is waiting for one (`awaiting-dag`) can be
     * re-planned; see `requestReplan` for what one re-plan changes. The same `requestId` is the same
     * request, also after a restart.
     */
    async replan(input: RunReplanInput): Promise<RunReplanOutput> {
      const loaded = await load(input.runId);
      if (!loaded.ok) {
        return { ...BASE, status: "rejected", revision: 0, epoch: null, issues: [loaded.issue] };
      }
      const outcome: { refused?: Refused; replayed?: number; applied?: number } = {};
      let written: Awaited<ReturnType<RunStore["update"]>>;
      try {
        written = await store.update(input.runId, (current) => {
          const controlNonce = uuid();
          const result = requestReplan(current, {
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
            controlNonce,
            controlNonceDigest: sha256Hex(controlNonce),
            intentId: `intent-plan-${uuid().replace(/-/gu, "").slice(0, 8)}`,
            messageId: uuid(),
            payloadHash: "0".repeat(64),
            templateVersion: PLAN_REPLAN_VERSION,
            now: clock.now(),
          });
          if (!result.ok) {
            outcome.refused = refused(
              result.code,
              result.code === "revision-conflict"
                ? { current: result.current }
                : result.code === "replan-not-allowed"
                  ? { lifecycle: result.lifecycle }
                  : {},
              result.code === "revision-conflict"
                ? "refresh"
                : result.code === "delivery-unresolved"
                  ? "retry"
                  : "none",
            );
            return null;
          }
          if (result.replayed) {
            outcome.replayed = result.epoch;
            return null;
          }
          const intent = result.next.outbox.find((entry) => entry.id === result.intentId);
          const text = intent?.kind === "wake" ? compilePlanRequest(intent, result.next) : null;
          if (intent === undefined || text === null) {
            outcome.refused = refused("plan-unbuildable", {}, "inspect");
            return null;
          }
          // The hash of the text the executor will rebuild from the ledger and compare before it sends.
          intent.payloadHash = payloadHash(text);
          const checked = checkLedgerInvariants(result.next);
          if (!checked.ok) {
            outcome.refused = refused(
              "ledger-refused",
              { invariant: checked.violations[0]?.invariant ?? "?" },
              "inspect",
            );
            return null;
          }
          outcome.applied = result.epoch;
          return result.next;
        });
      } catch (error) {
        log(`replan of ${input.runId} could not be written`, error);
        return {
          ...BASE,
          status: "rejected",
          revision: 0,
          epoch: null,
          issues: [issue("ledger-refused", {}, "retry")],
        };
      }
      const revision = revisionOf(written);
      if (outcome.refused) {
        const { code, params, action } = outcome.refused;
        return {
          ...BASE,
          status: "rejected",
          revision,
          epoch: null,
          issues: [issue(code, params, action)],
        };
      }
      if (outcome.replayed !== undefined) {
        return { ...BASE, status: "replayed", revision, epoch: outcome.replayed, issues: [] };
      }
      push(input.runId);
      return { ...BASE, status: "applied", revision, epoch: outcome.applied ?? null, issues: [] };
    },

    /**
     * Answers a decision a task waits on. The decision id is the key: it can be answered once, a
     * repeat with the same `requestId` and answer is the same answer, and anyone else's stands.
     */
    async decide(input: RunDecideInput): Promise<RunDecideOutput> {
      const loaded = await load(input.runId);
      const closed = {
        ...BASE,
        decisionId: input.decisionId,
        taskId: null,
        status: "rejected" as const,
      };
      if (!loaded.ok) return { ...closed, revision: 0, issues: [loaded.issue] };
      const outcome: {
        refused?: Refused;
        replayed?: string | null;
        applied?: string;
        cancelled?: string[];
      } = {};
      let written: Awaited<ReturnType<RunStore["update"]>>;
      try {
        written = await store.update(input.runId, (current) => {
          const result = answerDecision(current, {
            decisionId: input.decisionId,
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
            action: input.answer.action,
            now: clock.now(),
            newId: () => uuid(),
            controlNonceDigest: sha256Hex(uuid()),
          });
          if (!result.ok) {
            const params: Params =
              result.code === "revision-conflict"
                ? { current: result.current }
                : result.code === "decision-not-answerable"
                  ? { category: result.category }
                  : result.code === "action-unsupported"
                    ? { action: result.action }
                    : result.code === "run-not-active"
                      ? { lifecycle: result.lifecycle }
                      : result.code === "task-not-releasable"
                        ? { reason: result.reason }
                        : {};
            outcome.refused = refused(
              result.code,
              params,
              result.code === "revision-conflict" ? "refresh" : "none",
            );
            return null;
          }
          if (result.replayed) {
            outcome.replayed = result.taskId;
            return null;
          }
          const checked = checkLedgerInvariants(result.next);
          if (!checked.ok) {
            outcome.refused = refused(
              "ledger-refused",
              { invariant: checked.violations[0]?.invariant ?? "?" },
              "inspect",
            );
            return null;
          }
          outcome.applied = result.taskId;
          outcome.cancelled = result.cancelled;
          return result.next;
        });
      } catch (error) {
        log(`decision ${input.decisionId} could not be written`, error);
        return { ...closed, revision: 0, issues: [issue("ledger-refused", {}, "retry")] };
      }
      const revision = revisionOf(written);
      if (outcome.refused) {
        const { code, params, action } = outcome.refused;
        return { ...closed, revision, issues: [issue(code, params, action)] };
      }
      if (outcome.replayed !== undefined) {
        return {
          ...BASE,
          status: "replayed",
          revision,
          decisionId: input.decisionId,
          taskId: outcome.replayed,
          issues: [],
        };
      }
      push(input.runId);
      return {
        ...BASE,
        status: "applied",
        revision,
        decisionId: input.decisionId,
        taskId: outcome.applied ?? null,
        ...(outcome.cancelled === undefined ? {} : { cancelledTaskIds: outcome.cancelled }),
        issues: [],
      };
    },

    /**
     * Stops new work from starting. Only an `active` Run pauses; what is already running goes on to the
     * end of its turn and a report that arrives is taken in as usual. See `lifecycleRequest`.
     */
    pause(input: RunLifecycleInput): Promise<RunLifecycleOutput> {
      return lifecycleRequest("pause", input);
    },

    /** Cancels the whole Run once every running turn is proven ended; see `cancelRequest`. */
    cancel(input: RunCancelInput): Promise<RunCancelOutput> {
      return cancelRequest(input);
    },

    /** Lets a `paused` Run go on; the driver is asked to push it, so what was held goes out once. */
    resume(input: RunLifecycleInput): Promise<RunLifecycleOutput> {
      return lifecycleRequest("resume", input);
    },

    /**
     * "Try now": the driver's retry for one Run. Waits for it (a person is looking at the answer) but
     * joins a retry that is already running instead of starting another.
     */
    async kick(input: RunKickInput): Promise<RunKickOutput> {
      const rejected = (found: RunIssueView): RunKickOutput => ({
        ...BASE,
        status: "rejected",
        outcome: null,
        dispatched: 0,
        revision: 0,
        reason: null,
        issues: [found],
      });
      const loaded = await load(input.runId);
      if (!loaded.ok) return rejected(loaded.issue);
      let report: Awaited<ReturnType<EngineDriver["retryRun"]>>;
      try {
        report = await options.driver.retryRun(input.runId);
      } catch (error) {
        log(`kick of ${input.runId} failed`, error);
        return rejected(issue("ledger-refused", {}, "retry"));
      }
      const read = await store.get(input.runId);
      if (report.status !== "ok" || read.status !== "ok")
        return rejected(issue("run-corrupt", {}, "inspect"));
      const lifecycle = read.record.lifecycle;
      const outcome: RunKickOutput["outcome"] = report.finished
        ? "finished"
        : lifecycle !== "active"
          ? "not-active"
          : report.dispatched > 0
            ? "dispatched"
            : report.last === "waiting"
              ? "waiting"
              : report.last === "blocked"
                ? "blocked"
                : "idle";
      return {
        ...BASE,
        status: "ok",
        outcome,
        dispatched: report.dispatched,
        revision: read.revision,
        reason: report.reason?.slice(0, 200) ?? null,
        issues: [],
      };
    },

    /** Resolves when every push a write started has finished. For tests and for a clean shutdown. */
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

export type RunControl = ReturnType<typeof createRunControl>;
