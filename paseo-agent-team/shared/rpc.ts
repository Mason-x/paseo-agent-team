import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  DefaultCatalogPreviewInputSchema,
  DefaultCatalogPreviewResultSchema,
} from "./schemas/default-catalog";
import { LaunchPreviewResultSchema } from "./schemas/launch-preview";
import { RoleSchema } from "./schemas/role";
import { TeamSchema } from "./schemas/team";
import { TeamModeSchema } from "./schemas/team-mode";

export const LaunchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) }),
  z.object({
    kind: z.literal("new-workspace"),
    projectId: z.string().min(1),
    title: z.string().trim().max(80).optional(),
  }),
]);

const LaunchRequestShape = {
  teamId: z.string().min(1),
  task: z.string().trim().min(1).max(20000),
  target: LaunchTargetSchema,
};

export const LaunchStartInputSchema = z.object({
  ...LaunchRequestShape,
  /**
   * Retired. There is one planning path, so an absent value and `sota` run it and every other
   * mode is refused with a retired-mode blocker and a refresh hint. The field stays in the schema
   * so a page or script that was not updated still gets that answer instead of a schema error.
   */
  mode: TeamModeSchema.optional(),
  /**
   * Mode-contract negotiation, accepted for older pages. Any integer is accepted and normalized
   * by `requestContractVersion` (only 2 is v2; absent, 1, 3, … are legacy), so an explicit `1`
   * from a copy of the old client stays a legacy request instead of becoming a schema error. It is
   * not a semantic request field and never enters the plan hash.
   */
  contractVersion: z.number().int().optional(),
  /**
   * Token from launch.preview. Omitted by legacy callers; new clients always send it.
   *
   * Known behavior (F06/73): the launch fingerprint includes each selected Profile's live display
   * name, so renaming a Profile invalidates an open preview and asks for a fresh one. This is
   * documented, not changed here.
   */
  expectedPlanHash: z.string().min(1).max(128).optional(),
});

export const LaunchPreviewInputSchema = z.object({
  ...LaunchRequestShape,
  /** Retired; see `LaunchStartInputSchema.mode`. */
  mode: TeamModeSchema.optional(),
  /** See `LaunchStartInputSchema.contractVersion`. */
  contractVersion: z.number().int().optional(),
});

const LaunchJobStepSchema = z.enum(["workspace", "coordinator", "member", "kickoff", "done"]);

export const LaunchJobSchema = z.object({
  runId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  state: z.enum(["running", "succeeded", "failed"]),
  step: LaunchJobStepSchema,
  memberIndex: z.number().int().optional(),
  memberTotal: z.number().int(),
  workspaceId: z.string().optional(),
  coordinatorId: z.string().optional(),
  memberIds: z.array(z.string()),
  warnings: z.array(z.string()),
  error: z
    .object({
      message: z.string(),
      detail: z.string().optional(),
      step: LaunchJobStepSchema,
      archived: z.boolean(),
      agentIdsKept: z.array(z.string()),
      kickoffMessage: z.string().optional(),
    })
    .optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Always `sota` in this version; the field stays so an older page parses the job. */
  mode: TeamModeSchema.optional(),
  /** Never set by this version (the stored Team mode is not read); kept for older pages. */
  rawMode: z.string().optional(),
  planHash: z.string().optional(),
});

export type LaunchTarget = z.infer<typeof LaunchTargetSchema>;
export type LaunchStartInput = z.infer<typeof LaunchStartInputSchema>;
export type LaunchPreviewInput = z.infer<typeof LaunchPreviewInputSchema>;
export type LaunchJob = z.infer<typeof LaunchJobSchema>;

export {
  designCancelRpc,
  designContinueRpc,
  designMarkSavedRpc,
  designPrepareSaveRpc,
  designResultRpc,
  designSaveFailedRpc,
  designStartRpc,
  designStatusRpc,
} from "./rpc/design";
export type {
  TeamPlanCapabilities,
  TeamPlanContext,
  TeamPlanDraft,
  TeamPlanDraftMember,
  TeamPlanInput,
  TeamPlanOutput,
  TeamPlanResult,
  TeamPlanRow,
} from "./rpc/team-plan";
export {
  emptyTeamPlanProbe,
  TEAM_PLAN_DESIGN_ROLE_POLICY,
  TEAM_PLAN_MAX_DRAFT_ROWS,
  TEAM_PLAN_MAX_INPUT_BYTES,
  TEAM_PLAN_MAX_ITEMS,
  TEAM_PLAN_MAX_ROWS,
  TEAM_PLAN_SCHEMA_VERSION,
  teamPlanRpc,
} from "./rpc/team-plan";

export type {
  CoordinatorPreview,
  LaunchPreviewResult,
  ModeLaunchPreview,
  SeatPreview,
} from "./schemas/launch-preview";

/**
 * Validates and plans on the host, then creates the team in the background. Agent creation can
 * outlast Paseo's 30s plugin RPC timeout, so callers poll `launchStatusRpc` for the outcome.
 */
export const launchStartRpc = defineRpc({
  name: "agent-team.launch.start",
  input: LaunchStartInputSchema,
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), job: LaunchJobSchema }),
    z.object({
      ok: z.literal(false),
      blockers: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
  ]),
});

/**
 * Read-only seat preview. It resolves the same settings, Team, Roles, and Profiles as start, but
 * never creates a workspace or an agent.
 */
export const launchPreviewRpc = defineRpc({
  name: "agent-team.launch.preview",
  input: LaunchPreviewInputSchema,
  output: LaunchPreviewResultSchema,
});

/** `job` is null once the run is forgotten (finished long ago, or the plugin restarted). */
export const launchStatusRpc = defineRpc({
  name: "agent-team.launch.status",
  input: z.object({
    runId: z.string().min(1),
    /** See `LaunchStartInputSchema.contractVersion`; accepted and ignored. */
    contractVersion: z.number().int().optional(),
  }),
  output: z.object({ job: LaunchJobSchema.nullable() }),
});

/** Example Roles and Teams bound to this host's Profiles. Served on demand to keep the client bundle small. */
export const exampleCatalogRpc = defineRpc({
  name: "agent-team.templates.examples",
  input: z.object({}),
  output: z.object({ roles: z.array(RoleSchema), teams: z.array(TeamSchema) }),
});

/** Read-only, revision-scoped default Role synchronization preview. */
export const defaultCatalogPreviewRpc = defineRpc({
  name: "agent-team.templates.defaults.preview",
  input: DefaultCatalogPreviewInputSchema,
  output: DefaultCatalogPreviewResultSchema,
});
