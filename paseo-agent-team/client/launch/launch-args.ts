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
