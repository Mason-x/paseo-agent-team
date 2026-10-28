import { describe, expect, test } from "vitest";
import {
  applyGapRetry,
  designerPrefillFromEvent,
  designLaunchSeed,
  designPrefillForHost,
  designPrefillSlot,
  designSaveAttemptKey,
  designStartFailureMessage,
  economyFocusForConfigure,
  roleEditorTargetForGap,
  shouldAutoSaveDesignJob,
  shouldCleanupDesignJob,
  shouldWarnOnlyWorkspace,
} from "../client/designer/design-screen-state";
import type { DesignLaunchPrefill } from "../client/designer/submission-state";
import type { DesignIssue } from "../shared/schemas/design";
import { designZh } from "../shared/zh/design";
import { designJob } from "./design-fixtures";
import { architect } from "./fixtures";

describe("gap exits", () => {
  test("opens a known Role with the Profile the row names", () => {
    expect(
      roleEditorTargetForGap([architect], { roleId: architect.id, profileId: "profile-1" }),
    ).toEqual({ role: architect, focusProfileId: "profile-1" });
    expect(roleEditorTargetForGap([architect], { roleId: architect.id })).toEqual({
      role: architect,
      focusProfileId: null,
    });
    // A missing Role must not open the editor on a different record.
    expect(roleEditorTargetForGap([architect], { roleId: "ghost" })).toBeNull();
  });

  test("maps gap policy exits onto the editor focus", () => {
    expect(economyFocusForConfigure({ layer: "allSeats", route: "execution" })).toEqual({
      layer: "allSeats",
      route: "execution",
    });
    expect(economyFocusForConfigure({ layer: "allSeats" })).toEqual({ layer: "allSeats" });
    expect(economyFocusForConfigure({ layer: "standard" })).toEqual({ layer: "standard" });
    expect(economyFocusForConfigure({ layer: "allSeats", route: "turbo" })).toBeNull();
  });
});

const issue: DesignIssue = {
  code: "DESIGN_NO_WORKSPACE",
  severity: "error",
  path: ["carrier"],
  params: { reason: "target-is-only-workspace" },
  action: "choose-workspace",
};

describe("screen prefill", () => {
  test("maps the one-shot event without inventing a workspace or mode", () => {
    const event = {
      token: "a".repeat(32),
      scopeId: "scope",
      request: "设计改版",
      workspaceId: null,
      createdAt: 1,
    };
    expect(designerPrefillFromEvent(event)).toEqual({
      nonce: "a".repeat(32),
      text: "设计改版",
      workspaceId: null,
    });
  });

  test("keeps an explicit mode", () => {
    expect(
      designerPrefillFromEvent({
        token: "b".repeat(32),
        scopeId: "scope",
        request: "需求",
        workspaceId: "ws-1",
        mode: "economy",
        createdAt: 1,
      }),
    ).toMatchObject({ workspaceId: "ws-1", mode: "economy" });
  });
});

describe("gap retry slot", () => {
  const prefill = {
    nonce: "n-1",
    text: "原需求",
    workspaceId: "ws-target",
    mode: "sota" as const,
    existingRolesOnly: false,
    confirmReplace: true,
  };

  test("shows the Teams tab and hands the card exactly the planned prefill", () => {
    expect(applyGapRetry("host-a", prefill)).toEqual({
      tab: "teams",
      designPrefill: { hostId: "host-a", value: prefill },
    });
  });

  test("a prefill made for another host is never delivered", () => {
    const slot = designPrefillSlot("host-a", prefill);
    expect(designPrefillForHost(slot, "host-a")).toBe(prefill);
    expect(designPrefillForHost(slot, "host-b")).toBeUndefined();
    expect(designPrefillForHost(null, "host-a")).toBeUndefined();
  });
});

describe("launch seed", () => {
  const prefill: DesignLaunchPrefill = {
    initialTeamId: "saved-team",
    lockTeam: true,
    initialTask: "改版",
    initialWorkspaceId: "ws-target",
  };

  test("passes the saved Team and editable target preselect, never a mode", () => {
    const seed = designLaunchSeed(prefill, "result-1");
    expect(seed).toEqual({
      key: "result-1",
      teamId: "saved-team",
      lockTeam: true,
      initialTask: "改版",
      initialWorkspaceId: "ws-target",
    });
    expect(seed).not.toHaveProperty("initialMode");
  });

  test("omits a missing target instead of falling back to a carrier", () => {
    const seed = designLaunchSeed({ ...prefill, initialWorkspaceId: undefined }, "result-2");
    expect(seed).not.toHaveProperty("initialWorkspaceId");
  });
});

describe("start failure copy", () => {
  test("the only-workspace blocker becomes an instruction", () => {
    expect(designStartFailureMessage([issue])).toBe(designZh.targetOnlyWorkspace);
  });

  test("other issues use their localized message", () => {
    expect(
      designStartFailureMessage([
        {
          code: "DESIGN_AGENT_FAILED",
          severity: "error",
          path: [],
          params: {},
          action: "inspect",
        },
      ]),
    ).toBe(designZh.agentFailed);
    expect(designStartFailureMessage([])).toBe(designZh.agentFailed);
  });
});

describe("auto save gate", () => {
  test("requires the visible Team tab and a ready, allowed result", () => {
    const ready = designJob({
      state: "ready",
      resultId: "a".repeat(64),
      allowed: { cancel: true, save: true, launch: false, continueAction: null },
    });
    expect(shouldAutoSaveDesignJob(true, ready)).toBe(true);
    expect(shouldAutoSaveDesignJob(false, ready)).toBe(false);
    expect(shouldAutoSaveDesignJob(true, { ...ready, state: "saving" })).toBe(false);
    expect(shouldAutoSaveDesignJob(true, { ...ready, resultId: null })).toBe(false);
    expect(
      shouldAutoSaveDesignJob(true, {
        ...ready,
        allowed: { ...ready.allowed, save: false },
      }),
    ).toBe(false);
  });
});

describe("cleanup gate", () => {
  const canceled = designJob({
    state: "canceled",
    cancelRequested: true,
    needsCleanup: true,
    saveState: "roles-only",
    resultId: "a".repeat(64),
  });
  const base = {
    active: true,
    job: canceled,
    unknownWrite: false,
    attempted: false,
    savePending: false,
  };

  test("cleans a canceled partial write once when it is safe", () => {
    expect(shouldCleanupDesignJob(base)).toBe(true);
    expect(shouldCleanupDesignJob({ ...base, job: { ...canceled, needsCleanup: false } })).toBe(
      true,
    );
    expect(
      shouldCleanupDesignJob({
        ...base,
        job: designJob({ state: "save_conflict", needsCleanup: true, resultId: "b".repeat(64) }),
      }),
    ).toBe(true);
  });

  test("skips hidden tabs, unknown writes, attempted keys, and live saves", () => {
    expect(shouldCleanupDesignJob({ ...base, active: false })).toBe(false);
    expect(shouldCleanupDesignJob({ ...base, unknownWrite: true })).toBe(false);
    expect(shouldCleanupDesignJob({ ...base, attempted: true })).toBe(false);
    expect(shouldCleanupDesignJob({ ...base, savePending: true })).toBe(false);
    expect(
      shouldCleanupDesignJob({
        ...base,
        job: designJob({ state: "ready", needsCleanup: true, resultId: "c".repeat(64) }),
      }),
    ).toBe(false);
  });
});

describe("save attempt key", () => {
  test("is stable per result and absent before a result exists", () => {
    const job = designJob({ resultId: "d".repeat(64) });
    expect(designSaveAttemptKey(job)).toBe(`${job.jobId}:${"d".repeat(64)}`);
    expect(designSaveAttemptKey({ ...job, resultId: null })).toBeNull();
  });
});

describe("only workspace warning", () => {
  test("warns before start only when the sole workspace is selected", () => {
    expect(shouldWarnOnlyWorkspace(["ws-1"], "ws-1")).toBe(true);
    expect(shouldWarnOnlyWorkspace(["ws-1"], "")).toBe(false);
    expect(shouldWarnOnlyWorkspace(["ws-1", "ws-2"], "ws-1")).toBe(false);
    expect(shouldWarnOnlyWorkspace([], "")).toBe(false);
  });
});
