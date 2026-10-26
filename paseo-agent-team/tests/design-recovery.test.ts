import { describe, expect, test } from "vitest";
import {
  type DiscoveredDesignAgent,
  discoverDesignJobs,
  permissionSummary,
  reconcileDesignJob,
} from "../server/designer/recovery";
import {
  DESIGN_RECORD_VERSION,
  type DesignJobStore,
  type StoredDesignJob,
} from "../server/designer/store";
import type { DesignTimelineItem, DesignTimelinePort } from "../server/designer/timeline";
import { DESIGN_HASH, DESIGN_JOB_ID, designJob } from "./design-fixtures";

const REQUEST = "22222222-2222-4222-8222-222222222222";

function record(overrides: Partial<StoredDesignJob> = {}): StoredDesignJob {
  return {
    schemaVersion: DESIGN_RECORD_VERSION,
    job: designJob({ attempt: 1, agentCreated: true, state: "designing" }),
    request: "给后台做一次改版",
    requestHash: DESIGN_HASH,
    mode: "sota",
    selectionIntent: null,
    creation: null,
    attempts: [
      {
        attempt: 1,
        nonce: "b".repeat(32),
        messageId: "55555555-5555-4555-8555-555555555555",
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
    ...overrides,
  };
}

function labels(jobId = DESIGN_JOB_ID): Record<string, string> {
  return {
    "agent-team.design": jobId,
    "agent-team.design.version": "1",
    "agent-team.design.request-id": REQUEST,
    "agent-team.design.request-hash": DESIGN_HASH,
    "agent-team.design.mode": "sota",
    "agent-team.design.request": "摘要",
  };
}

function store(
  records: StoredDesignJob[],
  problems: Awaited<ReturnType<DesignJobStore["problems"]>> = [],
): Pick<DesignJobStore, "list" | "get" | "problems"> {
  return {
    list: async () => records,
    get: async (jobId) => records.find((item) => item.job.jobId === jobId) ?? null,
    problems: async () => problems,
  };
}

function validAgent(overrides: Partial<DiscoveredDesignAgent> = {}): DiscoveredDesignAgent {
  return {
    agentId: DESIGN_JOB_ID,
    labels: labels(),
    archived: false,
    status: "idle",
    pendingPermissions: [],
    attentionReason: null,
    ...overrides,
  };
}

function timelineWith(
  entries: DesignTimelineItem[] = [],
  status: "initializing" | "idle" | "running" | "closed" | "error" = "idle",
): DesignTimelinePort {
  return {
    refresh: async () => ({
      status,
      activeTurn: false,
      pendingPermissionCount: 0,
      lastError: null,
    }),
    refetch: async () => ({
      epoch: "epoch-1",
      entries,
      hasOlder: false,
      hasNewer: false,
      gap: false,
      reset: false,
      staleCursor: false,
      beforeCursor: null,
    }),
  };
}

function boundaryAndAnswer(): DesignTimelineItem[] {
  return [
    {
      seqStart: 1,
      seqEnd: 1,
      type: "user_message",
      messageId: "55555555-5555-4555-8555-555555555555",
    },
    { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "完整方案", turnId: "turn-1" },
  ];
}

describe("design recovery facts", () => {
  test("reconciles a missed completion without sending or writing", async () => {
    const calls = { list: 0, refresh: 0 };
    const discovery = {
      list: async () => {
        calls.list += 1;
        return {
          agents: [
            {
              agentId: DESIGN_JOB_ID,
              labels: labels(),
              archived: false,
              status: "idle" as const,
              pendingPermissions: [],
              attentionReason: null,
            },
          ],
          nextCursor: null,
        };
      },
      refresh: async () => {
        calls.refresh += 1;
        return {
          agentId: DESIGN_JOB_ID,
          labels: labels(),
          archived: false,
          status: "idle" as const,
          pendingPermissions: [],
          attentionReason: null,
        };
      },
    };
    const timeline: DesignTimelinePort = {
      refresh: async () => ({
        status: "idle",
        activeTurn: false,
        pendingPermissionCount: 0,
        lastError: null,
      }),
      refetch: async () => ({
        epoch: "epoch-1",
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            type: "user_message",
            messageId: "55555555-5555-4555-8555-555555555555",
          },
          { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "完整方案", turnId: "turn-1" },
        ],
        hasOlder: false,
        hasNewer: false,
        gap: false,
        reset: false,
        staleCursor: false,
        beforeCursor: null,
      }),
    };
    const fact = await reconcileDesignJob(
      { discovery, timeline },
      store([record()]),
      DESIGN_JOB_ID,
    );
    expect(fact.observation).toBe("ready-candidate");
    expect(fact.attempt).toMatchObject({ status: "complete", text: "完整方案" });
    expect(calls).toEqual({ list: 0, refresh: 1 });
  });

  test("observes outcome-unknown when the send receipt is unknown", async () => {
    const current = record({ outcomeUnknown: true });
    current.attempts[0] = { ...current.attempts[0], ack: "unknown" };
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => ({
        agentId: DESIGN_JOB_ID,
        labels: labels(),
        archived: false,
        status: "idle" as const,
        pendingPermissions: [],
        attentionReason: null,
      }),
    };
    const timeline: DesignTimelinePort = {
      refresh: async () => ({
        status: "idle",
        activeTurn: false,
        pendingPermissionCount: 0,
        lastError: null,
      }),
      refetch: async () => ({
        epoch: "epoch-1",
        entries: [],
        hasOlder: false,
        hasNewer: false,
        gap: false,
        reset: false,
        staleCursor: false,
        beforeCursor: null,
      }),
    };
    expect(
      (await reconcileDesignJob({ discovery, timeline }, store([current]), DESIGN_JOB_ID))
        .observation,
    ).toBe("outcome-unknown");
  });

  test("keeps a ledger job when the provider list is empty and reports orphans without claiming them", async () => {
    const records = Array.from({ length: 3 }, (_, index) =>
      record({
        job: designJob({
          jobId: `11111111-1111-4111-8111-11111111111${index}`,
          state: index === 2 ? "saved" : "ready",
        }),
      }),
    );
    const orphanId = "88888888-8888-4888-8888-888888888888";
    const discovery = {
      list: async ({ cursor }: { cursor: string | null }) =>
        cursor
          ? { agents: [], nextCursor: null }
          : {
              agents: [
                {
                  agentId: orphanId,
                  labels: labels(orphanId),
                  archived: false,
                  status: "idle" as const,
                  pendingPermissions: [],
                  attentionReason: null,
                },
                {
                  agentId: "bad",
                  labels: { "agent-team.design": "not-a-uuid" },
                  archived: false,
                  status: "error" as const,
                  pendingPermissions: [],
                  attentionReason: "error" as const,
                },
              ],
              nextCursor: "next",
            },
      refresh: async () => null,
    };
    const found = await discoverDesignJobs(discovery, store(records));
    expect(found.orphans).toEqual([{ jobId: orphanId, clientRequestId: REQUEST, mode: "sota" }]);
    expect(found.issues.map((item) => item.code)).toContain("DESIGN_RECOVERY_INCOMPLETE");
    expect(found.activeCount).toBe(2);
    expect(found.visibleCount).toBe(3);
  });

  test("stops discovery at twenty pages and hides raw permission payloads", async () => {
    let page = 0;
    const discovery = {
      list: async () => {
        page += 1;
        return { agents: [], nextCursor: page < 21 ? `cursor-${page}` : null };
      },
      refresh: async () => null,
    };
    const found = await discoverDesignJobs(discovery, store([]));
    expect(found.complete).toBe(false);
    expect(page).toBe(20);
    const summary = permissionSummary({
      agentId: DESIGN_JOB_ID,
      labels: labels(),
      archived: false,
      status: "idle",
      pendingPermissions: [{ id: "perm-1", kind: "tool", raw: { token: "secret" } }],
      attentionReason: "finished",
    });
    expect(summary.attentionReason).toBe("permission");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  test("distinguishes terminal, receipt-pending, and unclaimed observations and rejects copied labels", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => ({
        agentId: DESIGN_JOB_ID,
        labels: labels(),
        archived: false,
        status: "idle" as const,
        pendingPermissions: [],
        attentionReason: null,
      }),
    };
    const timeline: DesignTimelinePort = {
      refresh: async () => ({
        status: "idle",
        activeTurn: false,
        pendingPermissionCount: 0,
        lastError: null,
      }),
      refetch: async () => ({
        epoch: "epoch-1",
        entries: [],
        hasOlder: false,
        hasNewer: false,
        gap: false,
        reset: false,
        staleCursor: false,
        beforeCursor: null,
      }),
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery, timeline },
          store([record({ job: designJob({ attempt: 1, state: "saved" }) })]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("terminal");
    const pending = record();
    pending.attempts[0] = { ...pending.attempts[0], ack: "pending" };
    expect(
      (await reconcileDesignJob({ discovery, timeline }, store([pending]), DESIGN_JOB_ID))
        .observation,
    ).toBe("receipt-pending");
    const unlabeled = {
      ...discovery,
      refresh: async () => ({
        agentId: DESIGN_JOB_ID,
        labels: {},
        archived: false,
        status: "idle" as const,
        pendingPermissions: [],
        attentionReason: null,
      }),
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery: unlabeled, timeline },
          store([record()]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("unclaimed");
    const found = await discoverDesignJobs(
      {
        list: async () => ({
          agents: [
            {
              agentId: "other",
              labels: labels(),
              archived: false,
              status: "idle",
              pendingPermissions: [],
              attentionReason: null,
            },
            {
              agentId: "bad",
              labels: {
                "agent-team.design": "not-a-uuid",
                "agent-team.design.version": "1",
                "agent-team.design.request-id": REQUEST,
                "agent-team.design.mode": "sota",
              },
              archived: false,
              status: "idle",
              pendingPermissions: [],
              attentionReason: null,
            },
          ],
          nextCursor: null,
        }),
        refresh: async () => null,
      },
      store([record()]),
    );
    expect(found.owned).toEqual([]);
    expect(found.orphans).toEqual([]);
    expect(found.issues.map((item) => item.summary)).toContain("agent mismatch");
  });
  test("matrix: unclaimed on non-empty but mismatched labels", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () =>
        validAgent({ labels: { ...labels(), "agent-team.design.version": "2" } }),
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery, timeline: timelineWith() },
          store([record()]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("unclaimed");
    const wrongHash = {
      ...discovery,
      refresh: async () =>
        validAgent({ labels: { ...labels(), "agent-team.design.request-hash": "d".repeat(64) } }),
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery: wrongHash, timeline: timelineWith() },
          store([record()]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("unclaimed");
  });

  test("matrix: unknown when the attempt number is outside 1..3", async () => {
    const current = record({ job: designJob({ attempt: 0, agentCreated: true }) });
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => validAgent(),
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery, timeline: timelineWith() },
          store([current]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("unknown");
  });

  test("matrix: unchanged is the defensive complete-without-ack fallback", async () => {
    const current = record();
    current.attempts[0] = {
      ...current.attempts[0],
      ack: undefined as unknown as "acked",
    };
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => validAgent(),
    };
    const fact = await reconcileDesignJob(
      { discovery, timeline: timelineWith(boundaryAndAnswer()) },
      store([current]),
      DESIGN_JOB_ID,
    );
    expect(fact.observation).toBe("unchanged");
  });

  test("discovery reports store problems as recovery issues", async () => {
    const found = await discoverDesignJobs(
      {
        list: async () => ({ agents: [], nextCursor: null }),
        refresh: async () => null,
      },
      store([], [{ name: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json", reason: "unknown-version" }]),
    );
    expect(found.issues).toContainEqual({
      code: "DESIGN_RECOVERY_INCOMPLETE",
      summary: "store problem: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json (unknown-version)",
    });
  });

  test("matrix: missing ledger record never calls the provider", async () => {
    let calls = 0;
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => {
        calls += 1;
        return validAgent();
      },
    };
    const timeline = timelineWith();
    const fact = await reconcileDesignJob({ discovery, timeline }, store([]), DESIGN_JOB_ID);
    expect(fact.observation).toBe("missing");
    expect(calls).toBe(0);
  });

  test("matrix: terminal job short-circuits without provider calls", async () => {
    let calls = 0;
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => {
        calls += 1;
        return validAgent();
      },
    };
    const saved = record({ job: designJob({ attempt: 1, state: "saved" }) });
    expect(
      (
        await reconcileDesignJob(
          { discovery, timeline: timelineWith() },
          store([saved]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("terminal");
    expect(calls).toBe(0);
  });

  test("matrix: cancel-requested short-circuits without provider calls", async () => {
    let calls = 0;
    const current = record();
    current.job = { ...current.job, cancelRequested: true };
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => {
        calls += 1;
        return validAgent();
      },
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery, timeline: timelineWith() },
          store([current]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("cancel-requested");
    expect(calls).toBe(0);
  });

  test("matrix: unknown when the provider cannot see the known agent", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => null,
    };
    expect(
      (
        await reconcileDesignJob(
          { discovery, timeline: timelineWith() },
          store([record()]),
          DESIGN_JOB_ID,
        )
      ).observation,
    ).toBe("unknown");
  });

  test("matrix: waiting while the agent turn is still running", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => validAgent(),
    };
    let refetches = 0;
    const timeline: DesignTimelinePort = {
      refresh: async () => ({
        status: "idle",
        activeTurn: true,
        pendingPermissionCount: 1,
        lastError: null,
      }),
      refetch: async () => {
        refetches += 1;
        return {
          epoch: "epoch-1",
          entries: [],
          hasOlder: false,
          hasNewer: false,
          gap: false,
          reset: false,
          staleCursor: false,
          beforeCursor: null,
        };
      },
    };
    expect(
      (await reconcileDesignJob({ discovery, timeline }, store([record()]), DESIGN_JOB_ID))
        .observation,
    ).toBe("waiting");
    expect(refetches).toBe(0);
  });

  test("matrix: external-input when another user message enters the attempt", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => validAgent(),
    };
    const timeline = timelineWith([
      ...boundaryAndAnswer(),
      { seqStart: 3, seqEnd: 3, type: "user_message", text: "别人贴的方案" },
    ]);
    expect(
      (await reconcileDesignJob({ discovery, timeline }, store([record()]), DESIGN_JOB_ID))
        .observation,
    ).toBe("external-input");
  });

  test("matrix: attempt-error when the attempt contains an error entry", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => validAgent(),
    };
    const timeline = timelineWith([
      ...boundaryAndAnswer(),
      { seqStart: 3, seqEnd: 3, type: "notification", level: "error", text: "boom" },
    ]);
    expect(
      (await reconcileDesignJob({ discovery, timeline }, store([record()]), DESIGN_JOB_ID))
        .observation,
    ).toBe("attempt-error");
  });

  test("matrix: needs-continue when the attempt boundary is incomplete", async () => {
    const discovery = {
      list: async () => ({ agents: [], nextCursor: null }),
      refresh: async () => validAgent(),
    };
    const timeline = timelineWith([
      { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "无边界", turnId: "turn-1" },
    ]);
    expect(
      (await reconcileDesignJob({ discovery, timeline }, store([record()]), DESIGN_JOB_ID))
        .observation,
    ).toBe("needs-continue");
  });
});
