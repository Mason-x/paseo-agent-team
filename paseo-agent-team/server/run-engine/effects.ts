import { createHash } from "node:crypto";
import { type IntentTarget, transitionIntent } from "../../shared/domain/run-engine/effect-state";
import type { PaseoEnginePort, PortActiveTurnBehavior } from "../../shared/paseo/port";
import type { RunEffectIntent, RunRecord } from "../../shared/schemas/run-engine/ledger";
import { findDispatchEcho } from "./host";
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

export type EffectsOptions = {
  store: Pick<RunStore, "get" | "update">;
  port: PaseoEnginePort;
  /**
   * Rebuilds the exact prompt for an intent from the ledger. The intent stores only a hash of it,
   * so the text is never persisted or exposed. Returning `null` means "cannot build it".
   */
  compile(intent: DispatchIntent, record: RunRecord): string | null;
  clock?: { now(): string };
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

function isDispatch(intent: RunEffectIntent): intent is DispatchIntent {
  return intent.kind === "dispatch";
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
    await options.store.update(runId, (current) => {
      const result = transitionIntent(current, intentId, to, { now: clock.now(), reason });
      holder.ok = result.ok;
      holder.changed = result.ok && result.changed;
      return result.ok && result.changed ? result.next : null;
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
    for (const intent of record.outbox.filter(isDispatch)) {
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
      const dispatches = record.outbox.filter(isDispatch);
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
