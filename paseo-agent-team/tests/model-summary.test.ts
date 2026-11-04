import { describe, expect, test } from "vitest";
import { summarizeModelRows, unresolvedReasonOf } from "../shared/domain/model-summary";
import type { TeamPlanRow } from "../shared/schemas/team-plan";

type RowOverrides = Partial<Omit<TeamPlanRow, "profile">> & {
  profile?: TeamPlanRow["profile"] | null;
};

function row(overrides: RowOverrides = {}): TeamPlanRow {
  return {
    rowKey: "seat-1",
    kind: "member",
    roleId: "eng-dev",
    roleName: "【工程】开发",
    tier: "execution",
    taskKind: "coding",
    enabled: true,
    purpose: "member",
    activation: "eager",
    profile: {
      id: "profile-opus",
      name: "Opus primary",
      provider: "claude",
      model: "claude-opus-4",
    },
    source: "role-preferred",
    budget: "sota",
    budgetBasis: "host",
    availability: "available",
    configuredProfiles: [],
    issues: [],
    ...overrides,
  };
}

function input(
  rows: readonly TeamPlanRow[],
  overrides: Partial<Parameters<typeof summarizeModelRows>[0]> = {},
) {
  return summarizeModelRows({
    status: "ready",
    effectiveMode: "sota",
    rows,
    ...overrides,
  });
}

describe("model summary grouping", () => {
  test("merges different Profiles of one family and labels by the family table", () => {
    const result = input([
      row({
        rowKey: "a",
        profile: { id: "p-opus-1", name: "Primary", provider: "claude", model: "opus-4" },
      }),
      row({
        rowKey: "b",
        profile: { id: "p-opus-2", name: "Backup", provider: "omp", model: "cursor/opus" },
      }),
      row({
        rowKey: "c",
        profile: { id: "p-deepseek", name: "Cheap", provider: "deepseek", model: "deepseek-coder" },
      }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.groups).toEqual([
      { key: "family:opus", label: "Opus", count: 2 },
      { key: "family:deepseek", label: "DeepSeek", count: 1 },
    ]);
    expect(result.total).toBe(3);
  });

  test("includes the coordinator and a historical escalation row in counts", () => {
    const result = input([
      row({ rowKey: "coordinator", kind: "coordinator", roleId: "lead", activation: "eager" }),
      row({
        rowKey: "standby",
        purpose: "escalation",
        activation: "escalation-only",
        profile: { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "sonnet-4" },
      }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.total).toBe(2);
    expect(result.groups).toEqual(
      expect.arrayContaining([
        { key: "family:sonnet", label: "Sonnet", count: 1 },
        { key: "family:opus", label: "Opus", count: 1 },
      ]),
    );
  });

  test("excludes disabled rows from every count", () => {
    const result = input([
      row({ rowKey: "enabled" }),
      row({ rowKey: "disabled-profile", enabled: false }),
      row({ rowKey: "disabled-unresolved", enabled: false, profile: null }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.total).toBe(1);
    expect(result.unresolved.count).toBe(0);
  });

  test("groups by Profile id when the model id cannot be verified", () => {
    const result = input([
      row({
        rowKey: "a",
        profile: { id: "p-1", name: "Mystery One", provider: "claude", model: "gpt-6" },
      }),
      row({
        rowKey: "b",
        profile: { id: "p-2", name: "Mystery Two", provider: "claude", model: "gpt-6" },
      }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.groups).toEqual([
      { key: "profile:p-1", label: "Mystery One", count: 1 },
      { key: "profile:p-2", label: "Mystery Two", count: 1 },
    ]);
  });

  test("a Profile name that contains a family token does not identify that family", () => {
    const result = input([
      row({ profile: { id: "p-lite", name: "Opus-Lite", provider: "claude", model: "mystery" } }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.groups[0]).toEqual({
      key: "profile:p-lite",
      label: "Opus-Lite",
      count: 1,
    });
  });

  test("does not infer a family from a Profile name when the model is ambiguous", () => {
    const result = input([
      row({
        profile: { id: "p-ambiguous", name: "Sonnet", provider: "claude", model: "opus-sonnet" },
      }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.groups).toEqual([{ key: "profile:p-ambiguous", label: "Sonnet", count: 1 }]);
  });
});

describe("unresolved rows", () => {
  function issue(
    code: string,
    params: Record<string, string> = {},
    severity: "warning" | "blocker" = "blocker",
  ) {
    return { code, severity, params };
  }

  test("classifies the missing reason instead of calling everything unbound", () => {
    expect(unresolvedReasonOf(row({ roleId: null, profile: null }))).toBe("role-missing");
    expect(
      unresolvedReasonOf(
        row({
          profile: null,
          issues: [issue("MODE_PROFILE_UNRESOLVED", { reason: "all-missing" })],
        }),
      ),
    ).toBe("profile-missing");
    expect(
      unresolvedReasonOf(
        row({
          profile: null,
          issues: [issue("MODE_PROFILE_UNRESOLVED", { reason: "provider-unavailable" })],
        }),
      ),
    ).toBe("provider-unavailable");
    expect(unresolvedReasonOf(row({ profile: null, availability: "unverified", issues: [] }))).toBe(
      "unverified",
    );
    expect(unresolvedReasonOf(row({ profile: null, issues: [] }))).toBe("unbound");
    expect(
      unresolvedReasonOf(row({ profile: null, issues: [issue("MODE_POOL_EMPTY", {}, "warning")] })),
    ).toBe("policy");
  });

  test("a binding failure takes precedence over unverified availability", () => {
    for (const [reason, expected] of [
      ["all-missing", "profile-missing"],
      ["provider-unavailable", "provider-unavailable"],
      ["all-excluded", "policy"],
    ] as const) {
      expect(
        unresolvedReasonOf(
          row({
            profile: null,
            availability: "unverified",
            issues: [issue("MODE_PROFILE_UNRESOLVED", { reason })],
          }),
        ),
      ).toBe(expected);
    }
  });

  test("counts unresolved rows, groups reasons, and keeps total equal to enabled rows", () => {
    const rows = [
      row({ rowKey: "a" }),
      row({ rowKey: "b", profile: null }),
      row({
        rowKey: "c",
        profile: null,
        issues: [issue("MODE_PROFILE_UNRESOLVED", { reason: "all-missing" })],
      }),
      row({
        rowKey: "d",
        profile: null,
        availability: "unverified",
        issues: [],
      }),
      row({ rowKey: "e", profile: null, enabled: false }),
    ];
    const result = input(rows);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.unresolved).toEqual({
      count: 3,
      reasons: [
        { reason: "profile-missing", count: 1 },
        { reason: "unbound", count: 1 },
        { reason: "unverified", count: 1 },
      ],
    });
    expect(result.total).toBe(result.groups.reduce((sum, group) => sum + group.count, 0) + 3);
    expect(result.total).toBe(4);
  });
});

describe("summary availability", () => {
  test("an unknown mode yields no summary and keeps the raw value", () => {
    const result = summarizeModelRows({
      status: "blocked",
      effectiveMode: null,
      rawMode: "turbo",
      rows: [row()],
    });
    expect(result).toEqual({ status: "none", reason: "unknown-mode", rawMode: "turbo" });
  });

  test("an unavailable host yields no summary", () => {
    expect(
      summarizeModelRows({
        status: "unavailable",
        effectiveMode: "sota",
        rows: [row()],
      }),
    ).toEqual({ status: "none", reason: "unavailable" });
  });

  test("a blocked plan with a known mode still summarizes its rows", () => {
    const result = input([row({ profile: null })], { status: "blocked" });
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.total).toBe(1);
    expect(result.unresolved.count).toBe(1);
  });

  test("an empty Team is an empty summary, never a fake zero-model claim", () => {
    expect(input([])).toEqual({
      status: "summary",
      total: 0,
      groups: [],
      unresolved: { count: 0, reasons: [] },
    });
  });

  test("sorts by count descending, then label, then key", () => {
    const result = input([
      row({
        rowKey: "a",
        profile: { id: "p-sonnet", name: "S", provider: "claude", model: "sonnet" },
      }),
      row({ rowKey: "b", profile: { id: "p-opus", name: "O", provider: "claude", model: "opus" } }),
      row({
        rowKey: "c",
        profile: { id: "p-opus-2", name: "O2", provider: "claude", model: "opus" },
      }),
    ]);
    expect(result.status).toBe("summary");
    if (result.status !== "summary") return;
    expect(result.groups.map((group) => group.key)).toEqual(["family:opus", "family:sonnet"]);
  });
});
