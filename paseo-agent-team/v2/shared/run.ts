import { z } from "zod";

export const TEAM_DIR = ".team";
export const RUN_STATES = [
  "writing",
  "gating",
  "reviewing",
  "ready",
  "blocked",
  "merged",
  "abandoned",
] as const;
export const BLOCKED_REASONS = [
  "gate-attempts-exhausted",
  "review-rounds-exhausted",
  "writer-stopped-without-submit",
  "writer-asked-human",
  "writer-worktree-changed-during-review",
  "review-setup-failed",
  "agent-failed",
  "stalled",
] as const;
export const SEATS = ["r1", "r2", "r3"] as const;

export const DEFAULT_LIMITS = { maxGateAttempts: 5, maxReviewRounds: 3, stallMinutes: 15 };
export const DEFAULT_PROTECTED = ["tests/**", ".github/**", "paseo-team.json"];

export const StateSchema = z.enum(RUN_STATES);
export const BlockedReasonSchema = z.enum(BLOCKED_REASONS);
export const SeatSchema = z.enum(SEATS);

export const GateCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  timeoutSec: z.number().int().positive(),
});

/** A profile materialized into what `agents.create` needs. */
export const AgentSpecSchema = z.object({
  profile: z.string(),
  provider: z.string().min(1),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What a launch may ask for. The strict provider format lives here and not in AgentSpecSchema:
 * stored Runs must stay readable even if a rule is tightened later.
 */
export const LaunchSpecSchema = AgentSpecSchema.extend({
  provider: z
    .string()
    .regex(/^[^/\s]+\/\S+$/, "provider must be in provider/model format, e.g. claude/sonnet"),
});

export const LimitsSchema = z.object({
  maxGateAttempts: z.number().int().positive(),
  maxReviewRounds: z.number().int().positive(),
  stallMinutes: z.number().positive(),
});

export const GateAttemptSchema = z.object({
  n: z.number().int(),
  sha: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  result: z.enum(["pass", "fail", "error"]).optional(),
  checks: z.array(
    z.object({
      name: z.string(),
      exitCode: z.number().nullable(),
      durationMs: z.number(),
      logFile: z.string(),
    }),
  ),
  policyViolations: z.array(z.string()),
  error: z.string().optional(),
  summary: z.string().optional(),
});

const WorkspaceRefSchema = z.object({ id: z.string(), path: z.string(), branch: z.string() });
const AgentRefSchema = z.object({ agentId: z.string(), profile: z.string(), family: z.string() });

export const ReviewSchema = z.object({
  id: z.string(),
  round: z.number().int(),
  sha: z.string(),
  seat: SeatSchema,
  reviewer: AgentRefSchema,
  workspace: WorkspaceRefSchema.extend({ removedAt: z.string().optional() }),
  verdict: z.enum(["approve", "request-changes"]).optional(),
  blocking: z.number().int().default(0),
  reportFile: z.string(),
  void: z.enum(["writer-worktree-changed", "no-verdict"]).optional(),
  nudges: z.number().int().default(0),
});

export const RunSchema = z.object({
  schemaVersion: z.literal(1),
  /** Incremented on every write; lets callers tell whether a dispatch changed anything. */
  revision: z.number().int(),
  id: z.string(),
  title: z.string(),
  state: StateSchema,
  blockedReason: BlockedReasonSchema.optional(),
  blockedFrom: StateSchema.optional(),
  blockedNote: z.string().optional(),
  repo: z.object({ sourceCheckout: z.string(), baseRef: z.string(), baseSha: z.string() }),
  workspace: WorkspaceRefSchema,
  task: z.object({
    file: z.literal(".team/task.md"),
    gateCommands: z.array(GateCommandSchema),
    protectedPaths: z.array(z.string()),
    allowedPaths: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).default({}),
  }),
  specs: z.object({ writer: AgentSpecSchema, reviewers: z.array(AgentSpecSchema).min(1).max(3) }),
  writer: AgentRefSchema,
  limits: LimitsSchema,
  round: z.number().int().default(0),
  nudges: z.number().int().default(0),
  attempts: z.array(GateAttemptSchema),
  reviews: z.array(ReviewSchema),
  approved: z
    .object({
      sha: z.string(),
      reviewIds: z.array(z.string()),
      override: z.literal("human").optional(),
    })
    .optional(),
  lastProgressAt: z.string(),
  createdAt: z.string(),
  closedAt: z.string().optional(),
});

export type Run = z.infer<typeof RunSchema>;
export type RunState = z.infer<typeof StateSchema>;
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;
export type Seat = z.infer<typeof SeatSchema>;
export type GateCommand = z.infer<typeof GateCommandSchema>;
export type GateAttempt = z.infer<typeof GateAttemptSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** Optional `paseo-team.json` at the repository root: defaults for the launch dialog. */
export const ProjectConfigSchema = z.object({
  gate: z.array(GateCommandSchema).optional(),
  protectedPaths: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  limits: LimitsSchema.partial().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ACTIVE_STATES: readonly RunState[] = [
  "writing",
  "gating",
  "reviewing",
  "ready",
  "blocked",
];
export const isActive = (run: Pick<Run, "state">) => ACTIVE_STATES.includes(run.state);

export const reportPath = (round: number, seat: Seat) => `${TEAM_DIR}/reviews/${round}-${seat}.md`;
export const writerBranch = (runId: string) => `team/${runId}/writer`;
export const reviewBranch = (runId: string, round: number, seat: Seat) =>
  `team/${runId}/review-${round}-${seat}`;

export function newRunId(now: Date, random: () => number = Math.random): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `r-${day}-${Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0")}`;
}

/** Reviewer modes that never stop to ask before writing files or running commands; only tested ones (Spec 7.2.3). */
export const ALLOWED_MODES: Record<string, string[]> = { claude: ["auto"], codex: ["full-access"] };

export function reviewerModeProblem(seat: string, spec: AgentSpec): string | null {
  const key = spec.provider.split("/")[0] ?? "";
  const allowed = ALLOWED_MODES[key];
  const who = `审查席位 ${seat}（${spec.profile}）`;
  if (!allowed) return `${who}：provider ${key} 没有实测过，不能当审查者`;
  if (spec.modeId && allowed.includes(spec.modeId)) return null;
  return `${who}：modeId 必须是 ${allowed.join(" 或 ")}，现在是 ${spec.modeId ?? "未设置"}`;
}

/** Coarse model family from a `provider/model` string. Only used to warn about same-family review. */
export function familyOf(provider: string): string {
  const p = provider.toLowerCase();
  const table: [RegExp, string][] = [
    [/claude|anthropic|opus|sonnet|haiku/, "claude"],
    [/gpt|codex|openai|\bo[134]\b/, "openai"],
    [/gemini|antigravity/, "google"],
    [/deepseek/, "deepseek"],
    [/grok|xai/, "xai"],
    [/glm|zhipu/, "zhipu"],
    [/kimi|moonshot/, "moonshot"],
    [/qwen/, "alibaba"],
  ];
  return table.find(([re]) => re.test(p))?.[1] ?? p.split("/")[0] ?? p;
}
