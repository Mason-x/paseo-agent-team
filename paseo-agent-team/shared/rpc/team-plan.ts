import { defineRpc } from "@getpaseo/plugin";
import {
  TEAM_PLAN_DESIGN_ROLE_POLICY,
  TEAM_PLAN_MAX_DRAFT_ROWS,
  TEAM_PLAN_MAX_INPUT_BYTES,
  TEAM_PLAN_MAX_ITEMS,
  TEAM_PLAN_MAX_ROWS,
  TEAM_PLAN_SCHEMA_VERSION,
  type TeamPlanInput,
  TeamPlanInputSchema,
  TeamPlanOutputSchema,
} from "../schemas/team-plan";

/**
 * Read-only Team planning contract. The method is defined here but registered by the integration
 * owner (`index.server.ts`); this module must stay free of handlers and host imports.
 *
 * `items: []` is the capability probe: it returns capabilities with a null context and no results.
 */
export const teamPlanRpc = defineRpc({
  name: "agent-team.team.plan",
  input: TeamPlanInputSchema,
  output: TeamPlanOutputSchema,
});

export function emptyTeamPlanProbe(): TeamPlanInput {
  return { items: [] };
}

export type {
  TeamPlanCapabilities,
  TeamPlanContext,
  TeamPlanDraft,
  TeamPlanDraftMember,
  TeamPlanInput,
  TeamPlanOutput,
  TeamPlanResult,
  TeamPlanRow,
} from "../schemas/team-plan";
export {
  TEAM_PLAN_DESIGN_ROLE_POLICY,
  TEAM_PLAN_MAX_DRAFT_ROWS,
  TEAM_PLAN_MAX_INPUT_BYTES,
  TEAM_PLAN_MAX_ITEMS,
  TEAM_PLAN_MAX_ROWS,
  TEAM_PLAN_SCHEMA_VERSION,
};
