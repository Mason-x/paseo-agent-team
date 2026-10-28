import { z } from "zod";
import { utf8ByteLength } from "../domain/design-output";
import { SlugSchema } from "./common";
import { ModeIssueSchema, SeatProfileSchema } from "./launch-preview";
import {
  BudgetBasisSchema,
  RoleTierSchema,
  StoredCollaborationSchema,
  TaskKindSchema,
  TeamModeSchema,
} from "./team-mode";

/** Batch, size, and version bounds. The host rejects beyond them; it never truncates. */
export const TEAM_PLAN_SCHEMA_VERSION = 1;
export const TEAM_PLAN_MAX_ITEMS = 20;
export const TEAM_PLAN_MAX_DRAFT_ROWS = 256;
export const TEAM_PLAN_MAX_INPUT_BYTES = 128 * 1024;
export const TEAM_PLAN_MAX_ROWS = 1024;
/** Capability bit for the designer "existing Roles only" policy. */
export const TEAM_PLAN_DESIGN_ROLE_POLICY = 1;

/** The draft is intentionally incomplete: empty strings and missing Roles are planning inputs. */
export const TeamPlanDraftMemberSchema = z.strictObject({
  rowKey: z.string().min(1).max(256),
  seatId: z.string().optional(),
  roleId: z.string().optional(),
  instanceLabel: z.string().max(40).optional(),
  enabled: z.boolean(),
});

export const TeamPlanDraftSchema = z
  .strictObject({
    mode: z.string().optional(),
    coordinatorRoleId: z.string().optional(),
    memberCreation: z.string().optional(),
    // Stored shape: passthrough preserves newer collaboration fields for planning diagnostics.
    collaboration: StoredCollaborationSchema.optional(),
    members: z.array(TeamPlanDraftMemberSchema).max(TEAM_PLAN_MAX_DRAFT_ROWS),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.members.map((member) => member.rowKey)).size !== value.members.length) {
      ctx.addIssue({ code: "custom", message: "teamPlan.duplicateRowKey", path: ["members"] });
    }
  });

const SavedTeamPlanItemSchema = z.strictObject({
  key: z.string().min(1).max(256),
  kind: z.literal("saved"),
  teamId: SlugSchema,
});

const DraftTeamPlanItemSchema = z.strictObject({
  key: z.string().min(1).max(256),
  kind: z.literal("draft"),
  draft: TeamPlanDraftSchema,
});

export const TeamPlanInputSchema = z
  .strictObject({
    items: z
      .array(z.discriminatedUnion("kind", [SavedTeamPlanItemSchema, DraftTeamPlanItemSchema]))
      .max(TEAM_PLAN_MAX_ITEMS),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.key)).size !== value.items.length) {
      ctx.addIssue({ code: "custom", message: "teamPlan.duplicateKey", path: ["items"] });
    }
    if (utf8ByteLength(JSON.stringify(value)) > TEAM_PLAN_MAX_INPUT_BYTES) {
      ctx.addIssue({ code: "custom", message: "teamPlan.inputTooLarge", path: ["items"] });
    }
  });

export const TeamPlanRuntimeCapabilitiesSchema = z.strictObject({
  onDemand: z.boolean(),
  expansion: z.boolean(),
  collaboration: z.boolean(),
});

export const TeamPlanCapabilitiesSchema = z.strictObject({
  /** Mode-contract version this daemon speaks; absence of a v2 value means legacy. */
  modeContract: z.number().int().nonnegative(),
  /** Designer policy version; 1 means the existing-Roles-only switch is available. */
  designRolePolicy: z.number().int().nonnegative(),
  /** Every mode this daemon recognizes, as strings so future values do not break the DTO. */
  supportedModes: z.array(z.string().min(1)),
  runtimeCapabilities: TeamPlanRuntimeCapabilitiesSchema,
});

export const TeamPlanContextSchema = z.strictObject({
  revisions: z.strictObject({
    roles: z.string(),
    teams: z.string(),
    preferences: z.string(),
  }),
  profilesFingerprint: z.string(),
  availabilityFingerprint: z.string(),
});

export const TeamPlanRowSchema = z.strictObject({
  rowKey: z.string().min(1).max(256),
  seatId: z.string().optional(),
  logicalSeatId: z.string().optional(),
  kind: z.enum(["coordinator", "member"]),
  roleId: z.string().nullable(),
  roleName: z.string(),
  tier: RoleTierSchema.nullable(),
  taskKind: TaskKindSchema.optional(),
  route: z.string().max(64).optional(),
  enabled: z.boolean(),
  purpose: z.enum(["member", "candidate", "judge", "escalation"]).optional(),
  activation: z.enum(["eager", "on-demand", "escalation-only"]).optional(),
  /** The actual selection. Blocked, disabled, and unresolved rows must keep this null. */
  profile: SeatProfileSchema.nullable(),
  /** Open string: a newer planner may add sources without breaking this contract. */
  source: z.string().min(1).max(64),
  budget: z.enum(["economy", "sota", "unknown"]),
  budgetBasis: BudgetBasisSchema,
  availability: z.enum(["available", "unavailable", "unverified"]),
  /** Diagnostic bindings only; never read as "the model this seat will run". */
  configuredProfiles: z.array(SeatProfileSchema).max(10),
  issues: z.array(ModeIssueSchema),
});

export const TeamPlanResultSchema = z.strictObject({
  key: z.string().min(1).max(256),
  status: z.enum(["ready", "blocked", "unavailable"]),
  rawMode: z.string().optional(),
  effectiveMode: TeamModeSchema.nullable(),
  selectionFingerprint: z.string().min(1).max(128).nullable(),
  rows: z.array(TeamPlanRowSchema).max(TEAM_PLAN_MAX_ROWS),
  issues: z.array(ModeIssueSchema),
});

export const TeamPlanOutputSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_PLAN_SCHEMA_VERSION),
  capabilities: TeamPlanCapabilitiesSchema,
  checkedAt: z.string().datetime(),
  context: TeamPlanContextSchema.nullable(),
  results: z.array(TeamPlanResultSchema).max(TEAM_PLAN_MAX_ITEMS),
});

export type TeamPlanDraftMember = z.infer<typeof TeamPlanDraftMemberSchema>;
export type TeamPlanDraft = z.infer<typeof TeamPlanDraftSchema>;
export type TeamPlanInput = z.infer<typeof TeamPlanInputSchema>;
export type TeamPlanCapabilities = z.infer<typeof TeamPlanCapabilitiesSchema>;
export type TeamPlanContext = z.infer<typeof TeamPlanContextSchema>;
export type TeamPlanRow = z.infer<typeof TeamPlanRowSchema>;
export type TeamPlanResult = z.infer<typeof TeamPlanResultSchema>;
export type TeamPlanOutput = z.infer<typeof TeamPlanOutputSchema>;
