import { cancelPending } from "../../shared/domain/run-engine/cancel-request";
import { COORDINATOR_SEAT_ID } from "../../shared/domain/run-engine/dag-admission";
import { isAgentArchived } from "../../shared/domain/run-engine/lost-turn";
import {
  completeSeatRebuild,
  readLaunchWorkspace,
  rebindBlocker,
} from "../../shared/domain/run-engine/run-record";
import {
  type AgentSpec,
  type CannotRebuild,
  failRebuildRecord,
  raiseCannotRebuild,
  readAgentSpecs,
  readSeatRebuilds,
  rebuildsOfSeat,
  SEAT_REBUILD_MAX_PER_SEAT,
  type SeatRebuildItem,
  startRebuildRecord,
} from "../../shared/domain/run-engine/seat-rebuild";
import type { CreateMemberInput } from "../../shared/paseo/adapter";
import type { McpServers } from "../../shared/schemas/role";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { mcpServersSha256, sha256Hex } from "./digest";
import type { RunStore } from "./store";

/**
 * Making a member's Agent again from the spec frozen at launch (T11b). The decision to do it is the
 * service's (`service.ts`); this is what doing it takes, written so that every crash point leaves a record
 * the next look can finish:
 *
 *   1. one commit writes the attempt as `creating` (and says so on the Run) before anything is created;
 *   2. the Agent is created with a key that names the attempt, up to three times: asking the host again with
 *      the same key and the same configuration gives the same Agent, so an unknown result costs nothing;
 *   3. one commit gives the seat the new Agent (`rebindSeatAgent`), marks the attempt `bound` and raises the
 *      alert. Nothing can be bound without step 1, and step 3 is the only place a seat changes Agent.
 *
 * A restart in the middle leaves a `creating` attempt; `resumeRebuilds` carries it out again with the same
 * key. An attempt that cannot go on says so in its record (`failed`, a code, never a message) and uses up one
 * of the two generations a seat has. Whatever stops an attempt *before* it is written (no usable spec, a Role
 * whose MCP configuration is not the one the Run started with) writes no attempt and uses nothing up: it is
 * a warning that the Run can only be cancelled and started again.
 */

export type RoleMcp =
  | { status: "found"; mcpServers: McpServers | undefined }
  | { status: "missing" };

export type RebuildHost = {
  createAgent(input: CreateMemberInput): Promise<{ agentId: string }>;
  /** The Role as it is now; only its MCP configuration is used. A throw counts as missing. */
  readRole(roleId: string): Promise<RoleMcp>;
  /** Reads the history of an Agent so the host loads it again (what a parent needs before it can have children). */
  reopenAgent?(agentId: string): Promise<boolean>;
  /** How often one create is tried (default 3, like the launch) and the pause before try n+1 is n times this (750 ms). */
  createAttempts?: number;
  retryDelayMs?: number;
};

export type RebuildDeps = {
  store: Pick<RunStore, "get" | "update">;
  host: RebuildHost;
  clock: { now(): string };
  log: (message: string, detail?: unknown) => void;
};

export type Rebuildable =
  | {
      ok: true;
      spec: AgentSpec;
      mcpServers: McpServers | undefined;
      workspaceId: string;
      parentAgentId: string;
    }
  | { ok: false; why: CannotRebuild };

/** Whether a seat has everything a rebuild needs. Reads the Role; writes nothing. */
export async function checkRebuildable(
  host: Pick<RebuildHost, "readRole">,
  record: RunRecord,
  seatId: string,
): Promise<Rebuildable> {
  const specs = readAgentSpecs(record);
  if (specs.kind === "absent") return { ok: false, why: "no-spec" };
  if (specs.kind === "invalid") return { ok: false, why: "spec-damaged" };
  const spec = specs.seats.get(seatId);
  // Skipped at launch (too large) or damaged since: either way there is nothing to rebuild from.
  if (spec === undefined) return { ok: false, why: "no-spec" };
  if (sha256Hex(spec.systemPrompt) !== spec.systemPromptSha256) {
    return { ok: false, why: "prompt-mismatch" };
  }
  let role: RoleMcp;
  try {
    role = await host.readRole(spec.roleId);
  } catch {
    role = { status: "missing" };
  }
  if (role.status !== "found") return { ok: false, why: "role-missing" };
  if (mcpServersSha256(role.mcpServers) !== spec.mcpServersSha256) {
    return { ok: false, why: "mcp-changed" };
  }
  // The rest of what the create needs, checked here too so that a Run without it writes no attempt.
  const workspace = readLaunchWorkspace(record);
  if (workspace === null) return { ok: false, why: "no-workspace" };
  const parent = record.roster.find((seat) => seat.seatId === COORDINATOR_SEAT_ID)?.agentId;
  if (parent === null || parent === undefined) return { ok: false, why: "no-coordinator" };
  return {
    ok: true,
    spec,
    mcpServers: role.mcpServers,
    workspaceId: workspace.id,
    parentAgentId: parent,
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "agent_request_key_conflict" || message.includes("agent_request_key_conflict")) {
    return "key-conflict";
  }
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(code)) return code;
  return /parent/iu.test(message) ? "parent-unavailable" : "create-failed";
}

async function commitFail(
  deps: RebuildDeps,
  runId: string,
  rebuildId: string,
  code: string,
): Promise<void> {
  try {
    await deps.store.update(runId, (current) => {
      const failed = failRebuildRecord(current, rebuildId, code, deps.clock.now());
      return failed.changed ? failed.next : null;
    });
  } catch (error) {
    deps.log(`could not record the failed rebuild ${rebuildId} of ${runId}`, error);
  }
}

export type RebuildOutcome =
  | { status: "bound"; seatId: string; agentId: string }
  | { status: "failed"; seatId: string; code: string }
  | { status: "skipped" };

/** Carries out one `creating` attempt: create (same key every time), then bind in one commit. */
export async function executeRebuild(
  deps: RebuildDeps,
  runId: string,
  rebuildId: string,
): Promise<RebuildOutcome> {
  const read = await deps.store.get(runId);
  if (read.status !== "ok") return { status: "skipped" };
  const record = read.record;
  const rebuilds = readSeatRebuilds(record);
  const item =
    rebuilds.kind === "valid" ? rebuilds.items.find((e) => e.rebuildId === rebuildId) : undefined;
  if (item === undefined || item.state !== "creating") return { status: "skipped" };
  const fail = async (code: string): Promise<RebuildOutcome> => {
    await commitFail(deps, runId, rebuildId, code);
    return { status: "failed", seatId: item.seatId, code };
  };
  if (record.lifecycle === "finished" || record.lifecycle === "cancelled") {
    return fail("run-ended");
  }
  // The seat is not free to be moved (work or a message is on its way to the old Agent, or a proof ties it):
  // nothing is asked of the host. The attempt stays `creating`; a later look asks again, with the same key.
  const blocked = rebindBlocker(record, item.seatId, item.fromAgentId);
  if (blocked !== null) {
    deps.log(`the rebuild ${rebuildId} of ${runId} waits: its seat cannot be moved (${blocked})`);
    return { status: "skipped" };
  }
  const checked = await checkRebuildable(deps.host, record, item.seatId);
  if (!checked.ok) return fail(checked.why);
  const parent = checked.parentAgentId;
  const request: CreateMemberInput = {
    workspaceId: checked.workspaceId,
    parentAgentId: parent,
    title: item.title,
    labels: checked.spec.labels,
    systemPrompt: checked.spec.systemPrompt,
    profile: checked.spec.profile,
    mcpServers: checked.mcpServers,
    // No `prompt`: creating the Agent must not start a turn.
    idempotencyKey: item.idempotencyKey,
  };
  const attempts = Math.max(1, deps.host.createAttempts ?? 3);
  const delay = deps.host.retryDelayMs ?? 750;
  let agentId: string | undefined;
  let reopenedParent = false;
  for (let attempt = 1; agentId === undefined; attempt += 1) {
    try {
      agentId = (await deps.host.createAgent(request)).agentId;
    } catch (error) {
      const code = errorCode(error);
      deps.log(`creating the rebuilt Agent for ${item.seatId} of ${runId} did not succeed`, error);
      // The host would not give a child to a parent it has not loaded: read the parent, the same way a
      // closed member is reopened, and ask again with the same key.
      if (code === "parent-unavailable" && !reopenedParent && deps.host.reopenAgent) {
        reopenedParent = true;
        await deps.host.reopenAgent(parent).catch(() => false);
      }
      if (code === "key-conflict" || attempt >= attempts) return fail(code);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }

  const created = agentId;
  const holder: { code: string | null } = { code: null };
  try {
    await deps.store.update(runId, (current) => {
      const done = completeSeatRebuild(
        current,
        { rebuildId, toAgentId: created },
        deps.clock.now(),
      );
      if (!done.ok) {
        holder.code = `bind-${done.code}`;
        // The Agent exists on the host and its id is only in this process. A refusal that may pass (work on its
        // way to the old Agent, a seat that is not ready) leaves the attempt `creating`: the same key gives the
        // same Agent again and the bind is tried once more. Only an attempt that is gone or already settled
        // cannot be carried on, and is failed.
        if (done.code !== "rebuild-missing" && done.code !== "rebuild-settled") return null;
        const failed = failRebuildRecord(current, rebuildId, holder.code, deps.clock.now());
        return failed.changed ? failed.next : null;
      }
      return done.changed ? done.next : null;
    });
  } catch (error) {
    // The commit may or may not have landed. The attempt stays `creating`; the next look runs the same
    // create (same key: the same Agent) and binds again, which does nothing if it already happened.
    deps.log(`could not bind the rebuilt Agent ${created} of ${item.seatId} in ${runId}`, error);
    return { status: "skipped" };
  }
  if (holder.code !== null) {
    deps.log(
      `the rebuilt Agent ${created} of ${item.seatId} in ${runId} could not be bound`,
      holder.code,
    );
    const lost = holder.code === "bind-rebuild-missing" || holder.code === "bind-rebuild-settled";
    return lost
      ? { status: "failed", seatId: item.seatId, code: holder.code }
      : { status: "skipped" };
  }
  return { status: "bound", seatId: item.seatId, agentId: created };
}

/** The attempts a restart (or a crash) cut off: each is carried out again with its own key. */
export async function resumeRebuilds(deps: RebuildDeps, runId: string): Promise<RebuildOutcome[]> {
  const read = await deps.store.get(runId);
  if (read.status !== "ok") return [];
  const rebuilds = readSeatRebuilds(read.record);
  if (rebuilds.kind !== "valid") return [];
  const outcomes: RebuildOutcome[] = [];
  for (const item of rebuilds.items) {
    if (item.state === "creating") outcomes.push(await executeRebuild(deps, runId, item.rebuildId));
  }
  return outcomes;
}

export function hasCreatingRebuild(record: RunRecord): boolean {
  const rebuilds = readSeatRebuilds(record);
  return rebuilds.kind === "valid" && rebuilds.items.some((item) => item.state === "creating");
}

export type RebuildRequest = {
  seatId: string;
  fromAgentId: string;
  generation: 1 | 2;
  reason: string;
};

/**
 * Writes the attempt, then carries it out. Everything is judged again inside the commit that writes it,
 * on the record it really holds: a Run that was paused or cancelled meanwhile, a seat that took work, an
 * attempt that someone else wrote, a seat that already has its two generations. Returns `skipped` if so.
 */
export async function startRebuild(
  deps: RebuildDeps,
  runId: string,
  request: RebuildRequest,
  title: string,
): Promise<RebuildOutcome> {
  const holder: { id: string | null } = { id: null };
  try {
    await deps.store.update(runId, (current) => {
      if (current.lifecycle !== "active" || cancelPending(current)) return null;
      if (current.launch.state !== "running") return null;
      const rebuilds = readSeatRebuilds(current);
      if (rebuilds.kind === "invalid") return null;
      const items: readonly SeatRebuildItem[] = rebuilds.kind === "valid" ? rebuilds.items : [];
      if (items.some((item) => item.state === "creating")) return null;
      const mine = rebuildsOfSeat(items, request.seatId);
      if (mine.length >= SEAT_REBUILD_MAX_PER_SEAT || mine.length + 1 !== request.generation) {
        return null;
      }
      const seat = current.roster.find((entry) => entry.seatId === request.seatId);
      if (seat?.agentId !== request.fromAgentId) return null;
      // Archived while the Role was being read: nothing is made for a seat that was put away.
      if (isAgentArchived(current, request.fromAgentId)) return null;
      if (rebindBlocker(current, request.seatId, request.fromAgentId) !== null) return null;
      const started = startRebuildRecord(
        current,
        {
          seatId: request.seatId,
          generation: request.generation,
          fromAgentId: request.fromAgentId,
          title,
          reason: request.reason,
        },
        deps.clock.now(),
      );
      if (!started.changed) return null;
      holder.id = `rebuild-${request.seatId}-g${request.generation}`;
      return started.next;
    });
  } catch (error) {
    deps.log(`could not write the rebuild of ${request.seatId} in ${runId}`, error);
    return { status: "skipped" };
  }
  if (holder.id === null) return { status: "skipped" };
  return executeRebuild(deps, runId, holder.id);
}

/** One warning that the Run cannot rebuild this seat; nothing is created and no attempt is written. */
export async function warnCannotRebuild(
  deps: Pick<RebuildDeps, "store" | "clock" | "log">,
  runId: string,
  seatId: string,
  why: CannotRebuild,
): Promise<void> {
  try {
    await deps.store.update(runId, (current) => {
      const next = raiseCannotRebuild(current, seatId, why, deps.clock.now());
      return next === current ? null : next;
    });
  } catch (error) {
    deps.log(`could not warn that ${seatId} of ${runId} cannot be rebuilt`, error);
  }
}
