import { describe, expect, test, vi } from "vitest";
import { createRetirementProbe, shouldRetire } from "../client/catalog/retirement";
import { omitRetired } from "../shared/domain/retired-fields";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { NOW } from "./fixtures";

const economy = {
  pool: [
    { profileId: "p-grok", family: "Bad Fam!", boundModel: { provider: "omp", model: "x" } },
    { profileRef: "future" },
    { profileId: "p-grok", family: "second" },
  ],
  taskOrder: { coding: ["p-grok"] },
  profileBudget: { p9: "premium" },
  allSeats: {
    version: 99,
    profiles: [{ profileId: "p-sonnet", futureEntryField: { keep: "entry" } }],
    routes: { review: ["p-sonnet"] },
    futureBlockField: { keep: "block" },
  },
  futureEconomyField: { keep: "economy" },
};
const raw = {
  maxMembers: 100,
  archiveOnLaunchFailure: false,
  recentRuns: [
    {
      runId: "run-1",
      teamId: "team",
      teamName: "Team",
      workspaceId: "ws",
      coordinatorAgentId: "agent",
      memberAgentIds: [],
      taskExcerpt: "task",
      createdAt: NOW,
    },
  ],
  templatesImportedAt: NOW,
  designerProfile: { profileId: "designer", future: { keep: true } },
  defaultPresets: { catalogRevision: "cat", seenRoleIds: ["qa-test"], future: { keep: true } },
  quotaRecovery: { mode: "manual", future: { keep: true } },
  economy,
  futurePreferences: { nested: [1, { keep: true }] },
};

describe("retired economy data protection", () => {
  test("reading preserves unknown entries, duplicates, invalid labels and future blocks", () => {
    const parsed = PreferencesSchema.parse(raw);
    expect(JSON.stringify(parsed.economy)).toBe(JSON.stringify(economy));
    expect(parsed.maxMembers).toBe(100);
    expect(parsed.quotaRecovery).toEqual(raw.quotaRecovery);
  });

  test("an old or failed host preserves the whole raw economy block on a preference edit", async () => {
    for (const probe of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error("offline");
      }),
    ]) {
      const original = structuredClone(raw);
      const shouldRemove = await shouldRetire(probe, "preferences", original);
      const edited = { ...original, maxMembers: 12 };
      const saved = shouldRemove ? omitRetired("preferences", edited) : edited;
      expect(shouldRemove).toBe(false);
      expect(JSON.stringify(saved.economy)).toBe(JSON.stringify(economy));
      expect(saved).toEqual({ ...raw, maxMembers: 12 });
      expect(original).toEqual(raw);
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });

  test("an upgraded host removes only economy while preserving raw nested extensions", async () => {
    const original = structuredClone(raw);
    const shouldRemove = await shouldRetire(async () => true, "preferences", original);
    const edited = { ...original, maxMembers: 12 };
    const saved = shouldRemove ? omitRetired("preferences", edited) : edited;
    const { economy: _economy, ...retained } = raw;
    expect(shouldRemove).toBe(true);
    expect(saved).toEqual({ ...retained, maxMembers: 12 });
    expect(JSON.stringify(original.economy)).toBe(JSON.stringify(economy));
    expect(original).toEqual(raw);
  });

  test("a clean preference object never triggers a capability probe", async () => {
    const { economy: _economy, ...clean } = raw;
    const probe = vi.fn(async () => true);
    expect(await shouldRetire(probe, "preferences", clean)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(omitRetired("preferences", clean)).toBe(clean);
  });

  test("an unresponsive capability probe times out and keeps the original block", async () => {
    const probe = createRetirementProbe(() => new Promise(() => undefined), 5);
    expect(await shouldRetire(probe, "preferences", raw)).toBe(false);
    expect(JSON.stringify(raw.economy)).toBe(JSON.stringify(economy));
  });
});
