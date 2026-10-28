import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  defaultCatalogPreviewRpc,
  designCancelRpc,
  designContinueRpc,
  designMarkSavedRpc,
  designPrepareSaveRpc,
  designResultRpc,
  designSaveFailedRpc,
  designStartRpc,
  designStatusRpc,
  emptyTeamPlanProbe,
  exampleCatalogRpc,
  type LaunchJob,
  LaunchPreviewInputSchema,
  LaunchStartInputSchema,
  launchPreviewRpc,
  launchStartRpc,
  launchStatusRpc,
  projectLaunchJobForLegacyPeer,
  teamPlanRpc,
} from "../shared/rpc";
import { launchContractZh } from "../shared/zh/launch-contract";

/** Literal copy of 75ec305's `LaunchJobSchema` (three-mode enum, strip object). */
const baselineTeamMode = z.enum(["sota", "economy", "collaborative"]);
const baselineLaunchJob = z.object({
  runId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  state: z.enum(["running", "succeeded", "failed"]),
  step: z.enum(["workspace", "coordinator", "member", "kickoff", "done"]),
  memberIndex: z.number().int().optional(),
  memberTotal: z.number().int(),
  workspaceId: z.string().optional(),
  coordinatorId: z.string().optional(),
  memberIds: z.array(z.string()),
  warnings: z.array(z.string()),
  error: z
    .object({
      message: z.string(),
      detail: z.string().optional(),
      step: z.enum(["workspace", "coordinator", "member", "kickoff", "done"]),
      archived: z.boolean(),
      agentIdsKept: z.array(z.string()),
      kickoffMessage: z.string().optional(),
    })
    .optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  mode: baselineTeamMode.optional(),
  planHash: z.string().optional(),
});

const legacyJob: LaunchJob = {
  runId: "run-legacy",
  teamId: "team-1",
  teamName: "Legacy",
  state: "succeeded",
  step: "done",
  memberTotal: 1,
  memberIds: ["m1"],
  warnings: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  mode: "economy",
};

const newModeJob: LaunchJob = {
  runId: "run-new",
  teamId: "team-2",
  teamName: "New",
  state: "running",
  step: "coordinator",
  memberTotal: 1,
  memberIds: ["m1"],
  warnings: ["starting"],
  startedAt: "2026-01-01T00:00:00.000Z",
  mode: "economy-all",
  rawMode: "future",
  planHash: "abc",
};

/** Literal copy of 75ec305's strict preview DTOs, enough for one legacy seat. */
const baselineSeatProfile = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  provider: z.string().min(1),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
const baselineSeatPreview = z.strictObject({
  seatId: z.string().min(1),
  logicalSeatId: z.string().min(1),
  roleId: z.string().min(1),
  roleName: z.string(),
  instanceLabel: z.string().optional(),
  purpose: z.enum(["member", "candidate", "judge", "escalation"]),
  activation: z.enum(["eager", "on-demand", "escalation-only"]),
  cohortId: z.string().optional(),
  profile: baselineSeatProfile.nullable(),
  source: z.enum(["role-preferred", "role-fallback", "economy-pool", "unavailable"]),
  family: z.string().optional(),
  alternates: z.array(z.string()),
  budget: z.enum(["economy", "sota", "unknown"]),
  budgetBasis: z.enum(["host", "pool", "conservative-default"]),
  standby: z.boolean(),
  unavailable: z.boolean(),
  issues: z.array(
    z.strictObject({
      code: z.string(),
      severity: z.enum(["warning", "blocker"]),
      roleId: z.string().optional(),
      seatId: z.string().optional(),
      profileId: z.string().optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    }),
  ),
});
const baselineCoordinator = z.strictObject({
  roleId: z.string().min(1),
  roleName: z.string(),
  profile: baselineSeatProfile.nullable(),
  source: z.enum(["role-preferred", "role-fallback", "unavailable"]),
  budget: z.enum(["economy", "sota", "unknown"]).optional(),
  budgetBasis: z.enum(["host", "pool", "conservative-default"]).optional(),
  issues: z.array(z.object({}).passthrough()),
});
const baselineLaunchPreview = z.strictObject({
  requestedMode: baselineTeamMode,
  coordinator: baselineCoordinator,
  seats: z.array(baselineSeatPreview),
  counts: z.strictObject({
    logical: z.number().int().min(0),
    physical: z.number().int().min(0),
    eager: z.number().int().min(0),
    deferred: z.number().int().min(0),
    escalation: z.number().int().min(0),
    sotaPotential: z.number().int().min(0),
  }),
  budget: z.strictObject({
    economy: z.number().int().min(0),
    sota: z.number().int().min(0),
    unknown: z.number().int().min(0),
    deferredSota: z.number().int().min(0),
  }),
  issues: z.array(z.object({}).passthrough()),
  warnings: z.array(z.string()),
  planHash: z.string().min(1).max(128),
});

const legacyPreview = {
  requestedMode: "economy" as const,
  coordinator: {
    roleId: "lead",
    roleName: "Lead",
    profile: { id: "p1", name: "P1", provider: "claude" },
    source: "role-preferred" as const,
    budget: "sota" as const,
    budgetBasis: "host" as const,
    issues: [],
  },
  seats: [
    {
      seatId: "seat-m1",
      logicalSeatId: "logical-m1",
      roleId: "eng",
      roleName: "Eng",
      purpose: "member" as const,
      activation: "eager" as const,
      profile: { id: "p2", name: "P2", provider: "omp" },
      source: "role-preferred" as const,
      alternates: [],
      budget: "economy" as const,
      budgetBasis: "pool" as const,
      standby: false,
      unavailable: false,
      issues: [],
    },
  ],
  counts: { logical: 1, physical: 1, eager: 1, deferred: 0, escalation: 0, sotaPotential: 0 },
  budget: { economy: 1, sota: 0, unknown: 0, deferredSota: 0 },
  issues: [],
  warnings: [],
  planHash: "hash",
};

describe("plugin RPC contracts", () => {
  test("method names are part of the client/server protocol, so they stay fixed", () => {
    expect(launchStartRpc.name).toBe("agent-team.launch.start");
    expect(launchPreviewRpc.name).toBe("agent-team.launch.preview");
    expect(launchStatusRpc.name).toBe("agent-team.launch.status");
    for (const name of [
      launchStartRpc.name,
      launchPreviewRpc.name,
      launchStatusRpc.name,
      exampleCatalogRpc.name,
      defaultCatalogPreviewRpc.name,
      designStartRpc.name,
      designStatusRpc.name,
      designResultRpc.name,
      designPrepareSaveRpc.name,
      designMarkSavedRpc.name,
      designSaveFailedRpc.name,
      designCancelRpc.name,
      designContinueRpc.name,
    ]) {
      expect(name).toMatch(/^[a-z][a-z0-9._-]*$/);
    }
    expect(exampleCatalogRpc.name).toBe("agent-team.templates.examples");
    expect(defaultCatalogPreviewRpc.name).toBe("agent-team.templates.defaults.preview");
  });

  test("the eight design RPCs are re-exported from the main shared/rpc entry", () => {
    expect([
      designStartRpc.name,
      designStatusRpc.name,
      designResultRpc.name,
      designPrepareSaveRpc.name,
      designMarkSavedRpc.name,
      designSaveFailedRpc.name,
      designCancelRpc.name,
      designContinueRpc.name,
    ]).toEqual([
      "agent-team.design.start",
      "agent-team.design.status",
      "agent-team.design.result",
      "agent-team.design.prepare-save",
      "agent-team.design.mark-saved",
      "agent-team.design.save-failed",
      "agent-team.design.cancel",
      "agent-team.design.continue",
    ]);
    expect(new Set([designStartRpc, designStatusRpc, designResultRpc]).size).toBe(3);
  });

  test("a launch needs a Team, a task, and a target", () => {
    const valid = {
      teamId: "coding-team",
      task: "  Add Stripe  ",
      target: { kind: "workspace", workspaceId: "ws-1" },
    };
    expect(LaunchStartInputSchema.parse(valid).task).toBe("Add Stripe");
    expect(() => LaunchStartInputSchema.parse({ ...valid, task: "   " })).toThrow();
    expect(() => LaunchStartInputSchema.parse({ ...valid, teamId: "" })).toThrow();
    expect(() => LaunchStartInputSchema.parse({ ...valid, target: undefined })).toThrow();
    expect(() =>
      LaunchStartInputSchema.parse({ ...valid, target: { kind: "elsewhere" } }),
    ).toThrow();
    expect(() =>
      LaunchStartInputSchema.parse({ ...valid, target: { kind: "workspace", workspaceId: "" } }),
    ).toThrow();
  });

  test("launch mode and preview hash are optional but validated", () => {
    const valid = {
      teamId: "coding-team",
      task: "Add Stripe",
      target: { kind: "workspace", workspaceId: "ws-1" },
    };
    expect(LaunchStartInputSchema.parse(valid)).toEqual(valid);
    expect(LaunchStartInputSchema.parse({ ...valid, mode: "economy" }).mode).toBe("economy");
    expect(
      LaunchStartInputSchema.parse({ ...valid, expectedPlanHash: "a".repeat(64) }).expectedPlanHash,
    ).toBe("a".repeat(64));
    expect(() => LaunchStartInputSchema.parse({ ...valid, mode: "future" })).toThrow();
    expect(() => LaunchStartInputSchema.parse({ ...valid, expectedPlanHash: "" })).toThrow();
    expect(LaunchPreviewInputSchema.parse({ ...valid, mode: "collaborative" })).toMatchObject({
      mode: "collaborative",
    });
    expect(LaunchPreviewInputSchema.parse({ ...valid }).teamId).toBe("coding-team");
  });

  test("preview answers with the DTO or readable blockers", () => {
    const hash = "a".repeat(64);
    const preview = {
      requestedMode: "sota",
      coordinator: {
        roleId: "tech-lead",
        roleName: "Tech Lead",
        profile: { id: "p1", name: "Profile", provider: "claude" },
        source: "role-preferred",
        issues: [],
      },
      seats: [],
      counts: { logical: 0, physical: 0, eager: 0, deferred: 0, escalation: 0, sotaPotential: 0 },
      budget: { economy: 0, sota: 0, unknown: 0, deferredSota: 0 },
      issues: [],
      warnings: [],
      planHash: hash,
    };
    expect(launchPreviewRpc.output.parse({ ok: true, preview })).toEqual({ ok: true, preview });
    expect(
      launchPreviewRpc.output.parse({
        ok: false,
        blockers: ["无法启动"],
        warnings: [],
        issues: [],
      }),
    ).toMatchObject({ ok: false });
    expect(() =>
      launchPreviewRpc.output.parse({ ok: true, preview: { ...preview, extra: true } }),
    ).toThrow();
    expect(() =>
      launchPreviewRpc.output.parse({ ok: false, blockers: [], warnings: [] }),
    ).toThrow();
  });

  test("a new workspace takes a bounded, trimmed title", () => {
    const input = (title: string) => ({
      teamId: "t",
      task: "x",
      target: { kind: "new-workspace", projectId: "p1", title },
    });
    expect(LaunchStartInputSchema.parse(input("  Billing ")).target).toMatchObject({
      title: "Billing",
    });
    expect(() => LaunchStartInputSchema.parse(input("x".repeat(81)))).toThrow();
  });

  test("start answers with either a job or the reasons it cannot start", () => {
    expect(
      launchStartRpc.output.parse({ ok: false, blockers: ["Team 不存在。"], warnings: [] }),
    ).toMatchObject({ ok: false });
    expect(() => launchStartRpc.output.parse({ ok: true })).toThrow();
    expect(() => launchStartRpc.output.parse({ ok: false, warnings: [] })).toThrow();
  });

  test("status may report that the run is no longer known", () => {
    expect(launchStatusRpc.output.parse({ job: null })).toEqual({ job: null });
    expect(() => launchStatusRpc.input.parse({ runId: "" })).toThrow();
  });

  test("preset preview is strict, defaults to blocking Profile errors, and requires a discriminated response", () => {
    expect(defaultCatalogPreviewRpc.input.parse({})).toEqual({ allowUnboundOnProfileError: false });
    expect(defaultCatalogPreviewRpc.input.parse({ allowUnboundOnProfileError: true })).toEqual({
      allowUnboundOnProfileError: true,
    });
    expect(() => defaultCatalogPreviewRpc.input.parse({ autoImport: true })).toThrow();
    expect(
      defaultCatalogPreviewRpc.output.parse({
        ok: false,
        blockers: [{ code: "profiles-unavailable", message: "读取失败" }],
      }),
    ).toMatchObject({ ok: false });
    expect(() => defaultCatalogPreviewRpc.output.parse({ ok: false, blockers: [] })).toThrow();
    expect(() => defaultCatalogPreviewRpc.output.parse({ ok: true, roles: [] })).toThrow();
    expect(exampleCatalogRpc.input.parse({})).toEqual({});
    expect(exampleCatalogRpc.output.parse({ roles: [], teams: [] })).toEqual({
      roles: [],
      teams: [],
    });
  });

  test("team.plan is exported once with the zero-read probe shape", () => {
    expect(teamPlanRpc.name).toBe("agent-team.team.plan");
    expect(teamPlanRpc.input.parse(emptyTeamPlanProbe())).toEqual({ items: [] });
    expect(
      teamPlanRpc.input.parse({ items: [{ key: "draft", kind: "draft", draft: { members: [] } }] }),
    ).toMatchObject({ items: [{ key: "draft" }] });
  });

  test("launch.status takes an optional integer contractVersion only", () => {
    expect(launchStatusRpc.input.parse({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(launchStatusRpc.input.parse({ runId: "run-1", contractVersion: 2 })).toEqual({
      runId: "run-1",
      contractVersion: 2,
    });
    expect(launchStatusRpc.input.parse({ runId: "run-1", contractVersion: 3 })).toMatchObject({
      contractVersion: 3,
    });
    expect(() => launchStatusRpc.input.parse({ runId: "run-1", contractVersion: 2.5 })).toThrow();
  });

  test("a new-mode job is projected to the baseline DTO for a legacy poller", () => {
    // 75ec305's literal schema: `mode` only knows the three legacy values and `z.object` strips
    // unknown keys. Without projection the parse fails, which is the counter-proof below.
    expect(baselineLaunchJob.safeParse(newModeJob).success).toBe(false);

    const projected = projectLaunchJobForLegacyPeer(newModeJob);
    expect(projected).not.toBeNull();
    if (projected === null) return;
    expect(projected).not.toHaveProperty("mode");
    expect(projected).not.toHaveProperty("rawMode");
    expect(projected.state).toBe("running");
    expect(projected.step).toBe("coordinator");
    expect(projected.planHash).toBe(newModeJob.planHash);
    expect(projected.warnings).toEqual([...newModeJob.warnings, launchContractZh.refreshHint]);
    expect(baselineLaunchJob.safeParse(projected).success).toBe(true);

    // The stored job is untouched: projection works on a copy.
    expect(newModeJob.mode).toBe("economy-all");
    expect(newModeJob.rawMode).toBe("future");
    // Re-projecting an already hinted job does not duplicate the hint.
    const again = projectLaunchJobForLegacyPeer(projected);
    expect(again?.warnings).toEqual(projected.warnings);
  });

  test("legacy jobs, v2 callers, and null pass the projection through", () => {
    expect(projectLaunchJobForLegacyPeer(null)).toBeNull();
    expect(projectLaunchJobForLegacyPeer(legacyJob)).toBe(legacyJob);
    expect(projectLaunchJobForLegacyPeer(newModeJob, 2)).toBe(newModeJob);
    expect(projectLaunchJobForLegacyPeer(newModeJob, 3)).not.toBe(newModeJob);
    expect(projectLaunchJobForLegacyPeer(newModeJob, 3)).not.toHaveProperty("mode");
  });

  test("a legacy preview still parses with the baseline strict schema", () => {
    expect(baselineLaunchPreview.safeParse(legacyPreview).success).toBe(true);
    // Guard: the baseline schema is strict, so a new field would be caught here.
    expect(
      baselineLaunchPreview.safeParse({
        ...legacyPreview,
        seats: [{ ...legacyPreview.seats[0], route: "execution" }],
      }).success,
    ).toBe(false);
  });
});
