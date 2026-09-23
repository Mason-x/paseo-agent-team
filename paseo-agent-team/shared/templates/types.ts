import type { ProfileRef } from "../schemas/profile-ref";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";

export type HostProfile = {
  id: string;
  name: string;
  provider: string;
};

export type ExampleCatalog = {
  roles: Role[];
  teams: Team[];
};

export function bindPreferredProfile(
  profiles: readonly HostProfile[],
  preferredProviders: readonly string[],
): ProfileRef {
  for (const provider of preferredProviders) {
    const match = profiles.find((profile) => profile.provider === provider);
    if (match) return { profileId: match.id, nameSnapshot: match.name };
  }
  const first = profiles[0];
  if (first) return { profileId: first.id, nameSnapshot: first.name };
  return { profileId: "unbound", nameSnapshot: "Bind a profile" };
}
