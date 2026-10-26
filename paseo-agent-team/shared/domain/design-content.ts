import type { DesignResult } from "../schemas/design";
import type { ProfileRef } from "../schemas/profile-ref";
import type { Role } from "../schemas/role";
import { canonicalize } from "./catalog-content";

/**
 * The fixed result body before the server injects resultId and planningFingerprint.
 *
 * Server hash order: compute planningFingerprint first, then compute
 * resultId = SHA256(canonicalDesignContent({ ...core, planningFingerprint })) with the resultId
 * field excluded. G2 deliberately returns this core with neither field set.
 */
export type DesignResultCore = Omit<DesignResult, "resultId" | "planningFingerprint">;

/**
 * Stable JSON text for hashing. `catalog-content.canonicalize` supplies the project's canonical
 * rules (sorted object keys, undefined object values omitted, undefined array items as null). The
 * `value` envelope keeps every top-level field of the design object: unlike Role content, a
 * Result's source/designer/timestamps are part of the identity comparison during merge.
 */
export function canonicalDesignContent(value: unknown): string {
  return canonicalize({ value });
}

function profileRuntimeRef(ref: ProfileRef): unknown {
  return { profileId: ref.profileId, hint: ref.hint ?? null };
}

/**
 * Hash input for one Role's behavior. Includes every field that can change its prompt or launch
 * binding; excludes display decorations (color/icon/nameSnapshot) and management metadata
 * (source/preset/designer/createdAt/updatedAt). Profile order and MCP config are significant.
 */
export function roleBehaviorContent(role: Role): unknown {
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? null,
    mission: role.mission,
    responsibilities: role.responsibilities,
    restrictions: role.restrictions,
    systemPrompt: role.systemPrompt,
    outputContract: role.outputContract,
    preferredProfiles: role.preferredProfiles.map(profileRuntimeRef),
    fallbackProfiles: role.fallbackProfiles.map(profileRuntimeRef),
    mcpServers: role.mcpServers ?? null,
    enabled: role.enabled,
    executionPolicy: role.executionPolicy ?? null,
  };
}

/** Hash input for resultId: the complete core, excluding the two server-injected hashes. */
export function designResultContent(core: DesignResultCore): unknown {
  return core;
}
