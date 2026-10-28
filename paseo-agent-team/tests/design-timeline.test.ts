import { describe, expect, test } from "vitest";
import {
  DESIGN_RECORD_VERSION,
  LEGACY_RECORD_RULES,
  type StoredDesignJob,
} from "../server/designer/store";
import {
  type DesignTimelineItem,
  type DesignTimelinePage,
  type DesignTimelinePort,
  readAttemptText,
} from "../server/designer/timeline";
import { DESIGN_HASH, designJob } from "./design-fixtures";

const MESSAGE = "55555555-5555-4555-8555-555555555555";

function stored(): StoredDesignJob {
  return {
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
        messageId: MESSAGE,
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
}

function item(seq: number, overrides: Partial<DesignTimelineItem>): DesignTimelineItem {
  return { seqStart: seq, seqEnd: seq, type: "assistant_message", text: "", ...overrides };
}

function port(pages: DesignTimelinePage[], status = "idle"): DesignTimelinePort {
  let index = 0;
  return {
    refresh: async () => ({
      status: status as "idle",
      activeTurn: false,
      pendingPermissionCount: 0,
      lastError: null,
    }),
    refetch: async () => pages[index++] ?? pages[pages.length - 1] ?? emptyPage(),
  };
}

function emptyPage(): DesignTimelinePage {
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
}

function page(
  entries: DesignTimelineItem[],
  overrides: Partial<DesignTimelinePage> = {},
): DesignTimelinePage {
  return { ...emptyPage(), entries, ...overrides };
}

describe("design attempt timeline", () => {
  test("joins paged assistant text once and ignores tool, reasoning, and plugin entries", async () => {
    const older = page(
      [
        item(1, { type: "user_message", messageId: MESSAGE, text: "kickoff" }),
        item(2, { type: "tool_call", text: "tool" }),
      ],
      { hasOlder: false, beforeCursor: null },
    );
    const newer = page(
      [
        item(2, { type: "tool_call", text: "tool" }),
        item(3, { type: "assistant_message", text: "第一段", turnId: "turn-1" }),
        item(4, { type: "reasoning", text: "思考" }),
        item(5, { type: "assistant_message", text: "第二段", turnId: "turn-1" }),
        item(6, { type: "plugin", text: "plugin" }),
      ],
      { hasOlder: true, beforeCursor: "older" },
    );
    const result = await readAttemptText(port([newer, older]), stored(), 1, {
      outcome: "completed",
    });
    expect(result).toMatchObject({ status: "complete", text: "第一段第二段", turnId: "turn-1" });
  });

  test("rejects an old turn, an empty turn while running, and external user text", async () => {
    const boundary = item(1, { type: "user_message", clientMessageId: MESSAGE });
    const old = await readAttemptText(
      port([page([boundary, item(2, { text: "答案", turnId: "old" })])]),
      stored(),
      1,
    );
    expect(old).toMatchObject({ status: "incomplete" });
    const running = port(
      [page([boundary, item(2, { text: "答案", turnId: "turn-1" })])],
      "running",
    );
    expect(await readAttemptText(running, stored(), 1)).toMatchObject({ status: "running" });
    const external = port([
      page([
        boundary,
        item(2, { text: "答案", turnId: "turn-1" }),
        item(3, { type: "user_message", text: "别人贴的方案" }),
      ]),
    ]);
    expect(await readAttemptText(external, stored(), 1)).toMatchObject({
      status: "external-input",
      issue: "DESIGN_EXTERNAL_INPUT",
    });
  });

  test("retries one gap and still fails when the rebuilt range is incomplete", async () => {
    const broken = page([], { gap: true, staleCursor: true });
    expect(await readAttemptText(port([broken, broken]), stored(), 1)).toMatchObject({
      status: "incomplete",
      issue: "DESIGN_TIMELINE_INCOMPLETE",
    });
  });

  test("does not accept partial JSON from a failed or canceled hook", async () => {
    const entries = page([
      item(1, { type: "user_message", messageId: MESSAGE }),
      item(2, { text: '{"partial":true}', turnId: "turn-1" }),
    ]);
    expect(
      await readAttemptText(port([entries]), stored(), 1, { outcome: "failed" }),
    ).toMatchObject({ status: "error" });
    expect(
      await readAttemptText(port([entries]), stored(), 1, { outcome: "canceled" }),
    ).toMatchObject({ status: "error" });
  });

  test("replaces contained ranges and rejects partial overlaps", async () => {
    const boundary = item(1, { type: "user_message", messageId: MESSAGE });
    const contained = await readAttemptText(
      port([page([boundary, item(2, { seqEnd: 4, text: "ABC", turnId: "turn-1" })])]),
      stored(),
      1,
    );
    expect(contained).toMatchObject({ status: "complete", text: "ABC" });
    const overlap = port([
      page([
        boundary,
        item(2, { seqEnd: 3, text: "AB", turnId: "turn-1" }),
        item(3, { seqStart: 3, seqEnd: 5, text: "BCD", turnId: "turn-1" }),
      ]),
    ]);
    expect(await readAttemptText(overlap, stored(), 1)).toMatchObject({ status: "incomplete" });
  });

  test("rebuilds once after an epoch change when the boundary remains", async () => {
    const calls = { count: 0 };
    const reader: DesignTimelinePort = {
      refresh: async () => ({
        status: "idle",
        activeTurn: false,
        pendingPermissionCount: 0,
        lastError: null,
      }),
      refetch: async () => {
        calls.count += 1;
        return calls.count === 1
          ? page([], { epoch: "changed" })
          : page(
              [
                item(1, { type: "user_message", messageId: MESSAGE }),
                item(2, { text: "恢复", turnId: "turn-1" }),
              ],
              { epoch: "changed" },
            );
      },
    };
    expect(await readAttemptText(reader, stored(), 1)).toMatchObject({
      status: "complete",
      text: "恢复",
    });
    expect(calls.count).toBe(2);
  });
  test("treats a missing lastError baseline as null", async () => {
    const current = stored();
    current.attempts[0] = { ...current.attempts[0], lastError: undefined };
    const reader: DesignTimelinePort = {
      refresh: async () => ({
        status: "idle",
        activeTurn: false,
        pendingPermissionCount: 0,
        lastError: "boom",
      }),
      refetch: async () =>
        page([
          item(1, { type: "user_message", messageId: MESSAGE }),
          item(2, { text: "答案", turnId: "turn-1" }),
        ]),
    };
    expect(await readAttemptText(reader, current, 1)).toMatchObject({
      status: "error",
      issue: "DESIGN_AGENT_FAILED",
    });
  });
});
