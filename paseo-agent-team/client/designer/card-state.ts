import type { DesignRequestCheck } from "../../shared/domain/design-request";

/** What the user chose by hand; `null` means they have not touched the fold yet. */
export type FoldChoice = "expanded" | "collapsed" | null;

/**
 * A compact screen with Teams to show belongs to the list, so the designer starts folded.
 * An empty list has nothing to show, so the designer starts open. Wide screens always start open.
 */
export function resolveCollapseDefault(compact: boolean, teamCount: number): boolean {
  return compact && teamCount > 0;
}

/**
 * The card follows `collapseByDefault` until the user folds or unfolds it, then keeps their
 * choice: a Team list that grows or shrinks never folds a card the user opened.
 */
export function resolveCollapsed(collapseByDefault: boolean, choice: FoldChoice): boolean {
  return choice === null ? collapseByDefault : choice === "collapsed";
}

/**
 * Typing is a deliberate act on the card, so it pins the card open before a Team list arriving
 * from elsewhere can fold it mid-edit. A fold the user already chose stays as it is.
 */
export function resolveFoldOnInput(choice: FoldChoice): FoldChoice {
  return choice ?? "expanded";
}

export type Selection = {
  /** The id to show and send; `""` is "not chosen". */
  id: string;
  /** The user chose an id the host no longer lists. */
  missing: boolean;
};

/**
 * A chosen id is only "missing" once the list it must come from has loaded, so a slow or failed
 * load never reads as a deleted workspace or Profile.
 */
export function resolveSelection(
  wanted: string,
  items: readonly { id: string }[],
  unverifiable: boolean,
): Selection {
  const missing = wanted !== "" && !unverifiable && !items.some((item) => item.id === wanted);
  return { id: wanted, missing };
}

/**
 * Profile for the design agent. With no choice of their own the user gets `defaultProfileId`,
 * but only while the host still lists it; an explicit choice is never swapped for another.
 */
export function resolveDesignerProfile(
  choice: string | null,
  defaultProfileId: string | undefined,
  profiles: readonly { id: string }[],
  loading: boolean,
): Selection {
  if (choice !== null) return resolveSelection(choice, profiles, loading);
  const id =
    defaultProfileId && profiles.some((profile) => profile.id === defaultProfileId)
      ? defaultProfileId
      : "";
  return { id, missing: false };
}

export type StartBlock =
  | "unavailable"
  | "disabled"
  | "submitting"
  | "request-empty"
  | "request-too-long"
  | "workspace-missing"
  | "profile-missing"
  | "profiles-loading"
  | "mode-needs-upgrade";

/** Why "Start design" is disabled, most fundamental reason first; `null` when it may run. */
export function resolveStartBlock(input: {
  hasStartHandler: boolean;
  disabledReason: string | undefined;
  submitting: boolean;
  request: DesignRequestCheck;
  workspaceMissing: boolean;
  profileMissing: boolean;
  profilesLoading: boolean;
  /** The chosen mode needs a host that confirmed the v2 contract, and this one has not. */
  modeNeedsUpgrade?: boolean;
}): StartBlock | null {
  if (!input.hasStartHandler) return "unavailable";
  if (input.disabledReason) return "disabled";
  if (input.modeNeedsUpgrade) return "mode-needs-upgrade";
  if (input.submitting) return "submitting";
  if (!input.request.ok) {
    return input.request.reason === "empty" ? "request-empty" : "request-too-long";
  }
  if (input.workspaceMissing) return "workspace-missing";
  if (input.profileMissing) return "profile-missing";
  if (input.profilesLoading) return "profiles-loading";
  return null;
}
