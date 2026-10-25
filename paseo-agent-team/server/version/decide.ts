import type { Blocker, InstallSource, Relation } from "../../shared/version";

const BLOCKS_UPDATE: Record<string, true> = {
  dirty: true,
  local_ahead: true,
  diverged: true,
  detached_head: true,
  no_upstream: true,
  not_git: true,
  no_remote: true,
  repository_busy: true,
  unsupported_checkout: true,
  installation_identity_unknown: true,
  path_invalid: true,
  cli_missing: true,
  branch_mismatch: true,
  shallow_history: true,
};

/** Separates "a newer target exists" from "this checkout may be fast-forwarded". */
export function decideUpdate(input: {
  source: InstallSource["kind"];
  registry: boolean;
  relation: Relation;
  sameCommit: boolean;
  blockers: readonly Blocker[];
  cliAvailable: boolean;
}): { updateAvailable: boolean | null; canUpdate: boolean } {
  if (input.source === "npm" || input.source === "unknown" || input.registry) {
    return { updateAvailable: null, canUpdate: false };
  }
  if (input.sameCommit || input.relation === "equal")
    return { updateAvailable: false, canUpdate: false };
  if (
    input.relation === "ahead" ||
    input.relation === "diverged" ||
    input.relation === "unrelated"
  ) {
    return { updateAvailable: false, canUpdate: false };
  }
  const blocked = input.blockers.some((item) => BLOCKS_UPDATE[item.code] === true);
  return { updateAvailable: true, canUpdate: input.cliAvailable && !blocked };
}
