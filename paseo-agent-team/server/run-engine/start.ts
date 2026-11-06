import { randomUUID } from "node:crypto";
import type { LaunchPlan, PlannedAgent } from "../../shared/domain/launch-plan";
import { COORDINATOR_SEAT_ID } from "../../shared/domain/run-engine/dag-admission";
import {
  buildPlanSeats,
  COORDINATOR_SYSTEM_VERSION,
  compileCoordinatorSystem,
  compileMemberSystem,
  compilePlanRequest,
  MEMBER_SYSTEM_VERSION,
  PLAN_REQUEST_VERSION,
  planRequestFacts,
} from "../../shared/domain/run-engine/engine-prompts";
import { devEndpoint } from "../../shared/domain/run-engine/gates";
import { raiseAlert } from "../../shared/domain/run-engine/run-alert";
import {
  addPlanRequest,
  bindSeatAgent,
  buildModelPlanBasis,
  buildRunRecord,
  MAX_ENGINE_TASK_CHARS,
  type SeatProfile,
  seatProfileOf,
  setLaunchState,
} from "../../shared/domain/run-engine/run-record";
import type { PaseoAdapter } from "../../shared/paseo/adapter";
import type { Role } from "../../shared/schemas/role";
import type { RunTeamEngineConfig } from "../../shared/schemas/run-engine/config";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { alertIdFor, sha256Hex } from "./digest";
import { type Effects, payloadHash, type SendableIntent } from "./effects";
import {
  type CommitIdentity,
  commitIdentity,
  dispatchWorkspace,
  ensureEvidenceRoot,
  inspectRepo,
} from "./repo";
import type { RunStore } from "./store";

/**
 * Starts an Engine Run. The order is the point:
 *
 *   preflight    nothing exists yet; any failure leaves no trace
 *   preparing    the Run's record is committed BEFORE any agent exists
 *   creating     each agent is created with an idempotency key and bound to its seat at once, so a
 *                crash leaves a record of who exists, and an unknown create result is re-checked
 *                with the same key instead of creating a second agent
 *   kickoff      the plan request is a prepared `wake` in the outbox; the executor sends it once
 *   running      only when the plan request is confirmed
 *
 * A failure after the record exists marks the launch failed, raises an alert, and (by preference)
 * archives the agents it created; the record stays so the Runs page can say what happened. An
 * unknown result for the plan request is not a failure and is never re-sent: the Run stays in
 * `kickoff-pending` for the executor's echo check to settle.
 */

export type EngineStartStep = "preflight" | "prepare" | "coordinator" | "member" | "kickoff";

export type EngineStartResult =
  | {
      ok: true;
      runId: string;
      coordinatorId: string;
      memberIds: string[];
      /** `running` once the plan request is confirmed; `kickoff-pending` while that is unproven. */
      launchState: "running" | "kickoff-pending";
    }
  | {
      ok: false;
      step: EngineStartStep;
      message: string;
      detail?: string;
      /** Agents created before the failure that were archived. */
      archived: boolean;
      agentIdsKept: string[];
    };

export type EngineStartInput = {
  plan: LaunchPlan;
  roles: readonly Role[];
  engine: RunTeamEngineConfig;
  /** Real directory of the launch Workspace. */
  workspaceDirectory: string;
  requestId: string;
  requestHash: string;
  planHash: string;
  maxMembers: number;
  serverId: string;
  paseoHome: string;
  archiveOnLaunchFailure: boolean;
  onProgress?: (progress: { step: EngineStartStep; index?: number; total?: number }) => void;
};

export type EngineStartDeps = {
  store: Pick<RunStore, "create" | "update" | "get">;
  adapter: Pick<PaseoAdapter, "createAgent" | "archiveAgent">;
  effects: Pick<Effects, "runOutbox">;
  /** Rebuilds the plan request text; tests may stand in. Default: the Engine's own. */
  compilePlanRequest?(intent: SendableIntent, record: RunRecord): string | null;
  /** Default: the current plan request version. */
  templateVersion?: number;
  /** Whether git can name a committer in the Workspace. Default: `git var GIT_COMMITTER_IDENT`. */
  commitIdentity?(directory: string): Promise<CommitIdentity>;
  clock?: { now(): string };
  ids?: { uuid(): string };
  log?: (message: string, detail?: unknown) => void;
};

function compileWake(intent: SendableIntent, record: RunRecord): string | null {
  return intent.kind === "wake" ? compilePlanRequest(intent, record) : null;
}

function describe(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : undefined;
}

export async function startEngineRun(
  deps: EngineStartDeps,
  input: EngineStartInput,
): Promise<EngineStartResult> {
  const clock = deps.clock ?? { now: () => new Date().toISOString() };
  const uuid = deps.ids?.uuid ?? (() => randomUUID());
  const log = deps.log ?? (() => undefined);
  const { plan, engine } = input;
  const runId = plan.runId;
  const created: string[] = [];

  const refuse = (step: EngineStartStep, message: string, detail?: string): EngineStartResult => ({
    ok: false,
    step,
    message,
    detail,
    archived: false,
    agentIdsKept: [],
  });

  // --- preflight: nothing exists yet ---------------------------------------------------------
  input.onProgress?.({ step: "preflight" });
  if (plan.task.length > MAX_ENGINE_TASK_CHARS) {
    return refuse("preflight", `任务描述超过 ${MAX_ENGINE_TASK_CHARS} 字，Engine Run 放不下`);
  }
  const inspected = await inspectRepo(input.workspaceDirectory);
  if (!inspected.ok) {
    return refuse("preflight", "启动 Workspace 不是可用的 git 仓库", inspected.reason);
  }
  const repo = inspected.repo;
  const workspace = dispatchWorkspace(repo, plan.workspaceId);
  if (!workspace.ok) {
    return refuse("preflight", "启动 Workspace 没有可派发的干净分支", workspace.reason);
  }
  const identity = await (deps.commitIdentity ?? commitIdentity)(repo.root);
  if (!identity.ok) {
    return refuse("preflight", "启动 Workspace 的 git 没有可用的提交身份", identity.detail);
  }
  const evidence = await ensureEvidenceRoot(
    repo,
    engine.policy.evidenceRoot,
    input.paseoHome,
    runId,
  );
  if (!evidence.ok) return refuse("preflight", "证据目录不可用", evidence.reason);

  const seatProfiles = new Map<string, SeatProfile>();
  const memberOfSeat = new Map<string, PlannedAgent>();
  for (const seat of engine.seats) {
    const planned = plan.seats.find((entry) => entry.logicalSeatId === seat.seatId);
    if (!planned) return refuse("preflight", "席位没有对应的计划成员", seat.seatId);
    seatProfiles.set(seat.seatId, seatProfileOf(planned.selected.profile));
    const member = plan.members.find((entry) => entry.seatId === planned.seatId);
    if (seat.enabled && !member)
      return refuse("preflight", "启用的席位没有要创建的成员", seat.seatId);
    if (member) memberOfSeat.set(seat.seatId, member);
  }
  seatProfiles.set(COORDINATOR_SEAT_ID, seatProfileOf(plan.coordinator.profile));

  // The Engine's own system prompts, never the plan's (the old chain's, which teach delegation).
  // Each is pinned in the record by version and hash before any agent exists.
  const systemPrompts = new Map<string, string>();
  const pinned: Record<string, { template: string; version: number; hash: string }> = {};
  const pin = (seatId: string, template: string, version: number, text: string) => {
    systemPrompts.set(seatId, text);
    pinned[seatId] = { template, version, hash: sha256Hex(text) };
  };
  pin(
    COORDINATOR_SEAT_ID,
    "coordinator-system",
    COORDINATOR_SYSTEM_VERSION,
    compileCoordinatorSystem({
      teamName: plan.team.name,
      operatingRules: plan.team.operatingRules,
      role: plan.coordinator.role,
    }),
  );
  for (const [seatId, member] of memberOfSeat) {
    pin(
      seatId,
      "member-system",
      MEMBER_SYSTEM_VERSION,
      compileMemberSystem({
        teamName: plan.team.name,
        memberName: member.title,
        role: member.role,
      }),
    );
  }

  // --- preparing: the record, before any agent ------------------------------------------------
  input.onProgress?.({ step: "prepare" });
  const now = clock.now();
  const fingerprint = sha256Hex(
    JSON.stringify(
      [...seatProfiles].map(([seatId, profile]) => [seatId, profile.profileId]).sort(),
    ),
  );
  const record = buildRunRecord({
    runId,
    requestId: input.requestId,
    requestHash: input.requestHash,
    planHash: input.planHash,
    now,
    serverId: input.serverId,
    config: engine,
    evidenceRoot: evidence.root,
    modelPlan: buildModelPlanBasis({
      plan,
      roles: input.roles,
      planHash: input.planHash,
      rosterFingerprint: fingerprint,
      maxMembers: input.maxMembers,
    }),
    seatProfiles,
    coordinatorChannelId: plan.coordinator.profile.provider,
    workspace: { id: plan.workspaceId, directory: input.workspaceDirectory },
  });
  (record.launch as Record<string, unknown>).systemPrompts = pinned;
  try {
    await deps.store.create(record);
  } catch (cause) {
    return refuse("prepare", "无法写入运行记录", describe(cause));
  }

  async function commit(change: (current: RunRecord) => RunRecord | null): Promise<void> {
    await deps.store.update(runId, (current) => change(current));
  }

  /** Marks the launch failed, says so on the Run, and archives what was created if asked to. */
  async function fail(
    step: EngineStartStep,
    message: string,
    cause?: unknown,
  ): Promise<EngineStartResult> {
    const detail = describe(cause);
    log(`engine launch ${runId} failed at ${step}`, cause);
    let archived = false;
    if (input.archiveOnLaunchFailure && created.length > 0) {
      archived = true;
      for (const id of created) {
        try {
          await deps.adapter.archiveAgent(id);
        } catch (error) {
          archived = false;
          log(`could not archive ${id}`, error);
        }
      }
    }
    try {
      await commit((current) => {
        const failed = setLaunchState(current, "failed", clock.now(), `${step}: ${message}`);
        const base = failed.ok ? failed.next : current;
        const summary = `启动失败（${step}）：${message}${detail ? `：${detail}` : ""}`;
        const raised = raiseAlert(
          base,
          { alertId: alertIdFor(summary), severity: "critical", summary },
          clock.now(),
        );
        return failed.ok || raised.changed ? raised.next : null;
      });
    } catch (error) {
      log(`could not record the failed launch of ${runId}`, error);
    }
    return {
      ok: false,
      step,
      message,
      detail,
      archived,
      agentIdsKept: archived ? [] : [...created],
    };
  }

  // --- creating: agents with idempotency keys, each bound to its seat at once ------------------
  await commit((current) => {
    const moved = setLaunchState(current, "creating", clock.now());
    return moved.ok && moved.changed ? moved.next : null;
  });

  /** One create, re-asked once with the same key: an unknown result then returns the same agent. */
  async function createAgent(seatId: string, agent: PlannedAgent, parent?: string) {
    const request = {
      workspaceId: plan.workspaceId,
      ...(parent === undefined ? {} : { parentAgentId: parent }),
      title: agent.title,
      labels: agent.labels,
      systemPrompt: systemPrompts.get(seatId) ?? "",
      profile: agent.profile,
      mcpServers: agent.role.mcpServers,
      idempotencyKey: `engine:${runId}:seat:${seatId}`,
    };
    let result: { agentId: string };
    try {
      result = await deps.adapter.createAgent(request);
    } catch (first) {
      log(`creating ${seatId} did not return cleanly; asking again with the same key`, first);
      result = await deps.adapter.createAgent(request);
    }
    created.push(result.agentId);
    await commit((current) => {
      const bound = bindSeatAgent(current, seatId, result.agentId, clock.now());
      if (!bound.ok) throw new Error(`cannot bind ${seatId}: ${bound.code}`);
      return bound.changed ? bound.next : null;
    });
    return result.agentId;
  }

  input.onProgress?.({ step: "coordinator" });
  let coordinatorId: string;
  try {
    coordinatorId = await createAgent(COORDINATOR_SEAT_ID, plan.coordinator);
  } catch (cause) {
    return fail("coordinator", "无法创建协调者", cause);
  }

  const memberIds: string[] = [];
  const enabled = engine.seats.filter((seat) => seat.enabled);
  try {
    for (const [index, seat] of enabled.entries()) {
      const member = memberOfSeat.get(seat.seatId);
      if (!member) throw new Error(`no member for seat ${seat.seatId}`);
      input.onProgress?.({ step: "member", index: index + 1, total: enabled.length });
      memberIds.push(await createAgent(seat.seatId, member, coordinatorId));
    }
  } catch (cause) {
    return fail("member", `无法创建第 ${memberIds.length + 1}/${enabled.length} 个成员`, cause);
  }

  // --- kickoff: the plan request goes through the outbox, once ---------------------------------
  input.onProgress?.({ step: "kickoff" });
  // The control nonce is made here, not earlier: it enters the record in the same commit as its
  // digest and the request it is rebuilt from, so no crash can leave a digest without its nonce.
  const controlNonce = uuid();
  const request = {
    intentId: `intent-plan-${uuid().replace(/-/gu, "").slice(0, 8)}`,
    messageId: uuid(),
    templateVersion: deps.templateVersion ?? PLAN_REQUEST_VERSION,
    task: plan.task,
    controlNonce,
    controlNonceDigest: sha256Hex(controlNonce),
  };
  try {
    await commit((current) => {
      const moved = setLaunchState(current, "kickoff-pending", clock.now());
      if (!moved.ok) throw new Error(`launch state: ${moved.code}`);
      // The roster as it is now (the agents exist) decides the agent keys the planner is shown.
      const seats = buildPlanSeats(
        moved.next,
        new Map(
          [...memberOfSeat].map(([seatId, member]) => [
            seatId,
            { memberName: member.title, role: member.role },
          ]),
        ),
      );
      const prepared = addPlanRequest(moved.next, {
        ...request,
        facts: planRequestFacts({
          seats,
          devTargetUsable: moved.next.policy.devTargets.some(
            (target) => devEndpoint(target.host) !== null,
          ),
        }),
        payloadHash: "0".repeat(64),
        now: clock.now(),
      });
      const intent = prepared.outbox.find((entry) => entry.id === request.intentId);
      if (intent?.kind !== "wake") throw new Error("the plan request was not prepared");
      const text = (deps.compilePlanRequest ?? compileWake)(intent, prepared);
      if (text === null) throw new Error("the plan request cannot be built");
      intent.payloadHash = payloadHash(text);
      return prepared;
    });
  } catch (cause) {
    return fail("kickoff", "无法准备计划请求", cause);
  }

  try {
    await deps.effects.runOutbox(runId);
  } catch (cause) {
    // The executor settles its own failures as outcome-unknown; an exception here is a store fault.
    return fail("kickoff", "无法发送计划请求", cause);
  }
  const after = await deps.store.get(runId);
  const sent =
    after.status === "ok" &&
    after.record.outbox.some(
      (entry) => entry.id === request.intentId && entry.state === "confirmed",
    );
  if (sent) {
    await commit((current) => {
      const moved = setLaunchState(current, "running", clock.now());
      return moved.ok && moved.changed ? moved.next : null;
    });
  }
  return {
    ok: true,
    runId,
    coordinatorId,
    memberIds,
    launchState: sent ? "running" : "kickoff-pending",
  };
}
