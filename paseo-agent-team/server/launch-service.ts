import { buildLaunchPlan, type LaunchPlan } from "../shared/domain/launch-plan";
import { launchPreviewWarnings, toModeLaunchPreview } from "../shared/domain/launch-preview";
import { isLaunchError, launchTeam } from "../shared/domain/launch-team";
import {
  type EconomyPolicy,
  type HostSnapshot,
  normalizeEconomyPolicy,
} from "../shared/domain/mode-resolver";
import type { ModeIssue } from "../shared/domain/role-execution";
import type { RuntimeCapabilities } from "../shared/domain/seat-plan";
import { createRunId } from "../shared/ids";
import {
  createPaseoAdapter,
  type PaseoAdapter,
  type PaseoProfile,
  type ProjectSummary,
  profilesFromConfig,
} from "../shared/paseo/adapter";
import type { PaseoPort } from "../shared/paseo/port";
import type { LaunchJob, LaunchPreviewInput, LaunchStartInput } from "../shared/rpc";
import type { LaunchPreviewResult } from "../shared/schemas/launch-preview";
import type { Preferences } from "../shared/schemas/preferences";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";
import { hashLaunchPlan } from "./launch-hash";

type SettingsState<Values> =
  | { status: "ready"; values: Values }
  | { status: "invalid"; error: string };

export type SettingsReader<Values> = { read(): Promise<SettingsState<Values>> };

export type LaunchStartResult =
  | { ok: true; job: LaunchJob }
  | { ok: false; blockers: string[]; warnings: string[] };

/** 5A runtime: planning and eager creation only. T7 turns the deferred capabilities on. */
export const LAUNCH_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  onDemand: false,
  expansion: false,
  collaboration: false,
};

const EMPTY_ECONOMY: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };

const MAX_JOBS = 50;
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

function describeCause(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return undefined;
}

type PreparedLaunch = {
  plan: LaunchPlan;
  planHash: string;
  workspace: { id: string } | null;
  project: ProjectSummary | undefined;
  preferences: Preferences;
  economy: EconomyPolicy;
  economyIssues: ModeIssue[];
};

type PrepareResult =
  | { ok: true; prepared: PreparedLaunch }
  | { ok: false; blockers: string[]; warnings: string[]; issues: ModeIssue[] };

function economyOf(preferences: Preferences, profiles: readonly PaseoProfile[]): EconomyPolicy {
  const normalized = normalizeEconomyPolicy(preferences.economy, profiles);
  return normalized.ok ? normalized.value : EMPTY_ECONOMY;
}

function economyIssuesOf(preferences: Preferences, profiles: readonly PaseoProfile[]): ModeIssue[] {
  const normalized = normalizeEconomyPolicy(preferences.economy, profiles);
  return normalized.issues ?? [];
}

/**
 * Launches Teams on the daemon host. Each launch is a job that keeps running after the RPC
 * returns, so a closed dialog or a reloaded client never leaves a half-created team behind.
 * Jobs live in memory: they only report progress, and every created agent carries run labels.
 */
export function createLaunchService(deps: {
  roles: SettingsReader<RolesDocument>;
  teams: SettingsReader<TeamsDocument>;
  preferences: SettingsReader<Preferences>;
  now?: () => Date;
  runId?: () => string;
  log?: (message: string, detail?: unknown) => void;
}) {
  const now = deps.now ?? (() => new Date());
  const nextRunId = deps.runId ?? (() => createRunId());
  const log = deps.log ?? ((message, detail) => console.error(`[agent-team] ${message}`, detail));
  const jobs = new Map<string, LaunchJob>();

  function prune() {
    const cutoff = now().getTime() - FINISHED_JOB_TTL_MS;
    for (const [runId, job] of jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) jobs.delete(runId);
    }
    for (const runId of jobs.keys()) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(runId);
    }
  }

  /** One planning pipeline for preview and start: read settings, host facts, then plan + hash. */
  async function prepare(
    input: LaunchPreviewInput | LaunchStartInput,
    adapter: PaseoAdapter,
    runId: string,
  ): Promise<PrepareResult> {
    const [roles, teams, preferences] = await Promise.all([
      deps.roles.read(),
      deps.teams.read(),
      deps.preferences.read(),
    ]);
    const invalid = [
      roles.status === "invalid" ? zh.settingsInvalid(zh.catalogRoles) : null,
      teams.status === "invalid" ? zh.settingsInvalid(zh.catalogTeams) : null,
      preferences.status === "invalid" ? zh.settingsInvalid(zh.catalogPreferences) : null,
    ].filter((message): message is string => message !== null);
    if (roles.status !== "ready" || teams.status !== "ready" || preferences.status !== "ready") {
      return { ok: false, blockers: invalid, warnings: [], issues: [] };
    }

    const target = input.target;
    const [workspace, project, hostResult] = await Promise.all([
      target.kind === "workspace" ? adapter.getWorkspace(target.workspaceId) : null,
      target.kind === "new-workspace"
        ? adapter
            .listProjects()
            .then((projects) => projects.find((entry) => entry.id === target.projectId))
            .catch(() => undefined)
        : undefined,
      (async (): Promise<{ host: HostSnapshot; daemonConfig: unknown }> => {
        let daemonConfig: unknown;
        try {
          daemonConfig = await adapter.readConfig();
        } catch (cause) {
          // Raw host errors may contain paths or tokens: log them, return a stable code only.
          log("launch config read failed", cause);
          return {
            host: { status: "unavailable", reason: "config-read-failed" },
            daemonConfig: undefined,
          };
        }
        const profiles = profilesFromConfig(daemonConfig);
        try {
          const availability = await adapter.listProviderAvailability();
          return {
            host: { status: "ready", profiles, availability },
            daemonConfig,
          };
        } catch (cause) {
          log("launch availability read failed", cause);
          // Profiles are still usable; SOTA keeps launching with an explicit warning, while the
          // new modes refuse to treat an unverified pool as healthy.
          return {
            host: {
              status: "ready",
              profiles,
              availability: [],
              availabilityUnverified: true,
            },
            daemonConfig,
          };
        }
      })(),
    ]);
    const { host, daemonConfig } = hostResult;
    const readyHost = host.status === "ready" ? host : undefined;
    const targetBlockers: string[] = [];
    if (target.kind === "workspace" && !workspace) targetBlockers.push(zh.workspaceMissing);
    if (target.kind === "new-workspace" && !project) targetBlockers.push(zh.projectMissing);

    const team = teams.values.teams.find((entry) => entry.id === input.teamId);
    const economy = economyOf(preferences.values, readyHost?.profiles ?? []);
    const economyIssues = economyIssuesOf(preferences.values, readyHost?.profiles ?? []);
    const plan = buildLaunchPlan({
      team,
      roles: roles.values.roles,
      profiles: readyHost?.profiles ?? [],
      availability: readyHost?.availability ?? [],
      workspaceId: workspace?.id ?? "",
      task: input.task,
      runId,
      maxMembers: preferences.values.maxMembers,
      mode: input.mode,
      host,
      economy,
      runtimeCapabilities: LAUNCH_RUNTIME_CAPABILITIES,
      daemonConfig,
    });
    const issues = [...economyIssues, ...plan.seatIssues];
    const blockers = [...targetBlockers, ...plan.blockers];
    const prepared: PreparedLaunch = {
      plan,
      planHash: hashLaunchPlan({
        team: plan.team,
        roles: roles.values.roles,
        plan,
        host,
        economy,
        target,
        task: input.task,
        maxMembers: preferences.values.maxMembers,
        runtimeCapabilities: LAUNCH_RUNTIME_CAPABILITIES,
      }),
      workspace,
      project,
      preferences: preferences.values,
      economy,
      economyIssues,
    };
    if (blockers.length > 0) {
      return { ok: false, blockers, warnings: plan.warnings, issues };
    }
    return { ok: true, prepared };
  }

  async function run(
    job: LaunchJob,
    plan: LaunchPlan,
    adapter: PaseoAdapter,
    options: {
      project?: ProjectSummary;
      workspaceTitle: string;
      archiveOnLaunchFailure: boolean;
    },
  ) {
    try {
      let launchPlan = plan;
      if (options.project) {
        job.step = "workspace";
        const workspace = await adapter.createWorkspace({
          title: options.workspaceTitle,
          project: options.project,
        });
        job.workspaceId = workspace.id;
        launchPlan = { ...plan, workspaceId: workspace.id };
      }
      const result = await launchTeam(launchPlan, adapter, {
        archiveOnLaunchFailure: options.archiveOnLaunchFailure,
        onProgress(progress) {
          job.step = progress.step;
          if (progress.step === "member") job.memberIndex = progress.index;
        },
      });
      job.coordinatorId = result.coordinatorId;
      job.memberIds = result.memberIds;
      job.state = "succeeded";
      job.step = "done";
    } catch (error) {
      job.state = "failed";
      const step = job.step === "done" ? "kickoff" : job.step;
      if (isLaunchError(error)) {
        job.error = {
          message: error.message,
          detail: describeCause(error.cause),
          step: error.step,
          archived: error.archived,
          agentIdsKept: error.agentIdsKept,
          kickoffMessage: error.kickoffMessage,
        };
      } else {
        job.error = {
          message: step === "workspace" ? zh.createWorkspaceFail : zh.launchFailed,
          detail: describeCause(error),
          step,
          archived: false,
          agentIdsKept: [],
        };
      }
      log(`launch ${job.runId} failed at ${job.error.step}`, error);
    } finally {
      job.finishedAt = now().toISOString();
    }
  }

  return {
    async preview(input: LaunchPreviewInput, paseo: PaseoPort): Promise<LaunchPreviewResult> {
      const adapter = createPaseoAdapter(paseo);
      const prepared = await prepare(input, adapter, "preview");
      if (!prepared.ok) {
        return {
          ok: false,
          blockers: prepared.blockers,
          warnings: prepared.warnings,
          issues: prepared.issues,
        };
      }
      return {
        ok: true,
        preview: toModeLaunchPreview(
          prepared.prepared.plan,
          prepared.prepared.planHash,
          prepared.prepared.economyIssues,
          prepared.prepared.economy,
        ),
      };
    },

    async start(input: LaunchStartInput, paseo: PaseoPort): Promise<LaunchStartResult> {
      const adapter = createPaseoAdapter(paseo);
      const runId = nextRunId();
      const prepared = await prepare(input, adapter, runId);
      if (!prepared.ok) {
        return { ok: false, blockers: prepared.blockers, warnings: prepared.warnings };
      }
      if (
        input.expectedPlanHash !== undefined &&
        input.expectedPlanHash !== prepared.prepared.planHash
      ) {
        return {
          ok: false,
          blockers: [zh.modes.planChanged],
          warnings: prepared.prepared.plan.warnings,
        };
      }

      const { plan, workspace, project, preferences } = prepared.prepared;
      const target = input.target;
      const job: LaunchJob = {
        runId,
        teamId: plan.team.id,
        teamName: plan.team.name,
        state: "running",
        step: target.kind === "new-workspace" ? "workspace" : "coordinator",
        memberTotal: plan.members.length,
        workspaceId: workspace?.id,
        memberIds: [],
        warnings: launchPreviewWarnings(plan, prepared.prepared.economyIssues),
        startedAt: now().toISOString(),
        mode: plan.mode,
        planHash: prepared.prepared.planHash,
      };
      jobs.set(runId, job);
      prune();
      void run(job, plan, adapter, {
        project: project ?? undefined,
        workspaceTitle:
          (target.kind === "new-workspace" ? target.title?.trim() : undefined) || plan.team.name,
        archiveOnLaunchFailure: preferences.archiveOnLaunchFailure,
      });
      return { ok: true, job: structuredClone(job) };
    },

    status(runId: string): LaunchJob | null {
      const job = jobs.get(runId);
      return job ? structuredClone(job) : null;
    },
  };
}

export type LaunchService = ReturnType<typeof createLaunchService>;
