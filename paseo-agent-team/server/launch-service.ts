import { buildLaunchPlan, type LaunchPlan } from "../shared/domain/launch-plan";
import { isLaunchError, launchTeam } from "../shared/domain/launch-team";
import { createRunId } from "../shared/ids";
import {
  createPaseoAdapter,
  type PaseoAdapter,
  type ProjectSummary,
  profilesFromConfig,
} from "../shared/paseo/adapter";
import type { PaseoPort } from "../shared/paseo/port";
import type { LaunchJob, LaunchStartInput } from "../shared/rpc";
import type { Preferences } from "../shared/schemas/preferences";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";

type SettingsState<Values> =
  | { status: "ready"; values: Values }
  | { status: "invalid"; error: string };

export type SettingsReader<Values> = { read(): Promise<SettingsState<Values>> };

export type LaunchStartResult =
  | { ok: true; job: LaunchJob }
  | { ok: false; blockers: string[]; warnings: string[] };

const MAX_JOBS = 50;
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

function describeCause(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return undefined;
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
    async start(input: LaunchStartInput, paseo: PaseoPort): Promise<LaunchStartResult> {
      const adapter = createPaseoAdapter(paseo);
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
        return { ok: false, blockers: invalid, warnings: [] };
      }

      const target = input.target;
      const [daemonConfig, availability, workspace, project] = await Promise.all([
        adapter.readConfig().catch(() => undefined),
        adapter.listProviderAvailability().catch(() => []),
        target.kind === "workspace" ? adapter.getWorkspace(target.workspaceId) : null,
        target.kind === "new-workspace"
          ? adapter
              .listProjects()
              .then((projects) => projects.find((entry) => entry.id === target.projectId))
              .catch(() => undefined)
          : undefined,
      ]);
      const targetBlockers: string[] = [];
      if (target.kind === "workspace" && !workspace) targetBlockers.push(zh.workspaceMissing);
      if (target.kind === "new-workspace" && !project) targetBlockers.push(zh.projectMissing);

      const team = teams.values.teams.find((entry) => entry.id === input.teamId);
      const runId = nextRunId();
      const plan = buildLaunchPlan({
        team,
        roles: roles.values.roles,
        profiles: profilesFromConfig(daemonConfig),
        availability,
        workspaceId: workspace?.id ?? "",
        task: input.task,
        runId,
        maxMembers: preferences.values.maxMembers,
        daemonConfig,
      });
      const blockers = [...targetBlockers, ...plan.blockers];
      if (blockers.length > 0) return { ok: false, blockers, warnings: plan.warnings };

      const job: LaunchJob = {
        runId,
        teamId: plan.team.id,
        teamName: plan.team.name,
        state: "running",
        step: target.kind === "new-workspace" ? "workspace" : "coordinator",
        memberTotal: plan.members.length,
        workspaceId: workspace?.id,
        memberIds: [],
        warnings: plan.warnings,
        startedAt: now().toISOString(),
      };
      jobs.set(runId, job);
      prune();
      void run(job, plan, adapter, {
        project: project ?? undefined,
        workspaceTitle:
          (target.kind === "new-workspace" ? target.title?.trim() : undefined) || plan.team.name,
        archiveOnLaunchFailure: preferences.values.archiveOnLaunchFailure,
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
