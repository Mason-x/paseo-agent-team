export const LABELS = {
  run: "agent-team.run",
  team: "agent-team.team",
  teamName: "agent-team.team-name",
  role: "agent-team.role",
  roleName: "agent-team.role-name",
  instance: "agent-team.instance",
  kind: "agent-team.kind",
  /** Coordinator only: the launch task, so a run describes itself without plugin storage. */
  task: "agent-team.task",
} as const;

/** Paseo's own parent link; agent snapshots carry it as a label. */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export type AgentTeamKind = "coordinator" | "member";

export const TASK_LABEL_MAX = 160;

/** One line, bounded, so it fits a label and a list row. */
export function taskExcerpt(task: string, max = TASK_LABEL_MAX): string {
  const line = task.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function teamLabels(input: {
  runId: string;
  teamId: string;
  teamName: string;
  roleId: string;
  roleName: string;
  kind: AgentTeamKind;
  instanceLabel?: string;
  task?: string;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [LABELS.run]: input.runId,
    [LABELS.team]: input.teamId,
    [LABELS.teamName]: input.teamName,
    [LABELS.role]: input.roleId,
    [LABELS.roleName]: input.roleName,
    [LABELS.kind]: input.kind,
  };
  if (input.instanceLabel) labels[LABELS.instance] = input.instanceLabel;
  const task = input.task ? taskExcerpt(input.task) : "";
  if (task) labels[LABELS.task] = task;
  return labels;
}
