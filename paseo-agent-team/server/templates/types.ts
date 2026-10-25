import type { PaseoProfile } from "../../shared/paseo/adapter";
import type { BindingReport } from "../../shared/schemas/default-catalog";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";

export type HostProfile = PaseoProfile;

export type ExampleCatalog = {
  roles: Role[];
  teams: Team[];
};

export type MaterializedDefaultCatalog = ExampleCatalog & { bindingReport: BindingReport };
