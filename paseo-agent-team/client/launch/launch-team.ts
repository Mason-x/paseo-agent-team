import type { RunSummary } from "../../shared/schemas/preferences";
import { zh } from "../../shared/zh";
import type { LaunchPlan } from "../domain/launch-plan";
import { compileKickoffMessage } from "../domain/prompt-compiler";
import type { PaseoAdapter } from "../paseo/adapter";

export type LaunchProgress =
  | { step: "coordinator" }
  | { step: "member"; index: number; total: number; title: string }
  | { step: "kickoff" };

export type LaunchResult = {
  runId: string;
  coordinatorId: string;
  memberIds: string[];
  kickoffMessage: string;
};

export type LaunchError = Error & {
  step: "coordinator" | "member" | "kickoff";
  agentIdsKept: string[];
  archived: boolean;
  cause: unknown;
  kickoffMessage?: string;
};

export function isLaunchError(error: unknown): error is LaunchError {
  return error instanceof Error && "step" in error && "agentIdsKept" in error;
}

function launchError(
  message: string,
  step: LaunchError["step"],
  agentIdsKept: string[],
  archived: boolean,
  cause: unknown,
  kickoffMessage?: string,
): LaunchError {
  const error = new Error(message) as LaunchError;
  error.step = step;
  error.agentIdsKept = agentIdsKept;
  error.archived = archived;
  error.cause = cause;
  error.kickoffMessage = kickoffMessage;
  return error;
}

async function archiveCreated(adapter: PaseoAdapter, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await adapter.archiveAgent(id);
    } catch {
      // Keep going so remaining created agents are still archived.
    }
  }
}

export async function launchTeam(
  plan: LaunchPlan,
  adapter: PaseoAdapter,
  options: {
    archiveOnLaunchFailure: boolean;
    onProgress?: (progress: LaunchProgress) => void;
  },
): Promise<LaunchResult> {
  const created: string[] = [];
  options.onProgress?.({ step: "coordinator" });

  let coordinatorId: string;
  try {
    const createdCoordinator = await adapter.createAgent({
      workspaceId: plan.workspaceId,
      title: plan.coordinator.title,
      labels: plan.coordinator.labels,
      systemPrompt: plan.coordinator.systemPrompt,
      profile: plan.coordinator.profile,
      mcpServers: plan.coordinator.role.mcpServers,
    });
    coordinatorId = createdCoordinator.agentId;
    created.push(coordinatorId);
  } catch (cause) {
    throw launchError(zh.createCoordinatorFail, "coordinator", [], false, cause);
  }

  const memberIds: string[] = [];
  try {
    for (const [index, member] of plan.members.entries()) {
      options.onProgress?.({
        step: "member",
        index: index + 1,
        total: plan.members.length,
        title: member.title,
      });
      const createdMember = await adapter.createAgent({
        workspaceId: plan.workspaceId,
        parentAgentId: coordinatorId,
        title: member.title,
        labels: member.labels,
        systemPrompt: member.systemPrompt,
        profile: member.profile,
        mcpServers: member.role.mcpServers,
      });
      memberIds.push(createdMember.agentId);
      created.push(createdMember.agentId);
    }
  } catch (cause) {
    if (options.archiveOnLaunchFailure) {
      await archiveCreated(adapter, created);
      throw launchError(
        zh.createMemberFail(memberIds.length + 1, plan.members.length),
        "member",
        [],
        true,
        cause,
      );
    }
    throw launchError(
      zh.createMemberFail(memberIds.length + 1, plan.members.length),
      "member",
      created,
      false,
      cause,
    );
  }

  const kickoffMessage = compileKickoffMessage({
    task: plan.task,
    runId: plan.runId,
    roster: [
      {
        agentId: coordinatorId,
        role: plan.coordinator.role,
        profile: plan.coordinator.profile,
      },
      ...plan.members.map((member, index) => ({
        agentId: memberIds[index] ?? "(missing)",
        role: member.role,
        instanceLabel: member.instanceLabel,
        profile: member.profile,
      })),
    ],
  });

  options.onProgress?.({ step: "kickoff" });
  try {
    await adapter.sendMessage(coordinatorId, kickoffMessage);
  } catch (cause) {
    throw launchError(zh.kickoffFail, "kickoff", created, false, cause, kickoffMessage);
  }

  return { runId: plan.runId, coordinatorId, memberIds, kickoffMessage };
}

export function toRunSummary(
  plan: LaunchPlan,
  result: LaunchResult,
  createdAt: string,
): RunSummary {
  return {
    runId: result.runId,
    teamId: plan.team.id,
    teamName: plan.team.name,
    workspaceId: plan.workspaceId,
    coordinatorAgentId: result.coordinatorId,
    memberAgentIds: result.memberIds,
    taskExcerpt: plan.task.slice(0, 120),
    createdAt,
  };
}

export function prependRun(recentRuns: readonly RunSummary[], run: RunSummary): RunSummary[] {
  return [run, ...recentRuns.filter((entry) => entry.runId !== run.runId)].slice(0, 20);
}
