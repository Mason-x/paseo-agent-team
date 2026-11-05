import { describe, expect, test } from "vitest";
import {
  createObserverHost,
  type ObservedHostPort,
  type TimelineRefetchPage,
} from "../../server/run-engine/host";

const DISPATCH = "22222222-2222-4222-8222-222222222222";

const page = (
  entries: TimelineRefetchPage["entries"],
  over: Partial<TimelineRefetchPage> = {},
): TimelineRefetchPage => ({
  entries,
  epoch: "e1",
  hasOlder: false,
  hasNewer: false,
  gap: false,
  staleCursor: false,
  reset: false,
  startCursor: null,
  ...over,
});
const entry = (seq: number, type: string, turnId: string, extra: Record<string, unknown> = {}) => ({
  item: { type, ...extra },
  turnId,
  seqStart: seq,
  seqEnd: seq,
});

function port(tail: TimelineRefetchPage, older: TimelineRefetchPage[] = []) {
  const calls: string[] = [];
  const queue = [...older];
  const value: ObservedHostPort = {
    agents: {
      ref: (agentId) => ({
        timeline: {
          async refetch(options) {
            calls.push(
              `${agentId}:${options.direction}:${options.cursor?.seq ?? "-"}:${options.projection}`,
            );
            if (options.direction === "tail") return tail;
            const next = queue.shift();
            if (!next) throw new Error("no more pages");
            return next;
          },
        },
      }),
    },
  };
  return { value, calls };
}

describe("observer host", () => {
  test("reads only the tail when the dispatch is already on it, and only ever refetches", async () => {
    const fake = port(
      page([
        entry(3, "user_message", "t-7", { messageId: DISPATCH }),
        entry(4, "assistant_message", "t-7", { text: "done" }),
      ]),
    );
    const window = await createObserverHost(fake.value).replyWindow("agent-b1", DISPATCH);
    expect(window).toMatchObject({ complete: true, text: "done" });
    expect(fake.calls).toEqual(["agent-b1:tail:-:canonical"]);
  });

  test("walks backwards across pages until the dispatch is found", async () => {
    const tail = page([entry(6, "assistant_message", "t-7", { text: "B" })], {
      hasOlder: true,
      startCursor: { epoch: "e1", seq: 6 },
    });
    const older = page(
      [
        entry(3, "user_message", "t-7", { messageId: DISPATCH }),
        entry(4, "assistant_message", "t-7", { text: "A" }),
        entry(5, "assistant_message", "t-7", { text: "A2" }),
      ],
      { hasNewer: true },
    );
    const fake = port(tail, [older]);
    const window = await createObserverHost(fake.value).replyWindow("agent-b1", DISPATCH);
    expect(window).toMatchObject({ complete: true, text: "A\nA2\nB" });
    expect(fake.calls).toEqual(["agent-b1:tail:-:canonical", "agent-b1:before:6:canonical"]);
  });

  test("running out of pages before the dispatch is unverifiable, not an empty reply", async () => {
    const mk = (seq: number) =>
      page([entry(seq, "assistant_message", "t-9", { text: "x" })], {
        hasOlder: true,
        startCursor: { epoch: "e1", seq },
      });
    const fake = port(mk(30), [mk(20), mk(10)]);
    const window = await createObserverHost(fake.value, { maxPages: 2 }).replyWindow(
      "agent-b1",
      DISPATCH,
    );
    expect(window).toEqual({ complete: false, reason: "too-many-pages" });
    expect(fake.calls).toHaveLength(2);
  });

  test("a page the host marks as gapped or from another epoch makes the window incomplete", async () => {
    const tail = page([entry(6, "assistant_message", "t-7", { text: "B" })], {
      hasOlder: true,
      startCursor: { epoch: "e1", seq: 6 },
    });
    const older = page([entry(3, "user_message", "t-7", { messageId: DISPATCH })], {
      epoch: "e2",
      hasNewer: true,
    });
    const window = await createObserverHost(port(tail, [older]).value).replyWindow(
      "agent-b1",
      DISPATCH,
    );
    expect(window).toEqual({ complete: false, reason: "epoch-changed" });
  });

  test("a host error propagates so the caller counts it instead of reading it as silence", async () => {
    const failing: ObservedHostPort = {
      agents: {
        ref: () => ({
          timeline: {
            refetch: () => Promise.reject(new Error("daemon unreachable")),
          },
        }),
      },
    };
    await expect(createObserverHost(failing).replyWindow("a", DISPATCH)).rejects.toThrow(
      "daemon unreachable",
    );
  });
});
