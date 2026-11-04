import type { LaunchPreviewInput, LaunchStartInput, LaunchTarget } from "../../shared/rpc";
import type { Team } from "../../shared/schemas/team";
import type { LaunchRequest } from "./events";

export type LaunchPrefill = { teamId?: string; task?: string };

/**
 * Turns `/team <team> <task>` into a prefill. The first word picks a Team when it matches a Team
 * id or name; otherwise the whole text is the task and the dialog keeps its default Team.
 */
export function resolveLaunchPrefill(
  request: Pick<LaunchRequest, "teamId" | "task" | "args">,
  teams: readonly Team[],
): LaunchPrefill {
  const args = request.args?.trim();
  if (!args) return { teamId: request.teamId, task: request.task };
  const [first = "", ...rest] = args.split(/\s+/);
  const word = first.toLowerCase();
  const team = teams.find((entry) => entry.id === word || entry.name.toLowerCase() === word);
  if (!team) return { teamId: request.teamId, task: args };
  const task = args.slice(first.length).trim();
  return { teamId: team.id, task: rest.length > 0 ? task : undefined };
}

/**
 * Launch requests carry neither `mode` nor `contractVersion`. The team mode is retired, so the
 * host plans from the saved Team's Roles alone, and a request without the negotiation field is
 * the plain case for a host of any version.
 */
export function launchPreviewRequest(input: {
  teamId: string;
  task: string;
  target: LaunchTarget;
}): LaunchPreviewInput {
  return {
    teamId: input.teamId,
    task: input.task,
    target: input.target,
  };
}

export function launchStartRequest(input: {
  teamId: string;
  task: string;
  target: LaunchTarget;
  expectedPlanHash: string;
}): LaunchStartInput {
  return {
    ...launchPreviewRequest(input),
    expectedPlanHash: input.expectedPlanHash,
  };
}

export function launchStatusRequest(runId: string): { runId: string } {
  return { runId };
}
