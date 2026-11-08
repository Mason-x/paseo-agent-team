import type { PaseoProfile } from "../../paseo/adapter";
import type { Role } from "../../schemas/role";
import type { RunTeamEngineConfig } from "../../schemas/run-engine/config";
import {
  RUN_SCHEMA_VERSION,
  type RunEffectIntent,
  type RunModelPlanBasis,
  type RunRecord,
} from "../../schemas/run-engine/ledger";
import { LAUNCH_PLANNER_VERSION } from "../launch-hash";
import type { LaunchPlan } from "../launch-plan";
import { MODE_CONTRACT_VERSION } from "../mode-contract";
import { identifyModelFamily } from "../model-family";
import { reserveCoordinatorTurn } from "./coordinator-budget";
import { COORDINATOR_DUTY, COORDINATOR_SEAT_ID } from "./dag-admission";
import { emptyReadRetries } from "./read-retry";

/**
 * Building the first record of an Engine Run, and the small controlled changes the start sequence
 * makes to it before any task exists. Pure: ids, times and digests come from the caller.
 *
 * The controlled changes (binding a created agent to its seat, moving `launch.state`) have no reducer
 * event. Each is a pure function on the record that appends an audit event, like `transitionIntent`,
 * and each refuses what would be a lie: a seat is never rebound to another agent.
 */

/** Largest task text the frozen planning basis can hold. */
export const MAX_ENGINE_TASK_CHARS = 4000;

/** What the Engine needs to know of a seat's Profile for the whole life of the Run. */
export type SeatProfile = {
  profileId: string;
  name: string;
  provider: string;
  model: string | null;
  /** Model family from the model id alone; `null` when it cannot be told. */
  family: string | null;
};

export function seatProfileOf(profile: PaseoProfile): SeatProfile {
  const match = identifyModelFamily({ model: profile.model ?? null });
  return {
    profileId: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model ?? null,
    family: match.status === "identified" ? match.family : null,
  };
}

/** The start Workspace of an Engine Run: the whole Run shares it (plan 11.4, M2). */
export type LaunchWorkspace = { id: string; directory: string };

/**
 * The start Workspace, frozen at launch in a passthrough field of `launch`. `resolveWorkspace` is
 * synchronous in the service, so the real directory must be in the record: asking the host later
 * would make every dispatch depend on a live read, and a moved Workspace would silently change
 * where a running Run writes. `null` when the record has none (no dispatch is then possible).
 */
export function readLaunchWorkspace(record: Pick<RunRecord, "launch">): LaunchWorkspace | null {
  const raw = (record.launch as Record<string, unknown>).workspace;
  if (typeof raw !== "object" || raw === null) return null;
  const { id, directory } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof directory !== "string" || directory === "") return null;
  return { id, directory };
}

/**
 * Seat -> Profile, frozen at launch in a passthrough field of `launch`. A Profile that is renamed or
 * removed later does not change who a seat in a running Run is, and no kick has to read the host to
 * find out. The planning basis stays in `launch.modelPlan` for audit.
 */
export function readSeatProfiles(record: Pick<RunRecord, "launch">): Map<string, SeatProfile> {
  const raw = (record.launch as Record<string, unknown>).seatProfiles;
  const out = new Map<string, SeatProfile>();
  if (typeof raw !== "object" || raw === null) return out;
  for (const [seatId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.profileId !== "string" || typeof entry.name !== "string") continue;
    if (typeof entry.provider !== "string") continue;
    out.set(seatId, {
      profileId: entry.profileId,
      name: entry.name,
      provider: entry.provider,
      model: typeof entry.model === "string" ? entry.model : null,
      family: typeof entry.family === "string" ? entry.family : null,
    });
  }
  return out;
}

export type ModelPlanBasisInput = {
  plan: LaunchPlan;
  roles: readonly Role[];
  /** The launch plan's own hash: the one P1 hash the ledger ties itself to. */
  planHash: string;
  /** SHA-256 hex of the canonical seat/profile roster; computed where crypto is available. */
  rosterFingerprint: string;
  maxMembers: number;
};

export function buildModelPlanBasis(input: ModelPlanBasisInput): RunModelPlanBasis {
  const { plan } = input;
  const roleIds = new Set([plan.team.coordinatorRoleId, ...plan.team.members.map((m) => m.roleId)]);
  const profiles = new Map<string, PaseoProfile>();
  for (const profile of [plan.coordinator.profile, ...plan.members.map((m) => m.profile)]) {
    profiles.set(profile.id, profile);
  }
  return {
    p1PlanHash: input.planHash,
    mode: plan.mode,
    targetWorkspaceId: plan.workspaceId || null,
    task: plan.task,
    maxMembers: input.maxMembers,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    team: {
      id: plan.team.id,
      name: plan.team.name,
      rawMode: plan.team.mode ?? plan.mode,
      modeContract: MODE_CONTRACT_VERSION,
      plannerVersion: LAUNCH_PLANNER_VERSION,
      coordinatorRoleId: plan.team.coordinatorRoleId,
      members: plan.team.members.map((member) => ({
        ...(member.seatId === undefined ? {} : { seatId: member.seatId }),
        roleId: member.roleId,
        ...(member.instanceLabel === undefined ? {} : { instanceLabel: member.instanceLabel }),
        enabled: member.enabled,
      })),
      memberCreation: plan.team.memberCreation ?? null,
      collaboration: null,
    },
    roles: input.roles
      .filter((role) => roleIds.has(role.id))
      .map((role) => ({
        roleId: role.id,
        roleName: role.name,
        enabled: role.enabled,
        executionPolicy: null,
        preferredProfiles: role.preferredProfiles.map((ref) => ({ ...ref })),
        fallbackProfiles: role.fallbackProfiles.map((ref) => ({ ...ref })),
      })),
    economy: null,
    profileTuples: [...profiles.values()].map((profile) => ({
      profileId: profile.id,
      provider: profile.provider,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.modeId === undefined ? {} : { modeId: profile.modeId }),
      ...(profile.thinkingOptionId === undefined
        ? {}
        : { thinkingOptionId: profile.thinkingOptionId }),
      ...(profile.featureValues === undefined ? {} : { featureValues: profile.featureValues }),
    })),
    rosterFingerprint: input.rosterFingerprint,
  };
}

export type RunRecordInput = {
  runId: string;
  requestId: string;
  requestHash: string;
  planHash: string;
  now: string;
  serverId: string;
  /** Run-level config frozen from the Team; `evidenceRoot` must already be the resolved directory. */
  config: RunTeamEngineConfig;
  evidenceRoot: string;
  modelPlan: RunModelPlanBasis;
  /** Seat id (logical, or `coordinator`) -> the Profile that seat runs on. */
  seatProfiles: ReadonlyMap<string, SeatProfile>;
  coordinatorChannelId: string;
  /** The start Workspace, frozen into `launch.workspace`. Omitted only by fixtures that inject it. */
  workspace?: LaunchWorkspace;
};

export function buildRunRecord(input: RunRecordInput): RunRecord {
  const { config, modelPlan, now } = input;
  const roster: RunRecord["roster"] = [
    ...config.seats.map((seat) => ({
      seatId: seat.seatId,
      tier: seat.tier,
      agentId: null,
      channelId: seat.channelId,
      duties: [...seat.duties],
      enabled: seat.enabled,
    })),
    {
      seatId: COORDINATOR_SEAT_ID,
      tier: "S" as const,
      agentId: null,
      channelId: input.coordinatorChannelId,
      duties: [COORDINATOR_DUTY],
      enabled: true,
    },
  ];

  // A channel is usable until the Engine learns otherwise; "unknown" would keep every seat idle.
  const channels: RunRecord["channels"] = [];
  for (const seat of roster) {
    if (channels.some((entry) => entry.channelId === seat.channelId)) continue;
    channels.push({
      channelId: seat.channelId,
      profileIds: [
        ...new Set(
          roster
            .filter((other) => other.channelId === seat.channelId)
            .map((other) => input.seatProfiles.get(other.seatId)?.profileId)
            .filter((id): id is string => id !== undefined),
        ),
      ],
      state: "available",
      unavailableUntil: null,
      scope: "channel",
      source: "usage-source",
      code: null,
      observedAt: now,
      incidentId: `incident-${seat.channelId}-0`,
      revision: 1,
    });
  }

  const seatProfiles: Record<string, SeatProfile> = {};
  for (const [seatId, profile] of input.seatProfiles) seatProfiles[seatId] = profile;

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    // A new Run is given read re-checks (`read-retry.ts`); a Run made without this block never is.
    readRetries: emptyReadRetries(),
    runId: input.runId,
    revision: 1,
    previousDigest: "",
    createdAt: now,
    updatedAt: now,
    hostBinding: { serverId: input.serverId },
    launch: {
      requestId: input.requestId,
      requestHash: input.requestHash,
      planHash: input.planHash,
      state: "preparing",
      modelPlan,
      seatProfiles,
      ...(input.workspace ? { workspace: { ...input.workspace } } : {}),
      // No `dagControl` yet: the control nonce is made when the plan request is prepared, and its
      // digest, its text and the request's hash are committed together (`addPlanRequest`).
    } as RunRecord["launch"],
    team: {
      id: modelPlan.team.id,
      name: modelPlan.team.name,
      rawMode: modelPlan.team.rawMode,
      modeContract: modelPlan.team.modeContract,
      plannerVersion: modelPlan.team.plannerVersion,
      modelPlanHash: modelPlan.p1PlanHash,
    },
    lifecycle: "bootstrapping",
    policy: { ...structuredClone(config.policy), evidenceRoot: input.evidenceRoot },
    roster,
    dagRevision: 0,
    tasks: [],
    resources: [],
    assignments: [],
    reopenGrants: [],
    outbox: [],
    nonceRegistry: [],
    eventReceipts: [],
    events: [{ seq: 1, kind: "run_created", at: now, payload: {} }],
    counters: { observationSeq: 0, eventsThroughSeq: 1, probeAttempts: 0, reopenAttempts: 0 },
    budgets: { entries: [] },
    decisions: [],
    approvals: [],
    channels,
    alerts: [],
    metrics: {
      strategicTurns: 0,
      workerEvents: 0,
      decisions: 0,
      tasks: 0,
      reworks: 0,
      firstReviewAccepted: 0,
      coverage: "complete",
    },
  };
}

function audit(next: RunRecord, kind: string, now: string, payload: Record<string, unknown>): void {
  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({ seq, kind, at: now, payload });
  next.updatedAt = now;
}

export type SeatBinding =
  | { ok: true; changed: boolean; next: RunRecord }
  | { ok: false; code: "seat-missing" | "seat-bound-to-another-agent" };

/**
 * Records that `agentId` is the agent of `seatId`. Binding the same agent again is a no-op, so a
 * repeated call after a crash is harmless; binding a different agent is refused, because a seat that
 * quietly changed agents would send work to someone the ledger did not authorize.
 */
export function bindSeatAgent(
  record: RunRecord,
  seatId: string,
  agentId: string,
  now: string,
): SeatBinding {
  const index = record.roster.findIndex((seat) => seat.seatId === seatId);
  const seat = record.roster[index];
  if (index < 0 || seat === undefined) return { ok: false, code: "seat-missing" };
  if (seat.agentId === agentId) return { ok: true, changed: false, next: record };
  if (seat.agentId !== null) return { ok: false, code: "seat-bound-to-another-agent" };
  const next = structuredClone(record);
  const target = next.roster[index];
  if (target === undefined) return { ok: false, code: "seat-missing" };
  target.agentId = agentId;
  audit(next, "seat-bound", now, { seatId, agentId });
  return { ok: true, changed: true, next };
}

export type LaunchState = RunRecord["launch"]["state"];

const LAUNCH_STEPS: Record<LaunchState, readonly LaunchState[]> = {
  preparing: ["creating", "failed", "cancelled"],
  creating: ["kickoff-pending", "failed", "cancelled"],
  "kickoff-pending": ["running", "failed", "cancelled"],
  running: [],
  failed: [],
  cancelled: [],
};

export type LaunchTransition =
  | { ok: true; changed: boolean; next: RunRecord }
  | { ok: false; code: "illegal-transition"; from: LaunchState };

/** Moves `launch.state` along preparing, creating, kickoff-pending, running; or to failed. */
export function setLaunchState(
  record: RunRecord,
  to: LaunchState,
  now: string,
  reason?: string,
): LaunchTransition {
  const from = record.launch.state;
  if (from === to) return { ok: true, changed: false, next: record };
  if (!LAUNCH_STEPS[from].includes(to)) return { ok: false, code: "illegal-transition", from };
  const next = structuredClone(record);
  next.launch.state = to;
  audit(next, "launch-state", now, {
    from,
    to,
    ...(reason ? { reason: reason.slice(0, 200) } : {}),
  });
  return { ok: true, changed: true, next };
}

export type PlanRequestInput = {
  intentId: string;
  messageId: string;
  /** SHA-256 hex of the compiled request text, filled in by the caller once it is compiled. */
  payloadHash: string;
  templateVersion: number;
  /** The task text and the control nonce the request is rebuilt from. */
  task: string;
  controlNonce: string;
  /** SHA-256 hex of `controlNonce`; shared code has no crypto, so the caller digests it. */
  controlNonceDigest: string;
  /** Everything else the request text is rebuilt from (the seat snapshot, the DEV target flag). */
  facts: Record<string, unknown>;
  now: string;
};

/**
 * Adds the plan request: a `wake` to the coordinator. It carries no assignment (there is no task
 * yet), so the schema's task id is a placeholder, and it leaves the outbox when the DAG is admitted.
 *
 * The control nonce comes into the record here and nowhere earlier: its digest (`launch.dagControl`),
 * its text (the intent's arguments, which the request is rebuilt from) and the request's hash land in
 * one commit, so no crash can leave a digest whose nonce is lost. A Run gets one plan request and
 * one nonce; asking again is refused rather than quietly replacing them. It also takes the
 * coordinator's first turn from its budget (`coordinator-budget.ts`).
 */
export function addPlanRequest(record: RunRecord, input: PlanRequestInput): RunRecord {
  const coordinator = record.roster.find((seat) => seat.seatId === COORDINATOR_SEAT_ID);
  if (!coordinator || coordinator.agentId === null) {
    throw new Error("the coordinator has no agent yet");
  }
  const launch = record.launch as Record<string, unknown>;
  if (launch.dagControl !== undefined || record.outbox.some((entry) => entry.kind === "wake")) {
    throw new Error("the plan request was already prepared");
  }
  // The plan request is the coordinator's first turn, paid in the same commit as the request. A Run
  // is only started with at least one turn (the launch gate and the preflight), so this does not refuse.
  const reservation = reserveCoordinatorTurn(record, `plan:${record.runId}:1`, input.messageId);
  if (reservation.status !== "reserved") {
    throw new Error("the coordinator has no turn left for the plan request");
  }
  const next = reservation.next;
  (next.launch as Record<string, unknown>).dagControl = {
    nonceDigest: input.controlNonceDigest,
    issuedAt: input.now,
    acceptedAt: null,
  };
  const intent: RunEffectIntent = {
    id: input.intentId,
    kind: "wake",
    recipient: coordinator.agentId,
    messageId: input.messageId,
    idempotencyKey: `plan:${record.runId}:1`,
    payloadHash: input.payloadHash,
    templateVersion: input.templateVersion,
    state: "prepared",
    recoverySendCount: 0,
    createdAt: input.now,
    confirmedAt: null,
    localCancellation: null,
    taskId: "plan",
    assignmentId: null,
    semanticArgs: {
      ...input.facts,
      purpose: "plan",
      task: input.task,
      controlNonce: input.controlNonce,
    },
  };
  next.outbox.push(intent);
  audit(next, "plan-request-prepared", input.now, { intentId: input.intentId });
  return next;
}
