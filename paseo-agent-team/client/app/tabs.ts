export const AGENT_TEAM_TABS = ["teams", "roles", "runs"] as const;
export type AgentTeamTab = (typeof AGENT_TEAM_TABS)[number];

/** The tab Agent Teams opens on when `params.tab` does not ask for another. */
export const DEFAULT_AGENT_TEAM_TAB: AgentTeamTab = "teams";

export const AGENT_TEAMS_SCREEN = "agent-teams";

export function parseTab(value: string | undefined): AgentTeamTab | undefined {
  return AGENT_TEAM_TABS.find((tab) => tab === value);
}

/** An explicit, valid `params.tab` wins; anything else opens the default tab. */
export function resolveInitialTab(value: string | undefined): AgentTeamTab {
  return parseTab(value) ?? DEFAULT_AGENT_TEAM_TAB;
}
