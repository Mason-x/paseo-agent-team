import type {
  RUN_ASSIGNMENT_PURPOSES,
  RunSeatSnapshot,
  RunTaskRecord,
  RunTier,
} from "../../schemas/run-engine/ledger";
import { executionTier, reviewRequirement } from "./tier";

export type RunAssignmentPurpose = (typeof RUN_ASSIGNMENT_PURPOSES)[number];

export type DispatchAction = "produce" | "review" | "smoke";

export type DispatchRequirement =
  | {
      kind: "required";
      allowedPurposes: readonly RunAssignmentPurpose[];
      requiredDuty: string;
      tier: RunTier | null;
    }
  | { kind: "not-applicable" }
  | { kind: "invalid" };

const PRODUCE_PURPOSES: readonly RunAssignmentPurpose[] = ["member", "coordinator", "reopen"];
const REVIEW_PURPOSES: readonly RunAssignmentPurpose[] = ["reviewer"];
const SMOKE_PURPOSES: readonly RunAssignmentPurpose[] = ["smoker"];

function readDuty(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  return typeof value === "string" ? value : "";
}

/**
 * Frozen per-task duty. Never infers implement from execution, title, or a prior assignment.
 */
export function dispatchRequirement(
  task: Pick<RunTaskRecord, "spec" | "escalations">,
  action: DispatchAction,
): DispatchRequirement {
  const devSmoke = task.spec.devSmoke === true;
  if (action === "smoke" && !devSmoke) return { kind: "not-applicable" };

  const duties = task.spec.dispatchDuties;
  if (duties === undefined || duties === null || typeof duties !== "object") {
    return { kind: "invalid" };
  }
  const duty = readDuty(duties[action]);
  if (duty === undefined || duty === null || duty === "") return { kind: "invalid" };

  if (action === "produce") {
    return {
      kind: "required",
      allowedPurposes: PRODUCE_PURPOSES,
      requiredDuty: duty,
      tier: executionTier(task),
    };
  }
  if (action === "review") {
    return {
      kind: "required",
      allowedPurposes: REVIEW_PURPOSES,
      requiredDuty: duty,
      tier: reviewRequirement(task).tier,
    };
  }
  return {
    kind: "required",
    allowedPurposes: SMOKE_PURPOSES,
    requiredDuty: duty,
    tier: null,
  };
}

/**
 * Structural roster filter only. Callers pass a required result; this does not call
 * `dispatchRequirement`. Runtime idle/channel/mode filters stay in the scheduler.
 */
export function structuralSeats(
  roster: readonly RunSeatSnapshot[],
  requirement: Extract<DispatchRequirement, { kind: "required" }>,
): readonly RunSeatSnapshot[] {
  return roster.filter((seat) => {
    if (!seat.enabled) return false;
    if (requirement.tier !== null && seat.tier !== requirement.tier) return false;
    return seat.duties.includes(requirement.requiredDuty);
  });
}
