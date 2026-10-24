export const AGENT_TEAM_TABS = ["roles", "teams", "runs"] as const;
export type AgentTeamTab = (typeof AGENT_TEAM_TABS)[number];

export const AGENT_TEAMS_SCREEN = "agent-teams";

export function parseTab(value: string | undefined): AgentTeamTab | undefined {
  return AGENT_TEAM_TABS.find((tab) => tab === value);
}
