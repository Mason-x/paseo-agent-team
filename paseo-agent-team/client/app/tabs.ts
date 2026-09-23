export const AGENT_TEAM_TABS = ["roles", "teams"] as const;
export type AgentTeamTab = (typeof AGENT_TEAM_TABS)[number];
