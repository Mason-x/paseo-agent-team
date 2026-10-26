import { describe, expect, test, vi } from "vitest";
import {
  buildDesignCoordinatorRow,
  buildDesignSeatRows,
  type DesignResultViewInput,
  formatDesignBudget,
  openDesignAgent,
  planDesignLaunch,
  resolveDesignJobCardSections,
  resolveDesignJobsRefreshInterval,
  resolveDesignJobView,
  resolveDesignResultView,
} from "../client/designer/submission-state";
import type { DesignIssue, DesignJob } from "../shared/schemas/design";
import {
  type ModeLaunchPreview,
  ModeLaunchPreviewSchema,
  type SeatPreview,
  type SeatProfileDto,
} from "../shared/schemas/launch-preview";
import { designZh } from "../shared/zh/design";
import { designJob, designResult } from "./design-fixtures";

const issue: DesignIssue = {
  code: "DESIGN_AGENT_FAILED",
  severity: "error",
  path: [],
  params: {},
  action: "inspect",
};

const profile = (overrides: Partial<SeatProfileDto> = {}): SeatProfileDto => ({
  id: "codex-xhigh",
  name: "Codex xhigh",
  provider: "codex",
  model: "gpt-5.5",
  ...overrides,
});

function seat(
  overrides: Pick<SeatPreview, "seatId" | "logicalSeatId" | "roleId"> & Partial<SeatPreview>,
): SeatPreview {
  return {
    roleName: "Architect",
    purpose: "member",
    activation: "eager",
    profile: profile(),
    source: "role-preferred",
    alternates: [],
    budget: "sota",
    budgetBasis: "host",
    standby: false,
    unavailable: false,
    issues: [],
    ...overrides,
  };
}

function preview(overrides: Partial<ModeLaunchPreview> = {}): ModeLaunchPreview {
  return ModeLaunchPreviewSchema.parse({
    requestedMode: "sota",
    coordinator: {
      roleId: "tech-lead",
      roleName: "Tech Lead",
      profile: profile({
        id: "claude-opus",
        name: "Claude Opus",
        provider: "claude",
        model: "opus",
      }),
      source: "role-preferred",
      issues: [],
    },
    seats: [],
    counts: { logical: 0, physical: 0, eager: 0, deferred: 0, escalation: 0, sotaPotential: 0 },
    budget: { economy: 0, sota: 0, unknown: 0, deferredSota: 0 },
    issues: [],
    warnings: [],
    planHash: "plan-hash",
    ...overrides,
  });
}

function resultWithPreview(
  previewValue: ModeLaunchPreview,
  overrides: Partial<DesignResultViewInput> = {},
): DesignResultViewInput {
  return { ...designResult(), preview: previewValue, ...overrides };
}

describe("tab visibility and refresh", () => {
  test("a hidden Team tab never refreshes, even while a job runs", () => {
    const running = designJob({ state: "designing" });
    expect(resolveDesignJobsRefreshInterval(false, [running])).toBe(false);
    expect(resolveDesignJobsRefreshInterval(false, [])).toBe(false);
  });

  test("an active tab polls running jobs faster than the backstop", () => {
    expect(resolveDesignJobsRefreshInterval(true, [designJob({ state: "designing" })])).toBe(2000);
    expect(resolveDesignJobsRefreshInterval(true, [designJob({ state: "ready" })])).toBe(15000);
  });
});

describe("collapsed job progress", () => {
  test("folding hides the body without losing phase, attempt, or issues", () => {
    const job = designJob({ state: "designing", attempt: 2, issues: [issue] });
    const open = resolveDesignJobCardSections(job, false);
    const folded = resolveDesignJobCardSections(job, true);
    expect(open.showBody).toBe(true);
    expect(folded.showBody).toBe(false);
    expect(folded.phase).toBe(open.phase);
    expect(folded.attemptLabel).toBe(open.attemptLabel);
    expect(folded.issueCount).toBe(1);
  });

  test("a missing designer Profile still shows the job error and its agent", () => {
    const job = designJob({
      state: "failed",
      designerProfile: null,
      agentCreated: true,
      issues: [issue],
    });
    const view = resolveDesignJobView(job);
    expect(view.designerProfileLabel).toBeNull();
    expect(view.phase).toBe(designZh.phases.failed);
    expect(view.issues).toHaveLength(1);
    expect(view.canOpenAgent).toBe(true);
    expect(view.tone).toBe("danger");
  });
});

describe("permissions navigate only", () => {
  test("pending permissions expose a summary without approving anything", () => {
    const job = designJob({
      requiresAttention: true,
      attentionReason: "permission",
      agentCreated: true,
      pendingPermissions: [{ id: "perm-1", kind: "tool", title: "Bash", description: "run tests" }],
    });
    const view = resolveDesignJobView(job);
    expect(view.showPermissions).toBe(true);
    expect(view.permissions[0]).toMatchObject({
      id: "perm-1",
      kindLabel: designZh.permissionKinds.tool,
      title: "Bash",
      description: "run tests",
    });
    expect(view.permissionNotice).toBeNull();
  });

  test("a finished attention state is not a permission", () => {
    const view = resolveDesignJobView(
      designJob({ requiresAttention: true, attentionReason: "finished" }),
    );
    expect(view.showPermissions).toBe(false);
  });

  test("permission attention without a listed request asks the user to open the conversation", () => {
    const view = resolveDesignJobView(
      designJob({ requiresAttention: true, attentionReason: "permission" }),
    );
    expect(view.showPermissions).toBe(true);
    expect(view.permissionNotice).toContain(designZh.jobPermissionEmpty);
  });

  test("truncated permission lists tell the user to finish in the conversation", () => {
    const view = resolveDesignJobView(
      designJob({
        attentionReason: "permission",
        permissionsTruncated: true,
        pendingPermissions: [{ id: "p1", kind: "plan", title: "Plan" }],
      }),
    );
    expect(view.permissionNotice).toContain(designZh.jobPermissionTruncated);
  });

  test("an older host without navigation returns false instead of throwing", () => {
    expect(openDesignAgent({ navigation: undefined, hostId: "host-1", agentId: "agent-1" })).toBe(
      false,
    );
  });

  test("navigation always carries the current host and never falls back to a default", () => {
    const openAgent = vi.fn();
    expect(
      openDesignAgent({ navigation: { openAgent }, hostId: "host-1", agentId: "agent-1" }),
    ).toBe(true);
    expect(openAgent).toHaveBeenCalledWith({ agentId: "agent-1", serverId: "host-1" });
    openAgent.mockClear();
    expect(openDesignAgent({ navigation: { openAgent }, hostId: "", agentId: "agent-1" })).toBe(
      false,
    );
    expect(openAgent).not.toHaveBeenCalled();
  });
});

describe("result seats", () => {
  test("every physical seat is visible with purpose, activation, profile, and budget", () => {
    const previewValue = preview({
      seats: [
        seat({
          seatId: "seat-member",
          logicalSeatId: "logical-member",
          roleId: "architect",
          budget: "economy",
          budgetBasis: "pool",
          source: "economy-pool",
          family: "openai",
        }),
        seat({
          seatId: "seat-candidate",
          logicalSeatId: "logical-member",
          roleId: "architect",
          purpose: "candidate",
          activation: "on-demand",
          budget: "sota",
          budgetBasis: "host",
        }),
        seat({
          seatId: "seat-judge",
          logicalSeatId: "logical-judge",
          roleId: "qa-test",
          roleName: "QA Test",
          purpose: "judge",
          activation: "eager",
          budget: "unknown",
          budgetBasis: "conservative-default",
        }),
        seat({
          seatId: "seat-escalation",
          logicalSeatId: "logical-escalation",
          roleId: "rework",
          roleName: "Rework",
          purpose: "escalation",
          activation: "escalation-only",
          standby: true,
          unavailable: false,
          profile: profile({ id: "claude-opus-high", name: "Claude Opus", provider: "claude" }),
        }),
      ],
    });
    const base = designResult();
    const rows = buildDesignSeatRows({
      preview: previewValue,
      memberReasons: base.memberReasons,
      newRoles: base.newRoles,
    });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      purposeLabel: designZh.seatPurposes.member,
      activationLabel: designZh.seatActivations.eager,
      profileLabel: "Codex xhigh",
      budgetLabel: `${designZh.budgets.economy} · ${designZh.budgetBasis.pool}`,
      sourceLabel: designZh.sources["economy-pool"],
      familyLabel: "openai",
    });
    expect(rows[1]).toMatchObject({
      roleId: "architect",
      purposeLabel: designZh.seatPurposes.candidate,
      activationLabel: designZh.seatActivations["on-demand"],
      budgetLabel: `${designZh.budgets.sota} · ${designZh.budgetBasis.host}`,
    });
    expect(rows[2]).toMatchObject({
      purposeLabel: designZh.seatPurposes.judge,
      budgetLabel: `${designZh.budgets.unknown} · ${designZh.budgetBasis["conservative-default"]}`,
    });
    expect(rows[3]).toMatchObject({
      purposeLabel: designZh.seatPurposes.escalation,
      activationLabel: designZh.seatActivations["escalation-only"],
      profileLabel: "Claude Opus",
      standby: true,
      unavailable: false,
    });
    expect(rows[3]?.profileLabel).not.toBe(designZh.resultSeatUnavailable);
  });

  test("a standby seat without a Profile is the only unavailable case", () => {
    const previewValue = preview({
      seats: [
        seat({
          seatId: "seat-escalation",
          logicalSeatId: "logical-escalation",
          roleId: "rework",
          purpose: "escalation",
          activation: "escalation-only",
          standby: true,
          unavailable: true,
          profile: null,
          source: "unavailable",
        }),
      ],
    });
    const base = designResult();
    const [row] = buildDesignSeatRows({
      preview: previewValue,
      memberReasons: base.memberReasons,
      newRoles: base.newRoles,
    });
    expect(row).toMatchObject({
      standby: true,
      unavailable: true,
      profileLabel: designZh.resultSeatUnavailable,
    });
  });

  test("cohorts and the coordinator reason are carried into the rows", () => {
    const previewValue = preview({
      seats: [
        seat({
          seatId: "seat-a",
          logicalSeatId: "logical-m1",
          roleId: "architect",
          cohortId: "cohort-1",
        }),
      ],
    });
    const base = designResult();
    const [row] = buildDesignSeatRows({
      preview: previewValue,
      memberReasons: base.memberReasons,
      newRoles: base.newRoles,
    });
    expect(row?.cohortId).toBe("cohort-1");
    expect(row?.reasonLabel).toBe("结构设计需要代码理解。");

    const coordinator = buildDesignCoordinatorRow({
      preview: previewValue,
      memberReasons: [
        {
          target: "coordinator",
          logicalSeatId: "logical-0",
          reason: "统筹",
          expectedProfileIds: [],
        },
      ],
    });
    expect(coordinator).toMatchObject({
      roleLabel: "Tech Lead",
      profileLabel: "Claude Opus",
      runtimeLabel: "claude/opus",
      reasonLabel: "统筹",
    });
  });

  test("budgets keep the host, pool, and conservative-default basis", () => {
    expect(formatDesignBudget("economy", "pool")).toBe(
      `${designZh.budgets.economy} · ${designZh.budgetBasis.pool}`,
    );
    expect(formatDesignBudget("sota", "host")).toBe(
      `${designZh.budgets.sota} · ${designZh.budgetBasis.host}`,
    );
    expect(formatDesignBudget("unknown", "conservative-default")).toBe(
      `${designZh.budgets.unknown} · ${designZh.budgetBasis["conservative-default"]}`,
    );
    expect(formatDesignBudget(undefined)).toBe(designZh.budgetUnknown);
  });

  test("T4 counts are shown unchanged and marked as excluding the coordinator", () => {
    const previewValue = preview({
      counts: { logical: 4, physical: 5, eager: 3, deferred: 2, escalation: 1, sotaPotential: 2 },
    });
    const view = resolveDesignResultView(resultWithPreview(previewValue), null);
    expect(view.logicalCount).toBe(4);
    expect(view.physicalCount).toBe(5);
    expect(view.countsNote).toBe(designZh.resultCountsNote);
    expect(view.coordinator).not.toBeNull();
  });

  test("an invalid preview fails closed instead of inventing seats", () => {
    const view = resolveDesignResultView(designResult({ preview: undefined as never }), null);
    expect(view.seats).toEqual([]);
    expect(view.coordinator).toBeNull();
    expect(view.warnings).toContain(designZh.resultPreviewUnavailable);
  });
});

describe("result launch prefill", () => {
  const result = resultWithPreview(preview({ planHash: "hash" }), {
    targetWorkspaceId: "ws-target",
    carrierWorkspaceId: "ws-carrier",
  });

  test("a saved Team prefills the target workspace, never the carrier", () => {
    const prefill = planDesignLaunch(result, "saved-team");
    expect(prefill).toEqual({
      initialTeamId: "saved-team",
      lockTeam: true,
      initialTask: result.request,
      initialWorkspaceId: "ws-target",
      initialMode: result.mode,
    });
    expect(prefill?.initialWorkspaceId).not.toBe("ws-carrier");
  });

  test("an unsaved result cannot open the launch dialog", () => {
    expect(planDesignLaunch(result, null)).toBeNull();
    const view = resolveDesignResultView(result, null);
    expect(view.launch).toBeNull();
    expect(view.launchHint).toBe(designZh.resultLaunchHint);
  });

  test("no target leaves the workspace unpreselected instead of using the carrier", () => {
    const noTarget = resultWithPreview(preview(), {
      targetWorkspaceId: null,
      carrierWorkspaceId: "ws-carrier",
    });
    const prefill = planDesignLaunch(noTarget, "saved-team");
    expect(prefill).not.toHaveProperty("initialWorkspaceId");
    expect(resolveDesignResultView(noTarget, "saved-team").targetLabel).toBe(
      designZh.resultNoTarget,
    );
  });

  test("the prefill is a plain descriptor; no launch function is attached", () => {
    const prefill = planDesignLaunch(result, "saved-team");
    expect(prefill && Object.values(prefill).every((value) => typeof value !== "function")).toBe(
      true,
    );
  });
});

describe("job copy", () => {
  test("save and continuation affordances follow the server allowance", () => {
    const job: DesignJob = designJob({
      state: "needs_continue",
      saveState: "unknown",
      savedTeamId: "saved-team",
      allowed: { cancel: true, save: true, launch: false, continueAction: "recheck" },
    });
    const view = resolveDesignJobView(job);
    expect(view.canRetrySave).toBe(true);
    expect(view.continueAction).toBe("recheck");
    expect(view.saveNote).toContain(designZh.jobSaveUnknown);
    expect(view.canCancel).toBe(true);
  });
});
