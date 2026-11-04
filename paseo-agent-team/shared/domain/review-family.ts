import { identifyModelFamily, modelFamilyName } from "./model-family";
import type { ModeIssue } from "./role-execution";
import type { PlannedSeat } from "./seat-plan";

// The default roster has two independent review seats: qa-test (review A, also the re-run seat) and
// qa-review (review B). Two reviews only count as independent when they come from different model
// families, so a fallback that lands both on the same family is worth a warning (.notes/274 D3).
export const REVIEW_ROLE_IDS = ["qa-test", "qa-review"] as const;

/**
 * Warning when both review seats are planned and resolve to the same identified model family.
 * It never blocks, and it stays silent whenever independence cannot be judged: a missing review
 * seat, or a model that does not identify as exactly one supported family.
 */
export function reviewFamilyIssue(seats: readonly PlannedSeat[]): ModeIssue | null {
  const families: string[] = [];
  for (const roleId of REVIEW_ROLE_IDS) {
    const seat = seats.find((entry) => entry.roleId === roleId);
    if (seat === undefined) return null;
    const match = identifyModelFamily(seat.selected.profile);
    if (match.status !== "identified") return null;
    families.push(match.family);
  }
  const [first, second] = families;
  if (first === undefined || first !== second) return null;
  return {
    code: "MODE_REVIEW_FAMILY_SAME",
    severity: "warning",
    roleId: REVIEW_ROLE_IDS[1],
    params: { family: modelFamilyName(first as Parameters<typeof modelFamilyName>[0]) },
  };
}
