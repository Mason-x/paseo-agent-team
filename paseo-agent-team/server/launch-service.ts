import { buildLaunchPlan, type LaunchPlan } from "../shared/domain/launch-plan";
import { launchPreviewWarnings, toModeLaunchPreview } from "../shared/domain/launch-preview";
import { isLaunchError, launchTeam } from "../shared/domain/launch-team";
import { checkModeAccess } from "../shared/domain/mode-contract";
import type { ModeIssue } from "../shared/domain/role-execution";
import { resolveTeamRunEngine } from "../shared/domain/run-engine/team-config";
import { createRunId } from "../shared/ids";
import {
  createPaseoAdapter,
  type PaseoAdapter,
  type ProjectSummary,
  type WorkspaceSummary,
} from "../shared/paseo/adapter";
import type { PaseoPort } from "../shared/paseo/port";
import type { LaunchJob, LaunchPreviewInput, LaunchStartInput } from "../shared/rpc";
import type { LaunchPreviewResult } from "../shared/schemas/launch-preview";
import type { Preferences } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { RunTeamEngineConfig } from "../shared/schemas/run-engine/config";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";
import { launchContractZh } from "../shared/zh/launch-contract";
import { runEngineZh } from "../shared/zh/run-engine";
import { hashLaunchPlan } from "./launch-hash";
import { readPlanningHost, readPlanningSettings, type SettingsReader } from "./planning-context";
import { sha256Hex } from "./run-engine/digest";
import { dispatchWorkspace, inspectRepo } from "./run-engine/repo";
import type { EngineLaunchHost } from "./run-engine/runtime";
import type { EngineStartStep } from "./run-engine/start";

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
  workspace: WorkspaceSummary | null;
  project: ProjectSummary | undefined;
  preferences: Preferences;
  roles: readonly Role[];
  /** The Team's enabled Run Engine block; `null` runs the original coordinator chain. */
  engine: RunTeamEngineConfig | null;
};

/**
 * What would stop an Engine start, checked in the preview and again at start: the ledger and the
 * daemon's server id must be readable, and an existing Workspace must be a git repository on a
 * branch with a commit and a clean tree. A new Workspace has no directory yet; `startEngineRun`
 * checks it after it is created.
 */
async function engineStartBlockers(
  host: EngineLaunchHost,
  workspace: WorkspaceSummary | null,
): Promise<string[]> {
  const text = runEngineZh.launch;
  const blockers: string[] = [];
  const identity = await host.identity();
  if (!identity.ok) blockers.push(text.identityUnavailable(identity.reason));
  if (!workspace) return blockers;
  if (!workspace.directory) {
    blockers.push(text.workspaceNoDirectory);
    return blockers;
  }
  const inspected = await inspectRepo(workspace.directory);
  if (!inspected.ok) {
    blockers.push(
      text.workspaceNotGit(inspected.reason === "git-error" ? inspected.detail.slice(0, 200) : ""),
    );
    return blockers;
  }
  const usable = dispatchWorkspace(inspected.repo, workspace.id);
  if (!usable.ok) {
    if (usable.reason === "detached-head") blockers.push(text.workspaceDetached);
    else if (usable.reason === "no-commit") blockers.push(text.workspaceNoCommit);
    else blockers.push(text.workspaceDirty);
    return blockers;
  }
  const committer = await host.commitIdentity(inspected.repo.root);
  if (!committer.ok) blockers.push(text.commitIdentityMissing(committer.detail));
  return blockers;
}

/** Where a failed Engine start is shown on the job; the job's steps are the old chain's. */
function jobStepOf(step: EngineStartStep): "coordinator" | "member" | "kickoff" {
  if (step === "member" || step === "kickoff") return step;
  return "coordinator";
}

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
  /**
   * The Run Engine, when this build can start Engine Runs. Absent, or `supported: false`, an
   * Engine-enabled Team is refused with a blocker (never run on the old chain); Teams without the
   * block never touch it.
   */
  engine?: EngineLaunchHost;
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

    // Access gate, before any host read or target read. The team mode is retired: an absent
    // override or `sota` runs, any other value is refused with a refresh hint, and the refusal is
    // the only blocker so the reason is unambiguous. The saved Team's own mode is never checked.
    const access = checkModeAccess({ requestedMode: input.mode });
    if (!access.ok) {
      return {
        ok: false,
        blockers: [launchContractZh.retiredMode(access.value), launchContractZh.refreshHint],
        warnings: [],
        issues: [access.issue],
      };
    }
    const team = settings.teams.teams.find((entry) => entry.id === input.teamId);
    const resolution = team ? resolveTeamRunEngine(team) : { status: "absent" as const };
    const engineConfig = resolution.status === "enabled" ? resolution.config : null;
    const engineHost = deps.engine?.supported ? deps.engine : undefined;

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

    const plan = buildLaunchPlan({
      team,
      roles: settings.roles.roles,
      profiles: readyHost?.profiles ?? [],
      availability: readyHost?.availability ?? [],
      workspaceId: workspace?.id ?? "",
      task: input.task,
      runId,
      maxMembers: settings.preferences.maxMembers,
      host,
      runtimeCapabilities: LAUNCH_RUNTIME_CAPABILITIES,
      daemonConfig,
      runEngineSupported: engineHost !== undefined,
    });
    const issues = [...plan.seatIssues];
    const blockers = [...targetBlockers, ...plan.blockers];
    if (engineConfig && engineHost) {
      blockers.push(...(await engineStartBlockers(engineHost, workspace)));
    }
    const prepared: PreparedLaunch = {
      plan,
      planHash: hashLaunchPlan({
        team: plan.team,
        roles: settings.roles.roles,
        plan,
        host,
        target,
        task: input.task,
        maxMembers: settings.preferences.maxMembers,
        runtimeCapabilities: LAUNCH_RUNTIME_CAPABILITIES,
      }),
      workspace,
      project,
      preferences: settings.preferences,
      roles: settings.roles.roles,
      engine: engineConfig,
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

  /**
   * The Engine branch of a start. The Workspace is created first when asked, then its real
   * directory goes to `startEngineRun`, which freezes it into the Run's record. The job only
   * reports; the Run record is the truth, and `engine.launchState` mirrors its launch state.
   */
  async function runEngine(
    job: LaunchJob,
    prepared: PreparedLaunch,
    request: { requestHash: string; runId: string },
    adapter: PaseoAdapter,
    paseo: PaseoPort,
    options: { workspaceTitle: string },
  ) {
    const host = deps.engine;
    const { plan, engine } = prepared;
    try {
      if (!host || !engine) throw new Error("engine launch without an engine host");
      let workspace = prepared.workspace;
      if (prepared.project) {
        job.step = "workspace";
        workspace = await adapter.createWorkspace({
          title: options.workspaceTitle,
          project: prepared.project,
        });
        job.workspaceId = workspace.id;
      }
      if (!workspace?.directory) {
        throw new Error(runEngineZh.launch.workspaceNoDirectory);
      }
      job.step = "coordinator";
      const result = await host.start(
        {
          plan: { ...plan, workspaceId: workspace.id },
          roles: prepared.roles,
          engine,
          workspaceDirectory: workspace.directory,
          requestId: request.runId,
          requestHash: request.requestHash,
          planHash: prepared.planHash,
          maxMembers: prepared.preferences.maxMembers,
          archiveOnLaunchFailure: prepared.preferences.archiveOnLaunchFailure,
          onProgress(progress) {
            job.step = jobStepOf(progress.step);
            if (progress.step === "member" && progress.index !== undefined) {
              job.memberIndex = progress.index;
            }
            job.engine = {
              launchState:
                progress.step === "preflight" || progress.step === "prepare"
                  ? "preparing"
                  : progress.step === "kickoff"
                    ? "kickoff-pending"
                    : "creating",
            };
          },
        },
        paseo,
        adapter,
      );
      if (result.ok) {
        job.coordinatorId = result.coordinatorId;
        job.memberIds = result.memberIds;
        job.engine = { launchState: result.launchState };
        job.state = "succeeded";
        job.step = "done";
      } else {
        job.state = "failed";
        job.engine = { launchState: "failed" };
        job.error = {
          message: result.message,
          detail: result.detail,
          step: jobStepOf(result.step),
          archived: result.archived,
          agentIdsKept: result.agentIdsKept,
        };
        log(`engine launch ${job.runId} failed at ${result.step}`, result.detail);
      }
    } catch (error) {
      job.state = "failed";
      job.engine = { launchState: "failed" };
      const step = job.step === "done" ? "kickoff" : job.step;
      job.error = {
        message: step === "workspace" ? zh.createWorkspaceFail : zh.launchFailed,
        detail: describeCause(error),
        step,
        archived: false,
        agentIdsKept: [],
      };
      log(`engine launch ${job.runId} failed at ${job.error.step}`, error);
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
        preview: toModeLaunchPreview(prepared.prepared.plan, prepared.prepared.planHash),
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
        warnings: launchPreviewWarnings(plan),
        startedAt: now().toISOString(),
        mode: plan.mode,
        planHash: prepared.prepared.planHash,
        ...(prepared.prepared.engine ? { engine: { launchState: "preparing" as const } } : {}),
      };
      jobs.set(runId, job);
      prune();
      const workspaceTitle =
        (target.kind === "new-workspace" ? target.title?.trim() : undefined) || plan.team.name;
      if (prepared.prepared.engine) {
        void runEngine(
          job,
          prepared.prepared,
          {
            runId,
            requestHash: sha256Hex(
              JSON.stringify({ teamId: input.teamId, task: input.task, target: input.target }),
            ),
          },
          adapter,
          paseo,
          { workspaceTitle },
        );
        return { ok: true, job: structuredClone(job) };
      }
      void run(job, plan, adapter, {
        project: project ?? undefined,
        workspaceTitle,
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
