// I02: request wiring, host isolation, stale-preview gates and Role repair targets.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { designContractFields } from "../../client/designer/design-gateway";
import {
  planSettledForHost,
  roleEditorTargetForGap,
  teamPlanActive,
} from "../../client/designer/design-screen-state";
import {
  launchPreviewRequest,
  launchStartRequest,
  launchStatusRequest,
} from "../../client/launch/launch-args";
import {
  launchGate,
  launchPreviewIdentity,
  launchPreviewQueryKey,
} from "../../client/launch/launch-preview-state";
import { modeContractSupport } from "../../shared/domain/mode-contract";
import {
  LaunchPreviewInputSchema,
  LaunchStartInputSchema,
  launchStatusRpc,
} from "../../shared/rpc";
import {
  type LaunchPreviewResult,
  ModeLaunchPreviewSchema,
} from "../../shared/schemas/launch-preview";
import { architect } from "../fixtures";

const target = { kind: "workspace" as const, workspaceId: "ws-1" };
const input = { teamId: "coding-team", task: "Ship it", target, expectedPlanHash: "hash-1" };
const keyInput = { hostId: "host-1", teamId: input.teamId, task: input.task, target };

function source(...parts: string[]) {
  return readFileSync(path.join(import.meta.dirname, "..", "..", ...parts), "utf8");
}

describe("I02 wiring", () => {
  test("launch preview, start and status use the same mode-free request shape", () => {
    const preview = launchPreviewRequest(input);
    expect(LaunchPreviewInputSchema.parse(preview)).toEqual({
      teamId: "coding-team",
      task: "Ship it",
      target,
    });
    expect(preview).not.toHaveProperty("mode");
    expect(preview).not.toHaveProperty("contractVersion");
    const start = launchStartRequest(input);
    expect(LaunchStartInputSchema.parse(start)).toEqual(input);
    expect(start).not.toHaveProperty("mode");
    expect(start).not.toHaveProperty("contractVersion");
    expect(launchStatusRpc.input.parse(launchStatusRequest("run-1"))).toEqual({ runId: "run-1" });
  });

  test("designer contract negotiation keeps failure distinct from method-not-found", () => {
    expect(modeContractSupport({ kind: "failed" })).toBe("unknown");
    expect(modeContractSupport({ kind: "method-not-found" })).toBe("legacy");
    expect(modeContractSupport({ kind: "capabilities", modeContract: 2 })).toBe("v2");
    expect(designContractFields("v2")).toEqual({ contractVersion: 2 });
    expect(designContractFields("legacy")).toEqual({});
    expect(designContractFields("unknown")).toEqual({});
  });

  test("a single-path status preserves progress, warnings and hash", () => {
    const job = {
      runId: "run-1",
      teamId: "team-1",
      teamName: "Team",
      state: "succeeded" as const,
      step: "done" as const,
      memberTotal: 1,
      memberIds: ["m1"],
      warnings: ["w1", "w2"],
      startedAt: "2026-01-01T00:00:00.000Z",
      mode: "sota" as const,
      planHash: "abc",
    };
    expect(launchStatusRpc.output.parse({ job }).job).toEqual(job);
    expect(launchStatusRpc.output.parse({ job: null })).toEqual({ job: null });
  });

  test("gap exits resolve to the exact Role and editor focus", () => {
    expect(roleEditorTargetForGap([architect], { roleId: architect.id, profileId: "p1" })).toEqual({
      role: architect,
      focusProfileId: "p1",
    });
    expect(roleEditorTargetForGap([architect], { roleId: architect.id })).toEqual({
      role: architect,
      focusProfileId: null,
    });
    expect(roleEditorTargetForGap([architect], { roleId: "deleted-role" })).toBeNull();
    expect(roleEditorTargetForGap([], { roleId: architect.id })).toBeNull();
  });

  test("Crew and Teams launch dialogs do not expose retired mode or edit props", () => {
    for (const screen of [
      source("client", "main.tsx"),
      source("client", "app", "AgentTeamsScreen.tsx"),
    ]) {
      expect(screen).toMatch(/<LaunchDialog/);
      expect(screen).not.toMatch(
        /<LaunchDialog[\s\S]{0,700}(onEditTeam|initialMode|probeSettled)=/,
      );
    }
  });
});

describe("host isolation and preview identity", () => {
  test("preview identity includes host, Team, task and target, with task whitespace normalized", () => {
    expect(launchPreviewQueryKey(keyInput)).toEqual([
      "agent-team",
      "launch-preview",
      "host-1",
      "coding-team",
      "Ship it",
      target,
    ]);
    const original = launchPreviewIdentity(keyInput);
    expect(launchPreviewIdentity({ ...keyInput, task: " Ship it " })).toBe(original);
    for (const changed of [
      { ...keyInput, hostId: "host-2" },
      { ...keyInput, teamId: "team-2" },
      { ...keyInput, task: "Different task" },
      { ...keyInput, target: { kind: "workspace" as const, workspaceId: "ws-2" } },
    ])
      expect(launchPreviewIdentity(changed)).not.toBe(original);
  });

  test("an old preview cannot start after the target changes", () => {
    const preview: LaunchPreviewResult = {
      ok: true,
      preview: ModeLaunchPreviewSchema.parse({
        requestedMode: "sota",
        coordinator: {
          roleId: "lead",
          roleName: "Lead",
          profile: null,
          source: "unavailable",
          issues: [],
        },
        seats: [],
        counts: { logical: 0, physical: 0, eager: 0, deferred: 0, escalation: 0, sotaPotential: 0 },
        budget: { economy: 0, sota: 0, unknown: 0, deferredSota: 0 },
        issues: [],
        warnings: [],
        planHash: "hash",
      }),
    };
    const gate = launchGate({
      starting: false,
      running: false,
      contextLoading: false,
      taskReady: true,
      taskPending: false,
      targetReady: true,
      preview,
      previewIdentity: launchPreviewIdentity(keyInput),
      currentIdentity: launchPreviewIdentity({ ...keyInput, hostId: "host-2" }),
      fetching: false,
      error: null,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).not.toBeNull();
  });

  test("a settled v2 view from host A never authorizes host B", () => {
    const hostA = { scopeHostId: "A", loaded: true, error: null };
    expect(planSettledForHost(hostA, "A")).toBe(true);
    expect(planSettledForHost(hostA, "B")).toBe(false);
    expect(planSettledForHost({ ...hostA, scopeHostId: "B", loaded: false }, "B")).toBe(false);
    expect(planSettledForHost({ ...hostA, scopeHostId: "B", error: "offline" }, "B")).toBe(true);
    expect(planSettledForHost({ scopeHostId: null, loaded: true, error: null }, "A")).toBe(false);
  });

  test("cold loading never probes; the first ready screen plans the real list", () => {
    expect(
      teamPlanActive({
        teamsTab: true,
        launchOpen: false,
        settingsReady: false,
        profilesLoading: false,
      }),
    ).toBe(false);
    expect(
      teamPlanActive({
        teamsTab: true,
        launchOpen: false,
        settingsReady: true,
        profilesLoading: true,
      }),
    ).toBe(false);
    expect(
      teamPlanActive({
        teamsTab: true,
        launchOpen: false,
        settingsReady: true,
        profilesLoading: false,
      }),
    ).toBe(true);
    expect(
      teamPlanActive({
        teamsTab: false,
        launchOpen: true,
        settingsReady: true,
        profilesLoading: true,
      }),
    ).toBe(true);
    expect(
      teamPlanActive({
        teamsTab: false,
        launchOpen: true,
        settingsReady: false,
        profilesLoading: false,
      }),
    ).toBe(false);
  });

  test("the designer waits for its host probe while the launch dialog gates its own preview", () => {
    const screen = source("client", "app", "AgentTeamsScreen.tsx");
    const dialog = source("client", "launch", "LaunchDialog.tsx");
    const hook = source("client", "teams", "use-team-plans.ts");
    expect(screen).toContain("const plansSettled = planSettledForHost(plans, host.id);");
    expect(screen).toContain('active: tab === "teams" && plansSettled');
    expect(screen).toContain("disabledReason: plansSettled ? undefined");
    expect(screen).toContain("modeContract: plans.modeContract");
    expect(hook.indexOf("client.setScope({")).toBeLessThan(hook.indexOf("client.setActive(true)"));
    expect(dialog).toContain(
      "launchPreviewQueryKey({ hostId, teamId, task: previewTask, target })",
    );
    expect(dialog).toContain("const blocked = gate.disabled");
    expect(dialog).toContain("shownPreview.identity !== currentIdentity");
    expect(dialog).toContain("status(launchStatusRequest(job.runId))");
    expect(dialog).toContain("new Set(job?.warnings ?? [])");
  });
});

describe("editor exits and refresh wiring", () => {
  test("closing the Role editor invalidates the plan without closing the Team editor", () => {
    const screen = source("client", "app", "AgentTeamsScreen.tsx");
    expect(screen).toMatch(
      /onClose=\{\(\) => \{\s*setRoleEditor\(null\);\s*plans\.invalidate\(\);\s*void hostProfiles\.reload\(\);/,
    );
    expect(screen).toMatch(/<TeamEditor/);
  });

  test("saving member limits invalidates plans and reloads preferences", () => {
    const screen = source("client", "app", "AgentTeamsScreen.tsx");
    expect(screen).toMatch(/<MaxMembersEditor/);
    expect(screen).toMatch(
      /onSaved=\{\(\) => \{\s*plans\.invalidate\(\);\s*void preferences\.reload\(\);/,
    );
  });
});
