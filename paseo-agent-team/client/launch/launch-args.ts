import type { ModeContractSupport } from "../../shared/domain/mode-contract";
import type { LaunchPreviewInput, LaunchStartInput, LaunchTarget } from "../../shared/rpc";
import type { Team } from "../../shared/schemas/team";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { TEAM_MODE_OPTIONS } from "../shared/team-mode-options";
import { readStoredTeamMode } from "../teams/team-mode-edit";
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

export type LaunchModeDisplay =
  | { kind: "none" }
  | { kind: "known"; mode: TeamMode; label: string }
  | { kind: "unknown"; value: string };

/**
 * The dialog shows the Team's saved mode read-only. An unrecognized stored value stays visible as
 * itself: it is never relabeled as a known mode, and only editing the Team can replace it.
 */
export function launchModeDisplay(team: Team | undefined): LaunchModeDisplay {
  if (!team) return { kind: "none" };
  const stored = readStoredTeamMode(team.mode);
  if (stored.unknown !== null) return { kind: "unknown", value: stored.unknown };
  const label =
    TEAM_MODE_OPTIONS.find((option) => option.value === stored.mode)?.label ?? stored.mode;
  return { kind: "known", mode: stored.mode, label };
}

/**
 * Launch requests never carry `mode`: the host plans from the saved Team, so App and script
 * previews cannot disagree about the mode. The RPC field stays for advanced script use only.
 *
 * `contractVersion: 2` is declared only after the team.plan probe confirmed v2; legacy and
 * unknown callers stay on the baseline shape (I01's status projection keys off the same field).
 */
function contractField(modeContract: ModeContractSupport): { contractVersion?: 2 } {
  return modeContract === "v2" ? { contractVersion: 2 } : {};
}

export function launchPreviewRequest(
  input: {
    teamId: string;
    task: string;
    target: LaunchTarget;
  },
  modeContract: ModeContractSupport = "legacy",
): LaunchPreviewInput {
  return {
    teamId: input.teamId,
    task: input.task,
    target: input.target,
    ...contractField(modeContract),
  };
}

export function launchStartRequest(
  input: {
    teamId: string;
    task: string;
    target: LaunchTarget;
    expectedPlanHash: string;
  },
  modeContract: ModeContractSupport = "legacy",
): LaunchStartInput {
  return {
    ...launchPreviewRequest(input, modeContract),
    expectedPlanHash: input.expectedPlanHash,
  };
}

/** `launch.status` uses the same rule so a v2 caller keeps the real job (no legacy projection). */
export function launchStatusRequest(
  runId: string,
  modeContract: ModeContractSupport = "legacy",
): { runId: string; contractVersion?: number } {
  return modeContract === "v2" ? { runId, contractVersion: 2 } : { runId };
}
