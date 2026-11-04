import { describe, expect, test, vi } from "vitest";
import {
  copyRole,
  copyTeam,
  keepRoleMetadata,
  keepTeamMetadata,
} from "../client/catalog/preset-metadata";
import {
  type PresetGateway,
  type PreviewSuccess,
  retryPresetPreferences,
} from "../client/catalog/preset-service";
import { createRetirementProbe, shouldRetire, shouldRetireAny } from "../client/catalog/retirement";
import { readRetiredTeamNotice, retiredTeamNoticeLines } from "../client/teams/team-mode-edit";
import { checkModeAccess } from "../shared/domain/mode-contract";
import { resolveSeatProfile } from "../shared/domain/mode-resolver";
import { omitRetired } from "../shared/domain/retired-fields";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { allAvailable, architect, claudeOpus, codexXhigh, codingTeam, NOW } from "./fixtures";

const legacyRole = RoleSchema.parse({
  ...architect,
  executionPolicy: { tier: { unknown: true }, taskKind: 17, extra: [1, 2] },
  custom: { nested: ["unchanged"] },
});
const legacyTeam = TeamSchema.parse({
  ...codingTeam,
  mode: "economy-all",
  collaboration: { judgeRoleId: "architect", extension: { nested: true } },
  memberCreation: "on-demand",
  designer: { jobId: "job-1" },
  extension: { deep: [1, { x: true }] },
});

describe("MT retired settings compatibility", () => {
  test("decodes old values and ignores malformed old role policy during preferred/fallback resolution", () => {
    expect(legacyRole.executionPolicy).toEqual({
      tier: { unknown: true },
      taskKind: 17,
      extra: [1, 2],
    });
    expect(legacyTeam.mode).toBe("economy-all");
    const first = resolveSeatProfile({
      role: legacyRole,
      host: { status: "ready", profiles: [claudeOpus, codexXhigh], availability: allAvailable },
    });
    expect(first).toMatchObject({
      ok: true,
      value: { profile: { id: claudeOpus.id }, source: "role-preferred" },
    });
    const fallback = resolveSeatProfile({
      role: legacyRole,
      host: { status: "ready", profiles: [codexXhigh], availability: allAvailable },
    });
    expect(fallback).toMatchObject({
      ok: true,
      value: { profile: { id: codexXhigh.id }, source: "role-fallback" },
    });
  });

  test("only the saved object loses its retired keys while unrelated fields and rows survive", () => {
    const other = { ...legacyTeam, id: "other" };
    const editedTeam = keepTeamMetadata(
      legacyTeam,
      { ...omitRetired("team", legacyTeam), name: "Edited" },
      { retireLegacyFields: true },
    );
    const editedRole = keepRoleMetadata(
      legacyRole,
      { ...omitRetired("role", legacyRole), name: "Edited" },
      { retireLegacyFields: true },
    );
    expect(editedTeam).not.toHaveProperty("mode");
    expect(editedTeam).not.toHaveProperty("collaboration");
    expect(editedTeam).toMatchObject({
      memberCreation: "on-demand",
      designer: legacyTeam.designer,
      extension: legacyTeam.extension,
    });
    expect(editedRole).not.toHaveProperty("executionPolicy");
    expect(editedRole.custom).toEqual(legacyRole.custom);
    const rows = [editedTeam, other];
    expect(rows[1]).toEqual(other);
    expect(rows[1].mode).toBe("economy-all");
    expect(
      copyTeam(legacyTeam, "copy", "Copy", NOW, { retireLegacyFields: true }),
    ).not.toHaveProperty("mode");
    expect(
      copyRole(legacyRole, "copy-role", "Copy", NOW, { retireLegacyFields: true }),
    ).not.toHaveProperty("executionPolicy");
    expect(copyRole(legacyRole, "copy-role", "Copy", NOW)).toHaveProperty("executionPolicy");
  });

  test("probes only retired objects and preserves them on rejection and timeout", async () => {
    const probe = vi.fn(async () => true);
    expect(await shouldRetire(probe, "role", architect)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(await shouldRetireAny(probe, "role", [architect, legacyRole])).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(
      await shouldRetire(
        async () => {
          throw new Error("offline");
        },
        "team",
        legacyTeam,
      ),
    ).toBe(false);
    const never = createRetirementProbe(() => new Promise(() => {}), 5);
    expect(await shouldRetire(never, "team", legacyTeam)).toBe(false);
  });

  test("Team notice is one line for default mode or both retired keys", () => {
    for (const team of [{ ...codingTeam, mode: "sota" }, legacyTeam]) {
      const notice = readRetiredTeamNotice(team);
      expect(retiredTeamNoticeLines(notice, null)).toHaveLength(1);
      expect(retiredTeamNoticeLines(notice, false)).toHaveLength(1);
      expect(retiredTeamNoticeLines(notice, true)).toHaveLength(1);
    }
  });

  test("retired request modes block while default and sota run", () => {
    expect(checkModeAccess({}).ok).toBe(true);
    expect(checkModeAccess({ requestedMode: "sota" }).ok).toBe(true);
    for (const mode of ["economy", "economy-all", "collaborative", "unknown"]) {
      expect(checkModeAccess({ requestedMode: mode })).toMatchObject({
        ok: false,
        issue: { code: "MODE_UNKNOWN", params: { reason: "retired" } },
      });
    }
  });

  test.each([true, false])(
    "preset preference save preserves raw fields when retirement=%s",
    async (retire) => {
      const raw = {
        maxMembers: 4,
        economy: { pool: [], extra: { keep: true } },
        quotaRecovery: { mode: "future", custom: 9 },
        defaultPresets: { catalogRevision: "old", seenRoleIds: [], future: { keep: true } },
        unknown: { nested: [1, 2] },
      };
      const values = PreferencesSchema.parse(raw);
      const preview: PreviewSuccess = {
        ok: true,
        catalogRevision: "new",
        generatedAt: NOW,
        revisions: { roles: "r1", preferences: "p1" },
        roles: [],
        bindingReport: [],
        warnings: [],
      };
      const savePreferences = vi.fn<PresetGateway["savePreferences"]>(async () => "saved");
      const gateway: PresetGateway = {
        preview: vi.fn(async () => preview),
        readRoles: vi.fn(async () => ({
          status: "ready" as const,
          values: { roles: [] },
          raw: { roles: [] },
          revision: "r1",
        })),
        readPreferences: vi.fn(async () => ({
          status: "ready" as const,
          values,
          raw,
          revision: "p1",
        })),
        saveRolesDocument: vi.fn(async () => "saved" as const),
        savePreferences,
        reloadRoles: vi.fn(async () => {}),
        reloadPreferences: vi.fn(async () => {}),
      };
      expect(await retryPresetPreferences(gateway, preview, [], NOW, async () => retire)).toBe(
        "saved",
      );
      const saved = savePreferences.mock.calls[0]?.[0];
      expect(saved?.quotaRecovery).toEqual(raw.quotaRecovery);
      expect(saved?.unknown).toEqual(raw.unknown);
      expect(saved?.defaultPresets).toMatchObject({
        catalogRevision: "new",
        future: { keep: true },
      });
      if (retire) expect(saved).not.toHaveProperty("economy");
      else expect(saved?.economy).toEqual(raw.economy);
    },
  );
});
