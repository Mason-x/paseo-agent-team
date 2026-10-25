import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoProfile } from "../shared/paseo/adapter";
import type { DefaultRoleTemplate } from "../shared/schemas/default-catalog";

export const sourceProfiles = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/default-presets/source-profiles.json"), "utf8"),
) as PaseoProfile[];

export const expectedBindings = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/default-presets/expected-bindings.json"),
    "utf8",
  ),
) as Array<{ id: string; preferred: string[]; fallback: string[] }>;

export const expectedRoleContent = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/default-presets/expected-role-content.json"),
    "utf8",
  ),
) as DefaultRoleTemplate[];
