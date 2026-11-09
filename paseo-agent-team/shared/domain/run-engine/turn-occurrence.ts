import type { RunAssignment, RunEventReceipt, RunRecord } from "../../schemas/run-engine/ledger";

/**
 * The host numbers turns per session object, so after a restart a new turn can carry the id of an old
 * one (`foreground-turn-1` again). A turn receipt is therefore keyed by (kind, agent, turn id, which
 * time that id appeared): the first appearance keeps the original key, a later one gets `#<n>`.
 * `receipt.turnId` stays the bare id; the occurrence is read back from the key.
 *
 * Pure functions on the ledger. Anything that cannot be told apart safely stays on the old key, so a
 * duplicate is dropped rather than a second appearance invented (see the T9a notes in the README).
 */

/** What a receipt the Engine wrote itself (for a turn the host never ended) says about who settled it. */
export const ENGINE_SETTLER = "engine";

export type TurnReceiptKind = "turn_started" | "turn_ended";

const MAX_KEY_LENGTH = 256;

type Ledger = Pick<RunRecord, "eventReceipts">;
type KeyedReceipt = Pick<RunEventReceipt, "kind" | "agentId" | "turnId" | "eventKey">;
type TurnReceipt = RunEventReceipt & { kind: TurnReceiptKind };

export type TurnAppearance = { occurrence: number; receipt: TurnReceipt };

function baseKey(kind: string, agentId: string, turnId: string): string {
  return `${kind}:${agentId}:${turnId}`;
}

/**
 * The key of the `occurrence`-th appearance of a turn. `null` when that appearance cannot be encoded
 * without ambiguity or truncation: a turn id that already contains `#` (it could collide with another
 * id's suffix) or a key that would pass the ledger's length limit. The caller then keeps the old key.
 */
export function turnKey(
  kind: TurnReceiptKind,
  agentId: string,
  turnId: string,
  occurrence: number,
): string | null {
  const base = baseKey(kind, agentId, turnId);
  if (occurrence <= 1) return base;
  if (turnId.includes("#")) return null;
  const key = `${base}#${occurrence}`;
  return key.length > MAX_KEY_LENGTH ? null : key;
}

/** Which appearance a stored turn receipt is. Anything not exactly `…#<n>` (n ≥ 2) counts as the first. */
export function receiptOccurrence(receipt: KeyedReceipt): number {
  if (receipt.agentId === null || receipt.turnId === null || receipt.turnId.includes("#")) return 1;
  const base = baseKey(receipt.kind, receipt.agentId, receipt.turnId);
  if (!receipt.eventKey.startsWith(`${base}#`)) return 1;
  const rest = receipt.eventKey.slice(base.length + 1);
  if (!/^[1-9]\d*$/u.test(rest)) return 1;
  const n = Number(rest);
  return Number.isSafeInteger(n) && n >= 2 ? n : 1;
}

function isTurnReceipt(receipt: RunEventReceipt): receipt is TurnReceipt {
  return (
    (receipt.kind === "turn_started" || receipt.kind === "turn_ended") &&
    receipt.agentId !== null &&
    receipt.turnId !== null
  );
}

/** Whether two turn receipts belong to one appearance of one turn (a start and an end that match). */
export function sameTurnOccurrence(a: RunEventReceipt, b: RunEventReceipt): boolean {
  return (
    isTurnReceipt(a) &&
    isTurnReceipt(b) &&
    a.agentId === b.agentId &&
    a.turnId === b.turnId &&
    receiptOccurrence(a) === receiptOccurrence(b)
  );
}

/** Every start and end receipt of one turn id, with the appearance each belongs to. */
export function turnAppearances(record: Ledger, agentId: string, turnId: string): TurnAppearance[] {
  const found: TurnAppearance[] = [];
  for (const receipt of record.eventReceipts) {
    if (isTurnReceipt(receipt) && receipt.agentId === agentId && receipt.turnId === turnId) {
      found.push({ occurrence: receiptOccurrence(receipt), receipt });
    }
  }
  return found;
}

function maxOccurrence(items: readonly TurnAppearance[]): number {
  return items.reduce((best, item) => Math.max(best, item.occurrence), 0);
}

export type OwnTurn = {
  occurrence: number;
  started: TurnReceipt | undefined;
  ended: TurnReceipt | undefined;
};

/**
 * The appearance of `turnId` that belongs to a message sent at `since`: the earliest one that has a
 * receipt at or after `since`. Used to find the turn an assignment, a repair request or a plan request
 * itself ran in. Not "the newest": when a later turn reuses the id and a reply window runs over both,
 * the first is still the one that was asked.
 */
export function ownTurn(
  record: Ledger,
  input: { agentId: string; turnId: string; since: string | null },
): OwnTurn | undefined {
  const all = turnAppearances(record, input.agentId, input.turnId);
  const limit = input.since === null ? Number.NEGATIVE_INFINITY : Date.parse(input.since);
  const candidates = all.filter((item) => Date.parse(item.receipt.receivedAt) >= limit);
  if (candidates.length === 0) return undefined;
  const occurrence = candidates.reduce((best, item) => Math.min(best, item.occurrence), Infinity);
  const same = all.filter((item) => item.occurrence === occurrence);
  return {
    occurrence,
    started: same.find((item) => item.receipt.kind === "turn_started")?.receipt,
    ended: same.find((item) => item.receipt.kind === "turn_ended")?.receipt,
  };
}

/** The creation time of the outbox message a reply is anchored on, or `fallback` when it is not there. */
export function anchorSince(
  record: Pick<RunRecord, "outbox">,
  anchorMessageId: string,
  fallback: Pick<RunAssignment, "createdAt"> | string | null,
): string | null {
  const intent = record.outbox.find((entry) => entry.messageId === anchorMessageId);
  if (intent !== undefined) return intent.createdAt;
  if (fallback === null) return null;
  return typeof fallback === "string" ? fallback : fallback.createdAt;
}

/**
 * Whether a `turn_started` of the agent came after `ended` and is a different turn or a different
 * appearance of it. A late start of the very turn that already ended (the hooks arrived out of order)
 * is not "the member started again".
 */
export function startedAfterEnded(record: Ledger, ended: RunEventReceipt): boolean {
  return record.eventReceipts.some(
    (receipt) =>
      receipt.kind === "turn_started" &&
      receipt.agentId === ended.agentId &&
      receipt.seq > ended.seq &&
      !sameTurnOccurrence(receipt, ended),
  );
}

/**
 * Which appearance a host hook belongs to, decided from the ledger and the time this plugin process
 * began (`processStart`): receipts written since then are what this process has already seen.
 *
 * - `turn_started`: this process wrote that start → the same appearance (a duplicate); this process wrote
 *   an end whose start is missing (out of order) → that appearance; otherwise a new one.
 * - `turn_ended`: this process wrote that end → the same; else the newest appearance that started and
 *   has no end (a turn that began before a plugin reload); else the newest one when its end was written
 *   by the Engine itself (the real end arrives late); else a new one (its start was missed).
 */
export function resolveHookOccurrence(
  record: Ledger,
  input: {
    kind: TurnReceiptKind;
    agentId: string;
    turnId: string;
    processStart: string;
  },
): number {
  const all = turnAppearances(record, input.agentId, input.turnId);
  const latest = maxOccurrence(all);
  const begun = Date.parse(input.processStart);
  const mine = all.filter((item) => Date.parse(item.receipt.receivedAt) >= begun);
  const of = (items: readonly TurnAppearance[], kind: TurnReceiptKind) =>
    items.filter((item) => item.receipt.kind === kind);
  if (input.kind === "turn_started") {
    const seen = maxOccurrence(of(mine, "turn_started"));
    if (seen > 0) return seen;
    const orphan = of(mine, "turn_ended")
      .map((item) => item.occurrence)
      .filter(
        (occurrence) => !of(all, "turn_started").some((item) => item.occurrence === occurrence),
      )
      .reduce((best, occurrence) => Math.max(best, occurrence), 0);
    if (orphan > 0) return orphan;
    return latest === 0 ? 1 : latest + 1;
  }
  const seen = maxOccurrence(of(mine, "turn_ended"));
  if (seen > 0) return seen;
  const open = of(all, "turn_started")
    .map((item) => item.occurrence)
    .filter((occurrence) => !of(all, "turn_ended").some((item) => item.occurrence === occurrence))
    .reduce((best, occurrence) => Math.max(best, occurrence), 0);
  if (open > 0) return open;
  const newestEnd = of(all, "turn_ended").find((item) => item.occurrence === latest);
  if (
    newestEnd !== undefined &&
    (newestEnd.receipt as { settledBy?: unknown }).settledBy === ENGINE_SETTLER
  ) {
    return latest;
  }
  return latest === 0 ? 1 : latest + 1;
}

/**
 * The appearance a reconcile read belongs to: the turn `turnId` that the reply anchored at `since` ran
 * in. When no receipt of it is on record after `since`, the turn is a new appearance after any earlier one.
 */
export function resolveReconcileOccurrence(
  record: Ledger,
  input: { agentId: string; turnId: string; since: string | null },
): number {
  const own = ownTurn(record, input);
  if (own !== undefined) return own.occurrence;
  const latest = maxOccurrence(turnAppearances(record, input.agentId, input.turnId));
  return latest === 0 ? 1 : latest + 1;
}
