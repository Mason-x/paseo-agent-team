export const LABELS = {
  run: "agent-team.run",
  team: "agent-team.team",
  teamName: "agent-team.team-name",
  role: "agent-team.role",
  roleName: "agent-team.role-name",
  instance: "agent-team.instance",
  kind: "agent-team.kind",
} as const;

export type AgentTeamKind = "coordinator" | "member";

export function teamLabels(input: {
  runId: string;
  teamId: string;
  teamName: string;
  roleId: string;
  roleName: string;
  kind: AgentTeamKind;
  instanceLabel?: string;
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
  return labels;
}
