import { createHash } from "node:crypto";
import {
  producerHead,
  resolveProducerProof,
} from "../../shared/domain/run-engine/delivery-binding";
import { evidenceResourcesAvailable } from "../../shared/domain/run-engine/dispatch-builder";
import { type IntentTarget, transitionIntent } from "../../shared/domain/run-engine/effect-state";
import {
  evidenceRepairOf,
  validStoredEvidenceRepair,
} from "../../shared/domain/run-engine/evidence-repair";
import { readLaunchWorkspace } from "../../shared/domain/run-engine/run-record";
import { noteTask } from "../../shared/domain/run-engine/task-note";
import { hasUnsettledEffects } from "../../shared/domain/run-engine/transitions";
import type { PaseoEnginePort, PortActiveTurnBehavior } from "../../shared/paseo/port";
import type { RunEffectIntent, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { findDispatchEcho } from "./host";
import {
  deliveredFiles,
  dispatchWorkspace,
  inspectRepo,
  prepareEvidenceDir,
  verifyScopes,
} from "./repo";
import type { RunStore } from "./store";

/**
 * Outbox executor for dispatch intents (plan 4.2). The reducer prepares an intent inside the
 * ledger; this module is the only code that turns it into a Paseo `send`. The order is the whole
 * point:
 *
 *   1. commit `sending`           (nothing has left the process yet)
 *   2. call Paseo, outside the store lock
 *   3. commit `confirmed`, or `outcome-unknown` when the call did not return cleanly
 *
 * Crash anywhere and the next call finds either `prepared` (nothing was sent, send now) or
 * `sending` (the call may or may not have happened). `sending` is never re-sent: it becomes
 * `outcome-unknown`, and the only way out of that is evidence from the host timeline. Absence of
 * evidence leaves it frozen for a decision; a timeout is not a reason to send again (AC04/AC05/AC10).
 */
export type DispatchIntent = Extract<RunEffectIntent, { kind: "dispatch" }>;
/** What the executor sends: a task dispatch, or a wake (the plan request to the coordinator). */
export type SendableIntent = Extract<RunEffectIntent, { kind: "dispatch" | "wake" }>;

export type EffectsOptions = {
  store: Pick<RunStore, "get" | "update">;
  port: PaseoEnginePort;
  /**
   * Rebuilds the exact prompt for an intent from the ledger. The intent stores only a hash of it,
   * so the text is never persisted or exposed. Returning `null` means "cannot build it".
   */
  compile(intent: SendableIntent, record: RunRecord): string | null;
  clock?: { now(): string };
  /** The Run's shared Workspace, to recheck a supplement just before it is sent. Defaults to `launch.workspace`. */
  resolveWorkspace?(record: RunRecord): { workspaceId: string; directory: string } | null;
  /**
   * What the host does with a message that lands mid-turn. Constant for the life of a Run on
   * purpose: the host deduplicates a repeated `messageId` only when the options are identical.
   * `steer` is the default because an unexpected collision must not throw away running work.
   */
  activeTurnBehavior?: PortActiveTurnBehavior;
  /** Upper bound on intents sent per call, so one call cannot monopolize a Run. */
  maxPerCall?: number;
  log?: (message: string, detail?: unknown) => void;
};

export type OutboxReport = {
  status: "ok" | "run-unavailable";
  /** Confirmed by this call's own send. */
  sent: string[];
  /** Earlier `sending` / `outcome-unknown` intents settled by timeline evidence. */
  reconciled: string[];
  /** Left `outcome-unknown`: no proof either way, resources stay frozen. */
  unknown: string[];
  /** Refused before sending (payload could not be rebuilt or its hash differs). */
  failed: string[];
};

const DEFAULT_MAX_PER_CALL = 32;

export function payloadHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isSendable(intent: RunEffectIntent): intent is SendableIntent {
  return intent.kind === "dispatch" || intent.kind === "wake";
}

/**
 * A Run that is paused, finished or cancelled sends nothing new. The plan request goes out while the
 * Run is still `bootstrapping` or `awaiting-dag`, so those lifecycles send as usual. What is already
 * on the host (`sending`, `outcome-unknown`) is still read and settled by echo in every lifecycle:
 * that only reads. A `prepared` intent is left as it is; when the Run is `active` again it goes out
 * once, because the ledger still says `prepared`.
 */
function lifecycleMaySend(lifecycle: RunRecord["lifecycle"]): boolean {
  return lifecycle !== "paused" && lifecycle !== "finished" && lifecycle !== "cancelled";
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[\w.:-]{1,64}$/u.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[\w.:-]{1,64}$/u.test(name)) return name;
  }
  return "send-error";
}

export function createEffects(options: EffectsOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const log = options.log ?? (() => undefined);
  const maxPerCall = options.maxPerCall ?? DEFAULT_MAX_PER_CALL;
  const activeTurnBehavior = options.activeTurnBehavior ?? "steer";
  const chains = new Map<string, Promise<unknown>>();
  // Same source as the service: a supplement is only sent while the Run's shared Workspace is intact.
  const resolveWorkspace =
    options.resolveWorkspace ??
    ((record: RunRecord) => {
      const workspace = readLaunchWorkspace(record);
      return workspace ? { workspaceId: workspace.id, directory: workspace.directory } : null;
    });

  /** A supplement can be left prepared across a restart; recheck live facts immediately before send. */
  async function evidencePreflight(record: RunRecord, intent: SendableIntent): Promise<boolean> {
    const assignment = record.assignments.find(
      (entry) => entry.assignmentId === intent.assignmentId,
    );
    const repair = assignment && evidenceRepairOf(record, assignment);
    if (!assignment || !repair) return true;
    if (!validStoredEvidenceRepair(record, assignment)) return false;
    const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
    const root = record.assignments.find((entry) => entry.assignmentId === repair.rootAssignmentId);
    const proof = resolveProducerProof(record, repair.rootAssignmentId);
    const location = resolveWorkspace(record);
    const dispatch = record.outbox.find(
      (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
    );
    if (
      !task ||
      !root?.workspace ||
      !proof ||
      proof.ref.kind !== "git-commit" ||
      !location ||
      location.workspaceId !== root.workspace.id ||
      !dispatch ||
      typeof dispatch.semanticArgs.evidenceDir !== "string" ||
      typeof dispatch.semanticArgs.repoRoot !== "string"
    ) {
      return false;
    }
    try {
      const snapshot = (await options.port.agents.ref(assignment.agentId).refresh())?.agent;
      const pending = Array.isArray(snapshot?.pendingPermissions)
        ? snapshot.pendingPermissions.length > 0
        : Boolean(snapshot?.pendingPermissions);
      if (snapshot?.status !== "idle" || snapshot.activeTurn || pending || snapshot.lastError) {
        return false;
      }
      const inspected = await inspectRepo(location.directory);
      if (!inspected.ok) return false;
      const repo = inspected.repo;
      const delivered = proof.ref.value.toLowerCase();
      if (repo.branch !== root.workspace.branch || repo.headSha?.toLowerCase() !== delivered)
        return false;
      if (!dispatchWorkspace(repo, location.workspaceId).ok) return false;
      const normalize = (value: string) => {
        const normalized = value.replaceAll("\\", "/");
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      };
      if (normalize(repo.root) !== normalize(dispatch.semanticArgs.repoRoot)) return false;
      const verified = await verifyScopes(repo, task.spec.scopes);
      if (!verified.ok) return false;
      const actual = await deliveredFiles(repo, root.workspace.baseRef, delivered);
      if (!actual.ok) return false;
      const sorted = (files: readonly string[]) =>
        [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
      const left = sorted(proof.changedFiles);
      const right = sorted(actual.files);
      if (left.length !== right.length || left.some((file, index) => file !== right[index]))
        return false;
      const evidence = await prepareEvidenceDir(
        repo,
        record.policy.evidenceRoot,
        assignment.assignmentId,
      );
      return (
        evidence.ok && normalize(evidence.dir) === normalize(dispatch.semanticArgs.evidenceDir)
      );
    } catch (error) {
      log(`cannot recheck evidence intent ${intent.id}`, error);
      return false;
    }
  }

  /**
   * One commit: move an intent to `to`. `ok` means the ledger now holds that state; `changed`
   * means THIS commit moved it there. Claiming the right to send needs `changed`: if another
   * runner already moved the intent to `sending`, `ok` is true but the send is not ours.
   */
  async function settleDetailed(
    runId: string,
    intentId: string,
    to: IntentTarget,
    reason?: string,
  ): Promise<{ ok: boolean; changed: boolean }> {
    const holder = { ok: false, changed: false };
    await options.store.update(runId, (current, context) => {
      const intent = current.outbox.find((entry) => entry.id === intentId);
      const assignment = current.assignments.find(
        (entry) => entry.assignmentId === intent?.assignmentId,
      );
      const repair = assignment && evidenceRepairOf(current, assignment);
      const now = clock.now();
      // The claim to send is taken in the commit that moves the intent, so a pause or an end that
      // landed after the snapshot of the caller still wins: nothing moves, nothing is sent.
      if (to === "sending" && !lifecycleMaySend(current.lifecycle)) return null;
      if (to === "sending" && repair && assignment && intent) {
        const task = current.tasks.find((entry) => entry.spec.id === assignment.taskId);
        const head = producerHead(current, assignment.taskId);
        const seat = current.roster.find((entry) => entry.seatId === assignment.seatId);
        const channel = current.channels.find((entry) => entry.channelId === assignment.channelId);
        const remaining = {
          ...current,
          outbox: current.outbox.filter((entry) => entry.id !== intentId),
        };
        if (
          current.lifecycle !== "active" ||
          current.launch.state === "failed" ||
          current.launch.state === "cancelled" ||
          !task ||
          (task.state !== "assigned" && task.state !== "in_progress") ||
          task.frozenClaimId !== null ||
          !seat?.enabled ||
          seat.agentId !== assignment.agentId ||
          channel?.state !== "available" ||
          current.policy.disabledChannels.includes(assignment.channelId) ||
          current.policy.disabledProfileIds.includes(assignment.profileId) ||
          head.kind !== "ok" ||
          head.assignment.assignmentId !== assignment.assignmentId ||
          !validStoredEvidenceRepair(current, assignment) ||
          !evidenceResourcesAvailable(current, task, context.otherResources, {
            allowFrozen: intent.kind === "wake",
          }).ok ||
          current.decisions.some(
            (entry) =>
              entry.subjectId === task.spec.id &&
              (entry.state === "open" || entry.state === "waiting-human"),
          ) ||
          current.outbox.some(
            (entry) =>
              entry.id !== intentId &&
              entry.recipient === intent.recipient &&
              (entry.state === "sending" || entry.state === "outcome-unknown"),
          ) ||
          (intent.kind === "dispatch" && hasUnsettledEffects(remaining, task.spec.id))
        ) {
          return null;
        }
      }
      const result = transitionIntent(current, intentId, to, { now, reason });
      holder.ok = result.ok;
      holder.changed = result.ok && result.changed;
      if (!result.ok || !result.changed) return null;
      let next = result.next;
      if (to === "outcome-unknown" && repair && assignment) {
        for (const claim of next.resources) {
          if (claim.taskId === assignment.taskId) claim.frozen = true;
        }
        const noted = noteTask(next, assignment.taskId, "evidence-send-outcome-unknown", { now });
        if (noted.ok && noted.changed) next = noted.next;
      }
      return next;
    });
    return holder;
  }

  async function settle(
    runId: string,
    intentId: string,
    to: IntentTarget,
    reason?: string,
  ): Promise<boolean> {
    return (await settleDetailed(runId, intentId, to, reason)).ok;
  }

  async function snapshot(runId: string): Promise<RunRecord | null> {
    const read = await options.store.get(runId);
    return read.status === "ok" ? read.record : null;
  }

  /** Crash window and unknown results: settle by evidence only, never by sending again. */
  async function reconcileUnknown(runId: string, report: OutboxReport): Promise<void> {
    const record = await snapshot(runId);
    if (!record) return;
    for (const intent of record.outbox.filter(isSendable)) {
      if (intent.state === "sending") {
        // The process died (or the commit of the result failed) after `sending` was written.
        if (await settle(runId, intent.id, "outcome-unknown", "interrupted")) {
          log(`intent ${intent.id} was sending; now outcome-unknown`);
        }
      } else if (intent.state !== "outcome-unknown") {
        continue;
      }
      let echo: Awaited<ReturnType<typeof findDispatchEcho>>;
      try {
        echo = await findDispatchEcho(options.port, intent.recipient, intent.messageId);
      } catch (error) {
        log(`cannot read timeline for ${intent.recipient}`, error);
        report.unknown.push(intent.id);
        continue;
      }
      if (echo.status === "found" && (await settle(runId, intent.id, "confirmed", "echo"))) {
        report.reconciled.push(intent.id);
      } else {
        report.unknown.push(intent.id);
      }
    }
  }

  async function sendPrepared(runId: string, report: OutboxReport): Promise<void> {
    for (let sentCount = 0; sentCount < maxPerCall; ) {
      const record = await snapshot(runId);
      if (!record) return;
      if (!lifecycleMaySend(record.lifecycle)) return;
      const dispatches = record.outbox.filter(isSendable);
      // An agent whose last delivery is unresolved gets nothing more until that is settled.
      const blocked = new Set(
        dispatches
          .filter((intent) => intent.state === "sending" || intent.state === "outcome-unknown")
          .map((intent) => intent.recipient),
      );
      const intent = dispatches.find(
        (entry) => entry.state === "prepared" && !blocked.has(entry.recipient),
      );
      if (!intent) return;

      const text = options.compile(intent, record);
      if (text === null || payloadHash(text) !== intent.payloadHash) {
        // Never send a different payload than the one the ledger committed to.
        await settle(
          runId,
          intent.id,
          "failed",
          text === null ? "payload-unbuilt" : "payload-hash",
        );
        report.failed.push(intent.id);
        continue;
      }

      if (!(await evidencePreflight(record, intent))) {
        await options.store.update(runId, (current) => {
          const stillPrepared = current.outbox.find(
            (entry) => entry.id === intent.id && entry.state === "prepared",
          );
          if (typeof stillPrepared?.taskId !== "string" || stillPrepared.taskId === "") return null;
          const noted = noteTask(current, stillPrepared.taskId, "evidence-send-waiting", {
            now: clock.now(),
          });
          return noted.ok && noted.changed ? noted.next : null;
        });
        return;
      }

      // Commit the intent to `sending` first. If this throws, nothing was sent. Only the runner
      // whose commit made the move owns the send; anyone else stops and leaves it to that runner.
      if (!(await settleDetailed(runId, intent.id, "sending")).changed) return;
      sentCount += 1;
      try {
        await options.port.agents
          .ref(intent.recipient)
          .send(text, { messageId: intent.messageId, activeTurnBehavior });
      } catch (error) {
        // Not proof of non-delivery: the host may have taken the message and lost the reply.
        await settle(runId, intent.id, "outcome-unknown", `send:${errorCode(error)}`);
        report.unknown.push(intent.id);
        log(`send for ${intent.id} did not return cleanly`, error);
        continue;
      }
      // If this commit fails the intent stays `sending`; the next call reconciles it by echo.
      await settle(runId, intent.id, "confirmed");
      report.sent.push(intent.id);
    }
  }

  async function runOutboxUnlocked(runId: string): Promise<OutboxReport> {
    const report: OutboxReport = {
      status: "ok",
      sent: [],
      reconciled: [],
      unknown: [],
      failed: [],
    };
    if ((await snapshot(runId)) === null) return { ...report, status: "run-unavailable" };
    await reconcileUnknown(runId, report);
    await sendPrepared(runId, report);
    return report;
  }

  return {
    /**
     * Settles anything left unresolved, then sends the prepared dispatch intents of one Run in
     * ledger order. Calls for the same Run are serialized inside this process; across processes the
     * store's own write lock and the committed `sending` state keep a second runner from re-sending.
     */
    runOutbox(runId: string): Promise<OutboxReport> {
      const previous = chains.get(runId) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => runOutboxUnlocked(runId));
      chains.set(
        runId,
        run.catch(() => undefined),
      );
      return run;
    },
  };
}

export type Effects = ReturnType<typeof createEffects>;
