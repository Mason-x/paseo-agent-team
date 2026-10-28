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
import { TEAM_MODE_OPTIONS } from "../../client/shared/team-mode-options";
import {
  type LaunchJob,
  LaunchPreviewInputSchema,
  LaunchStartInputSchema,
  launchStatusRpc,
  projectLaunchJobForLegacyPeer,
} from "../../shared/rpc";
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
