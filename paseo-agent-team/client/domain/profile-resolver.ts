import type { ProfileRef } from "../../shared/schemas/profile-ref";
import type { Role } from "../../shared/schemas/role";
import { zh } from "../../shared/zh";
import type { PaseoProfile, ProviderAvailability } from "../paseo/adapter";

export type ProfileSource = "role-preferred" | "role-fallback";

export type TriedProfile = {
  ref: ProfileRef;
  status: "missing" | "provider-unavailable";
};

export type ProfileResolution =
  | { ok: true; profile: PaseoProfile; source: ProfileSource; warnings: string[] }
  | {
      ok: false;
      reason: "no-candidates" | "all-missing" | "provider-unavailable";
      tried: TriedProfile[];
    };

type Candidate = { ref: ProfileRef; source: ProfileSource };

function availabilityOf(
  provider: string,
  availability: readonly ProviderAvailability[],
): ProviderAvailability | undefined {
  return availability.find((entry) => entry.provider === provider);
}

export function resolveProfile(
  role: Role,
  profiles: readonly PaseoProfile[],
  availability: readonly ProviderAvailability[],
): ProfileResolution {
  const candidates: Candidate[] = [];
  for (const ref of role.preferredProfiles) {
    candidates.push({ ref, source: "role-preferred" });
  }
  for (const ref of role.fallbackProfiles) {
    candidates.push({ ref, source: "role-fallback" });
  }

  if (candidates.length === 0) {
    return { ok: false, reason: "no-candidates", tried: [] };
  }

  const tried: TriedProfile[] = [];
  const warnings: string[] = [];

  for (const candidate of candidates) {
    const profile = profiles.find((entry) => entry.id === candidate.ref.profileId);
    const label = candidate.ref.nameSnapshot ?? candidate.ref.profileId;
    if (!profile) {
      tried.push({ ref: candidate.ref, status: "missing" });
      warnings.push(zh.profileMissing(label));
      continue;
    }
    const provider = availabilityOf(profile.provider, availability);
    if (provider && !provider.available) {
      tried.push({ ref: candidate.ref, status: "provider-unavailable" });
      warnings.push(zh.providerUnavailable(profile.provider, provider.reason));
      continue;
    }
    if (candidate.source === "role-fallback") {
      warnings.push(zh.usingFallback(profile.name));
    }
    return { ok: true, profile, source: candidate.source, warnings };
  }

  const allMissing = tried.length > 0 && tried.every((entry) => entry.status === "missing");
  return {
    ok: false,
    reason: allMissing ? "all-missing" : "provider-unavailable",
    tried,
  };
}
