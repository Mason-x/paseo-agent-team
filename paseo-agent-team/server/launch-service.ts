import { buildLaunchPlan, type LaunchPlan } from "../shared/domain/launch-plan";
import { launchPreviewWarnings, toModeLaunchPreview } from "../shared/domain/launch-preview";
import { isLaunchError, launchTeam } from "../shared/domain/launch-team";
import { checkModeAccess, requestContractVersion } from "../shared/domain/mode-contract";
import type { EconomyPolicy } from "../shared/domain/mode-resolver";
import type { ModeIssue } from "../shared/domain/role-execution";
import { createRunId } from "../shared/ids";
import {
  createPaseoAdapter,
  type PaseoAdapter,
  type ProjectSummary,
} from "../shared/paseo/adapter";
import type { PaseoPort } from "../shared/paseo/port";
import type { LaunchJob, LaunchPreviewInput, LaunchStartInput } from "../shared/rpc";
import type { LaunchPreviewResult } from "../shared/schemas/launch-preview";
import type { Preferences } from "../shared/schemas/preferences";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";
import { launchContractZh } from "../shared/zh/launch-contract";
import { hashLaunchPlan } from "./launch-hash";
import {
  planningEconomy,
  readPlanningHost,
  readPlanningSettings,
  type SettingsReader,
} from "./planning-context";

export type { SettingsReader } from "./planning-context";

export type LaunchStartResult =
  | { ok: true; job: LaunchJob }
  | { ok: false; blockers: string[]; warnings: string[] };

import { LAUNCH_RUNTIME_CAPABILITIES } from "../shared/domain/launch-runtime";

export { LAUNCH_RUNTIME_CAPABILITIES };

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
  /** The stored value planning could not read; a job then carries it instead of a placeholder. */
  rawMode?: string;
};

type PrepareResult =
  | { ok: true; prepared: PreparedLaunch }
  | { ok: false; blockers: string[]; warnings: string[]; issues: ModeIssue[] };

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
    const settings = await readPlanningSettings({
      roles: deps.roles,
      teams: deps.teams,
      preferences: deps.preferences,
    });
    if (settings.status === "unavailable") {
      return {
        ok: false,
        blockers: settings.blockers,
        warnings: [],
        issues: settings.issues,
      };
    }

    // Access gate: after reading the stored Team, before any override, host read, or target read.
    // A stale caller may not launch a Team whose saved mode it cannot represent, even by sending
    // a legacy override; the refusal is the only blocker, so the reason is unambiguous.
    const team = settings.teams.teams.find((entry) => entry.id === input.teamId);
    const access = checkModeAccess({
      storedMode: team?.mode,
      requestedMode: input.mode,
      contractVersion: requestContractVersion(input),
    });
    if (!access.ok) {
      return {
        ok: false,
        blockers: [
          launchContractZh.modeRequired(access.denial.subject, access.denial.value),
          launchContractZh.refreshHint,
        ],
        warnings: [],
        issues: [access.issue],
      };
    }

    const target = input.target;
    const [workspace, project, hostFacts] = await Promise.all([
      target.kind === "workspace" ? adapter.getWorkspace(target.workspaceId) : null,
      target.kind === "new-workspace"
        ? adapter
            .listProjects()
            .then((projects) => projects.find((entry) => entry.id === target.projectId))
            .catch(() => undefined)
        : undefined,
      readPlanningHost(adapter, log),
    ]);
    const { host, daemonConfig } = hostFacts;
    const readyHost = host.status === "ready" ? host : undefined;
    const targetBlockers: string[] = [];
    if (target.kind === "workspace" && !workspace) targetBlockers.push(zh.workspaceMissing);
    if (target.kind === "new-workspace" && !project) targetBlockers.push(zh.projectMissing);

    const { economy, issues: economyIssues } = planningEconomy(settings.preferences, host);
    const plan = buildLaunchPlan({
      team,
      roles: settings.roles.roles,
      profiles: readyHost?.profiles ?? [],
      availability: readyHost?.availability ?? [],
      workspaceId: workspace?.id ?? "",
      task: input.task,
      runId,
      maxMembers: settings.preferences.maxMembers,
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
        roles: settings.roles.roles,
        plan,
        host,
        economy,
        target,
        task: input.task,
        maxMembers: settings.preferences.maxMembers,
        runtimeCapabilities: LAUNCH_RUNTIME_CAPABILITIES,
      }),
      workspace,
      project,
      preferences: settings.preferences,
      economy,
      economyIssues,
      ...(plan.rawMode === undefined ? {} : { rawMode: plan.rawMode }),
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
        ...(prepared.prepared.rawMode === undefined
          ? { mode: plan.mode }
          : { rawMode: prepared.prepared.rawMode }),
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
