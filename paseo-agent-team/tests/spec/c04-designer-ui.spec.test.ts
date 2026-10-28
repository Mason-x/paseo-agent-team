// C04 designer UI specification: pure submission/switch/contract/gap/retry behavior from the
// public client modules. No React renderer is used; component-only wiring is noted in the report.
// Expectations come from 01 AC-0c.1/3/8–11/13–14, 04 §6.3 (H2=A, H3=B) and 89 K1–K7.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveStartBlock } from "../../client/designer/card-state";
import {
  designContractFields,
  designModeNeedsV2,
  prepareDesignStartInput,
  withDesignContract,
} from "../../client/designer/design-gateway";
import {
  shouldAutoSaveDesignJob,
  shouldCleanupDesignJob,
} from "../../client/designer/design-screen-state";
import {
  applyDesignPrefill,
  buildDesignRoleGapViews,
  buildDesignStartInput,
  createDesignRetryCache,
  createDesignSubmissionState,
  designJobRulesLabel,
  editDesignDraft,
  fingerprintDesignStartInput,
  planDesignGapRetry,
  planDesignSubmission,
  readGapRetrySeed,
  settleDesignSubmission,
  shouldConfirmDraftReplace,
} from "../../client/designer/submission-state";
import { withContractOnSaveRpcs } from "../../client/designer/use-design-save";
import { checkDesignRequest } from "../../shared/domain/design-request";
import {
  type DesignJob,
  DesignJobSchema,
  type DesignStartInput,
  type RoleGapReport,
} from "../../shared/schemas/design";
import { designGapZh } from "../../shared/zh/design-gap";
import { DESIGN_CLIENT_REQUEST_ID, designJob } from "../design-fixtures";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const NEW_REQUEST = "55555555-5555-4555-8555-555555555555";

const missingRole: RoleGapReport = {
  responsibility: "数据库迁移评审",
  reason: "现有 Role 不承担迁移评审。",
  use: "member",
  profiles: [
    { id: "p-sonnet", name: "服务端确认的 Sonnet", provider: "claude", model: "claude-sonnet-5" },
  ],
  suggestedRole: {
    id: "qa-migration",
    name: "【质量】迁移评审",
    responsibilities: ["评审迁移脚本", "确认可回滚"],
    executionPolicy: { tier: "decision", taskKind: "general" },
  },
};

const unlaunchable: RoleGapReport = {
  responsibility: "代码实现",
  reason: "现有实现 Role 的绑定不可用。",
  use: "member",
  profiles: [],
  profileGapReason: "host 没有合适的 Profile。",
  unlaunchableRole: {
    roleId: "eng-fullstack",
    roleName: "全栈工程师",
    unavailableProfileIds: ["p-gone", "p-down"],
    profileNames: ["已下线的 DeepSeek", "不可用的 Grok"],
  },
};

function gapJob(overrides: Partial<DesignJob> = {}): DesignJob {
  return designJob({
    state: "failed",
    mode: "sota",
    existingRolesOnly: true,
    outputContractVersion: 2,
    roleGap: [missingRole, unlaunchable],
    resultId: null,
    carrierWorkspaceId: "ws-carrier",
    targetWorkspaceId: "ws-target",
    allowed: { cancel: false, save: false, launch: false, continueAction: null },
    ...overrides,
  });
}

describe("AC-0c.1 / H2=A: the switch is on for every new draft and is never remembered", () => {
  test("new state, /team-design prefill, and an accepted request all reset to on", () => {
    expect(createDesignSubmissionState().draftState.draft.existingRolesOnly).toBe(true);

    let state = createDesignSubmissionState({ request: "旧需求" });
    state = editDesignDraft(state, { existingRolesOnly: false });
    expect(state.draftState.draft.existingRolesOnly).toBe(false);
    expect(
      createDesignSubmissionState({ request: "新卡片" }).draftState.draft.existingRolesOnly,
    ).toBe(true);

    const prefilled = applyDesignPrefill(state, { request: "斜杠命令", workspaceId: null });
    expect(prefilled.draftState.draft.existingRolesOnly).toBe(true);

    let accepted = createDesignSubmissionState({ request: "需求" });
    accepted = editDesignDraft(accepted, { existingRolesOnly: false });
    const planned = planDesignSubmission(accepted, () => JOB_ID);
    if (planned.kind !== "send") throw new Error("expected send");
    const settled = settleDesignSubmission(planned.state, {
      clientRequestId: JOB_ID,
      seq: planned.command.seq,
      outcome: "accepted",
    });
    expect(settled.cleared).toBe(true);
    expect(settled.state.draftState.draft).toMatchObject({
      request: "",
      existingRolesOnly: true,
    });
  });

  test("a job in flight shows its stored rule; missing means the legacy rule", () => {
    expect(designJobRulesLabel({ existingRolesOnly: true })).toBe(designGapZh.rulesOnly);
    expect(designJobRulesLabel({ existingRolesOnly: false })).toBe(designGapZh.rulesMax3);
    expect(designJobRulesLabel({ existingRolesOnly: undefined })).toBe(designGapZh.rulesLegacy);
  });
});

describe("AC-0c.9 / AC-0c.10: the switch reaches the request and the fingerprint", () => {
  test("start input always carries an explicit boolean; the fingerprint includes it", () => {
    const on = buildDesignStartInput(
      createDesignSubmissionState({ request: "需求" }).draftState.draft,
      JOB_ID,
    );
    const off = buildDesignStartInput(
      {
        ...createDesignSubmissionState({ request: "需求" }).draftState.draft,
        existingRolesOnly: false,
      },
      JOB_ID,
    );
    if (!on.ok || !off.ok) throw new Error("request must be valid");
    expect(on.input.existingRolesOnly).toBe(true);
    expect(off.input.existingRolesOnly).toBe(false);

    const base = {
      request: "需求",
      mode: "sota" as const,
      workspaceId: "ws-1",
      profileId: "p-1",
    };
    const omitted = fingerprintDesignStartInput(base);
    expect(fingerprintDesignStartInput({ ...base, existingRolesOnly: true })).toBe(omitted);
    expect(fingerprintDesignStartInput({ ...base, existingRolesOnly: false })).not.toBe(omitted);
  });
});

describe("K1 / AC-0d.23: all eight design RPCs carry the contract only on v2", () => {
  const start: DesignStartInput = {
    clientRequestId: JOB_ID,
    request: "需求",
    mode: "economy-all",
    existingRolesOnly: false,
  };

  test("start: v2 adds contractVersion and keeps the explicit rule", () => {
    const v2 = prepareDesignStartInput({ ...start, existingRolesOnly: undefined }, "v2");
    expect(v2).toMatchObject({ contractVersion: 2, existingRolesOnly: true });
  });

  test("legacy and unknown send neither contractVersion nor existingRolesOnly", () => {
    for (const support of ["legacy", "unknown"] as const) {
      const sent = prepareDesignStartInput({ ...start, contractVersion: 2 }, support);
      expect(sent, support).not.toHaveProperty("contractVersion");
      expect(sent, support).not.toHaveProperty("existingRolesOnly");
      expect(sent, support).toMatchObject({ mode: "economy-all", request: "需求" });
    }
  });

  test("status, result, cancel and continue share the same single-field gate", () => {
    const inputs: [string, Record<string, unknown>][] = [
      ["status", {}],
      ["statusById", { jobId: JOB_ID }],
      ["result", { jobId: JOB_ID }],
      ["cancel", { jobId: JOB_ID }],
      ["continue", { jobId: JOB_ID, expectedRevision: JOB_ID, action: "recheck" }],
    ];
    for (const [label, input] of inputs) {
      expect(withDesignContract(input, "v2"), label).toMatchObject({ contractVersion: 2 });
      expect(withDesignContract(input, "legacy"), label).not.toHaveProperty("contractVersion");
      expect(withDesignContract(input, "unknown"), label).not.toHaveProperty("contractVersion");
    }
    expect(designContractFields("unknown")).toEqual({});
  });

  test("prepareSave / markSaved / saveFailed are wrapped identically", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const rpcs = {
      readRoles: async () => ({ status: "ready" as const, revision: "r", values: {} }),
      writeRoles: async () => ({ status: "saved" as const, revision: "r", values: {} }),
      readTeams: async () => ({ status: "ready" as const, revision: "r", values: {} }),
      writeTeams: async () => ({ status: "saved" as const, revision: "r", values: {} }),
      readPreferences: async () => ({ status: "ready" as const, revision: "r", values: {} }),
      prepareSave: async (input: {
        jobId: string;
        resultId: string;
        clientId: string;
        intent: "save";
      }) => {
        seen.prepareSave = input as unknown as Record<string, unknown>;
        return { ok: false } as never;
      },
      markSaved: async (input: { jobId: string; resultId: string }) => {
        seen.markSaved = input as unknown as Record<string, unknown>;
        return { ok: false } as never;
      },
      saveFailed: async (input: { jobId: string; resultId: string }) => {
        seen.saveFailed = input as unknown as Record<string, unknown>;
        return { ok: false } as never;
      },
      reloadRoles: async () => {},
      reloadTeams: async () => {},
    };
    const call = async (support: "v2" | "legacy" | "unknown") => {
      const wrapped = withContractOnSaveRpcs(rpcs, support);
      await wrapped.prepareSave({
        jobId: JOB_ID,
        resultId: "a".repeat(64),
        clientId: JOB_ID,
        intent: "save",
      });
      await wrapped.markSaved({ jobId: JOB_ID, resultId: "a".repeat(64) });
      await wrapped.saveFailed({
        jobId: JOB_ID,
        resultId: "a".repeat(64),
        leaseId: JOB_ID,
        phase: "team",
        reason: "unknown",
      });
    };
    await call("v2");
    for (const key of ["prepareSave", "markSaved", "saveFailed"]) {
      expect(seen[key], key).toMatchObject({ contractVersion: 2 });
    }
    await call("legacy");
    for (const key of ["prepareSave", "markSaved", "saveFailed"]) {
      expect(seen[key], key).not.toHaveProperty("contractVersion");
    }
    await call("unknown");
    for (const key of ["prepareSave", "markSaved", "saveFailed"]) {
      expect(seen[key], key).not.toHaveProperty("contractVersion");
    }
  });

  test("economy-all needs v2; legacy modes do not, and the start block says so", () => {
    expect(designModeNeedsV2("economy-all", "legacy")).toBe(true);
    expect(designModeNeedsV2("economy-all", "unknown")).toBe(true);
    expect(designModeNeedsV2("economy-all", "v2")).toBe(false);
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      expect(designModeNeedsV2(mode, "legacy")).toBe(false);
    }
    const block = resolveStartBlock({
      hasStartHandler: true,
      disabledReason: undefined,
      submitting: false,
      request: checkDesignRequest("需求"),
      workspaceMissing: false,
      profileMissing: false,
      profilesLoading: false,
      modeNeedsUpgrade: true,
    });
    expect(block).toBe("mode-needs-upgrade");
  });
});

describe("AC-0c.5 / K4: the gap card is per item and routes by job.mode", () => {
  test("each gap renders server-verified text, names and policy", () => {
    const views = buildDesignRoleGapViews(gapJob());
    expect(views).toHaveLength(2);
    const missing = views[0];
    if (!missing) throw new Error("missing view");
    expect(missing).toMatchObject({
      responsibility: missingRole.responsibility,
      reason: missingRole.reason,
      useLabel: designGapZh.gapUse("member"),
      profiles: [{ id: "p-sonnet", name: "服务端确认的 Sonnet", provider: "claude" }],
      suggestedRole: {
        id: "qa-migration",
        name: "【质量】迁移评审",
        responsibilities: ["评审迁移脚本", "确认可回滚"],
        policyLabel: designGapZh.suggestedRolePolicy("decision", "general"),
      },
    });
    const broken = views[1];
    if (!broken) throw new Error("missing view");
    expect(broken).toMatchObject({
      responsibility: unlaunchable.responsibility,
      reason: unlaunchable.reason,
      noSuitableProfile: "host 没有合适的 Profile。",
      unlaunchable: {
        roleId: "eng-fullstack",
        roleName: "全栈工程师",
        unavailableProfileNames: ["已下线的 DeepSeek", "不可用的 Grok"],
      },
    });
  });

  test("economy-all always exits through the all-seats route, never only the Role editor", () => {
    const views = buildDesignRoleGapViews(gapJob({ mode: "economy-all" }));
    expect(views[0]?.primary).toEqual({
      kind: "configure-economy",
      layer: "allSeats",
      route: "decision",
      profileIds: ["p-sonnet"],
    });
    expect(views[0]?.secondary).toEqual({ kind: "create-role" });
    expect(views[1]?.primary).toMatchObject({ kind: "configure-economy", layer: "allSeats" });
    expect(views[1]?.primary).not.toHaveProperty("route");
    expect(views[1]?.secondary).toBeNull();
  });

  test("other modes: missing-role creates a Role, unlaunchable-role opens the binding", () => {
    const views = buildDesignRoleGapViews(gapJob({ mode: "economy" }));
    expect(views[0]?.primary).toEqual({ kind: "create-role" });
    expect(views[0]?.secondary).toBeNull();
    expect(views[1]?.primary).toEqual({
      kind: "open-role",
      roleId: "eng-fullstack",
      profileId: "p-gone",
    });
    expect(views[1]?.secondary).toBeNull();
  });
});

describe("AC-0c.8 / H3=B / K5: the retry only prefills", () => {
  const job = gapJob();
  const source = {
    request: "原始需求全文",
    profileId: "p-sonnet",
    useDefaultProfileHints: false,
  };

  test("the plan is data only: target workspace, switch off, keep the Profile intent", () => {
    let nonceCalls = 0;
    const plan = planDesignGapRetry(job, source, () => {
      nonceCalls += 1;
      return "nonce-1";
    });
    if (!plan.ok) throw new Error("retry seed missing");
    expect(nonceCalls).toBe(1);
    expect(plan.prefill).toEqual({
      nonce: "nonce-1",
      text: "原始需求全文",
      workspaceId: "ws-target",
      mode: job.mode,
      profileChoice: "p-sonnet",
      existingRolesOnly: false,
      confirmReplace: true,
    });

    const state = createDesignSubmissionState({ request: "用户正在输入的新草稿" });
    const prefilled = applyDesignPrefill(state, {
      request: plan.prefill.text,
      workspaceId: plan.prefill.workspaceId,
      mode: plan.prefill.mode,
      profileChoice: plan.prefill.profileChoice,
      existingRolesOnly: plan.prefill.existingRolesOnly,
    });
    expect(prefilled.draftState.draft).toMatchObject({
      request: "原始需求全文",
      workspaceId: "ws-target",
      existingRolesOnly: false,
    });
    // Nothing was submitted; the user must press start.
    expect(prefilled.submitting).toBe(false);
    expect(prefilled.pending).toBeNull();
  });

  test("a new clientRequestId is minted at start, not while planning the prefill", () => {
    const plan = planDesignGapRetry(job, source, () => "nonce-2");
    if (!plan.ok) throw new Error("retry seed missing");
    const prefilled = applyDesignPrefill(createDesignSubmissionState(), {
      request: plan.prefill.text,
      workspaceId: plan.prefill.workspaceId,
      mode: plan.prefill.mode,
      profileChoice: plan.prefill.profileChoice,
      existingRolesOnly: plan.prefill.existingRolesOnly,
    });
    const planned = planDesignSubmission(prefilled, () => NEW_REQUEST);
    if (planned.kind !== "send") throw new Error("expected send");
    expect(planned.command.clientRequestId).toBe(NEW_REQUEST);
    expect(planned.command.clientRequestId).not.toBe(DESIGN_CLIENT_REQUEST_ID);
    expect(planned.command.input).toMatchObject({
      request: "原始需求全文",
      mode: job.mode,
      workspaceId: "ws-target",
      existingRolesOnly: false,
    });
  });

  test("a typed draft needs confirmation; empty or identical does not", () => {
    expect(shouldConfirmDraftReplace("我正在写", "原始需求全文")).toBe(true);
    expect(shouldConfirmDraftReplace("", "原始需求全文")).toBe(false);
    expect(shouldConfirmDraftReplace("原始需求全文", "原始需求全文")).toBe(false);
  });

  test("a missing seed disables the retry instead of inventing a request", () => {
    expect(planDesignGapRetry(job, null)).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
    expect(planDesignGapRetry(job, { ...source, request: "   " })).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
  });
});

describe("AC-0c.3 / AC-0c.13 / AC-0c.14: legacy DTO and gap terminal safety", () => {
  test("a failed job without roleGap/new fields renders as the old failed job", () => {
    const legacy = designJob({
      state: "failed",
      roleGap: undefined,
      existingRolesOnly: undefined,
      outputContractVersion: undefined,
      resultId: null,
      allowed: { cancel: false, save: false, launch: false, continueAction: null },
    });
    expect(buildDesignRoleGapViews(legacy)).toEqual([]);
    expect(designJobRulesLabel(legacy)).toBe(designGapZh.rulesLegacy);
    expect(shouldAutoSaveDesignJob(true, legacy)).toBe(false);
    expect(
      shouldCleanupDesignJob({
        active: true,
        job: legacy,
        unknownWrite: false,
        attempted: false,
        savePending: false,
      }),
    ).toBe(false);
  });

  test("a gap terminal job cannot auto-save or compensate a Team", () => {
    const terminal = gapJob({ mode: "economy-all" });
    expect(terminal.resultId).toBeNull();
    expect(shouldAutoSaveDesignJob(true, terminal)).toBe(false);
    expect(
      shouldCleanupDesignJob({
        active: true,
        job: { ...terminal, needsCleanup: true },
        unknownWrite: false,
        attempted: false,
        savePending: false,
      }),
    ).toBe(false);
  });

  test("the legacy client is never offered a mode that needs v2", () => {
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      expect(designModeNeedsV2(mode, "legacy")).toBe(false);
    }
    expect(designModeNeedsV2("economy-all", "legacy")).toBe(true);
  });
});

describe("AC-0c.8 / Q2-B: gapRetry server seed on a gap job", () => {
  const seed = {
    request: "原始需求全文",
    profileId: "p-sonnet",
    useDefaultProfileHints: false,
  };

  test("a v2 status job carries the seed and the pure planner consumes it", () => {
    const job = gapJob({ gapRetry: seed });
    const parsed = DesignJobSchema.parse(job);
    expect(parsed.gapRetry).toEqual(seed);
    const source = readGapRetrySeed(parsed);
    expect(source).toEqual(seed);

    // A fresh client has an empty session cache; only the job seed remains.
    const cache = createDesignRetryCache();
    expect(cache.get(parsed.jobId)).toBeNull();
    const plan = planDesignGapRetry(parsed, source, () => "server-seed-nonce");
    if (!plan.ok) throw new Error("server seed missing");
    expect(plan.prefill).toEqual({
      nonce: "server-seed-nonce",
      text: "原始需求全文",
      workspaceId: "ws-target",
      mode: "sota",
      profileChoice: "p-sonnet",
      existingRolesOnly: false,
      confirmReplace: true,
    });
    const prefilled = applyDesignPrefill(createDesignSubmissionState(), {
      request: plan.prefill.text,
      workspaceId: plan.prefill.workspaceId,
      mode: plan.prefill.mode,
      profileChoice: plan.prefill.profileChoice,
      existingRolesOnly: plan.prefill.existingRolesOnly,
    });
    expect(prefilled.draftState.draft).toMatchObject({
      request: "原始需求全文",
      workspaceId: "ws-target",
      existingRolesOnly: false,
    });
    expect(prefilled.submitting).toBe(false);
  });

  test("a legacy job has no server seed and the pure planner falls back to the session cache", () => {
    const legacy = gapJob();
    expect(DesignJobSchema.parse(legacy).gapRetry).toBeUndefined();
    expect(readGapRetrySeed(legacy)).toBeNull();

    const cache = createDesignRetryCache();
    cache.remember(legacy.jobId, {
      clientRequestId: legacy.clientRequestId,
      request: "会话缓存里的需求",
      mode: legacy.mode,
      profileId: "p-sonnet",
    });
    const fromCache = planDesignGapRetry(legacy, cache.get(legacy.jobId), () => "cache-nonce");
    if (!fromCache.ok) throw new Error("cache fallback missing");
    expect(fromCache.prefill.text).toBe("会话缓存里的需求");

    cache.clear();
    expect(planDesignGapRetry(legacy, cache.get(legacy.jobId))).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
  });

  test("a missing seed asks for a new request instead of inventing one", () => {
    const root = path.join(import.meta.dirname, "..", "..");
    const panel = readFileSync(
      path.join(root, "client", "designer", "DesignJobsPanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("designGapZh.retryUnavailable");
    expect(planDesignGapRetry(gapJob(), null)).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
  });
});

test("the retry seed reader accepts the future server shape and rejects malformed values", () => {
  // The shape is already agreed with C03-2; the schema field itself is not in this build.
  expect(
    readGapRetrySeed({
      ...gapJob(),
      gapRetry: { request: "需求", profileId: null, useDefaultProfileHints: true },
    }),
  ).toEqual({ request: "需求", profileId: null, useDefaultProfileHints: true });
  expect(readGapRetrySeed(gapJob())).toBeNull();
  expect(
    readGapRetrySeed({
      ...gapJob(),
      gapRetry: { request: "需求", profileId: 3, useDefaultProfileHints: false },
    }),
  ).toBeNull();
});
