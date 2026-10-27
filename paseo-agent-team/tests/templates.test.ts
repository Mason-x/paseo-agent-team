import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { exampleCatalog, materializeDefaultCatalog } from "../server/templates";
import { defaultCatalogRevision, defaultRoleTemplates } from "../server/templates/default-catalog";
import { hashCatalogContent } from "../server/templates/hash";
import { resolveProfile } from "../shared/domain/profile-resolver";
import { DEFAULT_ROLE_EXECUTION } from "../shared/domain/role-execution";
import { DefaultRoleTemplateSchema } from "../shared/schemas/default-catalog";
import { RoleSchema } from "../shared/schemas/role";
import { expectedBindings, expectedRoleContent, sourceProfiles } from "./default-presets.fixtures";
import { NOW } from "./fixtures";

describe("default Role templates", () => {
  const catalog = exampleCatalog(sourceProfiles, NOW);

  test("ships exactly the 23 source Roles and no Teams; raw and materialized schemas pass", () => {
    expect(sourceProfiles).toHaveLength(16);
    expect(defaultCatalogRevision).toBe("defaults-2026-10-27.1");
    expect(defaultRoleTemplates).toHaveLength(23);
    expect(catalog.roles.map((role) => role.id)).toEqual(
      expectedRoleContent.map((role) => role.id),
    );
    expect(new Set(catalog.roles.map((role) => role.id)).size).toBe(23);
    expect(catalog.teams).toEqual([]);
    for (const template of defaultRoleTemplates) {
      expect(DefaultRoleTemplateSchema.parse(template)).toEqual(template);
    }
    for (const role of catalog.roles) expect(RoleSchema.parse(role)).toEqual(role);
  });

  test("preserves every source content field and every ordered hint", () => {
    // executionPolicy is added by the generator from DEFAULT_ROLE_EXECUTION; the source-content
    // fixture stays free of it so a binding/content change cannot hide behind tier edits.
    expect(expectedRoleContent.every((role) => !("executionPolicy" in role))).toBe(true);
    expect(
      defaultRoleTemplates.map(({ executionPolicy: _executionPolicy, ...content }) => content),
    ).toEqual(expectedRoleContent);
    for (const [index, role] of catalog.roles.entries()) {
      const {
        preferredProfiles,
        fallbackProfiles,
        createdAt,
        updatedAt,
        source,
        preset,
        executionPolicy,
        ...content
      } = role;
      const { preferredHints, fallbackHints, ...expectedContent } = expectedRoleContent[index];
      expect(content, role.id).toEqual(expectedContent);
      expect(executionPolicy, role.id).toEqual(DEFAULT_ROLE_EXECUTION[role.id]);
      expect(
        preferredProfiles.map((ref) => ref.hint),
        role.id,
      ).toEqual(preferredHints);
      expect(
        fallbackProfiles.map((ref) => ref.hint),
        role.id,
      ).toEqual(fallbackHints);
      expect({ createdAt, updatedAt, source }).toEqual({
        createdAt: NOW,
        updatedAt: NOW,
        source: "preset",
      });
      expect(preset).toEqual({
        catalogId: "agent-team-default",
        templateId: role.id,
        catalogRevision: defaultCatalogRevision,
        templateHash: hashCatalogContent(defaultRoleTemplates[index]),
        appliedHash: hashCatalogContent(role),
        importedAt: NOW,
      });
    }
  });

  test("the generator writes the explicit tier for all 23 presets", () => {
    expect(Object.keys(DEFAULT_ROLE_EXECUTION)).toHaveLength(23);
    expect(defaultRoleTemplates.map((role) => role.id).sort()).toEqual(
      Object.keys(DEFAULT_ROLE_EXECUTION).sort(),
    );
    for (const template of defaultRoleTemplates) {
      expect(template.executionPolicy, template.id).toEqual(DEFAULT_ROLE_EXECUTION[template.id]);
    }
    // Only tier/taskKind: no Profile ID, no host metadata leaks into the raw module.
    expect(
      defaultRoleTemplates.every(
        (template) =>
          JSON.stringify(Object.keys(template.executionPolicy ?? {}).sort()) ===
          '["taskKind","tier"]',
      ),
    ).toBe(true);
  });

  test("binds all preferred and fallback IDs in the exact source order, including both Opus Highs", () => {
    for (const [index, role] of catalog.roles.entries()) {
      const expected = expectedBindings[index];
      expect(role.id).toBe(expected.id);
      expect(
        role.preferredProfiles.map((ref) => ref.profileId),
        role.id,
      ).toEqual(expected.preferred);
      expect(
        role.fallbackProfiles.map((ref) => ref.profileId),
        role.id,
      ).toEqual(expected.fallback);
      for (const ref of [...role.preferredProfiles, ...role.fallbackProfiles]) {
        expect(ref.nameSnapshot).toBe(
          sourceProfiles.find((profile) => profile.id === ref.profileId)?.name,
        );
      }
    }
    const creative = catalog.roles.find((role) => role.id === "content-creative");
    const creativeId = "agent_profile_mvmk07xw_q0yyt5jxtc";
    const generalId = "agent_profile_mub9al8i_n1fbqae2oqi";
    expect(creative?.preferredProfiles.slice(0, 2).map((ref) => ref.profileId)).toEqual([
      creativeId,
      generalId,
    ]);
    for (const role of catalog.roles.filter((role) => role.id !== "content-creative")) {
      expect(
        [...role.preferredProfiles, ...role.fallbackProfiles].some(
          (ref) => ref.profileId === creativeId,
        ),
      ).toBe(false);
    }
    expect(
      materializeDefaultCatalog(sourceProfiles, NOW).bindingReport.every(
        (entry) => entry.method === "exact",
      ),
    ).toBe(true);
  });

  test("raw data is portable and contains no host IDs, refs, timestamps, paths, or notes", () => {
    const raw = readFileSync(
      join(import.meta.dirname, "../server/templates/default-catalog.ts"),
      "utf8",
    );
    expect(raw).not.toContain("agent_profile_");
    expect(raw).not.toMatch(/tests\/fixtures|[a-z]:[\\/]/i);
    function audit(value: unknown) {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        expect(["profileId", "notes", "createdAt", "updatedAt", "source", "preset"]).not.toContain(
          key,
        );
        audit(entry);
      }
    }
    audit(defaultRoleTemplates);
    expect(
      DefaultRoleTemplateSchema.safeParse({ ...defaultRoleTemplates[0], profileId: "host-id" })
        .success,
    ).toBe(false);
  });

  test("does not ship Roles that launch host CLIs", () => {
    const blob = JSON.stringify(defaultRoleTemplates);
    for (const command of ["codex exec", "claude -p", "skip-git-repo-check", "claude-flow"]) {
      expect(blob).not.toContain(command);
    }
  });

  test("research Roles retain their read-only restrictions", () => {
    const researchRoles = catalog.roles.filter((role) => role.id.startsWith("research-"));
    expect(researchRoles).toHaveLength(4);
    for (const role of researchRoles) {
      expect(
        role.restrictions.some((item) => /只读|不修改/.test(item)),
        role.id,
      ).toBe(true);
    }
  });

  test.each(["claude", "codex", "omp"])(
    "all 23 Roles resolve when %s Profiles are absent",
    (provider) => {
      const profiles = sourceProfiles.filter((profile) => profile.provider !== provider);
      const availability = ["claude", "codex", "omp"].map((name) => ({
        provider: name,
        available: name !== provider,
      }));
      for (const role of exampleCatalog(profiles, NOW).roles) {
        const result = resolveProfile(role, profiles, availability);
        expect(result.ok, role.id).toBe(true);
        if (result.ok) expect(result.profile.provider).not.toBe(provider);
      }
    },
  );

  test("only-codex hosts bind only identical codex runtime tuples", () => {
    const profiles = sourceProfiles.filter((profile) => profile.provider === "codex");
    for (const role of exampleCatalog(profiles, NOW).roles) {
      for (const ref of [...role.preferredProfiles, ...role.fallbackProfiles]) {
        const bound = profiles.find((profile) => profile.id === ref.profileId);
        if (bound) {
          expect(ref.hint).toMatchObject({ provider: "codex" });
          for (const field of ["provider", "model", "modeId", "thinkingOptionId"] as const) {
            expect(ref.hint?.[field]).toBe(bound[field]);
          }
        } else {
          expect(ref.profileId).toMatch(/^unbound:default:/);
        }
      }
    }
  });

  test("an empty host still yields valid Roles with distinct hinted placeholders", () => {
    for (const role of exampleCatalog([], NOW).roles) {
      RoleSchema.parse(role);
      const refs = [...role.preferredProfiles, ...role.fallbackProfiles];
      expect(new Set(refs.map((ref) => ref.profileId)).size).toBe(refs.length);
      expect(refs.every((ref) => ref.nameSnapshot === ref.hint?.name)).toBe(true);
      expect(resolveProfile(role, [], [])).toMatchObject({ ok: false, reason: "all-missing" });
    }
  });
});
