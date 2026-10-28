import { createHash } from "node:crypto";
import { canonicalize } from "../shared/domain/catalog-content";
import { routeOf } from "../shared/domain/cheap-routing";
import { LAUNCH_RUNTIME_CAPABILITIES } from "../shared/domain/launch-runtime";
import { MODE_CONTRACT_VERSION, TEAM_MODES } from "../shared/domain/mode-contract";
import type { EconomyPolicy, HostSnapshot } from "../shared/domain/mode-resolver";
import { type ModeIssue, resolveRoleExecution } from "../shared/domain/role-execution";
import type { PlannedSeat } from "../shared/domain/seat-plan";
import { buildTeamModelPlan, type TeamPlanningFields } from "../shared/domain/team-model-plan";
import { createPaseoAdapter, type PaseoProfile } from "../shared/paseo/adapter";
import type { PaseoPort } from "../shared/paseo/port";
import type { Role } from "../shared/schemas/role";
import type { RoleTier, TaskKind } from "../shared/schemas/team-mode";
import {
  TEAM_PLAN_DESIGN_ROLE_POLICY,
  TEAM_PLAN_MAX_ROWS,
  TEAM_PLAN_SCHEMA_VERSION,
  type TeamPlanCapabilities,
  type TeamPlanContext,
  type TeamPlanInput,
  type TeamPlanOutput,
  type TeamPlanResult,
  type TeamPlanRow,
} from "../shared/schemas/team-plan";
import { zh } from "../shared/zh";
import {
  type PlanningReaders,
  type PlanningSnapshot,
  readPlanningSnapshot,
} from "./planning-context";

/**
 * Read-only Team planning service behind `agent-team.team.plan`.
 *
 * One batch pays one snapshot (3 settings reads, 1 config read, 1 availability read) regardless of
 * item count. `items: []` is the capability probe and performs no read at all. Nothing here creates
 * a workspace or an agent, writes settings, or touches the design ledger.
 */

type ReadySnapshot = Extract<PlanningSnapshot, { status: "ready" }>;

type RowProfile = NonNullable<TeamPlanRow["profile"]>;
type RowAvailability = TeamPlanRow["availability"];

export const TEAM_PLAN_CAPABILITIES: TeamPlanCapabilities = {
  modeContract: MODE_CONTRACT_VERSION,
  designRolePolicy: TEAM_PLAN_DESIGN_ROLE_POLICY,
  supportedModes: [...TEAM_MODES],
  runtimeCapabilities: { ...LAUNCH_RUNTIME_CAPABILITIES },
};

function capabilities(): TeamPlanCapabilities {
  return {
    modeContract: TEAM_PLAN_CAPABILITIES.modeContract,
    designRolePolicy: TEAM_PLAN_CAPABILITIES.designRolePolicy,
    supportedModes: [...TEAM_PLAN_CAPABILITIES.supportedModes],
    runtimeCapabilities: { ...TEAM_PLAN_CAPABILITIES.runtimeCapabilities },
  };
}

function contextIssue(reason: string): ModeIssue {
  return { code: "MODE_CONTEXT_UNAVAILABLE", severity: "blocker", params: { reason } };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function profileDto(profile: PaseoProfile): RowProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.modeId === undefined ? {} : { modeId: profile.modeId }),
    ...(profile.thinkingOptionId === undefined
      ? {}
      : { thinkingOptionId: profile.thinkingOptionId }),
  };
}

/** Provider availability for one real selection; a missing row is unverified, never "available". */
function availabilityOf(profile: PaseoProfile, host: HostSnapshot): RowAvailability {
  if (host.status !== "ready") return "unavailable";
  const row = host.availability.find((entry) => entry.provider === profile.provider);
  if (!row) return "unverified";
  return row.available ? "available" : "unavailable";
}

function blockedAvailability(host: HostSnapshot): RowAvailability {
  return host.status === "ready" && host.availabilityUnverified ? "unverified" : "unavailable";
}

/** Diagnostic bindings: stored order, live Profiles only, deduped, capped by the DTO. */
function configuredProfilesFor(role: Role | null, profiles: readonly PaseoProfile[]): RowProfile[] {
  if (!role) return [];
  const live = new Map(profiles.map((profile) => [profile.id, profile]));
  const seen = new Set<string>();
  const rows: RowProfile[] = [];
  for (const ref of [...role.preferredProfiles, ...role.fallbackProfiles]) {
    if (seen.has(ref.profileId)) continue;
    seen.add(ref.profileId);
    const profile = live.get(ref.profileId);
    if (!profile) continue;
    rows.push(profileDto(profile));
    if (rows.length === 10) break;
  }
  return rows;
}

function rolePolicy(
  role: Role | null,
  kind: "coordinator" | "member",
): { tier: RoleTier | null; taskKind?: TaskKind } {
  if (!role) return { tier: null };
  const execution = resolveRoleExecution(role, kind);
  return execution.ok
    ? { tier: execution.value.tier, taskKind: execution.value.taskKind }
    : { tier: null };
}

/** The logical seat id seat-plan derives for each stored member (same rule; pinned by tests). */
function logicalSeatIds(members: TeamPlanningFields["members"]): string[] {
  const explicit = new Set<string>();
  for (const member of members) {
    if (!member.enabled) continue;
    const seatId = member.seatId?.trim();
    if (seatId) explicit.add(seatId);
  }
  const taken = new Set(explicit);
  return members.map((member, index) => {
    if (!member.enabled) return "";
    const seatId = member.seatId?.trim();
    if (seatId) return seatId;
    const base = `seat-${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(candidate);
    return candidate;
  });
}

function coordinatorIssue(reason: string, roleId: string | null): ModeIssue {
  return {
    code: "MODE_PROFILE_UNRESOLVED",
    severity: "blocker",
    ...(roleId ? { roleId } : {}),
    params: { reason, field: "coordinator" },
  };
}

function issuesAttachedTo(
  issues: readonly ModeIssue[],
  logicalSeatId: string | undefined,
): ModeIssue[] {
  if (!logicalSeatId) return [];
  return issues.filter((issue) => issue.seatId === logicalSeatId);
}

function coordinatorRow(input: {
  team: TeamPlanningFields;
  role: Role | null;
  modelPlan: ReturnType<typeof buildTeamModelPlan>;
  host: HostSnapshot;
}): TeamPlanRow {
  const { team, role, modelPlan, host } = input;
  const policy = rolePolicy(role, "coordinator");
  const profiles = host.status === "ready" ? host.profiles : [];
  const base = {
    rowKey: "coordinator",
    kind: "coordinator" as const,
    roleId: role?.id ?? (team.coordinatorRoleId || null),
    roleName: role?.name ?? (team.coordinatorRoleId || zh.missing),
    tier: policy.tier,
    ...(policy.taskKind === undefined ? {} : { taskKind: policy.taskKind }),
    enabled: true,
    configuredProfiles: configuredProfilesFor(role, profiles),
  };
  const selection = modelPlan.coordinator.selection;
  if (selection) {
    return {
      ...base,
      ...(selection.route === undefined ? {} : { route: selection.route }),
      profile: profileDto(selection.profile),
      source: selection.source,
      budget: selection.budget,
      budgetBasis: selection.budgetBasis,
      availability: availabilityOf(selection.profile, host),
      issues: [...selection.issues],
    };
  }
  const issues = !role
    ? [coordinatorIssue("role-missing", team.coordinatorRoleId || null)]
    : modelPlan.coordinator.legacyFailureReason !== null
      ? [coordinatorIssue(modelPlan.coordinator.legacyFailureReason, role.id)]
      : [...modelPlan.coordinator.issues];
  return {
    ...base,
    // The failed coordinator still belongs to the coordinator route; same routeOf source as the
    // planner, only when the role policy is readable (otherwise the planner has no route either).
    ...(modelPlan.effectiveMode === "economy-all" && policy.tier !== null
      ? { route: routeOf("coordinator", policy.tier) }
      : {}),
    profile: null,
    source: "unavailable",
    budget: "unknown",
    budgetBasis: "conservative-default",
    availability: blockedAvailability(host),
    issues,
  };
}

function seatRow(input: {
  rowKey: string;
  seat: PlannedSeat;
  role: Role | null;
  host: HostSnapshot;
}): TeamPlanRow {
  const { rowKey, seat, role, host } = input;
  const policy = rolePolicy(role, "member");
  return {
    rowKey,
    seatId: seat.seatId,
    logicalSeatId: seat.logicalSeatId,
    kind: "member",
    roleId: seat.roleId,
    roleName: seat.roleName,
    tier: policy.tier,
    ...(policy.taskKind === undefined ? {} : { taskKind: policy.taskKind }),
    ...(seat.selected.route === undefined ? {} : { route: seat.selected.route }),
    enabled: true,
    purpose: seat.purpose,
    activation: seat.activation,
    profile: seat.selected.unavailable ? null : profileDto(seat.selected.profile),
    source: seat.selected.source,
    budget: seat.selected.budget,
    budgetBasis: seat.selected.budgetBasis,
    availability: seat.selected.unavailable
      ? blockedAvailability(host)
      : availabilityOf(seat.selected.profile, host),
    configuredProfiles: configuredProfilesFor(role, host.status === "ready" ? host.profiles : []),
    issues: [...seat.selected.issues],
  };
}

function memberPlaceholderRow(input: {
  rowKey: string;
  member: TeamPlanningFields["members"][number];
  logicalSeatId: string | undefined;
  role: Role | null;
  host: HostSnapshot;
  mode: TeamPlanResult["effectiveMode"];
  issues: readonly ModeIssue[];
  enabled: boolean;
}): TeamPlanRow {
  const { rowKey, member, logicalSeatId, role, host, mode, issues, enabled } = input;
  const policy = rolePolicy(role, "member");
  return {
    rowKey,
    ...(logicalSeatId === undefined ? {} : { logicalSeatId }),
    kind: "member",
    roleId: member.roleId === "" ? null : member.roleId,
    roleName: role?.name ?? (member.roleId || zh.missing),
    tier: policy.tier,
    ...(policy.taskKind === undefined ? {} : { taskKind: policy.taskKind }),
    // An enabled economy-all seat has a route even when no cheap candidate resolved; standard,
    // legacy, and disabled rows keep the previous shape.
    ...(mode === "economy-all" && enabled && policy.tier !== null
      ? { route: routeOf("member", policy.tier) }
      : {}),
    enabled,
    profile: null,
    source: "unavailable",
    budget: "unknown",
    budgetBasis: "conservative-default",
    availability: blockedAvailability(host),
    configuredProfiles: configuredProfilesFor(role, host.status === "ready" ? host.profiles : []),
    issues: [...issues],
  };
}

function memberIndexForSeat(
  seat: PlannedSeat,
  logicalIndex: ReadonlyMap<string, number>,
): number | undefined {
  return logicalIndex.get(seat.logicalSeatId);
}

function fingerprint(input: {
  team: TeamPlanningFields;
  roles: readonly Role[];
  host: HostSnapshot;
  economy: EconomyPolicy;
  rows: readonly TeamPlanRow[];
}): string {
  const referenced = new Set<string>();
  if (input.team.coordinatorRoleId) referenced.add(input.team.coordinatorRoleId);
  for (const member of input.team.members) {
    if (member.roleId) referenced.add(member.roleId);
  }
  const roles = input.roles
    .filter((role) => referenced.has(role.id))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((role) => ({
      id: role.id,
      enabled: role.enabled,
      executionPolicy: role.executionPolicy ?? null,
      preferredProfiles: role.preferredProfiles.map((ref) => ref.profileId),
      fallbackProfiles: role.fallbackProfiles.map((ref) => ref.profileId),
    }));
  const host =
    input.host.status === "ready"
      ? {
          status: "ready" as const,
          unverified: input.host.availabilityUnverified === true,
          profiles: input.host.profiles
            .map((profile) => ({
              id: profile.id,
              provider: profile.provider,
              model: profile.model ?? null,
              modeId: profile.modeId ?? null,
              thinkingOptionId: profile.thinkingOptionId ?? null,
              featureValues: profile.featureValues ?? null,
            }))
            .slice()
            .sort((left, right) => left.id.localeCompare(right.id)),
          availability: input.host.availability
            .map((row) => ({
              provider: row.provider,
              available: row.available,
              reason: row.reason ?? null,
            }))
            .slice()
            .sort((left, right) => left.provider.localeCompare(right.provider)),
        }
      : { status: "unavailable" as const, reason: input.host.reason ?? null };
  const allSeats =
    input.economy.allSeats === undefined
      ? null
      : input.economy.allSeats.status === "ready"
        ? {
            status: "ready" as const,
            version: input.economy.allSeats.version,
            profiles: input.economy.allSeats.profiles
              .map((entry) => ({
                profileId: entry.profileId,
                enabled: entry.enabled,
                family: entry.family,
                boundModel: entry.boundModel,
              }))
              .slice()
              .sort((left, right) => left.profileId.localeCompare(right.profileId)),
            routes: input.economy.allSeats.routes,
            executionTaskOrder: input.economy.allSeats.executionTaskOrder,
          }
        : {
            status: input.economy.allSeats.status,
            reason:
              input.economy.allSeats.status === "invalid" ? input.economy.allSeats.reason : null,
          };
  const economy = {
    pool: input.economy.pool
      .map((entry) => ({
        profileId: entry.profileId,
        enabled: entry.enabled,
        family: entry.family ?? null,
      }))
      .slice()
      .sort((left, right) => left.profileId.localeCompare(right.profileId)),
    taskOrder: input.economy.taskOrder,
    profileBudget: input.economy.profileBudget,
    allSeats,
  };
  const rows = input.rows.map((row) => ({
    rowKey: row.rowKey,
    seatId: row.seatId ?? null,
    logicalSeatId: row.logicalSeatId ?? null,
    kind: row.kind,
    roleId: row.roleId,
    enabled: row.enabled,
    source: row.source,
    budget: row.budget,
    budgetBasis: row.budgetBasis,
    availability: row.availability,
    route: row.route ?? null,
    profile:
      row.profile === null
        ? null
        : {
            id: row.profile.id,
            provider: row.profile.provider,
            model: row.profile.model ?? null,
            modeId: row.profile.modeId ?? null,
            thinkingOptionId: row.profile.thinkingOptionId ?? null,
          },
    issues: row.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      roleId: issue.roleId ?? null,
      seatId: issue.seatId ?? null,
      profileId: issue.profileId ?? null,
      params: Object.fromEntries(
        Object.entries(issue.params).sort(([left], [right]) => left.localeCompare(right)),
      ),
    })),
  }));
  return sha256(
    canonicalize({
      planning: {
        mode: input.team.mode ?? null,
        coordinatorRoleId: input.team.coordinatorRoleId,
        memberCreation: input.team.memberCreation ?? null,
        collaboration: input.team.collaboration ?? null,
        members: input.team.members.map((member) => ({
          roleId: member.roleId,
          seatId: member.seatId ?? null,
          instanceLabel: member.instanceLabel ?? null,
          enabled: member.enabled,
        })),
      },
      roles,
      host,
      economy,
      rows,
    }),
  );
}

/** A stored seatId repeated across members is a blocker; its rows still need unique keys. */
function hasDuplicateStoredSeatIds(members: TeamPlanningFields["members"]): boolean {
  const seen = new Set<string>();
  for (const member of members) {
    const seatId = member.seatId?.trim();
    if (!seatId) continue;
    if (seen.has(seatId)) return true;
    seen.add(seatId);
  }
  return false;
}

function planTeam(input: {
  key: string;
  team: TeamPlanningFields;
  rowKeys: readonly string[];
  snapshot: ReadySnapshot;
}): TeamPlanResult {
  const { key, team, rowKeys, snapshot } = input;
  const roles = snapshot.roles.roles;
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const modelPlan = buildTeamModelPlan({
    team,
    roles,
    host: snapshot.host,
    economy: snapshot.economy,
    maxMembers: snapshot.preferences.maxMembers,
    runtimeCapabilities: LAUNCH_RUNTIME_CAPABILITIES,
  });
  const logicalIds = logicalSeatIds(team.members);
  const logicalIndex = new Map<string, number>();
  for (const [index, logicalId] of logicalIds.entries()) {
    if (logicalId && !logicalIndex.has(logicalId)) logicalIndex.set(logicalId, index);
  }

  const uniqueKeys = hasDuplicateStoredSeatIds(team.members);
  const usedRowKeys = new Set<string>();
  function claimRowKey(base: string, memberIndex: number | undefined): string {
    if (!uniqueKeys) return base;
    if (!usedRowKeys.has(base)) {
      usedRowKeys.add(base);
      return base;
    }
    const fallback =
      memberIndex === undefined ? `member:${usedRowKeys.size}` : `member:${memberIndex}`;
    if (!usedRowKeys.has(fallback)) {
      usedRowKeys.add(fallback);
      return fallback;
    }
    let suffix = 2;
    let candidate = `${fallback}#${suffix}`;
    while (usedRowKeys.has(candidate)) {
      suffix += 1;
      candidate = `${fallback}#${suffix}`;
    }
    usedRowKeys.add(candidate);
    return candidate;
  }

  const seatsByMember = new Map<number, PlannedSeat[]>();
  const unassigned: PlannedSeat[] = [];
  for (const seat of modelPlan.seatPlan.seats) {
    const memberIndex = memberIndexForSeat(seat, logicalIndex);
    if (memberIndex === undefined) unassigned.push(seat);
    else {
      const group = seatsByMember.get(memberIndex) ?? [];
      group.push(seat);
      seatsByMember.set(memberIndex, group);
    }
  }

  const coordinatorBase = "coordinator";
  const rows: TeamPlanRow[] = [
    {
      ...coordinatorRow({
        team,
        role: team.coordinatorRoleId ? (roleById.get(team.coordinatorRoleId) ?? null) : null,
        modelPlan,
        host: snapshot.host,
      }),
      rowKey: claimRowKey(coordinatorBase, undefined),
    },
  ];
  for (const [index, member] of team.members.entries()) {
    const baseRowKey = rowKeys[index] ?? `member:${index}`;
    const role = roleById.get(member.roleId) ?? null;
    const group = seatsByMember.get(index) ?? [];
    if (group.length === 0) {
      rows.push(
        memberPlaceholderRow({
          rowKey: claimRowKey(baseRowKey, index),
          member,
          logicalSeatId: logicalIds[index] || undefined,
          role,
          host: snapshot.host,
          mode: modelPlan.effectiveMode,
          issues: issuesAttachedTo(modelPlan.issues, logicalIds[index] || undefined),
          enabled: member.enabled,
        }),
      );
      continue;
    }
    for (const seat of group) {
      // A duplicated stored seatId maps several physical seats to one member; each row still needs
      // its own key. Normal collaboration rows intentionally share the member key.
      rows.push(
        seatRow({
          rowKey: uniqueKeys ? claimRowKey(baseRowKey, index) : baseRowKey,
          seat,
          role,
          host: snapshot.host,
        }),
      );
    }
  }
  for (const seat of unassigned) {
    rows.push(
      seatRow({
        rowKey: claimRowKey(`seat:${seat.seatId}`, undefined),
        seat,
        role: roleById.get(seat.roleId) ?? null,
        host: snapshot.host,
      }),
    );
  }

  const enabledMembers = team.members.filter((member) => member.enabled).length;
  const eagerRunnable = modelPlan.seatPlan.seats.some(
    (seat) => seat.activation === "eager" && !seat.selected.unavailable,
  );
  const staleEscalationOnly =
    modelPlan.seatPlan.seats.length > 0 &&
    !eagerRunnable &&
    !LAUNCH_RUNTIME_CAPABILITIES.onDemand &&
    modelPlan.blockers.length === 0;
  const blocked =
    modelPlan.effectiveMode === null ||
    modelPlan.blockers.length > 0 ||
    modelPlan.coordinator.role === null ||
    modelPlan.coordinator.legacyFailureReason !== null ||
    enabledMembers === 0 ||
    staleEscalationOnly;

  if (rows.length > TEAM_PLAN_MAX_ROWS) {
    return {
      key,
      status: "blocked",
      effectiveMode: modelPlan.effectiveMode,
      ...(modelPlan.rawMode === undefined ? {} : { rawMode: modelPlan.rawMode }),
      selectionFingerprint: null,
      rows: [],
      issues: [
        ...modelPlan.issues,
        {
          code: "MODE_MEMBER_LIMIT",
          severity: "blocker",
          params: { members: rows.length, limit: TEAM_PLAN_MAX_ROWS },
        },
      ],
    };
  }

  return {
    key,
    status: blocked ? "blocked" : "ready",
    effectiveMode: modelPlan.effectiveMode,
    ...(modelPlan.rawMode === undefined ? {} : { rawMode: modelPlan.rawMode }),
    selectionFingerprint: fingerprint({
      team,
      roles,
      host: snapshot.host,
      economy: snapshot.economy,
      rows,
    }),
    rows,
    issues: [...modelPlan.issues],
  };
}

function savedRowKeys(team: TeamPlanningFields): string[] {
  // The row key comes from the stored member only (never from a derived seat id), and a disabled
  // member keeps the key it would have when enabled so the editor can bind the row. A duplicated
  // stored seatId (already a MODE_SEAT_DUPLICATE blocker) falls back to the unique member index;
  // otherwise two rows would share one client binding key.
  const seen = new Set<string>();
  return team.members.map((member, index) => {
    const seatId = member.seatId?.trim();
    if (!seatId || seen.has(seatId)) return `member:${index}`;
    seen.add(seatId);
    return `seat:${seatId}`;
  });
}

function profilesFingerprint(host: HostSnapshot): string {
  if (host.status !== "ready") return sha256(canonicalize({ status: "unavailable" }));
  return sha256(
    canonicalize({
      profiles: host.profiles
        .map((profile) => ({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          model: profile.model ?? null,
          modeId: profile.modeId ?? null,
          thinkingOptionId: profile.thinkingOptionId ?? null,
          featureValues: profile.featureValues ?? null,
        }))
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

function availabilityFingerprint(host: HostSnapshot): string {
  if (host.status !== "ready") {
    return sha256(canonicalize({ status: "unavailable", reason: host.reason ?? null }));
  }
  return sha256(
    canonicalize({
      unverified: host.availabilityUnverified === true,
      providers: host.availability
        .map((row) => ({
          provider: row.provider,
          available: row.available,
          reason: row.reason ?? null,
        }))
        .slice()
        .sort((left, right) => left.provider.localeCompare(right.provider)),
    }),
  );
}

function draftTeam(input: TeamPlanInput["items"][number]): TeamPlanningFields | null {
  if (input.kind !== "draft") return null;
  const { draft } = input;
  return {
    mode: draft.mode,
    coordinatorRoleId: draft.coordinatorRoleId ?? "",
    memberCreation: draft.memberCreation,
    collaboration: draft.collaboration,
    // A draft plans with the client's row identity as the seat identity. It never reaches storage
    // and makes every planned row bind back to exactly one draft row.
    members: draft.members.map((member) => ({
      roleId: member.roleId ?? "",
      enabled: member.enabled,
      seatId: member.rowKey,
      ...(member.instanceLabel === undefined ? {} : { instanceLabel: member.instanceLabel }),
    })),
  };
}

function unavailableResult(key: string, issues: readonly ModeIssue[]): TeamPlanResult {
  const attached = [...issues];
  if (attached.length === 0) attached.push(contextIssue("context-unavailable"));
  return {
    key,
    status: "unavailable",
    effectiveMode: null,
    selectionFingerprint: null,
    rows: [],
    issues: attached,
  };
}

export function createTeamPlanService(deps: {
  readers: PlanningReaders;
  now?: () => Date;
  log?: (message: string, detail?: unknown) => void;
}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, detail) => console.error(`[agent-team] ${message}`, detail));

  async function plan(input: TeamPlanInput, paseo: PaseoPort): Promise<TeamPlanOutput> {
    const checkedAt = now().toISOString();
    // The capability probe must stay read-free: no adapter, no settings, no host facts.
    if (input.items.length === 0) {
      return {
        schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
        capabilities: capabilities(),
        checkedAt,
        context: null,
        results: [],
      };
    }

    const adapter = createPaseoAdapter(paseo);
    const snapshot = await readPlanningSnapshot({ readers: deps.readers, adapter, log });
    if (snapshot.status === "unavailable") {
      return {
        schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
        capabilities: capabilities(),
        checkedAt,
        context: null,
        results: input.items.map((item) => unavailableResult(item.key, snapshot.issues)),
      };
    }

    const context: TeamPlanContext = {
      revisions: snapshot.revisions,
      profilesFingerprint: profilesFingerprint(snapshot.host),
      availabilityFingerprint: availabilityFingerprint(snapshot.host),
    };

    const results = input.items.map((item): TeamPlanResult => {
      try {
        if (item.kind === "saved") {
          const team = snapshot.teams.teams.find((entry) => entry.id === item.teamId);
          if (!team) {
            // Empty issues are the Team-missing signal; every other unavailable result carries one.
            return {
              key: item.key,
              status: "unavailable",
              effectiveMode: null,
              selectionFingerprint: null,
              rows: [],
              issues: [],
            };
          }
          return planTeam({
            key: item.key,
            team,
            rowKeys: savedRowKeys(team),
            snapshot,
          });
        }
        const team = draftTeam(item);
        if (!team) return unavailableResult(item.key, [contextIssue("item-failed")]);
        if (item.draft.members.some((member) => member.rowKey === "coordinator")) {
          return {
            key: item.key,
            status: "blocked",
            effectiveMode: null,
            selectionFingerprint: null,
            rows: [],
            issues: [
              {
                code: "MODE_SEAT_DUPLICATE",
                severity: "blocker",
                params: { reason: "row-key-reserved", rowKey: "coordinator" },
              },
            ],
          };
        }
        return planTeam({
          key: item.key,
          team,
          rowKeys: item.draft.members.map((member) => member.rowKey),
          snapshot,
        });
      } catch {
        log("team plan item failed", { key: item.key });
        return unavailableResult(item.key, [contextIssue("item-failed")]);
      }
    });

    return {
      schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
      capabilities: capabilities(),
      checkedAt,
      context,
      results,
    };
  }

  return { plan };
}
