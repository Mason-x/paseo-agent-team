import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../client/hub-icon", () => ({ OmpIcon: () => null }));
vi.mock("../client/hub-popover", () => ({ HubPopover: () => null }));
vi.mock("../client/mcp-authorization", () => ({ OmpMcpAuthorizationCard: () => null }));
vi.mock("../client/mcp-popover", () => ({ McpPopover: () => null }));
vi.mock("../client/memory-panel", () => ({ OmpMemoryPanel: () => null }));
vi.mock("../client/memory-popover", () => ({ MemoryPopover: () => null }));
vi.mock("../client/omp-config-surface", () => ({
  OmpConfigSurface: () => null,
  OmpWorkspacePanel: () => null,
}));
vi.mock("../client/provider-icon", () => ({ quotaProviderIcon: () => () => null }));
vi.mock("../client/provider-image", () => ({ OmpImageTimeline: () => null }));
vi.mock("../client/quota-popover", () => ({ QuotaPopover: () => null }));
vi.mock("../client/sessions-popover", () => ({ SessionsPopover: () => null }));

import contribute from "../index.client";
import { listOmpQuotas } from "../shared/quota";

afterEach(() => {
  vi.useRealTimers();
});

test("profile aliases receive MCP controls and only their own cached quota results", async () => {
  vi.useFakeTimers();
  const agents = [
    { id: "alpha", provider: "omp-plugin-team-alpha", model: "omp:model:opaque-a" },
    { id: "team-beta", provider: "omp-plugin-team-beta", model: "omp:model:opaque-b" },
    { id: "default", provider: "omp", model: "anthropic/claude-fable-5" },
    { id: "codex", provider: "codex", model: "gpt-5.6-sol" },
  ];
  let onAgentsChanged = () => {};
  const buttons: Array<{
    id: string;
    agentId: string;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  }> = [];
  const rpc = vi.fn(async (definition, input) => {
    if (definition.name === "settings.composer-pills.read") {
      return {
        status: "ready",
        revision: "revision-1",
        values: { mcp: true, hub: true, memory: true, sessions: true, quota: true },
      };
    }
    if (definition !== listOmpQuotas) return { processes: [] };
    const profile = input.store?.profile;
    const fraction = profile === "team-alpha" ? 0.9 : profile === "team-beta" ? 0.2 : 0.5;
    return {
      quotas: [
        {
          provider: "anthropic",
          label: "Five hour",
          windowLabel: "5h",
          usedFraction: fraction,
          status: "ok",
          resetsAt: null,
          recordedAt: 1,
        },
      ],
    };
  });
  const registration = () => () => {};
  const client = {
    paseo: {
      agents: {
        list: async () => ({
          entries: agents.map((agent) => ({
            agent: { ...agent, cwd: "/same-workspace", workspaceId: "workspace", archivedAt: null },
          })),
          pageInfo: { hasMore: false },
        }),
        subscribe: (callback: () => void) => {
          onAgentsChanged = callback;
          return () => {};
        },
      },
    },
    rpc,
    addWorkspacePanel: registration,
    addCommandCenterItem: registration,
    addSurface: registration,
    addSidebarItem: registration,
    addTimelineRenderer: registration,
    addTimelineTransformer: registration,
    addComposerPill: (options: { id: string; agentId: string }) => {
      const button = { ...options, update: vi.fn(), remove: vi.fn() };
      buttons.push(button);
      return button;
    },
  } as unknown as PluginClientContext;
  const dispose = contribute(client);
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(buttons.filter((button) => button.id === "mcp").map((button) => button.agentId)).toEqual(
      ["alpha", "team-beta"],
    );
    const quota = (agentId: string) => {
      const button = buttons.findLast(
        (button) => button.id === "quota" && button.agentId === agentId,
      );
      if (!button) throw new Error(`Missing quota pill for ${agentId}`);
      return button;
    };
    expect(quota("alpha").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Quotas · 90%" }),
    );
    expect(quota("team-beta").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Quotas · 20%" }),
    );
    expect(quota("default").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ visible: true, label: "Anthropic · 50%" }),
    );
    expect(quota("codex").update).not.toHaveBeenCalled();
    expect(
      rpc.mock.calls
        .filter(([definition]) => definition === listOmpQuotas)
        .map(([, input]) => input.store?.profile),
    ).toEqual(["team-alpha", "team-beta", undefined]);

    agents[0].provider = "omp-plugin-team-beta";
    onAgentsChanged();
    await vi.advanceTimersByTimeAsync(250);
    expect(quota("alpha").update).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "Quotas · 20%" }),
    );
    expect(rpc.mock.calls.filter(([definition]) => definition === listOmpQuotas)).toHaveLength(3);
  } finally {
    dispose();
  }
});
