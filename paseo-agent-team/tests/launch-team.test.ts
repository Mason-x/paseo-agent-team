import { describe, expect, test, vi } from "vitest";
import { buildLaunchPlan } from "../shared/domain/launch-plan";
import { isLaunchError, launchTeam } from "../shared/domain/launch-team";
import type { PaseoAdapter } from "../shared/paseo/adapter";
import { LABELS } from "../shared/paseo/labels";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
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
    readConfig: vi.fn(async () => ({})),
    listProfiles: vi.fn(async () => []),
    listProviderAvailability: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    getWorkspace: vi.fn(async () => null),
    listProjects: vi.fn(async () => []),
    createWorkspace: vi.fn(async () => ({ id: "ws-new", name: "New workspace" })),
    createAgent: vi.fn(async (input: { parentAgentId?: string; title: string }) => ({
      agentId: input.parentAgentId ? `member-${input.title}` : "coord-1",
    })),
    sendMessage: vi.fn(async () => undefined),
    archiveAgent: vi.fn(async () => undefined),
    ...overrides,
  };
}

const failingMembers = () =>
  vi.fn(async (input: { parentAgentId?: string }) => {
    if (input.parentAgentId) throw new Error("member boom");
    return { agentId: "coord-1" };
  });

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
    expect(result.memberIds).toHaveLength(2);
    expect(progress[0]).toBe("coordinator");
    expect(progress.at(-1)).toBe("kickoff");
  });

  test("creates every agent in the target workspace with its labels and system prompt", async () => {
    const adapter = mockAdapter();
    await launchTeam(plan(), adapter, { archiveOnLaunchFailure: true });
    const calls = vi.mocked(adapter.createAgent).mock.calls.map((call) => call[0]);
    expect(calls.every((call) => call.workspaceId === "ws-1")).toBe(true);
    expect(calls[0]?.labels[LABELS.kind]).toBe("coordinator");
    expect(calls[0]?.labels[LABELS.task]).toBe("Add Stripe");
    expect(calls[1]?.labels[LABELS.kind]).toBe("member");
    expect(calls[1]?.labels[LABELS.task]).toBeUndefined();
    expect(calls[0]?.systemPrompt).toContain("send_agent_prompt");
    expect(calls[2]?.profile.id).toBe(codexXhigh.id);
  });

  test("fails at the coordinator step without archiving anything", async () => {
    const adapter = mockAdapter({
      createAgent: vi.fn(async () => {
        throw new Error("no coordinator");
      }),
    });
    const error = await launchTeam(plan(), adapter, { archiveOnLaunchFailure: true }).catch(
      (cause: unknown) => cause,
    );
    expect(isLaunchError(error)).toBe(true);
    expect(error).toMatchObject({ step: "coordinator", archived: false, agentIdsKept: [] });
    expect(adapter.archiveAgent).not.toHaveBeenCalled();
  });

  test("archives created agents when a member fails and the preference is on", async () => {
    const adapter = mockAdapter({ createAgent: failingMembers() });
    await expect(
      launchTeam(plan(), adapter, { archiveOnLaunchFailure: true }),
    ).rejects.toMatchObject({
      step: "member",
      archived: true,
      agentIdsKept: [],
    });
    expect(vi.mocked(adapter.archiveAgent)).toHaveBeenCalledWith("coord-1");
  });

  test("keeps archiving the rest when one archive call fails", async () => {
    const created: string[] = [];
    const adapter = mockAdapter({
      createAgent: vi.fn(async (input: { parentAgentId?: string; title: string }) => {
        if (input.title.startsWith("Developer")) throw new Error("member boom");
        const agentId = input.parentAgentId ? "member-1" : "coord-1";
        created.push(agentId);
        return { agentId };
      }),
      archiveAgent: vi.fn(async (id: string) => {
        if (id === "member-1") throw new Error("archive failed");
      }),
    });
    await expect(
      launchTeam(plan(), adapter, { archiveOnLaunchFailure: true }),
    ).rejects.toMatchObject({ archived: true });
    expect(vi.mocked(adapter.archiveAgent).mock.calls.map((call) => call[0])).toEqual(created);
  });

  test("keeps created agents when archiveOnLaunchFailure is false", async () => {
    const adapter = mockAdapter({ createAgent: failingMembers() });
    await expect(
      launchTeam(plan(), adapter, { archiveOnLaunchFailure: false }),
    ).rejects.toMatchObject({
      step: "member",
      archived: false,
      agentIdsKept: ["coord-1"],
    });
    expect(vi.mocked(adapter.archiveAgent)).not.toHaveBeenCalled();
  });

  test("does not archive when kickoff fails, and hands back the kickoff text", async () => {
    const adapter = mockAdapter({
      sendMessage: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    const error = await launchTeam(plan(), adapter, { archiveOnLaunchFailure: true }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({
      step: "kickoff",
      archived: false,
      agentIdsKept: ["coord-1", expect.any(String), expect.any(String)],
    });
    expect((error as { kickoffMessage?: string }).kickoffMessage).toContain("# Task");
    expect(vi.mocked(adapter.archiveAgent)).not.toHaveBeenCalled();
  });
});
