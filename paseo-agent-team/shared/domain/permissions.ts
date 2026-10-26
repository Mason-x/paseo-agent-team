export type PermissionUpdate = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The "allow, and stop asking this session" answer to a permission request.
 *
 * A provider can suggest allow rules for the tool being requested. Those suggestions usually
 * target a settings file in the project or user config; this keeps the rule but retargets it to
 * the running session, so approving a coordinator's delegation once does not write anything to
 * disk or outlive the agent. Empty when the provider offers no such rule.
 */
export function sessionAllowUpdates(
  suggestions: readonly unknown[] | undefined,
): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [];
  for (const entry of suggestions ?? []) {
    const suggestion = record(entry);
    if (suggestion?.type === "addRules" && suggestion.behavior === "allow") {
      updates.push({ ...suggestion, destination: "session" });
    }
  }
  return updates;
}
