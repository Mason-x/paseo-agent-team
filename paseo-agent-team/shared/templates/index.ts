import { rufloRoles, rufloTeams } from "./ruflo-catalog";
import type { ExampleCatalog, HostProfile } from "./types";

export { rufloRoles, rufloTeams } from "./ruflo-catalog";
export type { ExampleCatalog, HostProfile } from "./types";
export { bindPreferredProfile } from "./types";

export function exampleCatalog(profiles: readonly HostProfile[], now: string): ExampleCatalog {
  return {
    roles: rufloRoles(profiles, now),
    teams: rufloTeams(now),
  };
}
