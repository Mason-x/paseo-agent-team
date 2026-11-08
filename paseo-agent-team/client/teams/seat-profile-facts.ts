import type { SeatProfileFacts } from "../../shared/domain/run-engine/team-config";
import { logicalSeatIdsOf } from "../../shared/domain/run-engine/team-config-edit";
import type { TeamPlanRow } from "../../shared/schemas/team-plan";
import { draftRowKey } from "./team-plan-state";

type Member = { seatId?: string | undefined; enabled: boolean };

/**
 * The Profile each Team seat will actually use, for the launch gate's warnings (a Codex Profile that
 * is not full-access). Only a seat whose planned row is unambiguous counts: one enabled member row
 * with a selected Profile, found by the row key the editor itself sent, and whose logical seat id
 * (when the server names one) is the id the editor computes. A candidate, a blocked or unresolved
 * row, a row with a different key or a seat id that does not match is left out, never guessed.
 */
export function seatProfileFactsFromPlan(
  members: readonly Member[],
  rows: readonly TeamPlanRow[],
): SeatProfileFacts[] {
  const logical = logicalSeatIdsOf(members);
  const seatByKey = new Map<string, string>();
  let enabledIndex = 0;
  for (const [index, member] of members.entries()) {
    if (!member.enabled) continue;
    const seatId = logical[enabledIndex];
    enabledIndex += 1;
    if (seatId !== undefined) seatByKey.set(draftRowKey(member, index), seatId);
  }
  const perKey = new Map<string, TeamPlanRow[]>();
  for (const row of rows) {
    if (row.kind !== "member" || !row.enabled) continue;
    const group = perKey.get(row.rowKey) ?? [];
    group.push(row);
    perKey.set(row.rowKey, group);
  }
  const facts: SeatProfileFacts[] = [];
  for (const [key, group] of perKey) {
    const seatId = seatByKey.get(key);
    const row = group[0];
    if (seatId === undefined || group.length !== 1 || row === undefined) continue;
    if (row.purpose !== undefined && row.purpose !== "member") continue;
    if (row.logicalSeatId !== undefined && row.logicalSeatId !== seatId) continue;
    if (row.profile === null) continue;
    facts.push({
      seatId,
      provider: row.profile.provider,
      ...(row.profile.modeId === undefined ? {} : { modeId: row.profile.modeId }),
    });
  }
  return facts;
}
