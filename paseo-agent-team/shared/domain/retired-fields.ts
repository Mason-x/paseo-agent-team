// The one table of retired settings keys (.notes/274 §3), and the only code that removes them.
//
// Retired fields still DECODE (shared/schemas/team-mode.ts) and never take part in planning. They
// are deleted when the OWNING object is next saved by this version: a Team loses `mode` and
// `collaboration`, a Role loses `executionPolicy`, the host Preferences lose `economy`. Nothing
// else is touched: unknown extension keys, `memberCreation`, `designer`, `quotaRecovery`, nested
// content and key order all stay exactly as stored. An object is never rebuilt from a list of known
// fields, because that would silently drop whatever a newer writer added.
//
// Pure and import-free so the client, the server and the tests share one definition.

export const RETIRED_FIELDS = {
  team: ["mode", "collaboration"],
  role: ["executionPolicy"],
  preferences: ["economy"],
} as const;

export type RetiredFieldsKind = keyof typeof RETIRED_FIELDS;

/** The retired keys the object still carries as OWN properties, in the table's order. */
export function retiredKeysPresent(kind: RetiredFieldsKind, value: object): string[] {
  return RETIRED_FIELDS[kind].filter((key) => Object.hasOwn(value, key));
}

export function hasRetiredFields(kind: RetiredFieldsKind, value: object): boolean {
  return retiredKeysPresent(kind, value).length > 0;
}

/**
 * Remove the retired top-level keys, keep everything else by reference and in order. An object
 * without retired keys is returned as is (same identity), so a caller can skip a rewrite.
 */
export function omitRetired<T extends object>(kind: RetiredFieldsKind, value: T): T {
  const retired: readonly string[] = RETIRED_FIELDS[kind];
  if (!retired.some((key) => Object.hasOwn(value, key))) return value;
  // fromEntries defines own data properties, so a stored "__proto__" key stays an ordinary key.
  return Object.fromEntries(Object.entries(value).filter(([key]) => !retired.includes(key))) as T;
}
