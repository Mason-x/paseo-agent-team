/**
 * Shared pending predicate for ledger decisions and R07 DTOs. UI must not import a full decision.
 */
export function isDecisionPending(decision: { state: string }): boolean {
  return decision.state === "open" || decision.state === "waiting-human";
}
