import { describe, expect, test } from "vitest";
import { jobDoneText, jobProgressLabel } from "../client/launch/launch-job-copy";
import { previewBlockers, previewWarnings } from "../client/launch/launch-preview-state";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import type { LaunchJob } from "../shared/rpc";
import type { LaunchPreviewResult } from "../shared/schemas/launch-preview";
import { zh } from "../shared/zh";
import { runEngineZh } from "../shared/zh/run-engine";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  techLead,
} from "./fixtures";
import { policy } from "./fixtures/run-engine/base";

function job(overrides: Partial<LaunchJob> = {}): LaunchJob {
  return {
    runId: "run-1",
    teamId: "team",
    teamName: "Team",
    state: "running",
    step: "kickoff",
    memberTotal: 2,
    memberIds: [],
    warnings: [],
    startedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("what the dialog says while a job runs", () => {
  test("the steps before the kickoff are worded as they always were, Engine or not", () => {
    for (const engine of [undefined, { launchState: "creating" as const }]) {
      expect(jobProgressLabel(job({ step: "workspace", engine }))).toBe(zh.creatingWorkspace);
      expect(jobProgressLabel(job({ step: "coordinator", engine }))).toBe(zh.creatingCoordinator);
      expect(
        jobProgressLabel(job({ step: "member", memberIndex: 2, memberTotal: 3, engine })),
      ).toBe(zh.creatingMember(2, 3));
    }
  });

  test("a member step without an index counts from one", () => {
    expect(jobProgressLabel(job({ step: "member", memberTotal: 4 }))).toBe(zh.creatingMember(1, 4));
  });

  test("the coordinator chain's last step is unchanged", () => {
    expect(jobProgressLabel(job({ step: "kickoff" }))).toBe(zh.sendingKickoff);
  });

  test("an Engine Run's last step says a plan request was submitted, that it takes minutes, and not to start again", () => {
    for (const step of ["kickoff", "done"] as const) {
      const text = jobProgressLabel(job({ step, engine: { launchState: "kickoff-pending" } }));
      expect(text).toBe(runEngineZh.launchJob.sendingPlanRequest);
    }
    expect(runEngineZh.launchJob.sendingPlanRequest).toContain("计划请求");
    expect(runEngineZh.launchJob.sendingPlanRequest).toContain("几分钟");
    expect(runEngineZh.launchJob.sendingPlanRequest).toContain("不要重复启动");
  });
});

describe("what the dialog says when the job is done", () => {
  test("a Run whose plan request is confirmed, one whose is not yet, and the coordinator chain", () => {
    expect(jobDoneText(job({ state: "succeeded", engine: { launchState: "running" } }))).toBe(
      runEngineZh.launchJob.done,
    );
    expect(
      jobDoneText(job({ state: "succeeded", engine: { launchState: "kickoff-pending" } })),
    ).toBe(runEngineZh.launchJob.donePending);
    expect(jobDoneText(job({ state: "succeeded" }))).toBe(zh.launched);
  });

  test("the unconfirmed case says the Engine checks by itself and never sends twice", () => {
    expect(runEngineZh.launchJob.donePending).toContain("不会重复发送");
    expect(runEngineZh.launchJob.donePending).toContain("Runs 页");
  });
});

describe("the preview shows what the Engine launch gate says", () => {
  const seat = (seatId: string, duties: string[], tier = "B") => ({
    seatId,
    tier,
    duties,
    channelId: "claude",
    enabled: true,
  });
  const members = [
    { roleId: "architect", seatId: "seat-a", enabled: true },
    { roleId: "developer", instanceLabel: "Backend", seatId: "seat-d", enabled: true },
  ];
  function planFor(runEngine: unknown, supported: boolean) {
    return buildLaunchPlan({
      team: { ...codingTeam, members, runEngine },
      roles: [techLead, architect, developer],
      profiles: [claudeOpus, codexXhigh],
      availability: allAvailable,
      workspaceId: "ws-1",
      task: "Add Stripe subscriptions to the billing page.",
      runId: "run-1",
      maxMembers: 8,
      runEngineSupported: supported,
    });
  }
  const block = (seats: unknown[]) => ({ version: 1, enabled: true, seats, policy: policy() });

  test("a roster that does not match the Team is a blocker in the preview", () => {
    const plan = planFor(block([seat("seat-a", ["implement"])]), true);
    const result: LaunchPreviewResult = {
      ok: false,
      blockers: plan.blockers,
      warnings: plan.warnings,
    } as never;
    const blockers = previewBlockers(result);
    expect(blockers.join("\n")).toContain(runEngineZh.launch.seatMissing("seat-d"));
  });

  test("a host that cannot run the Engine refuses an enabled Team instead of quietly using the old chain", () => {
    const plan = planFor(block([seat("seat-a", ["implement"]), seat("seat-d", ["review"])]), false);
    const blockers = previewBlockers({
      ok: false,
      blockers: plan.blockers,
      warnings: plan.warnings,
    } as never);
    expect(blockers).toContain(runEngineZh.launch.unsupported);
  });

  test("a reviewer tier that is missing, and Codex without full access, are warnings in the preview", () => {
    const plan = planFor(
      block([seat("seat-a", ["implement"], "A"), seat("seat-d", ["review"], "B")]),
      true,
    );
    const warnings = previewWarnings({
      ok: true,
      preview: { warnings: plan.warnings, issues: [] },
    } as never);
    expect(warnings.join("\n")).toContain(
      runEngineZh.launch.reviewerTierMissing("seat-a", "L3", "A"),
    );
  });

  test("a damaged block is a blocker that says the old chain is not used", () => {
    const plan = planFor({ version: 9 }, true);
    const blockers = previewBlockers({ ok: false, blockers: plan.blockers, warnings: [] } as never);
    expect(blockers.join("\n")).toContain("不会改用旧流程");
  });

  test("a Team with no Engine block has no Engine line at all", () => {
    const plan = planFor(undefined, true);
    expect(plan.blockers.join("\n")).not.toContain("Run 引擎");
    expect(plan.warnings.join("\n")).not.toContain("Run 引擎");
  });
});
