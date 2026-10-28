import {
  type AllSeatsRoute,
  type CheapInvalidReason,
  evaluateCheapCandidate,
  orderedRouteIds,
} from "../../shared/domain/cheap-routing";
import {
  type DesignRoleLaunchTables,
  type DesignRoleLaunchVerdict,
  finalizeDesignIssues,
} from "../../shared/domain/design-validation";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
  resolveCoordinatorProfile,
  resolveModeProfile,
  selectCollaborationProfiles,
} from "../../shared/domain/mode-resolver";
import { resolveProfile } from "../../shared/domain/profile-resolver";
import { type ModeIssue, resolveRoleExecution } from "../../shared/domain/role-execution";
import type { ProviderAvailability } from "../../shared/paseo/adapter";
import { asRecord, type PaseoProfile, profilesFromConfig } from "../../shared/paseo/adapter";
import type { DesignAdapter, DesignWorkspaceSummary } from "../../shared/paseo/design-port";
import type { DesignBaseRevisions, DesignIssue, DesignJob } from "../../shared/schemas/design";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import type { TaskKind, TeamMode } from "../../shared/schemas/team-mode";
import type { RolesDocument, TeamsDocument } from "../../shared/settings";

const EMPTY_ECONOMY: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };
const MAX_UNAVAILABLE_PROFILE_IDS = 5;
const ROUTE_ORDER: readonly AllSeatsRoute[] = [
  "coordinator",
  "decision",
  "execution",
  "escalation",
  "retain",
];
const ROUTE_TASK_KINDS: readonly TaskKind[] = [
  "coding",
  "testing",
  "acceptance",
  "codebase",
  "ops",
  "general",
];

export type RoleLaunchability = {
  launchable: boolean;
  unavailableProfileIds: readonly string[];
};

/** One route candidate exactly as the planner judges it. */
export type DesignRouteCandidate = {
  profileId: string;
  family: string | null;
  eligible: boolean;
  reason?: CheapInvalidReason;
  /**
   * True when the planner reports this rejection as an issue. A candidate outside the allowlist
   * is only counted, so it must not be surfaced as a Role verdict.
   */
  reported: boolean;
};

export type DesignRouteRow = {
  route: AllSeatsRoute;
  /** Execution rows vary by task kind; every other route keeps one row. */
  taskKind: TaskKind | null;
  candidates: readonly DesignRouteCandidate[];
};

/** The economy-all route view; the prompt summary and the gap check both read this one table. */
export type DesignModeRouting =
  | { status: "ready"; routes: readonly DesignRouteRow[] }
  | { status: "absent" }
  | { status: "invalid"; reason: string };

/**
 * Enumerates the all-seats routes once per context read. This is presentation and gap evidence
 * only: it mirrors `resolveCheapSeat`'s single pass and never selects a seat, so launched plans
 * still come from D02 alone.
 */
export function describeModeRouting(input: {
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  economy: EconomyPolicy;
}): DesignModeRouting {
  const policy = input.economy.allSeats;
  if (policy === undefined || policy.status === "absent") return { status: "absent" };
  if (policy.status === "invalid") return { status: "invalid", reason: policy.reason };
  const order = { routes: policy.routes, executionTaskOrder: policy.executionTaskOrder };
  const live = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const entries = new Map(policy.profiles.map((entry) => [entry.profileId, entry]));
  const routes: DesignRouteRow[] = [];
  for (const route of ROUTE_ORDER) {
    for (const taskKind of route === "execution" ? ROUTE_TASK_KINDS : [null]) {
      const ids = orderedRouteIds(order, route, taskKind ?? undefined);
      const candidates = ids.map((profileId): DesignRouteCandidate => {
        const entry = entries.get(profileId);
        if (entry === undefined) {
          return {
            profileId,
            family: null,
            eligible: false,
            reason: "outside-list",
            reported: false,
          };
        }
        const profile = live.get(profileId);
        if (profile === undefined) {
          return {
            profileId,
            family: entry.family,
            eligible: false,
            reason: "missing",
            reported: true,
          };
        }
        const budget = input.economy.profileBudget[profileId];
        const check = evaluateCheapCandidate({
          entry,
          live: profile,
          route,
          ...(budget === undefined ? {} : { profileBudget: budget }),
          availability: input.availability,
        });
        return check.ok
          ? { profileId, family: check.family, eligible: true, reported: false }
          : {
              profileId,
              family: entry.family,
              eligible: false,
              reason: check.reason,
              reported: true,
            };
      });
      routes.push({ route, taskKind, candidates });
    }
  }
  return { status: "ready", routes };
}

/** The economy-all verdict: ids and reasons come from the planner's own issues. */
function cheapVerdict(issues: readonly ModeIssue[], launchable: boolean): DesignRoleLaunchVerdict {
  if (launchable) {
    return { launchable: true, unavailableProfileIds: [], verified: true };
  }
  const failed: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "MODE_CHEAP_PROFILE_INVALID") continue;
    const profileId = issue.profileId;
    if (typeof profileId !== "string" || failed.includes(profileId)) continue;
    if (failed.length >= MAX_UNAVAILABLE_PROFILE_IDS) break;
    failed.push(profileId);
  }
  const policyRequired = issues.some((issue) => issue.code === "MODE_CHEAP_POLICY_REQUIRED");
  const routeFailure = issues.find((issue) => issue.code === "MODE_CHEAP_ROUTE_UNAVAILABLE");
  const routeUnproven =
    routeFailure !== undefined &&
    (Number(routeFailure.params.candidates ?? 0) === 0 ||
      Number(routeFailure.params.unverified ?? 0) > 0);
  return { launchable, unavailableProfileIds: failed, verified: !policyRequired && !routeUnproven };
}

/** Legacy member verdict, unchanged from T2 so v1 text and old hosts behave exactly as before. */
function legacyMemberLaunchable(
  role: Role,
  mode: TeamMode,
  host: HostSnapshot,
  economy: EconomyPolicy,
): boolean {
  // Match the planner: old SOTA teams keep launching disabled Roles with a warning and ignore
  // an explicit tier. Collaborative execution seats use the same cohort/fallback path.
  const roleForPlan = mode === "sota" && !role.enabled ? { ...role, enabled: true } : role;
  const roleForResolution =
    mode === "sota" ? { ...roleForPlan, executionPolicy: undefined } : roleForPlan;
  const execution = resolveRoleExecution(roleForResolution, "member");
  if (mode === "collaborative" && execution.ok && execution.value.tier === "execution") {
    const cohort = selectCollaborationProfiles({
      role: roleForPlan,
      host,
      economy,
      requestedReplicas: 2,
    });
    return cohort.ok && cohort.value.selections.length > 0;
  }
  const resolved = resolveModeProfile({
    mode,
    role: roleForResolution,
    kind: "member",
    host,
    economy,
  });
  return resolved.ok && !resolved.value.unavailable;
}

/** The legacy binding verdict: the same resolver the planner uses for original bindings. */
function unavailableBindingIds(
  role: Role,
  profiles: readonly PaseoProfile[],
  availability: readonly ProviderAvailability[],
): string[] {
  const unavailable = new Set<string>();
  for (const ref of [...role.preferredProfiles, ...role.fallbackProfiles]) {
    if (unavailable.size >= MAX_UNAVAILABLE_PROFILE_IDS) break;
    const single: Role = { ...role, preferredProfiles: [ref], fallbackProfiles: [] };
    if (!resolveProfile(single, profiles, availability).ok) unavailable.add(ref.profileId);
  }
  return [...unavailable];
}

/**
 * A verdict is verified when every candidate that exists has an availability row. A missing
 * Profile is a definite fact; a missing availability row means the host cannot be checked at all.
 */
function bindingsVerified(
  role: Role,
  profiles: readonly PaseoProfile[],
  availability: readonly ProviderAvailability[],
): boolean {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const providers = new Set<string>();
  for (const ref of [...role.preferredProfiles, ...role.fallbackProfiles]) {
    const profile = byId.get(ref.profileId);
    if (profile !== undefined) providers.add(profile.provider);
  }
  return [...providers].every((provider) => availability.some((row) => row.provider === provider));
}

/**
 * Per-Role, per-use host capability. `member` and `coordinator` never infer one from the other:
 * a Role can launch as a member and fail as coordinator. The member projection stays exactly the
 * old shape for the prompt (04 §4.3), while both tables carry `verified` for gap validation.
 */
export function computeRoleLaunchability(input: {
  mode: TeamMode;
  roles: readonly Role[];
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  economy: EconomyPolicy;
}): DesignRoleLaunchTables {
  const host: HostSnapshot = {
    status: "ready",
    profiles: input.profiles,
    availability: input.availability,
  };
  const member: Record<string, DesignRoleLaunchVerdict> = {};
  const coordinator: Record<string, DesignRoleLaunchVerdict> = {};
  for (const role of input.roles) {
    const resolvedCoordinator = resolveCoordinatorProfile({
      mode: input.mode,
      role,
      host,
      economy: input.economy,
    });
    if (input.mode === "economy-all") {
      const resolvedMember = resolveModeProfile({
        mode: input.mode,
        role,
        kind: "member",
        host,
        economy: input.economy,
      });
      const memberIssues = resolvedMember.ok
        ? [...(resolvedMember.issues ?? []), ...resolvedMember.value.issues]
        : resolvedMember.issues;
      const memberLaunchable = resolvedMember.ok && !resolvedMember.value.unavailable;
      member[role.id] = cheapVerdict(memberIssues, memberLaunchable);
      coordinator[role.id] = resolvedCoordinator.ok
        ? cheapVerdict([], true)
        : cheapVerdict(resolvedCoordinator.issues, false);
      continue;
    }
    const unavailableProfileIds = unavailableBindingIds(role, input.profiles, input.availability);
    const verified = bindingsVerified(role, input.profiles, input.availability);
    member[role.id] = {
      launchable: legacyMemberLaunchable(role, input.mode, host, input.economy),
      unavailableProfileIds,
      verified,
    };
    coordinator[role.id] = {
      launchable: resolvedCoordinator.ok,
      unavailableProfileIds,
      verified,
    };
  }
  return { member, coordinator };
}

export type DesignContextCapabilities = {
  onDemand: boolean;
  expansion: boolean;
  collaboration: boolean;
};

export type DesignContextJob = Pick<
  DesignJob,
  "jobId" | "mode" | "carrierWorkspaceId" | "targetWorkspaceId"
>;

export type DesignSettingsSnapshot<T> =
  | { status: "ready"; revision: string; values: T }
  | { status: "invalid"; revision: string; error: string };

export type DesignSettingsReader<T> = {
  read(): Promise<DesignSettingsSnapshot<T>>;
};

export type DesignSettingsReaders = {
  roles: DesignSettingsReader<RolesDocument>;
  teams: DesignSettingsReader<TeamsDocument>;
  preferences: DesignSettingsReader<Preferences>;
};

export type DesignContextSnapshot = {
  jobId: string;
  mode: TeamMode;
  roles: readonly Role[];
  teams: readonly Team[];
  preferences: Preferences;
  revisions: DesignBaseRevisions;
  profiles: readonly PaseoProfile[];
  availability: readonly ProviderAvailability[];
  /**
   * Legacy member projection (04 §4.3), the same object as `roleLaunchTables.member`.
   * @deprecated The service reads `roleLaunchTables`; this stays only because C02's tests still
   * assert on it. Remove it together with those assertions.
   */
  roleLaunch: Readonly<Record<string, RoleLaunchability>>;
  /** Per-use verdicts injected into gap validation; never inferred across uses. */
  roleLaunchTables: DesignRoleLaunchTables;
  /** The economy-all route view; absent for the legacy modes. */
  modeRouting?: DesignModeRouting;
  daemonConfig: unknown;
  carrierWorkspace: DesignWorkspaceSummary;
  targetWorkspace: DesignWorkspaceSummary | null;
  carrierWorkspaceId: string;
  targetWorkspaceId: string | null;
  capabilities: DesignContextCapabilities;
};

export type ContextResult =
  | { ok: true; context: DesignContextSnapshot }
  | { ok: false; issues: DesignIssue[]; issuesTruncated: number };

type WorkspaceRead =
  | { kind: "ok"; workspace: DesignWorkspaceSummary }
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "unreadable" };

const CARRIER_PAGE_LIMIT = 50;
const CARRIER_MAX_PAGES = 5;

type CarrierRead =
  | { kind: "ok"; workspace: DesignWorkspaceSummary }
  | { kind: "none"; reason?: "target-is-only-workspace" }
  | {
      kind: "unavailable";
      reason: "missing" | "unreadable" | "internal" | "archiving";
      workspaceId: string | null;
    };

function configProfiles(config: unknown): PaseoProfile[] | null {
  const root = asRecord(config);
  if (!root || !Array.isArray(root.agentProfiles)) return null;
  return profilesFromConfig(config);
}

function issue(
  code: DesignIssue["code"],
  path: DesignIssue["path"],
  params: DesignIssue["params"],
  action: DesignIssue["action"],
): DesignIssue {
  return { code, severity: "error", path, params, action };
}

async function readWorkspace(adapter: DesignAdapter, workspaceId: string): Promise<WorkspaceRead> {
  try {
    const workspace = await adapter.getDesignWorkspace(workspaceId);
    return workspace ? { kind: "ok", workspace } : { kind: "missing" };
  } catch {
    return { kind: "unreadable" };
  }
}

function workspaceUnavailable(
  slot: "carrier" | "target",
  workspaceId: string | null,
  reason: "missing" | "unreadable" | "internal" | "archiving",
): DesignIssue {
  const params: DesignIssue["params"] = { reason };
  if (workspaceId) params.workspaceId = workspaceId;
  return issue("DESIGN_WORKSPACE_UNAVAILABLE", [slot], params, "choose-workspace");
}

function unavailableReason(workspace: DesignWorkspaceSummary): "internal" | "archiving" | null {
  if (workspace.internal) return "internal";
  if (workspace.archivingAt !== null) return "archiving";
  return null;
}

/**
 * Uses the requested carrier, or refreshes recent workspaces until one is usable. The list is
 * bounded; unavailable entries are skipped, while an unreadable list is reported explicitly.
 */
async function selectCarrier(
  adapter: DesignAdapter,
  carrierId: string | null,
  excludeId: string | null,
): Promise<CarrierRead> {
  if (carrierId) {
    const read = await readWorkspace(adapter, carrierId);
    if (read.kind === "ok") {
      const reason = unavailableReason(read.workspace);
      return reason
        ? { kind: "unavailable", reason, workspaceId: carrierId }
        : { kind: "ok", workspace: read.workspace };
    }
    return {
      kind: "unavailable",
      reason: read.kind === "missing" ? "missing" : "unreadable",
      workspaceId: carrierId,
    };
  }

  let cursor: string | undefined;
  let sawExcluded = false;
  let sawOther = false;
  let failure: CarrierRead | null = null;
  for (let page = 0; page < CARRIER_MAX_PAGES; page += 1) {
    let result: Awaited<ReturnType<DesignAdapter["listRecentWorkspaces"]>>;
    try {
      result = await adapter.listRecentWorkspaces({
        limit: CARRIER_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
    } catch {
      return { kind: "unavailable", reason: "unreadable", workspaceId: null };
    }
    const ordered = [...result.workspaces].sort((left, right) =>
      (right.activityAt ?? "").localeCompare(left.activityAt ?? ""),
    );
    for (const listed of ordered) {
      if (listed.id === excludeId) {
        sawExcluded = true;
        continue;
      }
      sawOther = true;
      const reason = unavailableReason(listed);
      if (reason) {
        failure ??= { kind: "unavailable", reason, workspaceId: listed.id };
        continue;
      }
      const read = await readWorkspace(adapter, listed.id);
      if (read.kind === "ok") {
        const refreshedReason = unavailableReason(read.workspace);
        if (refreshedReason) {
          failure ??= {
            kind: "unavailable",
            reason: refreshedReason,
            workspaceId: listed.id,
          };
          continue;
        }
        return { kind: "ok", workspace: read.workspace };
      }
      failure ??= {
        kind: "unavailable",
        reason: read.kind === "missing" ? "missing" : "unreadable",
        workspaceId: listed.id,
      };
    }
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  if (!sawOther && sawExcluded) return { kind: "none", reason: "target-is-only-workspace" };
  return sawOther && failure ? failure : { kind: "none" };
}

function settingsIssue(document: "roles" | "teams" | "preferences"): DesignIssue {
  return issue("DESIGN_SETTINGS_INVALID", [document], { document }, "inspect");
}

/**
 * Reads one coherent design context. Config is read once and profiles are projected from that
 * snapshot. Settings readers and workspace refreshes are independent; every failed read becomes
 * an explicit issue rather than an empty array.
 */
export async function readDesignContext(
  job: DesignContextJob,
  readers: DesignSettingsReaders,
  adapter: DesignAdapter,
  capabilities: DesignContextCapabilities,
): Promise<ContextResult> {
  const targetId = job.targetWorkspaceId;
  const carrierAndTargetMatch =
    job.carrierWorkspaceId !== null && targetId !== null && job.carrierWorkspaceId === targetId;
  const [
    configResult,
    availabilityResult,
    rolesResult,
    teamsResult,
    preferencesResult,
    carrierSettled,
    targetSettled,
  ] = await Promise.allSettled([
    adapter.readConfig(),
    adapter.listProviderAvailability(),
    readers.roles.read(),
    readers.teams.read(),
    readers.preferences.read(),
    carrierAndTargetMatch
      ? Promise.resolve<CarrierRead>({
          kind: "none",
          reason: "target-is-only-workspace",
        })
      : selectCarrier(adapter, job.carrierWorkspaceId, targetId),
    targetId ? readWorkspace(adapter, targetId) : Promise.resolve<WorkspaceRead>({ kind: "none" }),
  ]);
  const carrierResult: CarrierRead =
    carrierSettled.status === "fulfilled"
      ? carrierSettled.value
      : { kind: "unavailable", reason: "unreadable", workspaceId: null };
  const targetResult: WorkspaceRead =
    targetSettled.status === "fulfilled" ? targetSettled.value : { kind: "unreadable" };

  const issues: DesignIssue[] = [];
  let profiles: PaseoProfile[] | null = null;
  if (configResult.status === "rejected") {
    issues.push(issue("DESIGN_CONFIG_UNAVAILABLE", ["config"], { source: "config" }, "refresh"));
  } else {
    profiles = configProfiles(configResult.value);
    if (profiles === null)
      issues.push(
        issue("DESIGN_CONFIG_UNAVAILABLE", ["profiles"], { source: "config" }, "refresh"),
      );
  }
  if (availabilityResult.status === "rejected")
    issues.push(
      issue("DESIGN_CONFIG_UNAVAILABLE", ["availability"], { source: "availability" }, "refresh"),
    );
  if (rolesResult.status === "rejected" || rolesResult.value.status !== "ready")
    issues.push(settingsIssue("roles"));
  if (teamsResult.status === "rejected" || teamsResult.value.status !== "ready")
    issues.push(settingsIssue("teams"));
  if (preferencesResult.status === "rejected" || preferencesResult.value.status !== "ready")
    issues.push(settingsIssue("preferences"));

  if (carrierResult.kind === "none") {
    const params: DesignIssue["params"] = carrierResult.reason
      ? { reason: carrierResult.reason }
      : {};
    issues.push(issue("DESIGN_NO_WORKSPACE", ["carrier"], params, "choose-workspace"));
  } else if (carrierResult.kind === "unavailable") {
    issues.push(workspaceUnavailable("carrier", carrierResult.workspaceId, carrierResult.reason));
  } else {
    const reason = unavailableReason(carrierResult.workspace);
    if (reason) issues.push(workspaceUnavailable("carrier", carrierResult.workspace.id, reason));
  }
  if (targetId) {
    if (targetResult.kind === "missing") {
      issues.push(workspaceUnavailable("target", targetId, "missing"));
    } else if (targetResult.kind === "unreadable") {
      issues.push(workspaceUnavailable("target", targetId, "unreadable"));
    } else if (targetResult.kind === "ok") {
      const reason = unavailableReason(targetResult.workspace);
      if (reason) issues.push(workspaceUnavailable("target", targetId, reason));
    }
  }

  if (issues.length > 0) {
    const finalized = finalizeDesignIssues(issues);
    return {
      ok: false,
      issues: finalized.issues,
      issuesTruncated: finalized.issuesTruncated,
    };
  }
  if (
    configResult.status === "rejected" ||
    profiles === null ||
    availabilityResult.status === "rejected" ||
    rolesResult.status === "rejected" ||
    rolesResult.value.status !== "ready" ||
    teamsResult.status === "rejected" ||
    teamsResult.value.status !== "ready" ||
    preferencesResult.status === "rejected" ||
    preferencesResult.value.status !== "ready" ||
    carrierResult.kind !== "ok" ||
    targetResult.kind === "missing" ||
    targetResult.kind === "unreadable" ||
    (targetResult.kind === "ok" && unavailableReason(targetResult.workspace) !== null)
  ) {
    const finalized = finalizeDesignIssues(issues);
    return {
      ok: false,
      issues: finalized.issues,
      issuesTruncated: finalized.issuesTruncated,
    };
  }

  const preferences = preferencesResult.value.values;
  const normalizedEconomy = normalizeEconomyPolicy(preferences.economy, profiles);
  const economy = normalizedEconomy.ok ? normalizedEconomy.value : EMPTY_ECONOMY;
  const roleLaunchTables = computeRoleLaunchability({
    mode: job.mode,
    roles: rolesResult.value.values.roles,
    profiles,
    availability: availabilityResult.value,
    economy,
  });
  return {
    ok: true,
    context: {
      jobId: job.jobId,
      mode: job.mode,
      roles: rolesResult.value.values.roles,
      teams: teamsResult.value.values.teams,
      preferences,
      revisions: {
        roles: rolesResult.value.revision,
        teams: teamsResult.value.revision,
        preferences: preferencesResult.value.revision,
      },
      profiles,
      availability: availabilityResult.value,
      roleLaunch: roleLaunchTables.member,
      roleLaunchTables,
      ...(job.mode === "economy-all"
        ? {
            modeRouting: describeModeRouting({
              profiles,
              availability: availabilityResult.value,
              economy,
            }),
          }
        : {}),
      daemonConfig: configResult.value,
      carrierWorkspace: carrierResult.workspace,
      targetWorkspace: targetResult.kind === "ok" ? targetResult.workspace : null,
      carrierWorkspaceId: carrierResult.workspace.id,
      targetWorkspaceId: targetId,
      capabilities,
    },
  };
}
