import { describe, expect, test, vi } from "vitest";
import { resolveStartBlock } from "../client/designer/card-state";
import {
  designContractFields,
  designModeNeedsV2,
  prepareDesignStartInput,
  withDesignContract,
} from "../client/designer/design-gateway";
import {
  designerPrefillFromEvent,
  shouldAutoSaveDesignJob,
  shouldCleanupDesignJob,
} from "../client/designer/design-screen-state";
import {
  applyDesignPrefill,
  buildDesignRoleGapViews,
  buildDesignStartInput,
  createDesignRetryCache,
  createDesignSubmissionController,
  createDesignSubmissionState,
  designJobRulesLabel,
  editDesignDraft,
  fingerprintDesignStartInput,
  planDesignGapRetry,
  planDesignSubmission,
  readGapRetrySeed,
  resolveDesignJobView,
  settleDesignSubmission,
  shouldConfirmDraftReplace,
} from "../client/designer/submission-state";
import { withContractOnSaveRpcs } from "../client/designer/use-design-save";
import { checkDesignRequest } from "../shared/domain/design-request";
import type { DesignJob, DesignStartInput, RoleGapReport } from "../shared/schemas/design";
import { designGapZh } from "../shared/zh/design-gap";
import { designJob } from "./design-fixtures";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

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

const coordinatorGap: RoleGapReport = {
  responsibility: "统筹协调",
  reason: "没有可用的协调者。",
  use: "coordinator",
  profiles: [],
  profileGapReason: "没有协调者可用的 Profile。",
  unlaunchableRole: {
    roleId: "lead-orchestrator",
    roleName: "统筹",
    unavailableProfileIds: [],
    profileNames: [],
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
    issues: [
      {
        code: "DESIGN_REUSE_INVALID",
        severity: "error",
        path: [],
        params: { reason: "roles-gap", roleId: "" },
        action: "choose-profile",
      },
    ],
    ...overrides,
  });
}

describe("the switch: on by default, never remembered", () => {
  test("every new draft starts on, whatever the previous draft chose", () => {
    expect(createDesignSubmissionState().draftState.draft.existingRolesOnly).toBe(true);
    let state = createDesignSubmissionState({ request: "需求" });
    state = editDesignDraft(state, { existingRolesOnly: false });
    expect(state.draftState.draft.existingRolesOnly).toBe(false);
    // Nothing is persisted: a fresh state (a new card, a reload) is on again.
    expect(
      createDesignSubmissionState({ request: "需求" }).draftState.draft.existingRolesOnly,
    ).toBe(true);
  });

  test("a /team-design prefill is a new draft: on, even after the user turned it off", () => {
    let state = createDesignSubmissionState({ request: "旧" });
    state = editDesignDraft(state, { existingRolesOnly: false });
    state = applyDesignPrefill(state, { request: "新需求", workspaceId: null });
    expect(state.draftState.draft.existingRolesOnly).toBe(true);
  });

  test("an accepted request ends the draft and the next one starts on again", () => {
    let state = createDesignSubmissionState({ request: "需求" });
    state = editDesignDraft(state, { existingRolesOnly: false });
    const planned = planDesignSubmission(state, () => ID);
    if (planned.kind !== "send") throw new Error("expected send");
    const settled = settleDesignSubmission(planned.state, {
      clientRequestId: ID,
      seq: planned.command.seq,
      outcome: "accepted",
    });
    expect(settled.cleared).toBe(true);
    expect(settled.state.draftState.draft).toMatchObject({ request: "", existingRolesOnly: true });
  });

  test("the switch is part of the draft version, not the native input revision", () => {
    const state = createDesignSubmissionState({ request: "需求" });
    const next = editDesignDraft(state, { existingRolesOnly: false });
    expect(next.draftState.draftVersion).toBe(state.draftState.draftVersion + 1);
    expect(next.draftState.inputRevision).toBe(state.draftState.inputRevision);
  });
});

describe("the request always carries an explicit boolean", () => {
  test("true and false are both sent, never omitted", () => {
    for (const existingRolesOnly of [true, false]) {
      const built = buildDesignStartInput(
        { request: "需求", mode: "sota", workspaceId: "", profileChoice: null, existingRolesOnly },
        ID,
      );
      expect(built.ok && built.input.existingRolesOnly).toBe(existingRolesOnly);
    }
  });

  test("the fingerprint includes the switch; an omitted rule counts as on", () => {
    const base = { request: "需求", mode: "sota" as const };
    expect(fingerprintDesignStartInput(base)).toBe(
      fingerprintDesignStartInput({ ...base, existingRolesOnly: true }),
    );
    expect(fingerprintDesignStartInput({ ...base, existingRolesOnly: false })).not.toBe(
      fingerprintDesignStartInput({ ...base, existingRolesOnly: true }),
    );
  });

  test("an unknown outcome replays the id only for the same switch value", () => {
    let state = createDesignSubmissionState({ request: "需求" });
    const first = planDesignSubmission(state, () => ID);
    if (first.kind !== "send") throw new Error("expected send");
    state = settleDesignSubmission(first.state, {
      clientRequestId: ID,
      seq: first.command.seq,
      outcome: "unknown",
    }).state;
    const same = planDesignSubmission(state, () => OTHER_ID);
    expect(same.kind === "send" && same.command.clientRequestId).toBe(ID);
    const flipped = planDesignSubmission(
      editDesignDraft(state, { existingRolesOnly: false }),
      () => OTHER_ID,
    );
    expect(flipped.kind === "send" && flipped.command.clientRequestId).toBe(OTHER_ID);
  });

  test("a /team-design prefill event never carries the rule", () => {
    const prefill = designerPrefillFromEvent({
      token: "t",
      scopeId: "s",
      request: "需求",
      workspaceId: null,
      createdAt: 0,
    });
    expect(prefill).not.toHaveProperty("existingRolesOnly");
    expect(prefill).not.toHaveProperty("confirmReplace");
  });
});

describe("a job shows its own rule", () => {
  test("true, false, and a missing field (an old job) read differently", () => {
    expect(designJobRulesLabel({ existingRolesOnly: true })).toBe(designGapZh.rulesOnly);
    expect(designJobRulesLabel({ existingRolesOnly: false })).toBe(designGapZh.rulesMax3);
    expect(designJobRulesLabel({})).toBe(designGapZh.rulesLegacy);
    expect(resolveDesignJobView(designJob()).rulesLabel).toBe(designGapZh.rulesLegacy);
  });

  test("the form switch does not touch a running job", () => {
    const job = designJob({ existingRolesOnly: true });
    const before = resolveDesignJobView(job).rulesLabel;
    editDesignDraft(createDesignSubmissionState({ request: "x" }), { existingRolesOnly: false });
    expect(resolveDesignJobView(job).rulesLabel).toBe(before);
  });
});

describe("gap views", () => {
  test("one view per gap, in order, with the server-confirmed names", () => {
    const views = buildDesignRoleGapViews(gapJob());
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      responsibility: "数据库迁移评审",
      reason: "现有 Role 不承担迁移评审。",
      useLabel: designGapZh.gapUse("member"),
      profiles: [{ id: "p-sonnet", name: "服务端确认的 Sonnet", provider: "claude" }],
      suggestedRole: {
        id: "qa-migration",
        name: "【质量】迁移评审",
        responsibilities: ["评审迁移脚本", "确认可回滚"],
      },
      noSuitableProfile: null,
    });
    expect(views[1]).toMatchObject({
      unlaunchable: {
        roleId: "eng-fullstack",
        roleName: "全栈工程师",
        unavailableProfileNames: ["已下线的 DeepSeek", "不可用的 Grok"],
      },
      profiles: [],
      noSuitableProfile: "host 没有合适的 Profile。",
    });
  });

  test("a non-economy job sends a missing Role to Role creation and an unlaunchable Role to its binding", () => {
    const [missing, broken] = buildDesignRoleGapViews(gapJob({ mode: "sota" }));
    expect(missing?.primary).toEqual({ kind: "create-role" });
    expect(missing?.secondary).toBeNull();
    expect(broken?.primary).toEqual({
      kind: "open-role",
      roleId: "eng-fullstack",
      profileId: "p-gone",
    });
  });

  test("an economy-all job is repaired in the route list, never only in the Role editor", () => {
    const views = buildDesignRoleGapViews(gapJob({ mode: "economy-all" }));
    expect(views[0]?.primary).toEqual({
      kind: "configure-economy",
      layer: "allSeats",
      route: "decision",
      profileIds: ["p-sonnet"],
    });
    // A suggested Role can still be created, as the second choice.
    expect(views[0]?.secondary).toEqual({ kind: "create-role" });
    // The route of an unlaunchable member Role is unknown here (the card has no Role list).
    expect(views[1]?.primary).toEqual({
      kind: "configure-economy",
      layer: "allSeats",
      profileIds: ["p-gone", "p-down"],
    });
    expect(views[1]?.primary?.kind).not.toBe("open-role");
    const coordinator = buildDesignRoleGapViews(
      gapJob({ mode: "economy-all", roleGap: [coordinatorGap] }),
    );
    expect(coordinator[0]?.primary).toMatchObject({
      kind: "configure-economy",
      route: "coordinator",
    });
  });

  test("the exit follows the job's mode, not the form's mode", () => {
    const sota = buildDesignRoleGapViews(gapJob({ mode: "sota", roleGap: [unlaunchable] }));
    const economy = buildDesignRoleGapViews(
      gapJob({ mode: "economy-all", roleGap: [unlaunchable] }),
    );
    expect(sota[0]?.primary?.kind).toBe("open-role");
    expect(economy[0]?.primary?.kind).toBe("configure-economy");
  });

  test("a job without a gap, or from an old daemon, has no card", () => {
    expect(buildDesignRoleGapViews(designJob())).toEqual([]);
    expect(buildDesignRoleGapViews(designJob({ roleGap: null }))).toEqual([]);
    expect(resolveDesignJobView(designJob({ roleGap: null })).gaps).toEqual([]);
  });

  test("eight gaps are all shown, none merged", () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({
      ...missingRole,
      responsibility: `缺口 ${index}`,
    }));
    const views = buildDesignRoleGapViews(gapJob({ roleGap: eight }));
    expect(views.map((view) => view.responsibility)).toEqual(
      eight.map((gap) => gap.responsibility),
    );
    expect(new Set(views.map((view) => view.key)).size).toBe(8);
  });

  test("the generic roles-gap line is dropped once the card shows the gap", () => {
    const withGap = resolveDesignJobView(gapJob());
    expect(withGap.gaps.length).toBeGreaterThan(0);
    expect(withGap.issues.some((issue) => issue.params.reason === "roles-gap")).toBe(false);
    // An old daemon's failed job (no roleGap) keeps its ordinary issue rendering.
    const oldDaemon = resolveDesignJobView(gapJob({ roleGap: undefined }));
    expect(oldDaemon.gaps).toEqual([]);
    expect(oldDaemon.issues.some((issue) => issue.params.reason === "roles-gap")).toBe(true);
  });

  test("a gap job is never saved or compensated automatically", () => {
    const job = gapJob();
    expect(shouldAutoSaveDesignJob(true, job)).toBe(false);
    expect(
      shouldCleanupDesignJob({
        active: true,
        job,
        unknownWrite: false,
        attempted: false,
        savePending: false,
      }),
    ).toBe(false);
    expect(resolveDesignJobView(job).canRetrySave).toBe(false);
    expect(resolveDesignJobView(job).continueAction).toBeNull();
  });
});

describe("close the switch and retry", () => {
  const source = {
    request: "给后台做一次改版",
    profileId: "codex-xhigh",
    useDefaultProfileHints: false,
  };

  test("prefills the original request, the job's mode and target, and turns the switch off", () => {
    const plan = planDesignGapRetry(gapJob({ mode: "economy-all" }), source, () => "nonce-1");
    expect(plan).toEqual({
      ok: true,
      prefill: {
        nonce: "nonce-1",
        text: "给后台做一次改版",
        workspaceId: "ws-target",
        mode: "economy-all",
        profileChoice: "codex-xhigh",
        existingRolesOnly: false,
        confirmReplace: true,
      },
    });
  });

  test("the target is the job's target, never the carrier workspace", () => {
    const noTarget = planDesignGapRetry(
      gapJob({ targetWorkspaceId: null, carrierWorkspaceId: "ws-carrier" }),
      source,
    );
    expect(noTarget.ok && noTarget.prefill.workspaceId).toBe("");
  });

  test("the Profile intent survives: an id, the host's choice, or the preference", () => {
    const choice = (profileId: string | null, useDefaultProfileHints: boolean) => {
      const plan = planDesignGapRetry(gapJob(), {
        request: "需求",
        profileId,
        useDefaultProfileHints,
      });
      return plan.ok ? plan.prefill.profileChoice : "failed";
    };
    expect(choice("codex-xhigh", false)).toBe("codex-xhigh");
    expect(choice(null, true)).toBe("");
    expect(choice(null, false)).toBeNull();
  });

  test("without a recoverable request there is no retry", () => {
    expect(planDesignGapRetry(gapJob(), null)).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
    expect(planDesignGapRetry(gapJob(), { ...source, request: "   " })).toEqual({
      ok: false,
      reason: "request-unavailable",
    });
  });

  test("only prefills: no RPC, a new id at start, and a fingerprint unlike the original request", () => {
    const start = vi.fn(async (_input: DesignStartInput) => ({ ok: true as const, job: gapJob() }));
    const original = createDesignSubmissionController({
      start,
      nextId: () => ID,
      initialDraft: { request: source.request, mode: "sota", profileChoice: "codex-xhigh" },
    });
    const originalPlan = planDesignSubmission(original.getState(), () => ID);
    const plan = planDesignGapRetry(gapJob(), source, () => "nonce-1");
    if (!plan.ok || originalPlan.kind !== "send") throw new Error("expected plans");
    expect(start).not.toHaveBeenCalled();

    // The card applies the prefill, then the user presses start.
    const state = applyDesignPrefill(createDesignSubmissionState(), {
      request: plan.prefill.text,
      workspaceId: plan.prefill.workspaceId,
      mode: plan.prefill.mode,
      profileChoice: plan.prefill.profileChoice,
      existingRolesOnly: plan.prefill.existingRolesOnly,
    });
    expect(state.draftState.draft.existingRolesOnly).toBe(false);
    const retry = planDesignSubmission(state, () => OTHER_ID);
    if (retry.kind !== "send") throw new Error("expected send");
    expect(retry.command.clientRequestId).toBe(OTHER_ID);
    expect(retry.command.input.existingRolesOnly).toBe(false);
    expect(retry.state.pending?.fingerprint).not.toBe(originalPlan.state.pending?.fingerprint);
  });

  test("a typed draft needs a yes; an empty or identical one does not", () => {
    expect(shouldConfirmDraftReplace("我正在写的需求", "原需求")).toBe(true);
    expect(shouldConfirmDraftReplace("", "原需求")).toBe(false);
    expect(shouldConfirmDraftReplace("   ", "原需求")).toBe(false);
    expect(shouldConfirmDraftReplace("原需求", "原需求")).toBe(false);
  });

  test("the session memory remembers what each started job asked, bounded", () => {
    const cache = createDesignRetryCache();
    const input: DesignStartInput = {
      clientRequestId: ID,
      request: "需求",
      profileId: "p1",
    };
    cache.remember("job-a", input);
    expect(cache.get("job-a")).toEqual({
      request: "需求",
      profileId: "p1",
      useDefaultProfileHints: false,
    });
    cache.remember("job-b", { ...input, profileId: undefined, useDefaultProfileHints: true });
    expect(cache.get("job-b")).toEqual({
      request: "需求",
      profileId: null,
      useDefaultProfileHints: true,
    });
    expect(cache.get("job-missing")).toBeNull();
    for (let index = 0; index < 25; index += 1) cache.remember(`bulk-${index}`, input);
    expect(cache.get("job-a")).toBeNull();
    expect(cache.get("bulk-24")).not.toBeNull();
    cache.clear();
    expect(cache.get("bulk-24")).toBeNull();
  });

  test("the server seed is read only when well formed", () => {
    const withSeed = (gapRetry: unknown) => ({ ...gapJob(), gapRetry });
    expect(
      readGapRetrySeed(
        withSeed({ request: "需求", profileId: null, useDefaultProfileHints: true }),
      ),
    ).toEqual({ request: "需求", profileId: null, useDefaultProfileHints: true });
    expect(readGapRetrySeed(gapJob())).toBeNull();
    for (const bad of [
      null,
      "x",
      {},
      { request: "", profileId: null, useDefaultProfileHints: false },
      { request: "需求", profileId: 3, useDefaultProfileHints: false },
      { request: "需求", profileId: null },
    ]) {
      expect(readGapRetrySeed(withSeed(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("contract negotiation (K1)", () => {
  const start: DesignStartInput = {
    clientRequestId: ID,
    request: "需求",
    mode: "economy-all",
    existingRolesOnly: false,
  };

  test("only a confirmed v2 host gets contractVersion 2 and the explicit rule", () => {
    expect(designContractFields("v2")).toEqual({ contractVersion: 2 });
    expect(designContractFields("legacy")).toEqual({});
    expect(designContractFields("unknown")).toEqual({});
    expect(prepareDesignStartInput(start, "v2")).toEqual({
      ...start,
      existingRolesOnly: false,
      contractVersion: 2,
    });
    const omitted = prepareDesignStartInput({ ...start, existingRolesOnly: undefined }, "v2");
    expect(omitted.existingRolesOnly).toBe(true);
  });

  test("a baseline or unconfirmed host receives neither new field", () => {
    for (const support of ["legacy", "unknown"] as const) {
      const sent = prepareDesignStartInput({ ...start, contractVersion: 2 }, support);
      expect(sent).not.toHaveProperty("existingRolesOnly");
      expect(sent).not.toHaveProperty("contractVersion");
      expect(sent).toMatchObject({ clientRequestId: ID, request: "需求", mode: "economy-all" });
    }
  });

  test("the other design RPC inputs get the same single field", () => {
    expect(withDesignContract({ jobId: ID }, "v2")).toEqual({ jobId: ID, contractVersion: 2 });
    expect(withDesignContract({ jobId: ID }, "legacy")).toEqual({ jobId: ID });
    expect(withDesignContract({}, "unknown")).toEqual({});
  });

  test("the three save RPCs carry it too, and only for v2", async () => {
    const seen: Record<string, unknown> = {};
    const rpcs = {
      readRoles: vi.fn(),
      writeRoles: vi.fn(),
      readTeams: vi.fn(),
      writeTeams: vi.fn(),
      readPreferences: vi.fn(),
      prepareSave: vi.fn(async (input: unknown) => {
        seen.prepareSave = input;
        return { ok: false } as never;
      }),
      markSaved: vi.fn(async (input: unknown) => {
        seen.markSaved = input;
        return { ok: false } as never;
      }),
      saveFailed: vi.fn(async (input: unknown) => {
        seen.saveFailed = input;
        return { ok: false } as never;
      }),
      reloadRoles: vi.fn(),
      reloadTeams: vi.fn(),
    };
    const call = async (support: "v2" | "legacy" | "unknown") => {
      const wrapped = withContractOnSaveRpcs(rpcs, support);
      await wrapped.prepareSave({
        jobId: ID,
        resultId: "a".repeat(64),
        clientId: OTHER_ID,
        intent: "save",
      });
      await wrapped.markSaved({ jobId: ID, resultId: "a".repeat(64) });
      await wrapped.saveFailed({
        jobId: ID,
        resultId: "a".repeat(64),
        leaseId: OTHER_ID,
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
    expect(seen.prepareSave).not.toHaveProperty("contractVersion");
  });

  test("economy-all cannot start against a host that is not confirmed as v2", () => {
    expect(designModeNeedsV2("economy-all", "v2")).toBe(false);
    expect(designModeNeedsV2("economy-all", "legacy")).toBe(true);
    expect(designModeNeedsV2("economy-all", "unknown")).toBe(true);
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      expect(designModeNeedsV2(mode, "legacy")).toBe(false);
    }
    const request = checkDesignRequest("需求");
    expect(
      resolveStartBlock({
        hasStartHandler: true,
        disabledReason: undefined,
        submitting: false,
        request,
        workspaceMissing: false,
        profileMissing: false,
        profilesLoading: false,
        modeNeedsUpgrade: true,
      }),
    ).toBe("mode-needs-upgrade");
    expect(
      resolveStartBlock({
        hasStartHandler: true,
        disabledReason: undefined,
        submitting: false,
        request,
        workspaceMissing: false,
        profileMissing: false,
        profilesLoading: false,
      }),
    ).toBeNull();
  });
});
