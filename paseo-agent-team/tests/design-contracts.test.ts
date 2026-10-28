import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { modeIssueText } from "../client/launch/launch-preview-state";
import {
  legacyModeIssue,
  projectJobForContract,
  projectResultForContract,
  projectStatusForContract,
} from "../server/designer/compat";
import { formatDesignIssue } from "../shared/domain/design-output";
import { availableProfileIds } from "../shared/domain/design-planning";
import { TEAM_MODES, teamModeDisplay } from "../shared/domain/mode-contract";
import type { ProfileSelection } from "../shared/domain/mode-resolver";
import { MODE_ISSUE_CODES } from "../shared/domain/role-execution";
import { LABELS } from "../shared/paseo/labels";
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
  exampleCatalogRpc,
  launchStartRpc,
  launchStatusRpc,
} from "../shared/rpc";
import { SlugSchema } from "../shared/schemas/common";
import type { DesignStartOutput } from "../shared/schemas/design";
import {
  DESIGN_ISSUE_CODES,
  DesignCancelInputSchema,
  DesignContinueInputSchema,
  DesignIssueSchema,
  DesignMarkSavedInputSchema,
  DesignPrepareSaveInputSchema,
  DesignResultInputSchema,
  DesignSaveFailedInputSchema,
  DesignStartInputSchema,
  DesignStatusInputSchema,
} from "../shared/schemas/design";
import { ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { preferencesSettings, rolesSettings, teamsSettings } from "../shared/settings";
import { launchModeZh, zh } from "../shared/zh";
import { DESIGN_ISSUE_KEY_BY_CODE, designZh } from "../shared/zh/design";
import { designGapZh } from "../shared/zh/design-gap";
import { launchContractZh } from "../shared/zh/launch-contract";
import { cheapIssueText } from "../shared/zh/mode-plan";
import { modesZh } from "../shared/zh/modes";
import { teamPlanZh } from "../shared/zh/team-plan";
import {
  DESIGN_CLIENT_REQUEST_ID,
  DESIGN_HASH,
  DESIGN_JOB_ID,
  DESIGN_LEASE_ID,
  DESIGN_STATE_REVISION,
  designJob,
  designResult,
} from "./design-fixtures";

const failures = { ok: false, issues: [], job: null };

/** Literal copy of 75ec305's Job/Result shapes: three legacy modes, no contract-2 fields. */
const baselineMode = z.enum(["sota", "economy", "collaborative"]);
const baselineJob = z.object({
  jobId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  stateRevision: z.string().uuid(),
  state: z.enum([
    "starting",
    "designing",
    "validating",
    "fixing",
    "ready",
    "saving",
    "saved",
    "needs_continue",
    "save_conflict",
    "canceling",
    "canceled",
    "failed",
  ]),
  attempt: z.number().int().min(0).max(3),
  mode: baselineMode,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  requestExcerpt: z.string(),
  agentId: z.string().uuid(),
  agentCreated: z.boolean(),
  carrierWorkspaceId: z.string().min(1).max(256).nullable(),
  targetWorkspaceId: z.string().min(1).max(256).nullable(),
  designerProfile: z
    .object({
      id: z.string().min(1).max(256),
      name: z.string(),
      provider: z.string().min(1).max(256),
      model: z.string().optional(),
      modeId: z.string().optional(),
      thinkingOptionId: z.string().optional(),
    })
    .nullable(),
  agentStatus: z.enum(["initializing", "idle", "running", "closed", "error"]).nullable(),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable(),
  pendingPermissions: z.array(
    z.object({
      id: z.string().min(1).max(256),
      kind: z.enum(["tool", "plan", "question", "mode", "other"]),
      title: z.string(),
      description: z.string().optional(),
    }),
  ),
  permissionsTruncated: z.boolean(),
  resultId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  savedTeamId: SlugSchema.nullable(),
  saveState: z.enum(["none", "roles-only", "committed", "unknown"]),
  cancelRequested: z.boolean(),
  needsCleanup: z.boolean(),
  issues: z.array(DesignIssueSchema),
  issuesTruncated: z.number().int().nonnegative(),
  recovered: z.boolean(),
  saveLeaseExpiresAt: z.string().datetime().nullable(),
  allowed: z.object({
    cancel: z.boolean(),
    save: z.boolean(),
    launch: z.boolean(),
    continueAction: z.enum(["recheck", "repair"]).nullable(),
  }),
});

const baselineResult = z.object({
  version: z.literal(1),
  jobId: z.string().uuid(),
  resultId: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().min(1).max(3),
  materializedAt: z.string().datetime(),
  request: z.string(),
  mode: baselineMode,
  summary: z.string(),
  carrierWorkspaceId: z.string().min(1).max(256),
  targetWorkspaceId: z.string().min(1).max(256).nullable(),
  team: TeamSchema,
  newRoles: z.array(RoleSchema),
  reuse: z.array(
    z.object({
      roleId: SlugSchema,
      behaviorHash: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string(),
    }),
  ),
  memberReasons: z.array(
    z.object({
      target: z.union([z.literal("coordinator"), z.string().regex(/^m[1-9][0-9]?$/)]),
      logicalSeatId: z.string().min(1).max(256),
      reason: z.string(),
      expectedProfileIds: z.array(z.string().min(1).max(256)),
    }),
  ),
  preview: ModeLaunchPreviewSchema,
  planningFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  warnings: z.array(DesignIssueSchema),
});

const baselineFailure = z.object({
  ok: z.literal(false),
  issues: z.array(DesignIssueSchema),
  issuesTruncated: z.number().int().nonnegative(),
  job: baselineJob.nullable(),
});

const baselineStatusSuccess = z.object({
  ok: z.literal(true),
  scopeId: z.string().uuid(),
  jobs: z.array(baselineJob),
  truncated: z.boolean(),
  discoveryIssues: z.array(DesignIssueSchema),
});

describe("planning port", () => {
  test("standby selections contribute no expected Profile IDs", () => {
    const ready: ProfileSelection = {
      unavailable: false,
      profile: { id: "p1", name: "Profile 1", provider: "claude" },
      source: "role-preferred",
      budget: "sota",
      budgetBasis: "host",
      standby: false,
      issues: [],
    };
    const standby: ProfileSelection = {
      unavailable: true,
      profile: null,
      source: "unavailable",
      budget: "unknown",
      budgetBasis: "conservative-default",
      standby: true,
      issues: [],
    };

    expect(
      availableProfileIds([ready, standby, { ...ready, profile: { ...ready.profile, id: "p2" } }]),
    ).toEqual(["p1", "p2"]);
  });
});

describe("design RPC contracts", () => {
  test("the eight wire names are fixed", () => {
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
  });

  test("every RPC has strict input, output, and a discriminated failure reply", () => {
    const rpcInputs = [
      [designStartRpc.input, { clientRequestId: DESIGN_JOB_ID, request: "改版" }],
      [designStatusRpc.input, {}],
      [designResultRpc.input, { jobId: DESIGN_JOB_ID }],
      [
        designPrepareSaveRpc.input,
        { jobId: DESIGN_JOB_ID, resultId: DESIGN_HASH, clientId: DESIGN_CLIENT_REQUEST_ID },
      ],
      [designMarkSavedRpc.input, { jobId: DESIGN_JOB_ID, resultId: DESIGN_HASH }],
      [
        designSaveFailedRpc.input,
        {
          jobId: DESIGN_JOB_ID,
          resultId: DESIGN_HASH,
          leaseId: DESIGN_LEASE_ID,
          phase: "roles",
          reason: "write-failed",
        },
      ],
      [designCancelRpc.input, { jobId: DESIGN_JOB_ID }],
      [
        designContinueRpc.input,
        { jobId: DESIGN_JOB_ID, expectedRevision: DESIGN_STATE_REVISION, action: "recheck" },
      ],
    ] as const;

    for (const [schema, input] of rpcInputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, extra: true }).success).toBe(false);
    }

    for (const rpc of [
      designStartRpc,
      designStatusRpc,
      designResultRpc,
      designPrepareSaveRpc,
      designMarkSavedRpc,
      designSaveFailedRpc,
      designCancelRpc,
      designContinueRpc,
    ]) {
      expect(rpc.output.safeParse(failures).success).toBe(true);
    }
  });

  test("success payloads parse and infer the documented types", () => {
    const job = designJob();
    const startOutput: DesignStartOutput = designStartRpc.output.parse({
      ok: true,
      job,
    });
    expect(startOutput).toMatchObject({ ok: true, job: { jobId: DESIGN_JOB_ID } });

    expect(
      designStatusRpc.output.parse({
        ok: true,
        scopeId: DESIGN_JOB_ID,
        jobs: [job],
        truncated: false,
        discoveryIssues: [],
      }),
    ).toMatchObject({ ok: true });
    expect(
      designResultRpc.output.parse({
        ok: true,
        job,
        request: "改版",
        result: designResult(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      designPrepareSaveRpc.output.parse({
        ok: true,
        prepared: { outcome: "already-saved", job },
      }),
    ).toMatchObject({ ok: true });
    for (const rpc of [
      designMarkSavedRpc,
      designSaveFailedRpc,
      designCancelRpc,
      designContinueRpc,
    ]) {
      expect(rpc.output.parse({ ok: true, job })).toMatchObject({ ok: true });
    }
  });

  test("input schemas are the exported strict objects, not loose duplicates", () => {
    expect(designStartRpc.input).toBe(DesignStartInputSchema);
    expect(designStatusRpc.input).toBe(DesignStatusInputSchema);
    expect(designResultRpc.input).toBe(DesignResultInputSchema);
    expect(designPrepareSaveRpc.input).toBe(DesignPrepareSaveInputSchema);
    expect(designMarkSavedRpc.input).toBe(DesignMarkSavedInputSchema);
    expect(designSaveFailedRpc.input).toBe(DesignSaveFailedInputSchema);
    expect(designCancelRpc.input).toBe(DesignCancelInputSchema);
    expect(designContinueRpc.input).toBe(DesignContinueInputSchema);
  });

  test("every issue code has Chinese copy", () => {
    expect(Object.keys(DESIGN_ISSUE_KEY_BY_CODE).sort()).toEqual([...DESIGN_ISSUE_CODES].sort());
    for (const code of DESIGN_ISSUE_CODES) {
      expect(designZh[DESIGN_ISSUE_KEY_BY_CODE[code]]).toBeTypeOf("string");
    }
  });
});

describe("shared boundary", () => {
  test("shared imports neither Node, React, nor @getpaseo/client", () => {
    const root = join(import.meta.dirname, "..", "shared");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);

    const forbidden =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:node:[^"']+|react(?:\/[^"']*)?|@getpaseo\/client(?:\/[^"']*)?)["']/;
    const violations = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));

    expect(files.length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  });

  test("existing RPC names, settings ids, and labels stay unchanged", () => {
    expect([
      launchStartRpc.name,
      launchStatusRpc.name,
      exampleCatalogRpc.name,
      defaultCatalogPreviewRpc.name,
    ]).toEqual([
      "agent-team.launch.start",
      "agent-team.launch.status",
      "agent-team.templates.examples",
      "agent-team.templates.defaults.preview",
    ]);
    expect([rolesSettings.id, teamsSettings.id, preferencesSettings.id]).toEqual([
      "agent-team-roles",
      "agent-team-teams",
      "agent-team-preferences",
    ]);
    expect(LABELS).toMatchObject({
      run: "agent-team.run",
      team: "agent-team.team",
      teamName: "agent-team.team-name",
      role: "agent-team.role",
      roleName: "agent-team.role-name",
      instance: "agent-team.instance",
      kind: "agent-team.kind",
      task: "agent-team.task",
    });
  });

  test("zh exposes the designer copy and the contribution has no global Paseo API", () => {
    expect(zh.design).toBe(designZh);
    const source = readFileSync(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
    expect(source).not.toMatch(/server\.paseo\b/);
    expect(source).not.toMatch(/server\.before\s*\(/);
  });

  test("zh.modes merges the launch copy and modesZh without shadowing keys", () => {
    // Two disjoint source maps: a duplicate key would let one side silently replace the other.
    expect(Object.keys(launchModeZh).filter((key) => Object.hasOwn(modesZh, key))).toEqual([]);
    const merged = zh.modes as Record<string, unknown>;
    for (const [key, value] of Object.entries(modesZh)) expect(merged[key]).toBe(value);
    for (const [key, value] of Object.entries(launchModeZh)) expect(merged[key]).toBe(value);
    // Dead labels are gone; the stored values only exist in `modeLabels`.
    for (const dead of ["sota", "economy", "collaborative"]) {
      expect(merged).not.toHaveProperty(dead);
    }
    expect(zh).not.toHaveProperty("teamModeEconomy");
    expect(zh).not.toHaveProperty("teamModeEconomyHint");
  });

  test("zh aggregates the design gap and team plan copy in their own namespaces", () => {
    expect(zh.designGap).toBe(designGapZh);
    expect(zh.teamPlan).toBe(teamPlanZh);
    const keys = Object.keys(zh);
    expect(new Set(keys).size).toBe(keys.length);
    expect(zh.modes.collaborationRuntimeUnavailable).toContain(modesZh.modeLabels.flagship);
    expect(zh.modes.collaborationRuntimeUnavailable).toContain(modesZh.modeLabels.standard);
    expect(zh.modes.collaborationRuntimeUnavailable).not.toContain("SOTA 或标准");
  });

  test("mode labels come from the one display table", () => {
    expect(zh.teamModeSota).toBe(modesZh.modeLabels.flagship);
    expect(zh.teamModeCollaborative).toBe(modesZh.modeLabels.collaborative);
    for (const mode of TEAM_MODES) {
      expect(designZh.modes[mode]).toBe(modesZh.modeLabels[teamModeDisplay(mode)]);
    }
    expect(designZh.modes.economy).toBe("标准");
    expect(designZh.modes["economy-all"]).toBe("经济");
  });

  test("the standard-pool empty state names the standard mode, never economy-all", () => {
    expect(zh.economyPoolEmpty).toContain(modesZh.modeLabels.standard);
    expect(zh.economyPoolEmpty).not.toContain("经济模式");
    // The old copy claimed the standard pool gated the mode; the standard mode can fall back.
    expect(zh.economyPoolEmpty).not.toContain("才可使用");
    expect(zh.modes.collaborationRuntimeUnavailable).toContain(modesZh.modeLabels.standard);
    expect(zh.modes.collaborationRuntimeUnavailable).not.toContain("经济模式");
  });

  test("renamed-mode copy avoids raw stored values and the old economy-only wording", () => {
    expect(zh.memberCreationHint).toContain(
      `${modesZh.modeLabels.standard}/${modesZh.modeLabels.economy}/${modesZh.modeLabels.collaborative}`,
    );
    expect(zh.memberCreationHint).not.toContain("；经济/协作");

    const teamGate = launchContractZh.modeRequired("team", "economy-all");
    expect(teamGate).toContain(modesZh.modeLabels.economy);
    expect(teamGate).not.toContain("economy-all");
    const requestGate = launchContractZh.modeRequired("request", "economy-all");
    expect(requestGate).toContain("本次运行模式");
    expect(requestGate).not.toContain("economy-all");

    // A damaged Team is not a stale page: say so instead of claiming an update is required.
    const unknownGate = launchContractZh.modeRequired("team", "turbo");
    expect(unknownGate).toContain("无法识别");
    expect(unknownGate).toContain("Team 编辑器");
    expect(unknownGate).not.toContain("更新插件");
    expect(launchContractZh.refreshHint).not.toContain("插件已更新");
    expect(launchContractZh.refreshHint).toContain("刷新页面");
  });

  test("the new-Role limit copy reads 0, 3, and a legacy missing limit", () => {
    const message = (params: Record<string, string | number>) =>
      formatDesignIssue({
        code: "DESIGN_NEW_ROLE_LIMIT",
        severity: "error",
        path: [],
        params,
        action: "repair",
      });
    expect(message({ limit: 0 })).toContain("上限0");
    expect(message({ limit: 0 })).not.toContain("3");
    expect(message({ limit: 3 })).toContain("上限3");
    const legacy = message({});
    expect(legacy).not.toContain("{limit}");
    expect(legacy).toContain("上限");
    expect(legacy).not.toContain("3");
  });

  test("every MODE_ISSUE_CODES entry renders real copy, not the fallback", () => {
    const params = {
      route: "execution",
      reason: "no-eligible",
      profileId: "p",
      provider: "omp",
      field: "mode",
      value: "turbo",
      count: 2,
      limit: 1,
      members: 2,
      families: 1,
      requested: 2,
      kind: "coding",
      instanceLabel: "A",
      roleId: "r",
      seatId: "s",
    };
    for (const code of MODE_ISSUE_CODES) {
      const issue = { code, severity: "blocker" as const, params };
      if (code === "MODE_PLAN_CHANGED") {
        // Declared but never emitted yet; the copy exists, while the renderer case lives in
        // client/launch/launch-preview-state.ts (I02). Tracked as a stage-2/I02 handoff.
        expect(zh.modes.planChanged.length).toBeGreaterThan(0);
        continue;
      }
      const text = code.startsWith("MODE_CHEAP_")
        ? cheapIssueText(issue)
        : modeIssueText(issue as Parameters<typeof modeIssueText>[0]);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe(zh.modes.unknownFallback(code));
    }
  });

  test("all eight design RPC objects take an optional integer contractVersion", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    const hash = "a".repeat(64);
    const cases = [
      [designStartRpc, { clientRequestId: uuid, request: "设计一个团队" }],
      [designStatusRpc, {}],
      [designResultRpc, { jobId: uuid }],
      [designPrepareSaveRpc, { jobId: uuid, resultId: hash, clientId: uuid }],
      [designMarkSavedRpc, { jobId: uuid, resultId: hash }],
      [
        designSaveFailedRpc,
        { jobId: uuid, resultId: hash, leaseId: uuid, phase: "team", reason: "unknown" },
      ],
      [designCancelRpc, { jobId: uuid }],
      [designContinueRpc, { jobId: uuid, expectedRevision: uuid, action: "recheck" }],
    ] as const;
    for (const [rpc, input] of cases) {
      expect(rpc.input.safeParse(input).success, rpc.name).toBe(true);
      expect(rpc.input.safeParse({ ...input, contractVersion: 2 }).success, rpc.name).toBe(true);
      expect(rpc.input.safeParse({ ...input, contractVersion: 2.5 }).success, rpc.name).toBe(false);
      expect(rpc.input.safeParse({ ...input, contractVersion: "2" }).success, rpc.name).toBe(false);
    }
  });

  test("design.start takes an optional integer contractVersion", () => {
    // The object-layer matrix above covers all eight; this pins the start shape itself.
    const input = { clientRequestId: DESIGN_CLIENT_REQUEST_ID, request: "设计一个团队" };
    expect(designStartRpc.input.parse(input)).toMatchObject({ request: "设计一个团队" });
    expect(designStartRpc.input.parse({ ...input, contractVersion: 2 })).toMatchObject({
      contractVersion: 2,
    });
    expect(() => designStartRpc.input.parse({ ...input, contractVersion: 2.5 })).toThrow();
  });
});

describe("contract-1 projections against the frozen 75ec305 DTOs", () => {
  test("the baseline Job schema cannot parse a v2 economy-all job", () => {
    const job = designJob({ mode: "economy-all" });
    expect(baselineJob.safeParse(job).success).toBe(false);
  });

  test("a projected v2 job parses and loses every new field", () => {
    const job = designJob({
      mode: "sota",
      existingRolesOnly: true,
      outputContractVersion: 2,
      roleGap: null,
      gapRetry: { request: "原需求", profileId: null, useDefaultProfileHints: false },
    });
    const projected = projectJobForContract(job, 1);
    expect(projected).not.toHaveProperty("existingRolesOnly");
    expect(projected).not.toHaveProperty("outputContractVersion");
    expect(projected).not.toHaveProperty("roleGap");
    expect(projected).not.toHaveProperty("gapRetry");
    expect(baselineJob.safeParse(projected).success).toBe(true);
  });

  test("a legacy list hides the v2 job, sets truncated, and adds the refresh issue", () => {
    const visible = designJob({
      jobId: "aaaaaaaa-0000-4000-8000-000000000001",
      mode: "sota",
    });
    const hidden = designJob({
      jobId: "aaaaaaaa-0000-4000-8000-000000000002",
      mode: "economy-all",
    });
    const projected = projectStatusForContract(
      { jobs: [visible, hidden], truncated: false, discoveryIssues: [] },
      1,
    );
    expect(projected.jobs.map((job) => job.jobId)).toEqual([visible.jobId]);
    expect(projected.truncated).toBe(true);
    expect(projected.discoveryIssues).toEqual([
      expect.objectContaining({
        code: "DESIGN_MODE_UNAVAILABLE",
        action: "refresh",
        params: expect.objectContaining({ reason: "hidden-by-contract", hidden: 1 }),
      }),
    ]);
    expect(
      baselineStatusSuccess.safeParse({
        ok: true,
        scopeId: DESIGN_JOB_ID,
        jobs: projected.jobs,
        truncated: projected.truncated,
        discoveryIssues: projected.discoveryIssues,
      }).success,
    ).toBe(true);
  });

  test("a by-id refusal parses as the baseline failure with no job", () => {
    const refusal = {
      ok: false as const,
      issues: [legacyModeIssue("economy-all")],
      issuesTruncated: 0,
      job: null,
    };
    expect(baselineFailure.safeParse(refusal).success).toBe(true);
    expect(refusal.job).toBeNull();
  });

  test("the projected result still parses with the baseline Result schema", () => {
    const projected = projectResultForContract(designResult());
    expect(projected).not.toBeNull();
    expect(baselineResult.safeParse(projected).success).toBe(true);
  });
});
