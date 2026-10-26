import { finalizeDesignIssues } from "../../shared/domain/design-validation";
import type { ProviderAvailability } from "../../shared/paseo/adapter";
import { asRecord, type PaseoProfile, profilesFromConfig } from "../../shared/paseo/adapter";
import type { DesignAdapter, DesignWorkspaceSummary } from "../../shared/paseo/design-port";
import type { DesignBaseRevisions, DesignIssue, DesignJob } from "../../shared/schemas/design";
import type { Preferences } from "../../shared/schemas/preferences";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import type { TeamMode } from "../../shared/schemas/team-mode";
import type { RolesDocument, TeamsDocument } from "../../shared/settings";

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

  return {
    ok: true,
    context: {
      jobId: job.jobId,
      mode: job.mode,
      roles: rolesResult.value.values.roles,
      teams: teamsResult.value.values.teams,
      preferences: preferencesResult.value.values,
      revisions: {
        roles: rolesResult.value.revision,
        teams: teamsResult.value.revision,
        preferences: preferencesResult.value.revision,
      },
      profiles,
      availability: availabilityResult.value,
      daemonConfig: configResult.value,
      carrierWorkspace: carrierResult.workspace,
      targetWorkspace: targetResult.kind === "ok" ? targetResult.workspace : null,
      carrierWorkspaceId: carrierResult.workspace.id,
      targetWorkspaceId: targetId,
      capabilities,
    },
  };
}
