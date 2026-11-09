import { z } from "zod";
import { RunIdRefSchema, type RunRecord, RunTimeSchema } from "../../schemas/run-engine/ledger";
import { replyAnchor } from "./report-repair";
import { raiseAlert, resolveAlerts } from "./run-alert";

/**
 * Persistent, bounded, read-only re-checks (plan point 35, S1).
 *
 * A host read that failed with an error (the reply of an agent that ended its turn, or the live state
 * of a seat before a dispatch) is read again a few times, 1, 2 and 4 seconds apart, and the Run says
 * what happened. That is all this does. It never sends a message, never settles a report, never
 * dispatches and never touches a task: a read that works again leaves a warning that asks a person to
 * kick the Run, and a read that keeps failing leaves one that says the tries are used up.
 *
 * What makes it more than a timer: the tries are on the ledger. A try is counted before the read
 * happens, so a process that dies in the middle cannot hand out a free try after a restart, and the
 * time the next try is due is a timestamp, so a restart works it out again instead of starting over.
 *
 * The block is `readRetries` on a v2 Run, written when the Run is created. A Run without it (every v1
 * Run, and a v2 Run made before this existed) is never given one; a block that does not read back as
 * valid is left exactly as it is and nothing is retried for that Run. Like `launch.dagControl` it is a
 * passthrough field with its own reader, so the ledger schema is not touched.
 */

export const READ_RETRY_VERSION = 1;
export const READ_RETRY_MAX_ITEMS = 128;
export const READ_RETRY_MAX_ITEM_BYTES = 2048;
export const READ_RETRY_MAX_ATTEMPTS = 3;
/** The wait before try 1, 2 and 3. A failed try that was not the last waits for the next entry. */
export const READ_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
export const READ_RETRY_EVENT = "read-retry-changed";
/**
 * A read that works again moves the Run on by itself, but only for the first few times a source
 * recovers: a host that flaps for ever is not chased for ever, it is left with the warning.
 */
export const READ_RETRY_AUTO_CONTINUE_GENERATIONS = 3;

const Time = RunTimeSchema;

const TargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("seat"), agentId: RunIdRefSchema }),
  z.strictObject({
    type: z.literal("reply"),
    agentId: RunIdRefSchema,
    taskId: z.string().min(1).max(64),
    assignmentId: RunIdRefSchema,
    anchorMessageId: z.string().min(1).max(128),
  }),
]);
export type ReadRetryTarget = z.infer<typeof TargetSchema>;

const ItemSchema = z
  .strictObject({
    key: z.string().min(1).max(128),
    generation: z.number().int().min(1).max(10_000),
    target: TargetSchema,
    /** What the failure belongs to (Run epoch, assignment, message): the same source is one item. */
    sourceKey: z.string().min(1).max(256),
    attemptsStarted: z.number().int().min(0).max(READ_RETRY_MAX_ATTEMPTS),
    scheduledAt: Time,
    nextAt: Time.nullable(),
    state: z.enum(["waiting", "checking", "resolved", "held"]),
    lastCode: z.string().min(1).max(64).optional(),
    result: z
      .strictObject({
        observedAt: Time,
        turnId: z.string().min(1).max(128).optional(),
        receiptKey: z.string().min(1).max(256).optional(),
      })
      .optional(),
  })
  .superRefine((item, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (item.state === "waiting") {
      if (item.nextAt === null) fail("nextAt", "a waiting item has a due time");
      if (item.attemptsStarted >= READ_RETRY_MAX_ATTEMPTS) fail("attemptsStarted", "no tries left");
    } else if (item.nextAt !== null) {
      fail("nextAt", "only a waiting item has a due time");
    }
    if (item.state === "checking" && item.attemptsStarted < 1) {
      fail("attemptsStarted", "a try is counted before the read");
    }
    if (item.state === "held" && item.lastCode === undefined)
      fail("lastCode", "held needs a reason");
    if (JSON.stringify(item).length > READ_RETRY_MAX_ITEM_BYTES) fail("key", "item too large");
  });
export type ReadRetryItem = z.infer<typeof ItemSchema>;

const BlockSchema = z.strictObject({
  version: z.literal(READ_RETRY_VERSION),
  items: z.array(ItemSchema).max(READ_RETRY_MAX_ITEMS),
});

export type ReadRetryBlock =
  /** Not written for this Run: it is not given retries. */
  | { kind: "absent" }
  /** There, but not readable. Left as it is; nothing is retried. */
  | { kind: "invalid" }
  | { kind: "valid"; items: ReadRetryItem[] };

export function readReadRetries(record: Pick<RunRecord, "schemaVersion">): ReadRetryBlock {
  const raw = (record as Record<string, unknown>).readRetries;
  if (raw === undefined || record.schemaVersion !== 2) return { kind: "absent" };
  const parsed = BlockSchema.safeParse(raw);
  return parsed.success ? { kind: "valid", items: parsed.data.items } : { kind: "invalid" };
}

/** The block a new v2 Run starts with. */
export function emptyReadRetries(): { version: 1; items: [] } {
  return { version: READ_RETRY_VERSION, items: [] };
}

type Change = { changed: false; next: RunRecord } | { changed: true; next: RunRecord };

/** What the timer needs to know of a Run. */
export type ObservedRun = Pick<RunRecord, "schemaVersion" | "lifecycle" | "launch">;

function finished(record: ObservedRun): boolean {
  return (
    record.lifecycle === "finished" ||
    record.lifecycle === "cancelled" ||
    record.launch.state === "failed" ||
    record.launch.state === "cancelled"
  );
}

function plusMs(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

function commit(
  record: RunRecord,
  items: ReadRetryItem[],
  events: { item: ReadRetryItem; now: string }[],
  now: string,
): RunRecord {
  const next = structuredClone(record);
  (next as Record<string, unknown>).readRetries = { version: READ_RETRY_VERSION, items };
  for (const { item } of events) {
    const seq = next.counters.eventsThroughSeq + 1;
    next.counters.eventsThroughSeq = seq;
    next.events.push({
      seq,
      kind: READ_RETRY_EVENT,
      at: now,
      payload: {
        key: item.key,
        generation: item.generation,
        state: item.state,
        attemptsStarted: item.attemptsStarted,
        ...(item.lastCode === undefined ? {} : { code: item.lastCode }),
      },
    });
  }
  next.updatedAt = now;
  return next;
}

/** True while the thing the read was for is still being waited on. */
export function targetStillWaited(record: RunRecord, target: ReadRetryTarget): boolean {
  if (finished(record)) return false;
  if (target.type === "seat") {
    return record.roster.some((seat) => seat.agentId === target.agentId && seat.enabled);
  }
  const assignment = record.assignments.find((entry) => entry.assignmentId === target.assignmentId);
  return (
    assignment !== undefined &&
    assignment.agentId === target.agentId &&
    (assignment.state === "assigned" || assignment.state === "in_progress") &&
    assignment.acceptedProof === null &&
    replyAnchor(record, assignment) === target.anchorMessageId
  );
}

function label(target: ReadRetryTarget): string {
  return target.type === "seat"
    ? `席位 Agent ${target.agentId}`
    : `Agent ${target.agentId} 的回复（${target.assignmentId}）`;
}

/** The reason a used-up re-check carries when the host no longer has the turn it was asked about. */
export const LOST_TURN_CODE = "incomplete:dispatch-not-found";

/**
 * How long after a used-up re-check of a lost dispatch a further look at the host may settle the turn
 * as lost (T4b). A person's "立即检查并推进", a hook or a recovery brings that look; no timer does.
 */
export const LOST_TURN_SETTLE_DELAY_MS = 30_000;

/**
 * Said after the fixed text when the host lost the turn (a restart in the middle of it). The item does
 * not say whose turn it was, so the text says for which turns the Engine settles and what to do for the
 * others: for a member's own task turn whose start the Engine recorded, a look at least this long after
 * the tries were used up, with the member idle in Paseo, lets the Engine record the turn as lost by the
 * host and open the decision a person answers; when the host has already said the turn ended (T9b), the
 * same look with the member idle, closed or archived opens the decision without a receipt of the Engine's;
 * a judge's, smoke tester's, supplement's or re-report's turn, a turn the Engine saw neither begin nor
 * end, and a turn with a later turn start of the member are not settled, and a plain OK sent to the member
 * is the way out (A21). The Engine sends the member nothing by itself.
 */
export const LOST_TURN_HINT = `。宿主可能丢失了进行中的回合：如果这是成员（生产者）的实现回合，且该成员在 Paseo 里空闲，并且引擎记录过这一回合的开始，至少等 ${LOST_TURN_SETTLE_DELAY_MS / 1000} 秒后点“立即检查并推进”，引擎会把这一回合记为宿主丢失并开出决策（重试或取消）；如果宿主已经报告这一回合结束、回复却读不到，而成员空闲、已关闭或已归档，同样至少等 ${LOST_TURN_SETTLE_DELAY_MS / 1000} 秒后点“立即检查并推进”，引擎会开出决策（成员已关闭或归档时只能取消）；判官、冒烟、补证或补报回合不会被引擎结算（成员已关闭或归档时除外）；引擎没见到回合开始、或该成员之后又有更晚的回合记录的回合，也不会被结算，请向该成员发一条只要求回复 OK 的消息，等它回复后再点“立即检查并推进”`;

/** The hint the T4b version wrote (before the host's own turn end was settled, T9b); its alerts are still found. */
const T4B_LOST_TURN_HINT = `。宿主可能丢失了进行中的回合：如果这是成员（生产者）的实现回合，且该成员在 Paseo 里空闲，并且引擎记录过这一回合的开始，至少等 ${LOST_TURN_SETTLE_DELAY_MS / 1000} 秒后点“立即检查并推进”，引擎会把这一回合记为宿主丢失并开出决策（重试或取消）；判官、冒烟、补证或补报回合不会被引擎结算；引擎没见到回合开始、或该成员之后又有更晚的回合或结束记录的回合，也不会被结算，请向该成员发一条只要求回复 OK 的消息，等它回复后再点“立即检查并推进”`;

/** The hint of the version that asked a person to send the member a plain OK (A21); its alerts are still found. */
const EARLIER_LOST_TURN_HINT =
  "。宿主可能丢失了进行中的回合：待该成员在 Paseo 里空闲后，向它发一条只要求回复 OK 的消息，等它回复后点“立即检查并推进”（不保证一定恢复）";

/** The text before any hint was added; alerts written by the earliest versions carry exactly this. */
function earlierAlertSummary(item: ReadRetryItem): string {
  return item.state === "held"
    ? `读取重试已用尽（${item.lastCode ?? "unknown"}）：${label(item.target)}，请检查宿主后 kick`
    : `读取恢复，报告未入账，请 kick：${label(item.target)}`;
}

/** The text of the alert for an item, the same every time so the alert is found again. */
export function readRetryAlertSummary(item: ReadRetryItem): string {
  const base = earlierAlertSummary(item);
  return item.state === "held" && item.lastCode === LOST_TURN_CODE
    ? `${base}${LOST_TURN_HINT}`
    : base;
}

/** The texts of the alert of an item that earlier versions wrote (not the current one). */
function earlierSummariesOf(item: ReadRetryItem): string[] {
  const base = earlierAlertSummary(item);
  return item.state === "held" && item.lastCode === LOST_TURN_CODE
    ? [base, `${base}${EARLIER_LOST_TURN_HINT}`, `${base}${T4B_LOST_TURN_HINT}`]
    : [];
}

/** Every text the alert of an item may carry: the current one, and the ones of earlier versions. */
function alertSummariesOf(item: ReadRetryItem): string[] {
  return [...new Set([readRetryAlertSummary(item), ...earlierSummariesOf(item)])];
}

/** Takes down every alert of an item, whichever wording it was written with. */
export function resolveItemAlerts(
  record: RunRecord,
  item: ReadRetryItem,
  now: string,
  alertId: (summary: string) => string,
): RunRecord {
  const ids = new Set(alertSummariesOf(item).map((summary) => alertId(summary)));
  return resolveAlerts(record, (alert) => ids.has(alert.alertId), now).next;
}

/**
 * Raises the alert of an item, unless one of earlier wording for the same item is still there: that one
 * is the same alert, and a second would only say it twice.
 */
function raiseItemAlert(
  record: RunRecord,
  item: ReadRetryItem,
  now: string,
  alertId: (summary: string) => string,
): RunRecord {
  const summary = readRetryAlertSummary(item);
  const earlier = earlierSummariesOf(item);
  if (
    record.alerts.some(
      (alert) =>
        alert.state !== "resolved" && alert.summary !== summary && earlier.includes(alert.summary),
    )
  ) {
    return record;
  }
  return raiseAlert(record, { alertId: alertId(summary), severity: "warning", summary }, now).next;
}

/**
 * Records that a read failed. The same source is one item: while it is waiting, being tried or used
 * up, a repeat changes nothing; after a try went through it starts a new generation. A full block
 * drops its oldest resolved item to make room and otherwise refuses, so nothing is cut off.
 */
export function noteReadFailure(
  record: RunRecord,
  input: { key: string; sourceKey: string; target: ReadRetryTarget },
  now: string,
): Change {
  const block = readReadRetries(record);
  if (block.kind !== "valid" || finished(record)) return { changed: false, next: record };
  const items = block.items.map((item) => ({ ...item }));
  const index = items.findIndex((item) => item.key === input.key);
  const existing = items[index];
  let touched: ReadRetryItem;
  if (existing !== undefined) {
    if (existing.state !== "resolved") return { changed: false, next: record };
    touched = {
      key: existing.key,
      generation: existing.generation + 1,
      target: input.target,
      sourceKey: input.sourceKey,
      attemptsStarted: 0,
      scheduledAt: now,
      nextAt: plusMs(now, READ_RETRY_DELAYS_MS[0]),
      state: "waiting",
    };
    items[index] = touched;
  } else {
    if (items.length >= READ_RETRY_MAX_ITEMS) {
      const oldest = items
        .map((item, position) => ({ item, position }))
        .filter(({ item }) => item.state === "resolved")
        .sort((a, b) => Date.parse(a.item.scheduledAt) - Date.parse(b.item.scheduledAt))[0];
      if (oldest === undefined) return { changed: false, next: record };
      items.splice(oldest.position, 1);
    }
    touched = {
      key: input.key,
      generation: 1,
      target: input.target,
      sourceKey: input.sourceKey,
      attemptsStarted: 0,
      scheduledAt: now,
      nextAt: plusMs(now, READ_RETRY_DELAYS_MS[0]),
      state: "waiting",
    };
    items.push(touched);
  }
  if (!ItemSchema.safeParse(touched).success) return { changed: false, next: record };
  return { changed: true, next: commit(record, items, [{ item: touched, now }], now) };
}

/** The earliest time a waiting item is due, in milliseconds, or null when nothing waits. */
export function nextDueMs(record: ObservedRun): number | null {
  const block = readReadRetries(record);
  // A Run that is over is not tried for, so nothing of it may keep a timer running.
  if (block.kind !== "valid" || finished(record)) return null;
  let earliest: number | null = null;
  for (const item of block.items) {
    if (item.state !== "waiting" || item.nextAt === null) continue;
    const due = Date.parse(item.nextAt);
    if (earliest === null || due < earliest) earliest = due;
  }
  return earliest;
}

/** True when an item is stuck in `checking`: a try was counted and the process stopped before it ended. */
export function hasInterruptedTry(record: ObservedRun): boolean {
  const block = readReadRetries(record);
  return (
    block.kind === "valid" &&
    !finished(record) &&
    block.items.some((item) => item.state === "checking")
  );
}

export type StartedTry = { key: string; generation: number; target: ReadRetryTarget };

function afterFailure(
  item: ReadRetryItem,
  code: string,
  now: string,
): { item: ReadRetryItem; exhausted: boolean } {
  const exhausted = item.attemptsStarted >= READ_RETRY_MAX_ATTEMPTS;
  return {
    exhausted,
    item: exhausted
      ? { ...item, state: "held", nextAt: null, lastCode: code }
      : {
          ...item,
          state: "waiting",
          nextAt: plusMs(now, READ_RETRY_DELAYS_MS[item.attemptsStarted] ?? 4000),
          lastCode: code,
        },
  };
}

/**
 * Counts the tries that are due before any of them reads, and gives back which to run. An item left in
 * `checking` by a process that stopped has used its try: it waits for the next one or is used up. An
 * alert for a try that ends this way is raised when the item is used up.
 */
export function beginTries(
  record: RunRecord,
  now: string,
  alertId: (summary: string) => string,
): { change: Change; started: StartedTry[] } {
  const block = readReadRetries(record);
  if (block.kind !== "valid" || finished(record)) {
    return { change: { changed: false, next: record }, started: [] };
  }
  const nowMs = Date.parse(now);
  const started: StartedTry[] = [];
  const events: { item: ReadRetryItem; now: string }[] = [];
  let next = record;
  const items = block.items.map((item) => {
    if (item.state === "checking") {
      const after = afterFailure(item, "interrupted", now);
      events.push({ item: after.item, now });
      if (after.exhausted) {
        next = raiseItemAlert(next, after.item, now, alertId);
      }
      return after.item;
    }
    if (item.state === "waiting" && item.nextAt !== null && Date.parse(item.nextAt) <= nowMs) {
      const trying: ReadRetryItem = {
        ...item,
        state: "checking",
        attemptsStarted: item.attemptsStarted + 1,
        nextAt: null,
      };
      started.push({ key: item.key, generation: item.generation, target: item.target });
      events.push({ item: trying, now });
      return trying;
    }
    return item;
  });
  if (events.length === 0) return { change: { changed: false, next: record }, started };
  return { change: { changed: true, next: commit(next, items, events, now) }, started };
}

export type TryOutcome =
  | {
      key: string;
      generation: number;
      ok: true;
      observedAt: string;
      turnId?: string;
      receiptKey?: string;
    }
  | { key: string; generation: number; ok: false; code: string };

/** Ends the tries that were run. An outcome for an item that has moved on (another generation, no longer `checking`) is dropped. */
export function finishTries(
  record: RunRecord,
  outcomes: readonly TryOutcome[],
  now: string,
  alertId: (summary: string) => string,
): Change {
  const block = readReadRetries(record);
  if (block.kind !== "valid") return { changed: false, next: record };
  const events: { item: ReadRetryItem; now: string }[] = [];
  let next = record;
  const items = block.items.map((item) => {
    const outcome = outcomes.find(
      (entry) => entry.key === item.key && entry.generation === item.generation,
    );
    if (outcome === undefined || item.state !== "checking") return item;
    let after: ReadRetryItem;
    if (outcome.ok) {
      // The read works again. It only counts if the thing it was for is still waited on.
      const still = targetStillWaited(record, item.target);
      after = {
        ...item,
        state: "resolved",
        nextAt: null,
        ...(still
          ? {
              result: {
                observedAt: outcome.observedAt,
                ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
                ...(outcome.receiptKey === undefined ? {} : { receiptKey: outcome.receiptKey }),
              },
            }
          : { lastCode: "superseded" }),
      };
      if (still) next = raiseItemAlert(next, after, now, alertId);
    } else {
      const failed = afterFailure(item, outcome.code.slice(0, 64), now);
      after = failed.item;
      if (failed.exhausted && targetStillWaited(record, item.target)) {
        next = raiseItemAlert(next, after, now, alertId);
      }
    }
    events.push({ item: after, now });
    return after;
  });
  if (events.length === 0) return { changed: false, next: record };
  return { changed: true, next: commit(next, items, events, now) };
}

/**
 * The items a commit moved to `resolved` with a result (the read works again and the thing it was for
 * is still waited on), for the first `READ_RETRY_AUTO_CONTINUE_GENERATIONS` generations of their source.
 * Compares the record before and after, so it needs nothing from `finishTries` itself.
 */
export function recoveredItems(
  before: RunRecord,
  after: RunRecord,
): { key: string; generation: number }[] {
  const was = readReadRetries(before);
  const now = readReadRetries(after);
  if (now.kind !== "valid") return [];
  const found: { key: string; generation: number }[] = [];
  for (const item of now.items) {
    if (item.state !== "resolved" || item.result === undefined) continue;
    if (item.generation > READ_RETRY_AUTO_CONTINUE_GENERATIONS) continue;
    const prior =
      was.kind === "valid"
        ? was.items.find((entry) => entry.key === item.key && entry.generation === item.generation)
        : undefined;
    if (prior?.state === "resolved") continue;
    found.push({ key: item.key, generation: item.generation });
  }
  return found;
}

/**
 * Takes down the alerts of items that are over: the reply that was waited for has been taken in (or
 * the assignment is gone), the Run is finished, or a pass of the Run went by without the same seat
 * read failing again (`notedKeys` are the items that failed during that pass).
 */
export function sweepReadRetries(
  record: RunRecord,
  notedKeys: ReadonlySet<string>,
  now: string,
  alertId: (summary: string) => string,
): Change {
  const block = readReadRetries(record);
  if (block.kind !== "valid") return { changed: false, next: record };
  const ids = new Set<string>();
  for (const item of block.items) {
    if (item.state !== "resolved" && item.state !== "held") continue;
    const over =
      finished(record) ||
      (item.target.type === "reply"
        ? !targetStillWaited(record, item.target)
        : !notedKeys.has(item.key));
    if (!over) continue;
    for (const summary of alertSummariesOf(item)) ids.add(alertId(summary));
  }
  if (ids.size === 0) return { changed: false, next: record };
  const resolved = resolveAlerts(record, (alert) => ids.has(alert.alertId), now);
  return resolved.changed
    ? { changed: true, next: resolved.next }
    : { changed: false, next: record };
}
