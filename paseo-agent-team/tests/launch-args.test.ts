import { describe, expect, test } from "vitest";
import { resolveLaunchPrefill } from "../client/launch/launch-args";
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
