// I02 spec: launch requests negotiate the host's contract exactly (AC-0.4a/0.5/0.6,
// AC-0b.9/14), the legacy status projection is lossless for a stale page, and the screen's gap
// exits map onto real editor targets (AC-0c.8, AC-0d.20).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { designContractFields, designModeNeedsV2 } from "../../client/designer/design-gateway";
import {
  economyFocusForConfigure,
  roleEditorTargetForGap,
} from "../../client/designer/design-screen-state";
import {
  launchPreviewRequest,
  launchStartRequest,
  launchStatusRequest,
} from "../../client/launch/launch-args";
import {
  launchGate,
  launchPreviewCacheKey,
  launchPreviewQueryKey,
} from "../../client/launch/launch-preview-state";
import { TEAM_MODE_OPTIONS } from "../../client/shared/team-mode-options";
import {
  type LaunchJob,
  LaunchPreviewInputSchema,
  LaunchStartInputSchema,
  launchStatusRpc,
  projectLaunchJobForLegacyPeer,
} from "../../shared/rpc";
import type { LaunchPreviewResult } from "../../shared/schemas/launch-preview";
import { launchContractZh } from "../../shared/zh/launch-contract";
import { modesZh } from "../../shared/zh/modes";
import { architect } from "../fixtures";

const target = { kind: "workspace" as const, workspaceId: "ws-1" };
const input = { teamId: "coding-team", task: "Ship it", target, expectedPlanHash: "hash-1" };

describe("I02 wiring", () => {
  test("only a confirmed v2 probe adds contractVersion, and mode is never sent", () => {
    for (const support of ["legacy", "unknown"] as const) {
      const preview = launchPreviewRequest(input, support);
      expect(LaunchPreviewInputSchema.parse(preview)).toEqual(preview);
      expect(preview).not.toHaveProperty("contractVersion");
      expect(preview).not.toHaveProperty("mode");
      expect(launchStartRequest(input, support)).not.toHaveProperty("contractVersion");
      expect(launchStatusRequest("run-1", support)).toEqual({ runId: "run-1" });
    }
    const preview = launchPreviewRequest(input, "v2");
    expect(LaunchPreviewInputSchema.parse(preview)).toEqual({
      teamId: "coding-team",
      task: "Ship it",
      target,
      contractVersion: 2,
    });
    const start = launchStartRequest(input, "v2");
    expect(LaunchStartInputSchema.parse(start)).toMatchObject({
      expectedPlanHash: "hash-1",
      contractVersion: 2,
    });
    expect(start).not.toHaveProperty("mode");
    expect(launchStatusRequest("run-1", "v2")).toEqual({ runId: "run-1", contractVersion: 2 });
    expect(launchStatusRpc.input.parse(launchStatusRequest("run-1", "v2"))).toEqual({
      runId: "run-1",
      contractVersion: 2,
    });
  });

  test("the design gate keeps all three probe states distinct", () => {
    expect(designContractFields("v2")).toEqual({ contractVersion: 2 });
    expect(designContractFields("legacy")).toEqual({});
    expect(designContractFields("unknown")).toEqual({});
    // Unknown must not be flattened to legacy: only v2 unlocks new modes.
    expect(designModeNeedsV2("economy-all", "unknown")).toBe(true);
    expect(designModeNeedsV2("economy-all", "legacy")).toBe(true);
    expect(designModeNeedsV2("economy-all", "v2")).toBe(false);
  });

  test("a stale poll gets the real state without mode, plus one refresh hint", () => {
    const job: LaunchJob = {
      runId: "run-1",
      teamId: "team-1",
      teamName: "Team",
      state: "succeeded",
      step: "done",
      memberTotal: 1,
      memberIds: ["m1"],
      warnings: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      mode: "economy-all",
      planHash: "abc",
    };
    const legacy = projectLaunchJobForLegacyPeer(job, undefined);
    expect(legacy?.state).toBe("succeeded");
    expect(legacy).not.toHaveProperty("mode");
    expect(legacy?.warnings).toEqual([launchContractZh.refreshHint]);
    // v2 keeps the job untouched and never sees the legacy hint.
    expect(projectLaunchJobForLegacyPeer(job, 2)).toBe(job);
  });

  test("gap exits resolve to the exact Role and editor focus", () => {
    expect(roleEditorTargetForGap([architect], { roleId: architect.id, profileId: "p1" })).toEqual({
      role: architect,
      focusProfileId: "p1",
    });
    expect(roleEditorTargetForGap([architect], { roleId: "deleted-role" })).toBeNull();
    expect(economyFocusForConfigure({ layer: "allSeats", route: "retain" })).toEqual({
      layer: "allSeats",
      route: "retain",
    });
    expect(economyFocusForConfigure({ layer: "allSeats", route: "bogus" })).toBeNull();
  });

  test("the four mode labels come from the single table", () => {
    expect(TEAM_MODE_OPTIONS.map((option) => option.label)).toEqual([
      modesZh.modeLabels.flagship,
      modesZh.modeLabels.standard,
      modesZh.modeLabels.economy,
      modesZh.modeLabels.collaborative,
    ]);
  });

  test("the Crew launch keeps the fixed edit hint instead of an edit button", () => {
    const crew = readFileSync(
      path.join(import.meta.dirname, "..", "..", "client", "main.tsx"),
      "utf8",
    );
    expect(crew).toMatch(/<LaunchDialog/);
    expect(crew).not.toMatch(/onEditTeam=/);
    const teams = readFileSync(
      path.join(import.meta.dirname, "..", "..", "client", "app", "AgentTeamsScreen.tsx"),
      "utf8",
    );
    expect(teams).toMatch(/onEditTeam=/);
  });
});

// T2-51 independent additions: the implementer's cases above are untouched. These focus on the
// probe-settled gate, Crew ownership, cache identity, status warnings, and editor refresh wiring.
describe("acceptance additions: probe-settled gating and preview identity", () => {
  const keyInput = {
    hostId: "host-1",
    teamId: "coding-team",
    task: "Ship it",
    target: { kind: "workspace" as const, workspaceId: "ws-1" },
    savedMode: "economy-all" as const,
  };

  test("unknown is a distinct preview identity, never flattened to legacy", () => {
    const legacy = launchPreviewCacheKey(keyInput, "legacy");
    const unknown = launchPreviewCacheKey(keyInput, "unknown");
    const v2 = launchPreviewCacheKey(keyInput, "v2");
    expect(legacy).toEqual([...launchPreviewQueryKey(keyInput), "legacy"]);
    expect(unknown).not.toEqual(legacy);
    expect(v2).not.toEqual(unknown);
    expect(new Set([legacy, unknown, v2].map((key) => JSON.stringify(key))).size).toBe(3);
    // Only v2 grants the new-mode capability; unknown must keep blocking instead of pretending.
    expect(designModeNeedsV2("economy-all", "unknown")).toBe(true);
    expect(designModeNeedsV2("economy-all", "legacy")).toBe(true);
    expect(designModeNeedsV2("economy-all", "v2")).toBe(false);
  });

  test("an old preview identity cannot be started after the probe upgrades", () => {
    // Minimal gated preview: the decision under test is identity, not preview content.
    const preview = {
      ok: true,
      preview: { issues: [], warnings: [] },
    } as unknown as LaunchPreviewResult;
    const gate = launchGate({
      starting: false,
      running: false,
      contextLoading: false,
      taskReady: true,
      taskPending: false,
      targetReady: true,
      preview,
      previewIdentity: JSON.stringify(launchPreviewCacheKey(keyInput, "unknown")),
      currentIdentity: JSON.stringify(launchPreviewCacheKey(keyInput, "v2")),
      fetching: false,
      error: null,
    });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).not.toBeNull();
  });

  test("the screen and dialog do not poll or preview before the probe settles", () => {
    const root = path.join(import.meta.dirname, "..", "..");
    const screen = readFileSync(path.join(root, "client", "app", "AgentTeamsScreen.tsx"), "utf8");
    const dialog = readFileSync(path.join(root, "client", "launch", "LaunchDialog.tsx"), "utf8");

    expect(screen).toContain("const plansSettled = plans.loaded || plans.error !== null");
    expect(screen).toContain('active: tab === "teams" && plansSettled');
    expect(screen).toContain("disabledReason: plansSettled ? undefined");
    expect(screen).toMatch(/probeSettled=\{plansSettled\}/);
    expect(screen).toMatch(/modeContract: plans\.modeContract/);
    expect(screen).toMatch(/modeContract=\{plans\.modeContract\}/);

    expect(dialog).toMatch(/enabled:\s*[\s\S]{0,140}probeSettled/);
    expect(dialog).toContain("const blocked = gate.disabled || !probeSettled");
    expect(dialog).toMatch(/launchStatusRequest\(job\.runId, modeContract\)/);
    // The legacy hint is rendered from job warnings; v2 never receives it from the server.
    expect(dialog).toMatch(/new Set\(job\?\.warnings \?\? \[\]\)/);
  });

  test("the Crew panel owns a probe-only client and has no edit/mode entry", () => {
    const crew = readFileSync(
      path.join(import.meta.dirname, "..", "..", "client", "main.tsx"),
      "utf8",
    );
    expect(crew).toContain("useTeamPlans({");
    expect(crew).toContain("teams: [],");
    expect(crew).toContain("active: launch !== null");
    expect(crew).toContain("modeContract={crewPlans.modeContract}");
    expect(crew).toContain("probeSettled={crewProbeSettled}");
    expect(crew).not.toContain("initialMode");
    expect(crew).not.toMatch(/<LaunchDialog[\s\S]{0,400}onEditTeam=/);
  });

  test("a legacy status hint is added once; v2 and legacy-mode jobs keep their own warnings", () => {
    const job: LaunchJob = {
      runId: "run-1",
      teamId: "team-1",
      teamName: "Team",
      state: "succeeded",
      step: "done",
      memberTotal: 1,
      memberIds: ["m1"],
      warnings: ["w1", "w2"],
      startedAt: "2026-01-01T00:00:00.000Z",
      mode: "economy-all",
      planHash: "abc",
    };
    const legacy = projectLaunchJobForLegacyPeer(job, undefined);
    expect(legacy?.warnings).toEqual(["w1", "w2", launchContractZh.refreshHint]);
    const duplicate = projectLaunchJobForLegacyPeer(
      { ...job, warnings: [...job.warnings, launchContractZh.refreshHint] },
      undefined,
    );
    expect(duplicate?.warnings).toEqual(["w1", "w2", launchContractZh.refreshHint]);
    expect(projectLaunchJobForLegacyPeer(job, 2)).toBe(job);
    expect(projectLaunchJobForLegacyPeer({ ...job, mode: "economy" }, undefined)).toEqual({
      ...job,
      mode: "economy",
    });
  });
});

describe("acceptance additions: editor exits and invalidate hooks", () => {
  test("role and economy exits cover missing focus and invalid routes", () => {
    expect(roleEditorTargetForGap([architect], { roleId: architect.id })).toEqual({
      role: architect,
      focusProfileId: null,
    });
    expect(roleEditorTargetForGap([], { roleId: architect.id })).toBeNull();
    expect(economyFocusForConfigure({ layer: "standard", route: "bogus" })).toEqual({
      layer: "standard",
    });
    expect(economyFocusForConfigure({ layer: "allSeats" })).toEqual({ layer: "allSeats" });
    expect(economyFocusForConfigure({ layer: "allSeats", route: "retain" })).toEqual({
      layer: "allSeats",
      route: "retain",
    });
    expect(economyFocusForConfigure({ layer: "allSeats", route: "not-a-route" })).toBeNull();
  });

  test("closing either editor invalidates the plan while the Team draft is untouched", () => {
    const screen = readFileSync(
      path.join(import.meta.dirname, "..", "..", "client", "app", "AgentTeamsScreen.tsx"),
      "utf8",
    );
    // EconomyPoolEditor: both onSaved and onClose invalidate; onClose clears the focus.
    expect(screen).toMatch(/onSaved=\{\(\) => \{\s*plans\.invalidate\(\);/);
    expect(screen).toMatch(
      /onClose=\{\(\) => \{\s*plans\.invalidate\(\);\s*setEconomyFocus\(null\);/,
    );
    // RoleEditor: close invalidates and reloads the live Profiles.
    expect(screen).toMatch(
      /onClose=\{\(\) => \{\s*setRoleEditor\(null\);\s*plans\.invalidate\(\);\s*void hostProfiles\.reload\(\);/,
    );
    // The Team editor is a different modal and is intentionally not invalidated by these closes.
    expect(screen).toMatch(/<TeamEditor/);
  });
});
