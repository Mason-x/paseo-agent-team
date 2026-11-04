import { describe, expect, test } from "vitest";
import { createTeamPlanService } from "../server/team-plan-service";
import type { PaseoProfile } from "../shared/paseo/adapter";
import type { Team } from "../shared/schemas/team";
import { fakePort, preferences, ready } from "./fakes";
import { codingTeam, role, techLead } from "./fixtures";

const deepseek: PaseoProfile = {
  id: "deepseek",
  name: "DeepSeek",
  provider: "omp",
  model: "deepseek-v4",
};
const grok: PaseoProfile = {
  id: "grok",
  name: "Grok",
  provider: "omp",
  model: "grok-4.6",
};
const ambiguous: PaseoProfile = {
  id: "ambiguous",
  name: "Unknown",
  provider: "omp",
  model: "deepseek-grok",
};

async function planReview(options: {
  reviewPreferred?: string;
  reviewFallback?: string;
  includeReview?: boolean;
}) {
  const testRole = role({
    id: "qa-test",
    name: "Review A",
    preferredProfiles: [{ profileId: deepseek.id }],
  });
  const reviewRole = role({
    id: "qa-review",
    name: "Review B",
    preferredProfiles: [{ profileId: options.reviewPreferred ?? grok.id }],
    fallbackProfiles: options.reviewFallback ? [{ profileId: options.reviewFallback }] : [],
  });
  const team: Team = {
    ...codingTeam,
    members: [
      { roleId: testRole.id, enabled: true },
      ...(options.includeReview === false ? [] : [{ roleId: reviewRole.id, enabled: true }]),
    ],
  };
  const profiles = [deepseek, grok, ambiguous];
  const fake = fakePort({
    agentProfiles: profiles,
    mcp: { enabled: true, injectIntoAgents: true },
  });
  fake.port.providers.listAvailable.mockResolvedValue({
    providers: [{ provider: "omp", available: true }],
  });
  const lead = { ...techLead, preferredProfiles: [{ profileId: deepseek.id }] };
  const service = createTeamPlanService({
    readers: {
      roles: ready({ roles: [lead, testRole, reviewRole] }),
      teams: ready({ teams: [team] }),
      preferences: ready(preferences),
    },
  });
  const output = await service.plan(
    { items: [{ key: "team", kind: "saved", teamId: team.id }] },
    fake.port,
  );
  const result = output.results[0];
  if (!result) throw new Error("missing plan result");
  return result;
}

describe("independent review family warning", () => {
  test("warns when a fallback makes both review seats use the same family", async () => {
    const result = await planReview({ reviewPreferred: "missing", reviewFallback: deepseek.id });
    expect(result.status).toBe("ready");
    expect(result.rows.find((entry) => entry.roleId === "qa-review")).toMatchObject({
      profile: { id: deepseek.id },
      source: "role-fallback",
    });
    expect(result.issues.filter((issue) => issue.code === "MODE_REVIEW_FAMILY_SAME")).toEqual([
      expect.objectContaining({ severity: "warning", params: { family: "DeepSeek" } }),
    ]);
  });

  test("does not warn for distinct, missing, or ambiguous review families", async () => {
    for (const options of [{}, { includeReview: false }, { reviewPreferred: ambiguous.id }]) {
      const result = await planReview(options);
      expect(result.status).toBe("ready");
      expect(result.issues.filter((issue) => issue.code === "MODE_REVIEW_FAMILY_SAME")).toEqual([]);
    }
  });
});
