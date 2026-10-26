import type { PaseoProfile } from "../paseo/adapter";
import type { BindingReport, BindingReportEntry, ProfileHint } from "../schemas/default-catalog";
import type { ProfileRef } from "../schemas/profile-ref";

export function normalizeProfileName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function runtimeValue(value: string | undefined): string | undefined {
  // The contract treats an absent identifier and an empty one as the same absence, never a wildcard.
  return value === "" ? undefined : value;
}

function sameRuntime(hint: ProfileHint, profile: PaseoProfile): boolean {
  return (
    hint.provider === profile.provider &&
    runtimeValue(hint.model) === runtimeValue(profile.model) &&
    runtimeValue(hint.modeId) === runtimeValue(profile.modeId) &&
    runtimeValue(hint.thinkingOptionId) === runtimeValue(profile.thinkingOptionId)
  );
}

function matchHint(
  hint: ProfileHint,
  profiles: readonly PaseoProfile[],
): {
  profile?: PaseoProfile;
  method: BindingReportEntry["method"];
  reason: BindingReportEntry["reason"];
  candidates: readonly PaseoProfile[];
} {
  const named = profiles.filter(
    (profile) => normalizeProfileName(profile.name) === normalizeProfileName(hint.name),
  );
  const exact = named.filter((profile) => sameRuntime(hint, profile));
  const profile = exact[0];
  if (exact.length === 1 && profile) {
    return {
      profile,
      method: profile.name === hint.name ? "exact" : "normalized-name",
      reason: null,
      candidates: exact,
    };
  }
  if (exact.length > 1) {
    // Several Profiles share the normalized name and runtime. A single verbatim name breaks the
    // tie; anything else is genuinely ambiguous.
    const verbatim = exact.filter((candidate) => candidate.name === hint.name);
    if (verbatim.length === 1) {
      return { profile: verbatim[0], method: "exact", reason: null, candidates: exact };
    }
    return { method: "unbound", reason: "ambiguous", candidates: exact };
  }
  // A changed same-name Profile is never silently replaced by another Profile.
  if (named.length > 0) {
    return { method: "unbound", reason: "config-changed", candidates: named };
  }
  const runtime = profiles.filter((candidate) => sameRuntime(hint, candidate));
  if (runtime.length === 1) {
    return { profile: runtime[0], method: "runtime", reason: null, candidates: runtime };
  }
  return {
    method: "unbound",
    reason: runtime.length > 1 ? "ambiguous" : "missing",
    candidates: runtime,
  };
}

/** Strict identity binding, independent of provider availability. Never guesses a provider. */
export function bindProfileHints(
  roleId: string,
  preferredHints: readonly ProfileHint[],
  fallbackHints: readonly ProfileHint[],
  profiles: readonly PaseoProfile[],
): {
  preferredProfiles: ProfileRef[];
  fallbackProfiles: ProfileRef[];
  bindingReport: BindingReport;
} {
  const reservedIds = new Set(profiles.map((profile) => profile.id));
  const bindingReport: BindingReport = [];

  function bindList(hints: readonly ProfileHint[], list: "preferred" | "fallback"): ProfileRef[] {
    const refs: ProfileRef[] = [];
    const boundIds = new Set<string>();
    hints.forEach((hint, index) => {
      const match = matchHint(hint, profiles);
      const deduplicated = !!match.profile && boundIds.has(match.profile.id);
      bindingReport.push({
        roleId,
        list,
        index,
        hint,
        method: match.method,
        reason: match.reason,
        ...(match.profile ? { profileId: match.profile.id } : {}),
        candidateNames: match.candidates.slice(0, 100).map((profile) => profile.name.slice(0, 200)),
        deduplicated,
      });
      if (deduplicated) return;
      if (match.profile) {
        boundIds.add(match.profile.id);
        refs.push({ profileId: match.profile.id, nameSnapshot: match.profile.name, hint });
        return;
      }
      const base = `unbound:default:${roleId}:${list}:${index}`;
      let profileId = base;
      let suffix = 0;
      while (reservedIds.has(profileId)) profileId = `${base}:${++suffix}`;
      reservedIds.add(profileId);
      refs.push({ profileId, nameSnapshot: hint.name, hint });
    });
    return refs;
  }

  const preferredProfiles = bindList(preferredHints, "preferred");
  const fallbackProfiles = bindList(fallbackHints, "fallback");
  return { preferredProfiles, fallbackProfiles, bindingReport };
}
