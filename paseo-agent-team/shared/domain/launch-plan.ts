import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";
import { teamLabels } from "../paseo/labels";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import { zh } from "../zh";
import type { HostSnapshot } from "./mode-resolver";
import { resolveProfile } from "./profile-resolver";
import {
  type CoordinatorRosterEntry,
  compileCoordinatorSystemPrompt,
  compileKickoffMessage,
  compileMemberSystemPrompt,
} from "./prompt-compiler";
import type { ModeIssue } from "./role-execution";
import { engineLaunchGate, resolveTeamRunEngine } from "./run-engine/team-config";
import type { PlannedSeat, RuntimeCapabilities, SeatBudgetCounts, SeatCounts } from "./seat-plan";
import { buildTeamModelPlan } from "./team-model-plan";
import { coordinatorToolsBlocker } from "./tools-readiness";

export type { RuntimeCapabilities } from "./seat-plan";
export { MAX_RUNTIME_MEMBERS } from "./seat-plan";

export type PlannedSource = "role-preferred" | "role-fallback";

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
  /** Always "sota": the DTOs keep a `mode` field, but there is one planning path. */
  mode: "sota";
  team: Team;
  workspaceId: string;
  task: string;
  coordinator: PlannedAgent;
  members: PlannedAgent[];
  seats: PlannedSeat[];
  seatCounts: SeatCounts;
  seatBudget: SeatBudgetCounts;
  seatIssues: ModeIssue[];
  kickoffMessage: string;
  warnings: string[];
  blockers: string[];
};

/**
 * The host splits `provider/model` on the FIRST slash and keeps the rest as the model, so a
 * Profile whose `model` already starts with its own provider ends up with a model such as
 * `codex/gpt-6.1-sol`. Slashes in a model are legitimate (gateway ids), so this only warns.
 */
export function modelRepeatsProvider(profile: Pick<PaseoProfile, "provider" | "model">): boolean {
  const provider = profile.provider.trim().toLowerCase();
  return (
    provider.length > 0 && (profile.model ?? "").trim().toLowerCase().startsWith(`${provider}/`)
  );
}

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

  switch (entry.code) {
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
    case "MODE_ONDEMAND_UNAVAILABLE":
      return zh.modes.onDemandUnavailable;
    case "MODE_LIMIT_CLAMPED":
      return zh.modes.limitClamped(Number(entry.params.limit));
    case "MODE_REVIEW_FAMILY_SAME":
      return zh.modes.reviewFamilySame(String(entry.params.family ?? ""));
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
  /** Host snapshot for planning. Falls back to a ready snapshot from profiles/availability. */
  host?: HostSnapshot;
  /** Runtime capability flags; absent means this version supports no deferred work. */
  runtimeCapabilities?: RuntimeCapabilities;
  /** Whether this build can execute an Engine Run. Absent = no, so enabled Teams are refused. */
  runEngineSupported?: boolean;
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
    maxMembers: input.maxMembers,
    runtimeCapabilities: capabilities,
  });
  const seatPlan = modelPlan.seatPlan;
  for (const entry of seatPlan.blockers) {
    blockers.push(seatBlockerText(entry, input.roles, seatPlan.seats));
  }
  for (const entry of modelPlan.issues) {
    if (entry.severity !== "warning") continue;
    warnings.push(warningIssueText(entry, seatPlan.seats));
  }

  // One warning per Profile, however many seats use it. Never a blocker.
  const prefixWarned = new Set<string>();
  const selectedProfiles = [
    ...(modelPlan.coordinator.selection ? [modelPlan.coordinator.selection.profile] : []),
    ...seatPlan.seats.map((seat) => seat.selected.profile),
  ];
  for (const profile of selectedProfiles) {
    if (prefixWarned.has(profile.id) || !modelRepeatsProvider(profile)) continue;
    prefixWarned.add(profile.id);
    warnings.push(zh.profileModelPrefixed(profile.name, profile.provider, profile.model ?? ""));
  }

  // An enabled-but-unusable Run Engine block never falls back to the coordinator chain.
  const engineGate = engineLaunchGate({
    resolution: resolveTeamRunEngine(team),
    logicalSeatIds: seatPlan.seats.map((seat) => seat.logicalSeatId),
    engineSupported: input.runEngineSupported === true,
  });
  blockers.push(...engineGate.blockers);
  warnings.push(...engineGate.warnings);

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
  if (coordinatorRole) {
    const selection = modelPlan.coordinator.selection;
    if (selection) {
      warnings.push(...modelPlan.coordinator.warnings);
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
          seatPlan.seats.every((seat) => seat.activation === "eager")
            ? {}
            : {
                roster: seatPlan.seats.reduce<CoordinatorRosterEntry[]>((rows, seat) => {
                  const role = roleById.get(seat.roleId);
                  if (!role) return rows;
                  rows.push({
                    seatId: seat.seatId,
                    role,
                    instanceLabel: seat.instanceLabel,
                    profile: {
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
    }
  }

  const members: PlannedAgent[] = [];
  // Preview fidelity: materialize eager seats even when the plan is blocked. Launch safety stays
  // with launch-service, which rejects every plan with a non-empty blocker list before creating.
  for (const seat of seatPlan.seats) {
    if (seat.activation !== "eager") continue;
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

  // Per-Role Profile warnings (missing / provider unavailable / fallback in use) for every seat.
  for (const seat of seatPlan.seats) {
    const role = roleById.get(seat.roleId);
    if (!role) continue;
    const resolved = resolveProfile(role, hostProfiles, hostAvailability);
    if (resolved.ok) warnings.push(...resolved.warnings);
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
    mode: "sota",
    team,
    workspaceId: input.workspaceId,
    task,
    coordinator,
    members,
    seats: seatPlan.seats,
    seatCounts: seatPlan.counts,
    seatBudget: seatPlan.budget,
    seatIssues: [...modelPlan.issues],
    kickoffMessage,
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
  };
}
