import type { RunLevel, RunTaskRecord, RunTier } from "../../schemas/run-engine/ledger";

/** Difficulty implied by a governance tier (05 §4): B→L1, A→L3, S→L4. */
const TIER_LEVEL: Readonly<Record<RunTier, RunLevel>> = { B: "L1", A: "L3", S: "L4" };
const LEVEL_ORDER: Readonly<Record<RunLevel, number>> = { L1: 0, L2: 1, L3: 2, L4: 3 };
const LEVEL_REVIEW_TIER: Readonly<Record<RunLevel, RunTier>> = {
  L1: "B",
  L2: "A",
  L3: "A",
  L4: "S",
};

/** Last applied escalation wins; otherwise the frozen spec tier. Never derives from level. */
export function executionTier(task: Pick<RunTaskRecord, "spec" | "escalations">): RunTier {
  return task.escalations.at(-1)?.toTier ?? task.spec.tier;
}

/**
 * Review strength is the stricter of the task's own difficulty and the difficulty implied by its
 * current execution tier (05 §4). `a-with-s-plan` always requires an S final review; the S plan
 * review itself is a separate architecture task referenced by `architectureTaskId`.
 */
export function reviewRequirement(task: Pick<RunTaskRecord, "spec" | "escalations">): {
  level: RunLevel;
  tier: RunTier;
} {
  const implied = TIER_LEVEL[executionTier(task)];
  const stricter = LEVEL_ORDER[task.spec.level] >= LEVEL_ORDER[implied] ? task.spec.level : implied;
  const level = task.spec.implementationPolicy === "a-with-s-plan" ? "L4" : stricter;
  return { level, tier: LEVEL_REVIEW_TIER[level] };
}

/** Quality failures inside the current layer: subtract the last escalation's baseline. */
export function layerFailures(
  task: Pick<RunTaskRecord, "qualityFailures" | "escalations">,
): number {
  const baseline = task.escalations.at(-1)?.qualityFailures ?? 0;
  return Math.max(0, task.qualityFailures - baseline);
}
