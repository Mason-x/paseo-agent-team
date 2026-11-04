import { describe, expect, test } from "vitest";
import {
  missingProfileRefs,
  preferredProfileLabel,
  profileBindingLabels,
  teamRoleWarnings,
  teamsUsingRole,
} from "../client/domain/validation";
import { architect, claudeOpus, codingTeam, developer, techLead } from "./fixtures";

describe("validation", () => {
  test("finds missing profile refs without failing the role document", () => {
    const warnings = missingProfileRefs([architect], []);
    expect(warnings.map((warning) => warning.profileId).sort()).toEqual([
      "claude-opus-high",
      "codex-xhigh",
    ]);
  });

  test("lists teams that reference a role", () => {
    expect(teamsUsingRole([codingTeam], "architect").map((team) => team.id)).toEqual([
      "coding-team",
    ]);
    expect(teamsUsingRole([codingTeam], "tech-lead").map((team) => team.id)).toEqual([
      "coding-team",
    ]);
    expect(teamsUsingRole([codingTeam], "reviewer")).toEqual([]);
  });

  test("flags missing member roles", () => {
    const warnings = teamRoleWarnings([codingTeam], [techLead, architect]);
    expect(warnings[0]?.missingRoleIds).toContain("developer");
  });

  test("binding labels keep stored order and the live > snapshot > hint precedence", () => {
    const labels = profileBindingLabels(architect, [claudeOpus]);
    expect(labels.preferred.map((entry) => entry.label)).toEqual(["Claude Opus High"]);
    expect(labels.fallback.map((entry) => entry.label)).toEqual(["Codex xhigh"]);
    expect(labels.preferred[0]?.missing).toBe(false);

    const missing = profileBindingLabels(
      {
        ...architect,
        preferredProfiles: [
          { profileId: "gone", nameSnapshot: "Snapshot Name" },
          { profileId: "hinted", hint: { name: "Hint Name", provider: "claude" } },
          { profileId: "unknown" },
        ],
        fallbackProfiles: [],
      },
      [],
    );
    expect(missing.preferred.map((entry) => entry.label)).toEqual([
      "Snapshot Name",
      "Hint Name",
      null,
    ]);
    expect(missing.preferred.every((entry) => entry.missing)).toBe(true);
    expect(missing.fallback).toEqual([]);
  });

  test("binding detail shows the live model and thinking, or the preset hint when unbound", () => {
    const live = profileBindingLabels(
      {
        ...architect,
        preferredProfiles: [
          {
            profileId: claudeOpus.id,
            hint: {
              name: "Old",
              provider: "claude",
              model: "stale-model",
              thinkingOptionId: "low",
            },
          },
        ],
        fallbackProfiles: [],
      },
      [{ ...claudeOpus, model: "live-model", thinkingOptionId: "max" }],
    );
    expect(live.preferred[0]?.detail).toBe("live-model · max");

    const unbound = profileBindingLabels(
      {
        ...architect,
        preferredProfiles: [
          {
            profileId: "gone",
            hint: {
              name: "Hinted",
              provider: "omp",
              model: "gpt-6.1-terra",
              thinkingOptionId: "max",
            },
          },
          { profileId: "bare", nameSnapshot: "Bare" },
        ],
        fallbackProfiles: [],
      },
      [],
    );
    expect(unbound.preferred.map((entry) => entry.detail)).toEqual(["gpt-6.1-terra · max", null]);
  });

  test("preferred profile label uses the live name or a missing snapshot", () => {
    expect(preferredProfileLabel(architect, [claudeOpus])).toEqual({
      name: "Claude Opus High",
      missing: false,
    });
    expect(preferredProfileLabel(architect, []).name).toContain("缺失 Profile");
    expect(preferredProfileLabel(developer, []).missing).toBe(true);
  });
});
