import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import { teamLabels } from "../paseo/labels";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import type { TeamMode } from "../schemas/team-mode";
import { zh } from "../zh";
import { cheapIssueText } from "../zh/mode-plan";
import type { EconomyPolicy, HostSnapshot, ProfileSelection } from "./mode-resolver";
import { resolveProfile } from "./profile-resolver";
import {
  type CoordinatorRosterEntry,
  compileCoordinatorSystemPrompt,
  compileKickoffMessage,
  compileMemberSystemPrompt,
} from "./prompt-compiler";
import type { ModeIssue } from "./role-execution";
import type { PlannedSeat, RuntimeCapabilities, SeatBudgetCounts, SeatCounts } from "./seat-plan";
import { buildTeamModelPlan } from "./team-model-plan";
import { coordinatorToolsBlocker } from "./tools-readiness";

export type { RuntimeCapabilities } from "./seat-plan";
export { MAX_RUNTIME_MEMBERS } from "./seat-plan";

const EMPTY_ECONOMY_POLICY: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };

export type PlannedSource = "role-preferred" | "role-fallback" | "economy-pool";

export type PlannedAgent = {
  kind: "coordinator" | "member";
  /** Absent for the coordinator; every member carries the seat it materialized from. */
  seatId?: string;
  role: Role;
  instanceLabel?: string;
  profile: PaseoProfile;
  source: PlannedSource;
  title: string;
  labels: Record<string, string>;
  systemPrompt: string;
};

export type LaunchPlan = {
  runId: string;
  mode: TeamMode;
  team: Team;
  workspaceId: string;
  task: string;
  coordinator: PlannedAgent;
  members: PlannedAgent[];
  seats: PlannedSeat[];
  seatCounts: SeatCounts;
  seatBudget: SeatBudgetCounts;
  seatIssues: ModeIssue[];
  /** The same selection the coordinator was built from; preview uses it for the new mode. */
  coordinatorSelected?: ProfileSelection;
  kickoffMessage: string;
  warnings: string[];
  blockers: string[];
};

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd();
}

function memberTitle(role: Role, team: Team, instanceLabel?: string): string {
  const instance = instanceLabel ? ` (${instanceLabel})` : "";
  return truncate(`${role.name}${instance} · ${team.name}`, 60);
}

function coordinatorTitle(team: Team, task: string): string {
  return truncate(`${zh.teamTitlePrefix} ${team.name}: ${task.slice(0, 30)}`, 60);
}

function roleLabel(role: Role, instanceLabel?: string): string {
  return instanceLabel ? `${role.name} (${instanceLabel})` : role.name;
}

/** Every seat blocker becomes a readable launch blocker; unknown codes are never dropped. */
function seatBlockerText(
  entry: ModeIssue,
  roles: readonly Role[],
  seats: readonly PlannedSeat[],
): string {
  const role = entry.roleId ? roles.find((item) => item.id === entry.roleId) : undefined;
  const seat = entry.seatId ? seats.find((item) => item.seatId === entry.seatId) : undefined;
  const instanceLabel =
    typeof entry.params.instanceLabel === "string"
      ? entry.params.instanceLabel
      : seat?.instanceLabel;
  const label = role ? roleLabel(role, instanceLabel) : (entry.roleId ?? "");
  const reason = typeof entry.params.reason === "string" ? entry.params.reason : "";
  const field = typeof entry.params.field === "string" ? entry.params.field : "";
  const value = entry.params.value === undefined ? "" : String(entry.params.value);

  switch (entry.code) {
    case "MODE_CHEAP_POLICY_REQUIRED":
    case "MODE_CHEAP_PROFILE_INVALID":
    case "MODE_CHEAP_ROUTE_UNAVAILABLE":
      return cheapIssueText(entry);
    case "MODE_MEMBER_LIMIT":
      return zh.exceedMax(Number(entry.params.members), Number(entry.params.limit));
    case "MODE_SEAT_DUPLICATE":
      if (typeof entry.params.instanceLabel === "string") {
        return zh.idUsed(zh.instanceLabel, entry.params.instanceLabel);
      }
      if (reason === "instance-label-required") return zh.duplicateNeedsLabel;
      return zh.idUsed(zh.member, String(entry.params.seatId ?? ""));
    case "MODE_PROFILE_UNRESOLVED":
      if (reason === "role-missing") return zh.memberMissing(entry.roleId ?? "");
      return zh.memberProfileFail(label, reason);
    case "MODE_ROLE_DISABLED":
      return zh.modes.roleDisabled(label);
    case "MODE_CONTEXT_UNAVAILABLE":
      return zh.modes.contextUnavailable;
    case "MODE_UNKNOWN": {
      const detail = [field, value].filter(Boolean).join("=");
      return zh.modes.unknown(detail);
    }
    case "MODE_ROLE_POLICY_UNKNOWN":
      return zh.modes.rolePolicyUnknown(label);
    case "MODE_ESCALATION_INVALID":
      return zh.modes.escalationInvalid(label, reason);
    case "MODE_ESCALATION_UNAVAILABLE":
      return zh.modes.escalationUnavailable(label, reason);
    case "MODE_JUDGE_REQUIRED":
      return zh.modes.judgeRequired(reason);
    case "MODE_ONDEMAND_UNAVAILABLE":
      return zh.modes.onDemandUnavailable;
    default:
      return zh.modes.unknownFallback(entry.code);
  }
}

function warningLabel(entry: ModeIssue, seats: readonly PlannedSeat[]): string {
  const seat = entry.seatId
    ? seats.find((item) => item.seatId === entry.seatId || item.logicalSeatId === entry.seatId)
    : undefined;
  const instanceLabel =
    typeof entry.params.instanceLabel === "string"
      ? entry.params.instanceLabel
      : seat?.instanceLabel;
  const name = seat?.roleName ?? entry.roleId ?? "";
  return instanceLabel ? `${name} (${instanceLabel})` : name;
}

/** One warning-level issue becomes a warning sentence; the preview and start share this mapping. */
export function warningIssueText(entry: ModeIssue, seats: readonly PlannedSeat[]): string {
  const label = warningLabel(entry, seats);
  const reason = typeof entry.params.reason === "string" ? entry.params.reason : "";
  const field = typeof entry.params.field === "string" ? entry.params.field : "";
  const value = entry.params.value === undefined ? "" : String(entry.params.value);
  const profileId = typeof entry.params.profileId === "string" ? entry.params.profileId : "";
  const requested = Number(entry.params.requested);
  const families = Number(entry.params.families);
  const provider = typeof entry.params.provider === "string" ? entry.params.provider : undefined;

  switch (entry.code) {
    case "MODE_CHEAP_POLICY_REQUIRED":
    case "MODE_CHEAP_PROFILE_INVALID":
    case "MODE_CHEAP_ROUTE_UNAVAILABLE":
      return cheapIssueText(entry);
    case "MODE_MEMBER_LIMIT":
      return zh.exceedMax(Number(entry.params.members), Number(entry.params.limit));
    case "MODE_SEAT_DUPLICATE":
      if (typeof entry.params.instanceLabel === "string") {
        return zh.modes.duplicateLabelWarning(entry.params.instanceLabel);
      }
      return zh.modes.duplicateLabelWarning(label);
    case "MODE_PROFILE_UNRESOLVED":
      return reason === "role-missing"
        ? zh.memberMissing(entry.roleId ?? "")
        : zh.memberProfileFail(label, reason);
    case "MODE_ROLE_DISABLED":
      return zh.modes.roleDisabledWarning(label);
    case "MODE_CONTEXT_UNAVAILABLE":
      return reason === "availability-unverified"
        ? zh.modes.availabilityUnverified
        : zh.modes.contextUnavailable;
    case "MODE_UNKNOWN":
      return zh.modes.unknown([field, value].filter(Boolean).join("="));
    case "MODE_ROLE_POLICY_UNKNOWN":
      return zh.modes.rolePolicyWarning(label);
    case "MODE_ESCALATION_INVALID":
      return zh.modes.escalationInvalid(label, reason);
    case "MODE_ESCALATION_UNAVAILABLE":
      return zh.modes.escalationUnavailable(label, reason);
    case "MODE_JUDGE_REQUIRED":
      return zh.modes.judgeRequired(reason);
    case "MODE_ONDEMAND_FALLBACK_EAGER":
      return zh.modes.onDemandFallbackEager;
    case "MODE_ONDEMAND_UNAVAILABLE":
      return zh.modes.onDemandUnavailable;
    case "MODE_POOL_EMPTY":
      return zh.modes.poolEmpty;
    case "MODE_POOL_UNAVAILABLE":
      return zh.modes.poolUnavailable(provider);
    case "MODE_POOL_ENTRY_MISSING":
      return zh.modes.poolEntryMissing(profileId || label);
    case "MODE_POOL_CONFIG_INVALID":
      return zh.modes.poolConfigInvalid(field);
    case "MODE_POOL_DUPLICATE":
      return zh.modes.poolDuplicate(profileId || label);
    case "MODE_POOL_ORDER_IGNORED":
      return zh.modes.poolOrderIgnored(profileId || label);
    case "MODE_FAMILY_MISSING":
      return zh.modes.familyMissing(profileId || label);
    case "MODE_FAMILIES_REDUCED":
      return zh.modes.familiesReduced(requested, families);
    case "MODE_COLLAB_UNAVAILABLE":
      return zh.modes.collaborationUnavailable;
    case "MODE_NO_EXECUTION_COHORT":
      return zh.modes.noExecutionCohort;
    case "MODE_LIMIT_CLAMPED":
      return zh.modes.limitClamped(Number(entry.params.limit));
    default:
      return zh.modes.unknownFallback(entry.code);
  }
}

export function buildLaunchPlan(input: {
  team: Team | undefined;
  roles: readonly Role[];
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  workspaceId: string;
  task: string;
  runId: string;
  maxMembers: number;
  /** Launch-time mode override; otherwise the Team's stored mode (default sota). */
  mode?: TeamMode;
  /** Host snapshot for mode planning. Falls back to a ready snapshot from profiles/availability. */
  host?: HostSnapshot;
  /** Host economy pool. Empty by default, so non-SOTA modes fall back to original bindings. */
  economy?: EconomyPolicy;
  /** Runtime capability flags; absent means this version supports no deferred or collaborative work. */
  runtimeCapabilities?: RuntimeCapabilities;
  /** Raw daemon config, used to confirm the coordinator can reach Paseo's delegation tools. */
  daemonConfig?: unknown;
}): LaunchPlan {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const task = input.task.trim();
  if (!task) blockers.push(zh.taskRequired);

  const emptyCoordinator = {
    kind: "coordinator" as const,
    role: {
      id: "missing",
      name: zh.missing,
      mission: "missing",
      responsibilities: ["missing"],
      restrictions: [],
      systemPrompt: "missing",
      outputContract: [],
      preferredProfiles: [{ profileId: "missing" }],
      fallbackProfiles: [],
      enabled: false,
      createdAt: "",
      updatedAt: "",
    } satisfies Role,
    profile: { id: "missing", name: zh.missing, provider: "missing" },
    source: "role-preferred" as const,
    title: zh.missing,
    labels: {},
    systemPrompt: "",
  };

  if (!input.team) {
    blockers.push(zh.teamDoesNotExist);
    return {
      runId: input.runId,
      mode: "sota",
      team: {
        id: "missing",
        name: zh.missing,
        coordinatorRoleId: "missing",
        members: [{ roleId: "missing", enabled: true }],
        enabled: false,
        createdAt: "",
        updatedAt: "",
      },
      workspaceId: input.workspaceId,
      task,
      coordinator: emptyCoordinator,
      members: [],
      seats: [],
      seatCounts: {
        logical: 0,
        physical: 0,
        eager: 0,
        deferred: 0,
        escalation: 0,
        sotaPotential: 0,
      },
      seatBudget: { economy: 0, sota: 0, unknown: 0, deferredSota: 0 },
      seatIssues: [],
      kickoffMessage: "",
      warnings,
      blockers,
    };
  }

  const team = input.team;
  const roleById = new Map(input.roles.map((role) => [role.id, role]));
  const capabilities = input.runtimeCapabilities ?? {
    onDemand: false,
    expansion: false,
    collaboration: false,
  };
  const host = input.host ?? {
    status: "ready" as const,
    profiles: input.profiles,
    availability: input.availability,
  };
  const hostProfiles = host.status === "ready" ? host.profiles : input.profiles;
  const hostAvailability = host.status === "ready" ? host.availability : input.availability;
  const modelPlan = buildTeamModelPlan({
    team,
    roles: input.roles,
    host,
    economy: input.economy ?? EMPTY_ECONOMY_POLICY,
    maxMembers: input.maxMembers,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    runtimeCapabilities: capabilities,
  });
  const seatPlan = modelPlan.seatPlan;
  for (const entry of seatPlan.blockers) {
    if (
      entry.code === "MODE_ONDEMAND_UNAVAILABLE" &&
      seatPlan.mode === "collaborative" &&
      !capabilities.collaboration
    ) {
      // The collaboration capability blocker below explains the same situation; keep one copy.
      continue;
    }
    blockers.push(seatBlockerText(entry, input.roles, seatPlan.seats));
  }
  for (const entry of seatPlan.issues) {
    if (entry.severity !== "warning") continue;
    warnings.push(warningIssueText(entry, seatPlan.seats));
  }
  if (seatPlan.mode === "collaborative" && !capabilities.collaboration) {
    blockers.push(zh.modes.collaborationRuntimeUnavailable);
  }

  let enabledCount = 0;
  for (const member of team.members) {
    const role = roleById.get(member.roleId);
    if (!member.enabled) {
      if (role) warnings.push(zh.skippingDisabled(roleLabel(role, member.instanceLabel)));
      continue;
    }
    enabledCount += 1;
  }
  if (enabledCount === 0) blockers.push(zh.noEnabledMembers);

  const coordinatorRole = roleById.get(team.coordinatorRoleId);
  if (!coordinatorRole) {
    blockers.push(zh.coordinatorMissing(team.coordinatorRoleId));
  }

  let coordinator: PlannedAgent = emptyCoordinator;
  let coordinatorSelected: ProfileSelection | undefined;
  if (coordinatorRole) {
    const selection = modelPlan.coordinator.selection;
    if (selection) {
      warnings.push(...modelPlan.coordinator.warnings);
      coordinatorSelected = selection;
      const title = coordinatorTitle(team, task);
      coordinator = {
        kind: "coordinator",
        role: coordinatorRole,
        profile: selection.profile,
        source: selection.source,
        title,
        labels: teamLabels({
          runId: input.runId,
          teamId: team.id,
          teamName: team.name,
          roleId: coordinatorRole.id,
          roleName: coordinatorRole.name,
          kind: "coordinator",
          task,
        }),
        systemPrompt: compileCoordinatorSystemPrompt({
          role: coordinatorRole,
          team,
          escalationAvailable: capabilities.expansion,
          ...(seatPlan.seats.length === 0 ||
          (seatPlan.mode === "sota" && seatPlan.seats.every((seat) => seat.activation === "eager"))
            ? {}
            : {
                roster: seatPlan.seats.reduce<CoordinatorRosterEntry[]>((rows, seat) => {
                  const role = roleById.get(seat.roleId);
                  if (!role) return rows;
                  rows.push({
                    seatId: seat.seatId,
                    role,
                    instanceLabel: seat.instanceLabel,
                    profile: seat.selected.unavailable
                      ? null
                      : {
                          name: seat.selected.profile.name,
                          provider: seat.selected.profile.provider,
                          model: seat.selected.profile.model,
                        },
                    activation: seat.activation,
                  });
                  return rows;
                }, []),
              }),
        }),
      };
      const toolsBlocker = coordinatorToolsBlocker(input.daemonConfig, selection.profile.provider);
      if (toolsBlocker) blockers.push(toolsBlocker);
    } else if (modelPlan.coordinator.legacyFailureReason !== null) {
      blockers.push(zh.coordinatorProfileFail(modelPlan.coordinator.legacyFailureReason));
    } else {
      for (const entry of modelPlan.coordinator.issues) {
        blockers.push(seatBlockerText(entry, input.roles, seatPlan.seats));
      }
    }
  }

  const members: PlannedAgent[] = [];
  // Preview fidelity: materialize eager seats even when the plan is blocked. Launch safety stays
  // with launch-service, which rejects every plan with a non-empty blocker list before creating.
  for (const seat of seatPlan.seats) {
    if (seat.activation !== "eager" || seat.selected.unavailable) continue;
    const role = roleById.get(seat.roleId);
    if (!role) continue;
    members.push({
      kind: "member",
      seatId: seat.seatId,
      role,
      ...(seat.instanceLabel === undefined ? {} : { instanceLabel: seat.instanceLabel }),
      profile: seat.selected.profile,
      source: seat.selected.source,
      title: memberTitle(role, team, seat.instanceLabel),
      labels: teamLabels({
        runId: input.runId,
        teamId: team.id,
        teamName: team.name,
        roleId: role.id,
        roleName: role.name,
        kind: "member",
        instanceLabel: seat.instanceLabel,
      }),
      systemPrompt: compileMemberSystemPrompt({
        role,
        teamName: team.name,
        coordinatorTitle: coordinator.title,
        instanceLabel: seat.instanceLabel,
      }),
    });
  }

  // Restore the legacy per-Role Profile warnings (missing/unavailable/fallback) for seats that
  // actually use the original binding; economy-pool seats never consulted it.
  for (const seat of seatPlan.seats) {
    if (seat.selected.unavailable || seat.selected.source === "economy-pool") continue;
    const role = roleById.get(seat.roleId);
    if (!role) continue;
    const resolved = resolveProfile(role, hostProfiles, hostAvailability);
    if (resolved.ok) warnings.push(...resolved.warnings);
  }

  if (
    seatPlan.seats.length > 0 &&
    members.length === 0 &&
    !capabilities.onDemand &&
    seatPlan.blockers.length === 0
  ) {
    blockers.push(zh.modes.staleEscalationOnly);
  }

  const kickoffMessage = compileKickoffMessage({
    task,
    runId: input.runId,
    roster: [
      {
        agentId: "(coordinator)",
        role: coordinator.role,
        profile: coordinator.profile,
      },
      ...members.map((member) => ({
        agentId: "(pending)",
        role: member.role,
        instanceLabel: member.instanceLabel,
        profile: member.profile,
      })),
    ],
  });

  return {
    runId: input.runId,
    mode: seatPlan.mode,
    team,
    workspaceId: input.workspaceId,
    task,
    coordinator,
    members,
    seats: seatPlan.seats,
    seatCounts: seatPlan.counts,
    seatBudget: seatPlan.budget,
    seatIssues: [...modelPlan.issues],
    ...(coordinatorSelected === undefined ? {} : { coordinatorSelected }),
    kickoffMessage,
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
  };
}
