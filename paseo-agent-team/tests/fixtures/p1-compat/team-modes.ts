// Data only: no imports from the implementation, no assertions. Tests may parse, clone, and write
// these values into a real settings store. Unknown values must survive a round-trip verbatim.
//
// Baseline values are the stored Team.mode strings recognized at 75ec305. `economy-all` is the new
// stored value frozen by 04-arch-p1.md §3.1 (H4=A); it appears here as data, not as a planning
// claim. `UNKNOWN_TEAM_MODE` is recognized by no contract and is the passthrough probe.

export const BASELINE_TEAM_MODES = ["sota", "economy", "collaborative"] as const;

/** New stored value: every seat uses cheap Profiles. Never an alias for `economy`. */
export const TEAM_MODE_ECONOMY_ALL = "economy-all";

/** Not recognized by the baseline or the P1 contract; must round-trip unchanged. */
export const UNKNOWN_TEAM_MODE = "future-mode-unknown";

/** The four stored tiers after H4=A: flagship, standard (legacy economy), new economy, collaborative. */
export const FOUR_TIER_STORED_MODES = [
  "sota",
  "economy",
  TEAM_MODE_ECONOMY_ALL,
  "collaborative",
] as const;
