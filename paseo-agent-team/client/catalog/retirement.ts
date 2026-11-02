import { legacyFieldRetirement } from "../../shared/domain/mode-contract";
import { hasRetiredFields, type RetiredFieldsKind } from "../../shared/domain/retired-fields";
import type { TeamPlanSend } from "../teams/team-plan-state";

/**
 * E2 (.notes/274): a writer may drop the retired settings keys only when the host it writes to says
 * it no longer reads them. The answer comes from the same `agent-team.team.plan` capability probe
 * the Team list negotiates with (`items: []`), asked right before the save so it is about THIS host
 * NOW. A host without `retiresLegacyFields`, a daemon that predates the method, and a failed probe
 * all answer false: the object is then written back the way the earlier version would have.
 */
export type RetirementProbe = () => Promise<boolean>;

export function createRetirementProbe(send: TeamPlanSend): RetirementProbe {
  return async () => {
    try {
      const output = await send({ items: [] });
      return legacyFieldRetirement({
        kind: "capabilities",
        modeContract: output.capabilities.modeContract,
        retiresLegacyFields: output.capabilities.retiresLegacyFields,
      });
    } catch {
      return false;
    }
  };
}

/**
 * The writers' entry point. A write that has no retired key to drop never needs the answer, so the
 * host is asked only when the object being rewritten still carries one of them.
 */
export async function shouldRetire(
  probe: RetirementProbe,
  kind: RetiredFieldsKind,
  original: object | null | undefined,
): Promise<boolean> {
  if (original === null || original === undefined || !hasRetiredFields(kind, original)) {
    return false;
  }
  return probe();
}
