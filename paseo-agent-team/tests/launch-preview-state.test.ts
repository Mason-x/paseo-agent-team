import { describe, expect, test } from "vitest";
import {
  isPlanChanged,
  launchGate,
  launchPreviewCacheKey,
  launchPreviewIdentity,
  launchPreviewQueryKey,
  launchSeatStatus,
  modeIssueText,
  PREVIEW_TASK_DEBOUNCE_MS,
  previewBlockers,
  previewTaskState,
  previewWarnings,
  startFailureAction,
} from "../client/launch/launch-preview-state";
import { formatLaunchBudget } from "../client/shared/budget-format";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { toModeLaunchPreview } from "../shared/domain/launch-preview";
import type { EconomyPolicy, HostSnapshot } from "../shared/domain/mode-resolver";
import type { LaunchTarget } from "../shared/rpc";
import {
  type LaunchPreviewResult,
  ModeLaunchPreviewSchema,
} from "../shared/schemas/launch-preview";
import { zh } from "../shared/zh";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";

const target: LaunchTarget = { kind: "workspace", workspaceId: "ws-1" };
const input = {
  hostId: "host-1",
  teamId: "team-1",
  task: "  ship it  ",
  target,
  savedMode: "economy",
};

const preview = ModeLaunchPreviewSchema.parse({
  requestedMode: "economy",
  coordinator: {
    roleId: "coordinator",
    roleName: "Coordinator",
    profile: { id: "p-coordinator", name: "Coordinator Profile", provider: "anthropic" },
    source: "role-preferred",
    issues: [],
  },
  seats: [
    {
      seatId: "seat-1",
      logicalSeatId: "logical-1",
      roleId: "coder",
      roleName: "Coder",
      purpose: "member",
      activation: "eager",
      profile: { id: "p-coder", name: "Coder Profile", provider: "deepseek" },
      source: "economy-pool",
      alternates: [],
      budget: "economy",
      budgetBasis: "pool",
      standby: false,
      unavailable: false,
      issues: [],
    },
  ],
  counts: { logical: 1, physical: 1, eager: 1, deferred: 0, escalation: 0, sotaPotential: 0 },
  budget: { economy: 1, sota: 0, unknown: 0, deferredSota: 0 },
  issues: [],
  warnings: [],
  planHash: "hash-1",
});

const okResult: LaunchPreviewResult = { ok: true, preview };
const blockedResult: LaunchPreviewResult = {
  ok: false,
  blockers: ["No workspace"],
  warnings: ["Check the Team"],
  issues: [],
};

function gate(overrides: Partial<Parameters<typeof launchGate>[0]> = {}) {
  const identity = launchPreviewIdentity(input);
  return launchGate({
    starting: false,
    running: false,
    contextLoading: false,
    taskReady: true,
    taskPending: false,
    targetReady: true,
    preview: okResult,
    previewIdentity: identity,
    currentIdentity: identity,
    fetching: false,
    error: null,
    ...overrides,
  });
}

describe("launch preview identity", () => {
  test("query key includes host, Team, trimmed task, target, and saved mode", () => {
    expect(launchPreviewQueryKey(input)).toEqual([
      "agent-team",
      "launch-preview",
      "host-1",
      "team-1",
      "ship it",
      target,
      "economy",
    ]);
  });

  test("task whitespace does not create a new preview", () => {
    expect(launchPreviewIdentity({ ...input, task: "ship it" })).toBe(launchPreviewIdentity(input));
  });

  test("a probe upgrade changes the key once and invalidates the old preview", () => {
    const unknownKey = JSON.stringify(launchPreviewCacheKey(input, "unknown"));
    const v2Key = JSON.stringify(launchPreviewCacheKey(input, "v2"));
    // One key before and one after: React Query refetches once and never starts a launch.
    expect(new Set([unknownKey, v2Key]).size).toBe(2);
    expect(gate({ previewIdentity: unknownKey, currentIdentity: v2Key })).toEqual({
      disabled: true,
      reason: zh.modes.previewPending,
    });
  });

  test("task, target, and saved-mode changes all create a new identity", () => {
    const base = launchPreviewIdentity(input);
    expect(launchPreviewIdentity({ ...input, task: "ship it now" })).not.toBe(base);
    expect(
      launchPreviewIdentity({
        ...input,
        target: { kind: "new-workspace", projectId: "project-1" },
      }),
    ).not.toBe(base);
    expect(launchPreviewIdentity({ ...input, savedMode: "sota" })).not.toBe(base);
  });
});

describe("task debounce", () => {
  test("uses a 400 ms quiet period and keeps one preview identity while typing", () => {
    expect(PREVIEW_TASK_DEBOUNCE_MS).toBe(400);
    const samples = ["a", "ab", "abc"].map((text) => previewTaskState(text, "", false));
    expect(samples.every((sample) => sample.pending)).toBe(true);
    expect(new Set(samples.map((sample) => sample.task))).toEqual(new Set([""]));
    expect(previewTaskState("abc", "abc", false)).toEqual({ task: "abc", pending: false });
    expect(previewTaskState("abc", "ab", false)).toEqual({ task: "ab", pending: true });
  });

  test("composition always keeps start disabled and does not advance the preview", () => {
    expect(previewTaskState("abc", "ab", true)).toEqual({ task: "ab", pending: true });
  });
});

describe("launch gate", () => {
  test("allows start only for a complete, current, unblocked preview", () => {
    expect(gate()).toEqual({ disabled: false, reason: null });
  });

  test("disables start while the dialog is starting or running", () => {
    expect(gate({ starting: true })).toEqual({ disabled: true, reason: null });
    expect(gate({ running: true })).toEqual({ disabled: true, reason: null });
  });

  test("explains missing context, task, and target", () => {
    expect(gate({ contextLoading: true }).reason).toBe(zh.modes.previewLoadingContext);
    expect(gate({ taskReady: false }).reason).toBe(zh.modes.previewNoTask);
    expect(gate({ targetReady: false }).reason).toBe(zh.modes.previewNoTarget);
  });

  test("disables start while the task is debouncing or composing", () => {
    expect(gate({ taskPending: true }).reason).toBe(zh.modes.previewDebouncing);
  });

  test("disables start while a preview is pending or refreshing", () => {
    expect(gate({ preview: undefined }).reason).toBe(zh.modes.previewPending);
    expect(gate({ fetching: true }).reason).toBe(zh.modes.previewUpdating);
    expect(gate({ previewIdentity: "old-identity" }).reason).toBe(zh.modes.previewPending);
  });

  test("disables start when the preview itself is blocked", () => {
    expect(gate({ preview: blockedResult }).reason).toBe(zh.modes.previewBlocked);
    expect(
      gate({
        preview: {
          ok: true,
          preview: { ...preview, issues: [blockerIssue("MODE_CONTEXT_UNAVAILABLE")] },
        },
      }).reason,
    ).toBe(zh.modes.previewBlocked);
  });

  test("disables start when the preview request failed", () => {
    expect(gate({ error: "offline" }).reason).toBe(zh.modes.previewFailed);
  });
});

describe("preview lists and plan changes", () => {
  test("blockers and warnings are localized and deduplicated", () => {
    const duplicate = blockerIssue("MODE_CONTEXT_UNAVAILABLE");
    expect(
      previewBlockers({
        ok: true,
        preview: { ...preview, issues: [duplicate, duplicate] },
      }),
    ).toEqual([zh.modes.contextUnavailable]);
    expect(previewWarnings({ ok: true, preview: { ...preview, warnings: ["w", "w"] } })).toEqual([
      "w",
    ]);
    expect(previewBlockers(blockedResult)).toEqual(["No workspace"]);
    expect(previewWarnings(blockedResult)).toEqual(["Check the Team"]);
  });

  test("warnings come only from the server list for duplicate labels", () => {
    const duplicateTeam = {
      ...codingTeam,
      members: [
        { roleId: "developer", instanceLabel: "A", seatId: "seat-a", enabled: true },
        { roleId: "developer", instanceLabel: "a", seatId: "seat-b", enabled: true },
      ],
    };
    const { plan, preview: realPreview } = realPreviewOf(duplicateTeam);
    const warnings = previewWarnings({ ok: true, preview: realPreview });
    expect(warnings).toEqual(plan.warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("developer");
  });

  test("disabled Role warnings use only the server text, not a blocker sentence", () => {
    const disabledTeam = {
      ...codingTeam,
      members: [
        { roleId: "developer", instanceLabel: "Backend", seatId: "seat-dev", enabled: true },
      ],
    };
    const { plan, preview: realPreview } = realPreviewOf(disabledTeam, [
      techLead,
      architect,
      { ...developer, enabled: false },
    ]);
    const warnings = previewWarnings({ ok: true, preview: realPreview });
    expect(warnings).toEqual(plan.warnings);
    expect(warnings.some((warning) => warning.includes("仍按原绑定启动"))).toBe(true);
    expect(warnings).not.toContain(zh.modes.roleDisabled("developer"));
    expect(warnings).not.toContain(zh.modes.roleDisabled("Developer"));
  });

  test("only the exact plan-changed blocker refreshes a preview", () => {
    expect(isPlanChanged([zh.modes.planChanged])).toBe(true);
    expect(isPlanChanged([zh.modes.planChanged, "other"])).toBe(true);
    expect(isPlanChanged(["other"])).toBe(false);
    expect(startFailureAction([zh.modes.planChanged])).toBe("refresh-preview");
    expect(startFailureAction(["other"])).toBe("show-blockers");
  });

  test("standby never hides an on-demand activation label", () => {
    expect(launchSeatStatus({ activation: "on-demand", standby: true })).toBe(
      `${zh.modes.activationOnDemand} · ${zh.modes.standby}`,
    );
    expect(launchSeatStatus({ activation: "escalation-only", standby: true })).toBe(
      zh.modes.activationEscalationOnly,
    );
    expect(launchSeatStatus({ activation: "eager", standby: false })).toBe(
      zh.modes.activationEager,
    );
  });

  test("formats budget and basis with the F2 wording", () => {
    expect(formatLaunchBudget("economy", "pool")).toBe("经济 · 经济池");
    expect(formatLaunchBudget("sota", "host")).toBe("SOTA · 宿主标签");
    expect(formatLaunchBudget("unknown", "conservative-default")).toBe("未核实 · 保守默认");
    expect(formatLaunchBudget(undefined, undefined)).toBe(zh.modes.budgetValueUnknown);
  });

  test("maps common issue codes and falls back to the raw code", () => {
    expect(
      modeIssueText({
        code: "MODE_POOL_UNAVAILABLE",
        severity: "warning",
        params: { provider: "omp" },
      }),
    ).toBe(zh.modes.poolUnavailable("omp"));
    expect(
      modeIssueText({ code: "MODE_LIMIT_CLAMPED", severity: "warning", params: { limit: 8 } }),
    ).toBe(zh.modes.limitClamped(8));
    expect(modeIssueText({ code: "MODE_PLAN_CHANGED", severity: "blocker", params: {} })).toBe(
      zh.modes.planChanged,
    );
    expect(modeIssueText({ code: "FUTURE_CODE", severity: "warning", params: {} })).toBe(
      zh.modes.unknownFallback("FUTURE_CODE"),
    );
  });
});

function blockerIssue(code: string) {
  return { code, severity: "blocker" as const, params: {} };
}

const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: allAvailable,
};
const economy: EconomyPolicy = { pool: [], taskOrder: {}, profileBudget: {} };

function realPreviewOf(
  team: typeof codingTeam,
  roles = [techLead, architect, developer],
): { plan: ReturnType<typeof buildLaunchPlan>; preview: ReturnType<typeof toModeLaunchPreview> } {
  const plan = buildLaunchPlan({
    team,
    roles,
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
    workspaceId: "ws-1",
    task: "Add Stripe",
    runId: "preview",
    maxMembers: 24,
    mode: "sota",
    host,
    economy,
    runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
  });
  return { plan, preview: toModeLaunchPreview(plan, "hash", [], economy) };
}
