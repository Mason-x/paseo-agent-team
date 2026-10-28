import { createHash } from "node:crypto";
import { canonicalize } from "../shared/domain/catalog-content";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
} from "../shared/domain/mode-resolver";
import type { ModeIssue } from "../shared/domain/role-execution";
import { type PaseoAdapter, profilesFromConfig } from "../shared/paseo/adapter";
import type { Preferences } from "../shared/schemas/preferences";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";

/**
 * One read-only planning snapshot shared by launch preview/start and agent-team.team.plan.
 *
 * Nothing here writes: the three settings reads, one daemon-config read, and one provider
 * availability read are the whole surface. No workspace, project, template, designer, ledger, or
 * settings write is reachable from this module.
 */

export type SettingsState<Values> =
  | { status: "ready"; values: Values; revision?: string }
  | { status: "invalid"; error: string; revision?: string };

export type SettingsReader<Values> = { read(): Promise<SettingsState<Values>> };

export type PlanningReaders = {
  roles: SettingsReader<RolesDocument>;
  teams: SettingsReader<TeamsDocument>;
  preferences: SettingsReader<Preferences>;
};

export type PlanningRevisions = { roles: string; teams: string; preferences: string };

export type PlanningSettings =
  | {
      status: "ready";
      roles: RolesDocument;
      teams: TeamsDocument;
      preferences: Preferences;
      revisions: PlanningRevisions;
    }
  | { status: "unavailable"; blockers: string[]; issues: ModeIssue[] };

export type PlanningHost = { host: HostSnapshot; daemonConfig: unknown };

export type PlanningSnapshot =
  | {
      status: "ready";
      roles: RolesDocument;
      teams: TeamsDocument;
      preferences: Preferences;
      revisions: PlanningRevisions;
      host: HostSnapshot;
      daemonConfig: unknown;
      economy: EconomyPolicy;
      economyIssues: ModeIssue[];
    }
  | { status: "unavailable"; blockers: string[]; issues: ModeIssue[] };

const EMPTY_ECONOMY: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };

function contextIssue(reason: string, document?: string): ModeIssue {
  return {
    code: "MODE_CONTEXT_UNAVAILABLE",
    severity: "blocker",
    params: document === undefined ? { reason } : { reason, document },
  };
}

/**
 * Settings revisions are the client cache identity. A production reader returns the host revision;
 * a test double that omits it falls back to a prefixed content hash so the two can never be
 * confused, and the fallback never reaches a host.
 */
function revisionOf(state: { revision?: string }, values: unknown): string {
  if (state.revision !== undefined && state.revision.length > 0) return state.revision;
  return `sha256:${createHash("sha256")
    .update(canonicalize({ value: values }))
    .digest("hex")}`;
}

/** The three settings documents, read once. Invalid documents never reach a planner. */
export async function readPlanningSettings(readers: PlanningReaders): Promise<PlanningSettings> {
  const [roles, teams, preferences] = await Promise.all([
    readers.roles.read(),
    readers.teams.read(),
    readers.preferences.read(),
  ]);
  const blockers: string[] = [];
  const issues: ModeIssue[] = [];
  const documents = [
    { name: "roles", state: roles, label: zh.catalogRoles },
    { name: "teams", state: teams, label: zh.catalogTeams },
    { name: "preferences", state: preferences, label: zh.catalogPreferences },
  ] as const;
  for (const document of documents) {
    if (document.state.status === "invalid") {
      blockers.push(zh.settingsInvalid(document.label));
      issues.push(contextIssue("settings-invalid", document.name));
    }
  }
  if (roles.status !== "ready" || teams.status !== "ready" || preferences.status !== "ready") {
    return { status: "unavailable", blockers, issues };
  }
  return {
    status: "ready",
    roles: roles.values,
    teams: teams.values,
    preferences: preferences.values,
    revisions: {
      roles: revisionOf(roles, roles.values),
      teams: revisionOf(teams, teams.values),
      preferences: revisionOf(preferences, preferences.values),
    },
  };
}

/**
 * Host facts: one config read, then one availability read. A config failure leaves no Profiles, so
 * the host is unavailable; an availability failure keeps the Profiles and marks them unverified.
 * Raw host errors stay in the log and never reach a DTO.
 */
export async function readPlanningHost(
  adapter: PaseoAdapter,
  log: (message: string, detail?: unknown) => void,
): Promise<PlanningHost> {
  let daemonConfig: unknown;
  try {
    daemonConfig = await adapter.readConfig();
  } catch (cause) {
    log("planning config read failed", cause);
    return {
      host: { status: "unavailable", reason: "config-read-failed" },
      daemonConfig: undefined,
    };
  }
  const profiles = profilesFromConfig(daemonConfig);
  try {
    const availability = await adapter.listProviderAvailability();
    return { host: { status: "ready", profiles, availability }, daemonConfig };
  } catch (cause) {
    log("planning availability read failed", cause);
    return {
      host: { status: "ready", profiles, availability: [], availabilityUnverified: true },
      daemonConfig,
    };
  }
}

/** One normalization for both the economy value and its issues (launch used to normalize twice). */
export function planningEconomy(
  preferences: Preferences,
  host: HostSnapshot,
): { economy: EconomyPolicy; issues: ModeIssue[] } {
  const profiles = host.status === "ready" ? host.profiles : [];
  const normalized = normalizeEconomyPolicy(preferences.economy, profiles);
  return {
    economy: normalized.ok ? normalized.value : EMPTY_ECONOMY,
    issues: normalized.issues ?? [],
  };
}

/**
 * Full snapshot for agent-team.team.plan. The two reads are independent, so a capability probe
 * that already returned never reaches here; a batch pays exactly 3 + 1 + 1 reads.
 */
export async function readPlanningSnapshot(input: {
  readers: PlanningReaders;
  adapter: PaseoAdapter;
  log: (message: string, detail?: unknown) => void;
}): Promise<PlanningSnapshot> {
  const [settings, hostFacts] = await Promise.all([
    readPlanningSettings(input.readers),
    readPlanningHost(input.adapter, input.log),
  ]);
  const hostIssue =
    hostFacts.host.status === "unavailable"
      ? [contextIssue(hostFacts.host.reason ?? "context-unavailable")]
      : [];
  if (settings.status === "unavailable") {
    return {
      status: "unavailable",
      blockers: settings.blockers,
      issues: [...settings.issues, ...hostIssue],
    };
  }
  if (hostFacts.host.status === "unavailable") {
    return { status: "unavailable", blockers: [], issues: hostIssue };
  }
  const { economy, issues } = planningEconomy(settings.preferences, hostFacts.host);
  return {
    status: "ready",
    roles: settings.roles,
    teams: settings.teams,
    preferences: settings.preferences,
    revisions: settings.revisions,
    host: hostFacts.host,
    daemonConfig: hostFacts.daemonConfig,
    economy,
    economyIssues: issues,
  };
}
