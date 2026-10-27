import { describe, expect, test, vi } from "vitest";
import type { DesignDiscoveryPort } from "../server/designer/recovery";
import {
  DESIGN_RECORD_VERSION,
  LEGACY_RECORD_RULES,
  type StoredDesignJob,
} from "../server/designer/store";
import { type DesignTimelinePort, readAttemptText } from "../server/designer/timeline";
import {
  BRIDGE_DISCOVERY_PAGE_LIMIT,
  BRIDGE_TIMELINE_PAGE_LIMIT,
  buildDesignLabels,
  toDiscoveryPort,
  toTimelinePort,
} from "../shared/paseo/design-bridge";
import type {
  DesignAdapter,
  DesignAgentSummary,
  DesignTimelinePage,
  DesignTimelineRequest,
} from "../shared/paseo/design-port";
import { DESIGN_HASH, designJob } from "./design-fixtures";

const AGENT: DesignAgentSummary = {
  id: "agent-1",
  labels: { "agent-team.design": "job-1", "agent-team.design.version": "1" },
  status: "idle",
  activeTurn: false,
  archivedAt: null,
  requiresAttention: false,
  attentionReason: null,
  pendingPermissions: [{ id: "permission-1", kind: "tool", title: "Approve", description: "Run" }],
  lastError: null,
  providerUnavailable: false,
};

function page(overrides: Partial<DesignTimelinePage> = {}): DesignTimelinePage {
  return {
    epoch: "epoch-1",
    direction: "tail",
    projection: "projected",
    entries: [],
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    reset: false,
    gap: false,
    staleCursor: false,
    ...overrides,
  };
}

function adapter(overrides: Partial<DesignAdapter> = {}): DesignAdapter {
  return {
    readConfig: async () => ({}),
    listProviderAvailability: async () => [],
    listRecentWorkspaces: async () => ({ workspaces: [], nextCursor: null, hasMore: false }),
    getDesignWorkspace: async () => null,
    createDesignAgent: async () => ({ agentId: "agent-1" }),
    getDesignAgent: async () => AGENT,
    listDesignAgents: async () => ({ agents: [], nextCursor: null, hasMore: false }),
    readDesignTimeline: async () => page(),
    sendDesignMessage: async () => {},
    archiveDesignAgent: async () => {},
    ...overrides,
  };
}

describe("design bridge", () => {
  test("the bridge outputs are assignable to G5's timeline and discovery ports", () => {
    const timeline: DesignTimelinePort = toTimelinePort(adapter());
    const discovery: DesignDiscoveryPort = toDiscoveryPort(adapter());
    expect(timeline).toBeDefined();
    expect(discovery).toBeDefined();
  });

  test("starts at tail, then before with an encoded cursor and limit 100", async () => {
    const read = vi.fn(async (input: DesignTimelineRequest) =>
      input.direction === "tail"
        ? page({
            entries: [
              {
                seqStart: 1,
                seqEnd: 1,
                type: "user_message",
                text: "question",
                messageId: "message-1",
              },
              {
                seqStart: 2,
                seqEnd: 2,
                type: "assistant_message",
                text: "answer",
              },
              { seqStart: 3, seqEnd: 3, type: "other" },
              {
                seqStart: 4,
                seqEnd: 4,
                type: "notification",
                level: "warning",
                text: "warn",
              },
              { seqStart: 5, seqEnd: 5, type: "error", text: "bad", level: "error" },
            ],
            startCursor: { epoch: "epoch-1", seq: 1 },
            endCursor: { epoch: "epoch-1", seq: 5 },
            hasOlder: true,
          })
        : page({ direction: "before", epoch: "epoch-1" }),
    );
    const port = toTimelinePort(adapter({ readDesignTimeline: read }));

    const first = await port.refetch({ agentId: "agent-1", cursor: null, direction: "before" });
    expect(read).toHaveBeenNthCalledWith(1, {
      agentId: "agent-1",
      direction: "tail",
      limit: BRIDGE_TIMELINE_PAGE_LIMIT,
    });
    expect(first.entries.map((entry) => entry.type)).toEqual([
      "user_message",
      "assistant_message",
      "plugin",
      "notification",
      "error",
    ]);
    expect(first.entries[2]).not.toHaveProperty("text");
    expect(first.entries[3]?.level).toBe("info");
    expect(first.entries[4]?.level).toBe("error");
    expect(first.beforeCursor).toBe(JSON.stringify({ epoch: "epoch-1", seq: 1 }));

    await port.refetch({
      agentId: "agent-1",
      cursor: first.beforeCursor,
      direction: "before",
    });
    expect(read).toHaveBeenNthCalledWith(2, {
      agentId: "agent-1",
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: BRIDGE_TIMELINE_PAGE_LIMIT,
    });
  });

  test("rejects malformed cursors and flags missing older cursors as gaps", async () => {
    const read = vi.fn(async () => page());
    const port = toTimelinePort(adapter({ readDesignTimeline: read }));
    const invalid = await port.refetch({
      agentId: "agent-1",
      cursor: "not-json",
      direction: "before",
    });
    expect(read).not.toHaveBeenCalled();
    expect(invalid).toMatchObject({ gap: true, staleCursor: true, beforeCursor: null });

    const unsafe = await port.refetch({
      agentId: "agent-1",
      cursor: JSON.stringify({ epoch: "e", seq: Number.MAX_SAFE_INTEGER + 10 }),
      direction: "before",
    });
    expect(unsafe).toMatchObject({ gap: true, staleCursor: true });
    expect(read).not.toHaveBeenCalled();

    const gap = toTimelinePort(
      adapter({
        readDesignTimeline: async () =>
          page({ hasOlder: true, startCursor: null, endCursor: { epoch: "e", seq: 2 } }),
      }),
    );
    const missing = await gap.refetch({
      agentId: "agent-1",
      cursor: null,
      direction: "before",
    });
    expect(missing.gap).toBe(true);
    expect(missing.beforeCursor).toBeNull();
  });

  test("refresh maps agent facts and missing agents to a null status", async () => {
    const present = toTimelinePort(adapter());
    expect(await present.refresh("agent-1")).toEqual({
      status: "idle",
      activeTurn: false,
      pendingPermissionCount: 1,
      lastError: null,
    });
    const missing = toTimelinePort(adapter({ getDesignAgent: async () => null }));
    expect(await missing.refresh("gone")).toEqual({
      status: null,
      activeTurn: false,
      pendingPermissionCount: 0,
      lastError: null,
    });
  });

  test("discovery maps agent summaries and uses the exact page limit", async () => {
    const list = vi.fn(async () => ({
      agents: [{ ...AGENT, archivedAt: "2026-10-26T00:00:00.000Z" }],
      nextCursor: "next",
      hasMore: true,
    }));
    const port = toDiscoveryPort(adapter({ listDesignAgents: list }));
    const result = await port.list({ cursor: "cursor-1" });
    expect(list).toHaveBeenCalledWith({
      limit: BRIDGE_DISCOVERY_PAGE_LIMIT,
      cursor: "cursor-1",
    });
    expect(result.nextCursor).toBe("next");
    expect(result.agents[0]).toEqual({
      agentId: "agent-1",
      labels: AGENT.labels,
      archived: true,
      status: "idle",
      pendingPermissions: [{ id: "permission-1", kind: "tool" }],
      attentionReason: null,
    });
    expect(JSON.stringify(result)).not.toContain("Approve");
  });

  test("discovery does not claim completeness when hasMore has no cursor", async () => {
    const port = toDiscoveryPort(
      adapter({
        listDesignAgents: async () => ({ agents: [], nextCursor: null, hasMore: true }),
      }),
    );
    await expect(port.list({ cursor: null })).rejects.toThrow("incomplete");

    const complete = toDiscoveryPort(
      adapter({
        listDesignAgents: async () => ({ agents: [], nextCursor: "stale", hasMore: false }),
      }),
    );
    expect(await complete.list({ cursor: null })).toEqual({ agents: [], nextCursor: null });

    const refresh = toDiscoveryPort(adapter({ getDesignAgent: async () => null }));
    expect(await refresh.refresh("gone")).toBeNull();
  });

  test("emits only machine labels and never the request text", () => {
    const labels = buildDesignLabels({
      jobId: "11111111-1111-4111-8111-111111111111",
      clientRequestId: "22222222-2222-4222-8222-222222222222",
      requestHash: "a".repeat(64),
      mode: "economy",
      request: "需求里有 TOKEN=SECRET 和 password=hunter2",
    });
    expect(Object.keys(labels).sort()).toEqual([
      "agent-team.design",
      "agent-team.design.mode",
      "agent-team.design.request-hash",
      "agent-team.design.request-id",
      "agent-team.design.version",
    ]);
    expect(labels["agent-team.design.version"]).toBe("1");
    expect(labels["agent-team.design.request-id"]).toBe("22222222-2222-4222-8222-222222222222");
    expect(labels["agent-team.design.request-hash"]).toBe("a".repeat(64));
    expect(labels["agent-team.design.mode"]).toBe("economy");
    expect(JSON.stringify(labels)).not.toContain("TOKEN");
    expect(JSON.stringify(labels)).not.toContain("hunter2");
    expect(JSON.stringify(labels)).not.toContain("profile");
  });

  test("G5 readAttemptText consumes the bridged two-page timeline", async () => {
    const messageId = "55555555-5555-4555-8555-555555555555";
    const stored: StoredDesignJob = {
      schemaVersion: DESIGN_RECORD_VERSION,
      ...LEGACY_RECORD_RULES,
      job: designJob({ attempt: 1, agentCreated: true }),
      request: "给后台做一次改版",
      requestHash: DESIGN_HASH,
      mode: "sota",
      selectionIntent: null,
      creation: null,
      attempts: [
        {
          attempt: 1,
          nonce: "b".repeat(32),
          messageId,
          promptHash: DESIGN_HASH,
          epoch: "epoch-1",
          endCursor: null,
          summary: null,
          ack: "acked",
          turnId: "turn-1",
        },
      ],
      proposal: null,
      result: null,
      reuseFingerprints: {},
      leaseOwner: null,
      receipts: {},
      outcomeUnknown: false,
    };
    const read = vi.fn(async (input: DesignTimelineRequest) =>
      input.direction === "tail"
        ? page({
            entries: [
              {
                seqStart: 1,
                seqEnd: 1,
                type: "user_message",
                text: "kickoff",
                messageId,
              },
              {
                seqStart: 2,
                seqEnd: 2,
                type: "assistant_message",
                text: "A",
                turnId: "turn-1",
              },
              {
                seqStart: 3,
                seqEnd: 3,
                type: "other",
                text: "ignored",
              },
              {
                seqStart: 4,
                seqEnd: 4,
                type: "assistant_message",
                text: "B",
                turnId: "turn-1",
              },
            ],
            startCursor: { epoch: "epoch-1", seq: 1 },
            endCursor: { epoch: "epoch-1", seq: 4 },
            hasOlder: true,
          })
        : page({
            direction: "before",
            entries: [
              {
                seqStart: 1,
                seqEnd: 1,
                type: "user_message",
                text: "kickoff",
                messageId,
              },
            ],
            hasOlder: false,
          }),
    );
    const port = toTimelinePort(
      adapter({
        readDesignTimeline: read,
        getDesignAgent: async () => ({ ...AGENT, pendingPermissions: [] }),
      }),
    );
    const result = await readAttemptText(port, stored, 1, { outcome: "completed" });
    expect(result).toMatchObject({ status: "complete", text: "AB", turnId: "turn-1" });
  });
});
