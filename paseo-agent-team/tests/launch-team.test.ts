import { describe, expect, test, vi } from "vitest";
import { buildLaunchPlan } from "../client/domain/launch-plan";
import { launchTeam, prependRun, toRunSummary } from "../client/launch/launch-team";
import type { PaseoAdapter } from "../client/paseo/adapter";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  NOW,
  techLead,
} from "./fixtures";

function plan() {
  return buildLaunchPlan({
    team: codingTeam,
    roles: [techLead, architect, developer],
    profiles: [claudeOpus, codexXhigh],
    availability: allAvailable,
    workspaceId: "ws-1",
    task: "Add Stripe",
    runId: "run-1",
    maxMembers: 8,
  });
}

function mockAdapter(overrides: Partial<PaseoAdapter> = {}): PaseoAdapter {
  return {
    listProfiles: vi.fn(async () => []),
    listProviderAvailability: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    createWorkspace: vi.fn(async () => ({ id: "ws-new", name: "New workspace" })),
    coordinatorToolsHint: vi.fn(async () => null),
    createAgent: vi.fn(async (input: { parentAgentId?: string; title: string }) => ({
      agentId: input.parentAgentId ? `member-${input.title}` : "coord-1",
    })),
    sendMessage: vi.fn(async () => undefined),
    archiveAgent: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("launchTeam", () => {
  test("creates coordinator, then members with parent, then kickoff", async () => {
    const adapter = mockAdapter();
    const progress: string[] = [];
    const result = await launchTeam(plan(), adapter, {
      archiveOnLaunchFailure: true,
      onProgress: (event) => progress.push(event.step),
    });
    expect(vi.mocked(adapter.createAgent).mock.calls.map((call) => call[0].parentAgentId)).toEqual([
      undefined,
      "coord-1",
      "coord-1",
    ]);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.sendMessage).mock.calls[0]?.[0]).toBe("coord-1");
    expect(vi.mocked(adapter.sendMessage).mock.calls[0]?.[1]).toContain("coord-1");
    expect(result.coordinatorId).toBe("coord-1");
    expect(progress[0]).toBe("coordinator");
    expect(progress.at(-1)).toBe("kickoff");
  });

  test("archives created agents when a member fails and the preference is on", async () => {
    const adapter = mockAdapter({
      createAgent: vi.fn(async (input: { parentAgentId?: string }) => {
        if (input.parentAgentId) throw new Error("member boom");
        return { agentId: "coord-1" };
      }),
    });
    await expect(
      launchTeam(plan(), adapter, { archiveOnLaunchFailure: true }),
    ).rejects.toMatchObject({
      step: "member",
      archived: true,
      agentIdsKept: [],
    });
    expect(vi.mocked(adapter.archiveAgent)).toHaveBeenCalledWith("coord-1");
  });

  test("keeps created agents when archiveOnLaunchFailure is false", async () => {
    const adapter = mockAdapter({
      createAgent: vi.fn(async (input: { parentAgentId?: string }) => {
        if (input.parentAgentId) throw new Error("member boom");
        return { agentId: "coord-1" };
      }),
    });
    await expect(
      launchTeam(plan(), adapter, { archiveOnLaunchFailure: false }),
    ).rejects.toMatchObject({
      step: "member",
      archived: false,
      agentIdsKept: ["coord-1"],
    });
    expect(vi.mocked(adapter.archiveAgent)).not.toHaveBeenCalled();
  });

  test("does not archive when kickoff fails", async () => {
    const adapter = mockAdapter({
      sendMessage: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    await expect(
      launchTeam(plan(), adapter, { archiveOnLaunchFailure: true }),
    ).rejects.toMatchObject({
      step: "kickoff",
      archived: false,
    });
    expect(vi.mocked(adapter.archiveAgent)).not.toHaveBeenCalled();
  });

  test("prepends recent runs and drops the oldest after 20", () => {
    const summary = toRunSummary(
      plan(),
      { runId: "run-1", coordinatorId: "c", memberIds: ["m"], kickoffMessage: "" },
      NOW,
    );
    const runs = prependRun(
      Array.from({ length: 20 }, (_, index) => ({ ...summary, runId: `old-${index}` })),
      summary,
    );
    expect(runs).toHaveLength(20);
    expect(runs[0]?.runId).toBe("run-1");
    expect(runs.at(-1)?.runId).toBe("old-18");
  });
});
