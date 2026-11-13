import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  AgentSpecSchema,
  BlockedReasonSchema,
  GateCommandSchema,
  LaunchSpecSchema,
  LimitsSchema,
  ProjectConfigSchema,
  RunSchema,
  StateSchema,
} from "./run";

/** Host-wide settings: which profiles to use by default and how many Runs may be active (Spec 5.4). */
export const teamSettings = defineSettings({
  id: "agent-team-v2",
  scope: "host",
  version: 1,
  schema: z.object({
    maxActiveRuns: z.number().int().min(1).max(10).default(3),
    writer: AgentSpecSchema.optional(),
    reviewers: z.array(AgentSpecSchema).max(3).default([]),
  }),
});

const WaitingSchema = z.object({ who: z.string(), why: z.string(), options: z.array(z.string()) });

export const RunSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  state: StateSchema,
  blockedReason: BlockedReasonSchema.optional(),
  round: z.number(),
  gateAttempts: z.number(),
  createdAt: z.string(),
  lastProgressAt: z.string(),
  closedAt: z.string().optional(),
  waiting: WaitingSchema,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const StartInputSchema = z.object({
  title: z.string().min(1),
  repoPath: z.string().min(1),
  baseRef: z.string().min(1),
  taskMarkdown: z.string().min(1),
  gateCommands: z.array(GateCommandSchema),
  protectedPaths: z.array(z.string()),
  allowedPaths: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  limits: LimitsSchema.partial().optional(),
  writer: LaunchSpecSchema,
  reviewers: z.array(LaunchSpecSchema).min(1).max(3),
});

/** What the UI may ask for. The server adds the commit SHA and the dirty-file list itself. */
export const ResolveChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("more-attempts"), n: z.number().int().min(1).max(20) }),
  z.object({ kind: z.literal("message"), text: z.string().min(1) }),
  z.object({ kind: z.literal("more-round") }),
  z.object({ kind: z.literal("accept-current") }),
  z.object({ kind: z.literal("resubmit") }),
  z.object({ kind: z.literal("retry") }),
  z.object({ kind: z.literal("abandon") }),
]);
export type ResolveChoice = z.infer<typeof ResolveChoiceSchema>;

const id = z.object({ id: z.string() });

export const runListRpc = defineRpc({
  name: "run.list",
  input: z.object({}),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});
/** Reconciles first, so the answer always reflects git and the agents, not just the file. */
export const runGetRpc = defineRpc({
  name: "run.get",
  input: id,
  output: z.object({
    run: RunSchema,
    waiting: WaitingSchema,
    behindBase: z.number().nullable(),
    pendingPermission: z.boolean(),
  }),
});
export const runStartRpc = defineRpc({
  name: "run.start",
  input: StartInputSchema,
  output: z.object({ run: RunSchema, warnings: z.array(z.string()) }),
});
export const runResolveRpc = defineRpc({
  name: "run.resolve",
  input: z.object({ id: z.string(), choice: ResolveChoiceSchema }),
  output: z.object({ run: RunSchema }),
});
export const runCloseRpc = defineRpc({
  name: "run.close",
  input: z.object({ id: z.string(), outcome: z.enum(["merged", "abandoned"]) }),
  output: z.object({ run: RunSchema }),
});
export const projectConfigRpc = defineRpc({
  name: "project.config",
  input: z.object({ path: z.string() }),
  output: z.object({ config: ProjectConfigSchema.nullable(), error: z.string().nullable() }),
});
