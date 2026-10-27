import { describe, expect, test } from "vitest";
import {
  launchModeDisplay,
  launchPreviewRequest,
  launchStartRequest,
  resolveLaunchPrefill,
} from "../client/launch/launch-args";
import { zh } from "../shared/zh";
import { modesZh } from "../shared/zh/modes";
import { codingTeam } from "./fixtures";

const teams = [codingTeam, { ...codingTeam, id: "research-team", name: "Research Team" }];

describe("resolveLaunchPrefill", () => {
  test("passes a plain request through", () => {
    expect(resolveLaunchPrefill({ teamId: "coding-team", task: "Ship it" }, teams)).toEqual({
      teamId: "coding-team",
      task: "Ship it",
    });
    expect(resolveLaunchPrefill({}, teams)).toEqual({ teamId: undefined, task: undefined });
  });

  test("treats a first word that names a Team as the Team choice", () => {
    expect(resolveLaunchPrefill({ args: "coding-team Add Stripe billing" }, teams)).toEqual({
      teamId: "coding-team",
      task: "Add Stripe billing",
    });
  });

  test("matches Team names case-insensitively", () => {
    expect(resolveLaunchPrefill({ args: "  RESEARCH-TEAM   look into it " }, teams)).toEqual({
      teamId: "research-team",
      task: "look into it",
    });
    const named = [{ ...codingTeam, id: "alpha", name: "Squad" }];
    expect(resolveLaunchPrefill({ args: "squad do things" }, named)).toEqual({
      teamId: "alpha",
      task: "do things",
    });
  });

  test("a Team with no task leaves the task empty", () => {
    expect(resolveLaunchPrefill({ args: "coding-team" }, teams)).toEqual({
      teamId: "coding-team",
      task: undefined,
    });
  });

  test("otherwise the whole text is the task and the Team stays as requested", () => {
    expect(
      resolveLaunchPrefill({ args: "Add Stripe billing", teamId: "research-team" }, teams),
    ).toEqual({
      teamId: "research-team",
      task: "Add Stripe billing",
    });
  });

  test("blank command text falls back to the request", () => {
    expect(resolveLaunchPrefill({ args: "   ", task: "kept" }, teams)).toEqual({
      teamId: undefined,
      task: "kept",
    });
  });
});

describe("launchModeDisplay", () => {
  test("no selected Team shows no mode row", () => {
    expect(launchModeDisplay(undefined)).toEqual({ kind: "none" });
  });

  test("known modes use the existing mode copy", () => {
    expect(launchModeDisplay({ ...codingTeam, mode: "economy" })).toEqual({
      kind: "known",
      mode: "economy",
      label: modesZh.modeLabels.standard,
    });
    expect(launchModeDisplay({ ...codingTeam, mode: "collaborative" })).toEqual({
      kind: "known",
      mode: "collaborative",
      label: zh.teamModeCollaborative,
    });
  });

  test("a Team without a saved mode falls back to the planner default, SOTA", () => {
    expect(launchModeDisplay(codingTeam)).toEqual({
      kind: "known",
      mode: "sota",
      label: zh.teamModeSota,
    });
  });

  test("an unknown stored value stays unknown and keeps the original text", () => {
    expect(launchModeDisplay({ ...codingTeam, mode: "turbo" })).toEqual({
      kind: "unknown",
      value: "turbo",
    });
  });
});

describe("launch requests", () => {
  const target = { kind: "workspace" as const, workspaceId: "ws-1" };

  test("preview and start never send a mode", () => {
    const preview = launchPreviewRequest({ teamId: "coding-team", task: "Ship it", target });
    expect(preview).toEqual({ teamId: "coding-team", task: "Ship it", target });
    expect(preview).not.toHaveProperty("mode");

    const start = launchStartRequest({
      teamId: "coding-team",
      task: "Ship it",
      target,
      expectedPlanHash: "hash-1",
    });
    expect(start).toEqual({
      teamId: "coding-team",
      task: "Ship it",
      target,
      expectedPlanHash: "hash-1",
    });
    expect(start).not.toHaveProperty("mode");
  });
});
