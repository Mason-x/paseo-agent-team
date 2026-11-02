import { legacyFieldRetirement } from "../../shared/domain/mode-contract";
import { hasRetiredFields, type RetiredFieldsKind } from "../../shared/domain/retired-fields";
import type { TeamPlanSend } from "../teams/team-plan-state";

/**
 * E2 (.notes/274): a writer may drop the retired settings keys only when the host it writes to says
 * it no longer reads them. The answer comes from the same `agent-team.team.plan` capability probe
 * the Team list negotiates with (`items: []`), asked right before the save so it is about THIS host
 * NOW. A host without `retiresLegacyFields`, a daemon that predates the method, a failed probe and
 * one that does not answer in time all answer false: the object is then written back the way the
 * earlier version would have, and the save carries on without waiting any longer.
 */
export type RetirementProbe = () => Promise<boolean>;

/** The longest a save waits for the capability answer before writing the object back unchanged. */
export const RETIREMENT_PROBE_TIMEOUT_MS = 3000;

export function createRetirementProbe(
  send: TeamPlanSend,
  timeoutMs = RETIREMENT_PROBE_TIMEOUT_MS,
): RetirementProbe {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        send({ items: [] }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (output === null) return false;
      return legacyFieldRetirement({
        kind: "capabilities",
        modeContract: output.capabilities.modeContract,
        retiresLegacyFields: output.capabilities.retiresLegacyFields,
      });
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

/** The same rule for objects written together (adopted Roles): one question, only if one still carries a retired key. */
export async function shouldRetireAny(
  probe: RetirementProbe,
  kind: RetiredFieldsKind,
  originals: readonly object[],
): Promise<boolean> {
  if (!originals.some((original) => hasRetiredFields(kind, original))) return false;
  return probe();
}
