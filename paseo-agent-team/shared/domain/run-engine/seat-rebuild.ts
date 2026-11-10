import { z } from "zod";
import type { PaseoProfile } from "../../paseo/adapter";
import { RunIdRefSchema, type RunRecord, RunTimeSchema } from "../../schemas/run-engine/ledger";
import { raiseAlert, resolveAlerts } from "./run-alert";

/**
 * Rebuilding a member's Agent from the spec frozen at launch (T11b).
 *
 * A restart can leave a member that no read will bring back: one whose first turn was cut off (its
 * conversation never reached the disk), or one that never ran and cannot be opened (Codex). The Engine
 * then creates a new Agent for that seat from the configuration the Run was started with, and binds it
 * to the seat. This file is the pure part: what is frozen, what is written down while it happens, and
 * what a person is told. Reading the host, creating the Agent and deciding whether to are `server/`.
 *
 * Two passthrough blocks carry it, each with its own reader that never throws:
 *  - `launch.agentSpecs`, frozen with the record, before any Agent exists;
 *  - `seatRebuilds` at the top of the record, the attempts made (at most two generations per seat).
 * A block that cannot be read is left alone and nothing is started or continued for it. Both exist only
 * on a v2 Run started by a build that writes them; every other Run is simply not rebuilt.
 */

export const AGENT_SPECS_VERSION = 1;
/** One seat's system prompt, in UTF-8 bytes. A seat over it is not frozen and so cannot be rebuilt. */
export const AGENT_SPEC_PROMPT_MAX_BYTES = 64 * 1024;
/** All the frozen specs of a Run together: the ledger is rewritten whole by every commit. */
export const AGENT_SPECS_MAX_BYTES = 256 * 1024;

export const SEAT_REBUILDS_VERSION = 1;
export const SEAT_REBUILD_MAX_PER_SEAT = 2;
export const SEAT_REBUILD_MAX_ITEMS = 128;
export const SEAT_REBUILD_MAX_BYTES = 64 * 1024;
/** The audit event written when a seat is given a new Agent. */
export const SEAT_REBOUND_EVENT = "seat-rebound";

const utf8 = new TextEncoder();
export const utf8Bytes = (text: string): number => utf8.encode(text).length;

// --- the frozen launch spec ---------------------------------------------------------------------

export type AgentSpec = {
  /** `coordinator` for a member, `null` for the coordinator itself. */
  parentSeatId: string | null;
  title: string;
  labels: Record<string, string>;
  systemPrompt: string;
  systemPromptSha256: string;
  /** The whole Profile the launch sent, not the subset kept for scheduling. */
  profile: PaseoProfile;
  roleId: string;
  /** Digest of the Role's MCP configuration at launch. The configuration itself may hold secrets. */
  mcpServersSha256: string;
};

const Sha = z.string().regex(/^[a-f0-9]{64}$/);

const AgentSpecSchema = z.object({
  parentSeatId: z.string().min(1).max(128).nullable(),
  title: z.string().min(1).max(500),
  labels: z.record(z.string(), z.string()),
  systemPrompt: z.string().min(1),
  systemPromptSha256: Sha,
  profile: z
    .object({
      id: z.string().min(1),
      name: z.string(),
      provider: z.string().min(1),
      model: z.string().optional(),
      modeId: z.string().optional(),
      thinkingOptionId: z.string().optional(),
      featureValues: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  roleId: z.string().min(1).max(128),
  mcpServersSha256: Sha,
});

export type AgentSpecsRead =
  /** Not written for this Run (a v1 Run, or one started before this existed). */
  | { kind: "absent" }
  /** There, but not readable as a whole. */
  | { kind: "invalid" }
  /** A seat that is not in `seats` has no usable spec (it was skipped at launch, or is damaged). */
  | { kind: "valid"; seats: Map<string, AgentSpec> };

export function readAgentSpecs(
  record: Pick<RunRecord, "schemaVersion" | "launch">,
): AgentSpecsRead {
  const launch = record.launch as Record<string, unknown>;
  const raw = launch.agentSpecs;
  if (raw === undefined || record.schemaVersion !== 2) return { kind: "absent" };
  if (typeof raw !== "object" || raw === null) return { kind: "invalid" };
  const block = raw as Record<string, unknown>;
  if (block.version !== AGENT_SPECS_VERSION) return { kind: "invalid" };
  const seats = block.seats;
  if (typeof seats !== "object" || seats === null || Array.isArray(seats))
    return { kind: "invalid" };
  const pinned =
    typeof launch.systemPrompts === "object" && launch.systemPrompts !== null
      ? (launch.systemPrompts as Record<string, unknown>)
      : {};
  const out = new Map<string, AgentSpec>();
  for (const [seatId, value] of Object.entries(seats)) {
    const parsed = AgentSpecSchema.safeParse(value);
    if (!parsed.success) continue;
    const spec = parsed.data as AgentSpec;
    if (utf8Bytes(spec.systemPrompt) > AGENT_SPEC_PROMPT_MAX_BYTES) continue;
    // The prompt the Run pinned at launch is the one this spec must carry.
    const pin = pinned[seatId];
    const hash =
      typeof pin === "object" && pin !== null ? (pin as Record<string, unknown>).hash : undefined;
    if (hash !== spec.systemPromptSha256) continue;
    out.set(seatId, spec);
  }
  return { kind: "valid", seats: out };
}

/**
 * The specs to freeze, in the order given (members first, the coordinator last): a seat whose prompt is
 * over `AGENT_SPEC_PROMPT_MAX_BYTES`, or that would take the total over `AGENT_SPECS_MAX_BYTES`, is left
 * out whole, never cut. Later, smaller seats may still fit.
 */
export function freezeAgentSpecs(entries: readonly { seatId: string; spec: AgentSpec }[]): {
  version: 1;
  seats: Record<string, AgentSpec>;
} {
  const seats: Record<string, AgentSpec> = {};
  let total = 0;
  for (const { seatId, spec } of entries) {
    if (utf8Bytes(spec.systemPrompt) > AGENT_SPEC_PROMPT_MAX_BYTES) continue;
    const size = utf8Bytes(JSON.stringify(spec));
    if (total + size > AGENT_SPECS_MAX_BYTES) continue;
    total += size;
    seats[seatId] = spec;
  }
  return { version: AGENT_SPECS_VERSION, seats };
}

// --- the attempts ---------------------------------------------------------------------------------

export type SeatRebuildState = "creating" | "bound" | "failed";

const ItemSchema = z
  .strictObject({
    rebuildId: z.string().min(1).max(160),
    seatId: RunIdRefSchema,
    generation: z.union([z.literal(1), z.literal(2)]),
    fromAgentId: RunIdRefSchema,
    toAgentId: RunIdRefSchema.nullable(),
    idempotencyKey: z.string().min(1).max(512),
    title: z.string().min(1).max(500),
    reason: z.string().min(1).max(200),
    state: z.enum(["creating", "bound", "failed"]),
    requestedAt: RunTimeSchema,
    settledAt: RunTimeSchema.nullable(),
    error: z.string().min(1).max(64).nullable(),
  })
  .superRefine((item, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (item.state === "creating") {
      if (item.toAgentId !== null)
        fail("toAgentId", "a rebuild that is still being made has no agent");
      if (item.settledAt !== null) fail("settledAt", "not settled yet");
    }
    if (item.state === "bound") {
      if (item.toAgentId === null) fail("toAgentId", "a bound rebuild names its agent");
      if (item.settledAt === null) fail("settledAt", "bound is settled");
    }
    if (item.state === "failed") {
      if (item.error === null) fail("error", "a failed rebuild says why");
      if (item.settledAt === null) fail("settledAt", "failed is settled");
    }
    if (item.rebuildId !== rebuildIdFor(item.seatId, item.generation)) fail("rebuildId", "id");
  });
export type SeatRebuildItem = z.infer<typeof ItemSchema>;

const BlockSchema = z
  .strictObject({
    version: z.literal(SEAT_REBUILDS_VERSION),
    items: z.array(ItemSchema).max(SEAT_REBUILD_MAX_ITEMS),
  })
  .superRefine((block, ctx) => {
    const seen = new Set<string>();
    for (const item of block.items) {
      if (seen.has(item.rebuildId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "repeated rebuild" });
      }
      seen.add(item.rebuildId);
    }
    if (utf8Bytes(JSON.stringify(block)) > SEAT_REBUILD_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "block too large" });
    }
  });

export type SeatRebuildsRead =
  /** Not written for this Run. */
  | { kind: "absent" }
  /** There, but not readable. Nothing is started or continued for this Run. */
  | { kind: "invalid" }
  | { kind: "valid"; items: SeatRebuildItem[] };

export function readSeatRebuilds(record: Pick<RunRecord, "schemaVersion">): SeatRebuildsRead {
  const raw = (record as Record<string, unknown>).seatRebuilds;
  if (raw === undefined || record.schemaVersion !== 2) return { kind: "absent" };
  const parsed = BlockSchema.safeParse(raw);
  return parsed.success ? { kind: "valid", items: parsed.data.items } : { kind: "invalid" };
}

/** Same on every ask, so a repeated start finds its own attempt instead of adding another. */
export function rebuildIdFor(seatId: string, generation: number): string {
  return `rebuild-${seatId}-g${generation}`;
}

/** The host's key for the create: asking again with it returns the same Agent. */
export function rebuildKeyFor(runId: string, seatId: string, generation: number): string {
  return `engine:${runId}:seat:${seatId}:rebuild:${generation}`;
}

/**
 * The title of a rebuilt Agent. The host cuts a title at 60 UTF-16 units (`String.slice`), so the base is cut,
 * not the suffix, counted the same way, and never between the two halves of a surrogate pair.
 */
export const REBUILD_TITLE_MAX = 60;
export function rebuildTitle(base: string, generation: number): string {
  const suffix = `（重建 ${generation}）`;
  let head = base.slice(0, Math.max(0, REBUILD_TITLE_MAX - suffix.length));
  const last = head.charCodeAt(head.length - 1);
  if (head.length > 0 && last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${suffix}`;
}

/** The Agents a seat was rebuilt away from: what the observer no longer listens to. */
export function reboundFromAgents(record: Pick<RunRecord, "schemaVersion">): Set<string> {
  const read = readSeatRebuilds(record);
  return new Set(
    read.kind === "valid"
      ? read.items.filter((item) => item.state === "bound").map((item) => item.fromAgentId)
      : [],
  );
}

export function rebuildsOfSeat(
  items: readonly SeatRebuildItem[],
  seatId: string,
): SeatRebuildItem[] {
  return items.filter((item) => item.seatId === seatId);
}

// --- what a person reads ------------------------------------------------------------------------

/** Every rebuild alert begins with one of these, so they are found again by their text. */
const REBUILDING = (seatId: string, generation: number) =>
  `Engine 正在重建席位 ${seatId}（第 ${generation} 次）：`;
const REBOUND = (seatId: string, generation: number) =>
  `已按启动时冻结的配置为席位 ${seatId} 新建 Agent（第 ${generation} 次）；`;
const FAILED = (seatId: string, generation: number) =>
  `重建席位 ${seatId} 的 Agent 失败（第 ${generation} 次，`;
/** The alerts that say a seat cannot be rebuilt, and why. */
export const REBUILD_UNABLE_PREFIX = "Engine 无法重建";

export const rebuildingAlertText = (seatId: string, generation: number): string =>
  `${REBUILDING(seatId, generation)}按启动时冻结的配置为这个成员新建 Agent，不发消息。完成前不要归档或操作这个席位。`;
export const reboundAlertText = (seatId: string, generation: number): string =>
  `${REBOUND(seatId, generation)}旧 Agent 留在 Paseo 里，归档它不影响这个 Run。`;
export const failedAlertText = (seatId: string, generation: number, code: string): string =>
  generation >= SEAT_REBUILD_MAX_PER_SEAT
    ? `${FAILED(seatId, generation)}原因码 ${code}）：这个席位的 ${SEAT_REBUILD_MAX_PER_SEAT} 次重建都用完了，Engine 不会再试，只能取消这个 Run 后重新启动。`
    : `${FAILED(seatId, generation)}原因码 ${code}）：这个席位仍不可用。点“立即检查并推进”可再试一次（每个席位最多重建 ${SEAT_REBUILD_MAX_PER_SEAT} 次），否则取消这个 Run 后重新启动。`;

export type CannotRebuild =
  | "no-spec"
  | "spec-damaged"
  | "role-missing"
  | "mcp-changed"
  | "prompt-mismatch"
  | "no-workspace"
  | "no-coordinator"
  | "records-unreadable"
  | "proof-bound"
  | "records-full";

const UNABLE_REASON: Record<CannotRebuild, string> = {
  "no-spec": "这个 Run 没有保存这个成员的启动规格（0.8.0 之前启动的 Run，或规格超过大小上限）",
  "spec-damaged": "这个成员保存的启动规格已损坏",
  "role-missing": "它的 Role 已找不到或读不出来",
  "mcp-changed": "它的 Role 的 MCP 配置和启动时不一样",
  "prompt-mismatch": "保存的系统提示词和启动时记下的摘要对不上",
  "no-workspace": "这个 Run 没有记下启动时的 Workspace",
  "no-coordinator": "协调者的席位里没有 Agent，新成员没有父 Agent 可挂",
  "records-unreadable": "这个 Run 的重建记录读不懂",
  "proof-bound": "它的 Agent 已有被接受的交付证明，换绑会让台账失效",
  "records-full": "这个 Run 的重建记录已经写到大小上限，再写一条会让整块读不懂",
};

export const unableAlertText = (seatId: string, why: CannotRebuild): string =>
  why === "records-unreadable"
    ? `${REBUILD_UNABLE_PREFIX}成员：${UNABLE_REASON[why]}，Engine 不会再重建或继续重建。只能取消这个 Run 后重新启动。`
    : `${REBUILD_UNABLE_PREFIX}席位 ${seatId}：${UNABLE_REASON[why]}，Engine 不会重建它的 Agent，也不会创建任何东西。只能取消这个 Run 后重新启动。`;

const alertIdOf = (kind: string, seatId: string, generation?: number) =>
  `rebuild-${kind}-${seatId}${generation === undefined ? "" : `-g${generation}`}`.slice(0, 128);

/** One warning that a seat cannot be rebuilt; asking again for the same seat and reason writes nothing. */
export function raiseCannotRebuild(
  record: RunRecord,
  seatId: string,
  why: CannotRebuild,
  now: string,
): RunRecord {
  return raiseAlert(
    record,
    {
      alertId: alertIdOf(why === "records-unreadable" ? "unreadable" : `unable-${why}`, seatId),
      severity: "warning",
      summary: unableAlertText(seatId, why),
    },
    now,
  ).next;
}

// --- the attempt's records and alerts, each one commit's worth ------------------------------------

export type RebuildStart = {
  seatId: string;
  generation: 1 | 2;
  fromAgentId: string;
  title: string;
  reason: string;
};

/** What binding or failing an attempt adds to its record (an Agent id, a time, a code), kept free when one starts. */
const SETTLE_RESERVE_BYTES = 512;

/**
 * Whether this attempt can be written, and later settled, without the block of attempts passing its size
 * limit (a block over it is not readable, and then nothing in it counts). Asked before anything is created.
 */
export function canStartRebuild(record: RunRecord, input: RebuildStart): boolean {
  const read = readSeatRebuilds(record);
  if (read.kind === "invalid") return false;
  const items = read.kind === "valid" ? read.items : [];
  if (items.length + 1 > SEAT_REBUILD_MAX_ITEMS) return false;
  const next = {
    rebuildId: rebuildIdFor(input.seatId, input.generation),
    seatId: input.seatId,
    generation: input.generation,
    fromAgentId: input.fromAgentId,
    toAgentId: null,
    idempotencyKey: rebuildKeyFor(record.runId, input.seatId, input.generation),
    title: input.title,
    reason: input.reason.slice(0, 200),
    state: "creating",
    requestedAt: record.updatedAt,
    settledAt: null,
    error: null,
  };
  const block = { version: SEAT_REBUILDS_VERSION, items: [...items, next] };
  return utf8Bytes(JSON.stringify(block)) + SETTLE_RESERVE_BYTES <= SEAT_REBUILD_MAX_BYTES;
}

/** Writes the attempt before anything is created: a restart then finds it and carries on. */
export function startRebuildRecord(
  record: RunRecord,
  input: RebuildStart,
  now: string,
): { changed: boolean; next: RunRecord } {
  const read = readSeatRebuilds(record);
  if (read.kind === "invalid") return { changed: false, next: record };
  const items = read.kind === "valid" ? read.items : [];
  const rebuildId = rebuildIdFor(input.seatId, input.generation);
  if (items.some((item) => item.rebuildId === rebuildId)) return { changed: false, next: record };
  // Never write a block that the next read would call invalid.
  if (!canStartRebuild(record, input)) return { changed: false, next: record };
  const next = structuredClone(record);
  const item: SeatRebuildItem = {
    rebuildId,
    seatId: input.seatId,
    generation: input.generation,
    fromAgentId: input.fromAgentId,
    toAgentId: null,
    idempotencyKey: rebuildKeyFor(record.runId, input.seatId, input.generation),
    title: input.title,
    reason: input.reason.slice(0, 200),
    state: "creating",
    requestedAt: now,
    settledAt: null,
    error: null,
  };
  (next as Record<string, unknown>).seatRebuilds = {
    version: SEAT_REBUILDS_VERSION,
    items: [...items, item],
  };
  next.updatedAt = now;
  const raised = raiseAlert(
    next,
    {
      alertId: alertIdOf("creating", input.seatId, input.generation),
      severity: "warning",
      summary: rebuildingAlertText(input.seatId, input.generation),
    },
    now,
  );
  return { changed: true, next: raised.next };
}

/** The attempt did not give the seat an Agent. It stays a record (it used a generation), with its code. */
export function failRebuildRecord(
  record: RunRecord,
  rebuildId: string,
  code: string,
  now: string,
): { changed: boolean; next: RunRecord } {
  const read = readSeatRebuilds(record);
  const item =
    read.kind === "valid" ? read.items.find((e) => e.rebuildId === rebuildId) : undefined;
  if (read.kind !== "valid" || item === undefined || item.state !== "creating") {
    return { changed: false, next: record };
  }
  const next = structuredClone(record);
  const stored = (next as Record<string, unknown>).seatRebuilds as { items: SeatRebuildItem[] };
  const target = stored.items.find((e) => e.rebuildId === rebuildId);
  if (!target) return { changed: false, next: record };
  const safe = code.replace(/[^A-Za-z0-9_.:-]/gu, "-").slice(0, 64) || "failed";
  Object.assign(target, { state: "failed", error: safe, settledAt: now });
  next.updatedAt = now;
  const resolved = resolveAlerts(
    next,
    (alert) => alert.alertId === alertIdOf("creating", item.seatId, item.generation),
    now,
  );
  const raised = raiseAlert(
    resolved.next,
    {
      alertId: alertIdOf("failed", item.seatId, item.generation),
      severity: "warning",
      summary: failedAlertText(item.seatId, item.generation, safe),
    },
    now,
  );
  return { changed: true, next: raised.next };
}

/** Whether the new Agent of a bound rebuild has had its first dispatch confirmed by the host. */
function firstDispatchConfirmed(record: RunRecord, agentId: string | null): boolean {
  return (
    agentId !== null &&
    record.outbox.some(
      (intent) =>
        intent.kind === "dispatch" && intent.recipient === agentId && intent.state === "confirmed",
    )
  );
}

/**
 * Takes down the alerts that no longer tell the truth: "being rebuilt" once the attempt is settled; "rebuilt"
 * once the new Agent has taken a dispatch, or the Run is over; "failed" and "cannot be rebuilt" once nothing
 * waits for a closed seat any more (`held` false), or the Run is over. Writes nothing if there is nothing to take down.
 */
export function settleRebuildAlerts(
  record: RunRecord,
  state: { held: boolean; over: boolean },
  now: string,
): RunRecord {
  if (!record.alerts.some((alert) => alert.state !== "resolved" && isRebuildAlert(alert.alertId))) {
    return record;
  }
  const read = readSeatRebuilds(record);
  const items = read.kind === "valid" ? read.items : [];
  const keep = new Set<string>();
  for (const item of items) {
    if (item.state === "creating") keep.add(alertIdOf("creating", item.seatId, item.generation));
    if (item.state === "bound" && !state.over && !firstDispatchConfirmed(record, item.toAgentId)) {
      keep.add(alertIdOf("bound", item.seatId, item.generation));
    }
    const newest = Math.max(...rebuildsOfSeat(items, item.seatId).map((e) => e.generation));
    if (item.state === "failed" && state.held && !state.over && item.generation === newest) {
      keep.add(alertIdOf("failed", item.seatId, item.generation));
    }
  }
  const cannot = (alertId: string) =>
    alertId.startsWith("rebuild-unable-") || alertId.startsWith("rebuild-unreadable");
  return resolveAlerts(
    record,
    (alert) =>
      isRebuildAlert(alert.alertId) &&
      (cannot(alert.alertId) ? !state.held || state.over : !keep.has(alert.alertId)),
    now,
  ).next;
}

function isRebuildAlert(alertId: string): boolean {
  return alertId.startsWith("rebuild-");
}

/** The alerts a bound rebuild writes (called by `completeSeatRebuild`). */
export function reboundAlerts(
  record: RunRecord,
  item: Pick<SeatRebuildItem, "seatId" | "generation">,
  now: string,
): RunRecord {
  const resolved = resolveAlerts(
    record,
    (alert) => alert.alertId === alertIdOf("creating", item.seatId, item.generation),
    now,
  );
  return raiseAlert(
    resolved.next,
    {
      alertId: alertIdOf("bound", item.seatId, item.generation),
      severity: "warning",
      summary: reboundAlertText(item.seatId, item.generation),
    },
    now,
  ).next;
}
