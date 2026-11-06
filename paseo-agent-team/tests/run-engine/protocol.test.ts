import { describe, expect, test } from "vitest";
import {
  buildReplyWindow,
  extractProtocolBlock,
  PROTOCOL_BLOCK_MAX_BYTES,
  PROTOCOL_REPLY_MAX_BYTES,
  type TimelinePageLike,
  verifyReportOwnership,
} from "../../server/run-engine/protocol";
import type { RunNonceEntry } from "../../shared/schemas/run-engine/ledger";
import {
  ASSIGNMENT_T2,
  assignment,
  MESSAGE_T2,
  NONCE_T2,
  RUN_ID,
} from "../fixtures/run-engine/base";
import { PROTOCOL_BLOCK_CASES, PROTOCOL_REPLAY_CASE } from "../fixtures/run-engine/protocol";

const fence = (name: string, body: string) => `\`\`\`${name}\n${body}\n\`\`\``;
const report = () => structuredClone(PROTOCOL_REPLAY_CASE.report);
const reportFence = (value: Record<string, unknown> = report()) =>
  fence("task-report", JSON.stringify(value));

describe("extractProtocolBlock", () => {
  test("accepts one well-formed block, also when surrounded by prose", () => {
    const result = extractProtocolBlock(`Done.\n\n${reportFence()}\nThanks.`);
    expect(result).toMatchObject({ status: "block", kind: "task-report" });
  });

  test("fixture cases: each defect is rejected for its own named reason, none is accepted", () => {
    const expected: Record<string, string> = {
      "missing-block": "none",
      "two-task-reports": "multiple-blocks",
      "mixed-kinds": "mixed-kinds",
      "non-json-body": "non-json",
      "unknown-version": "unknown-version",
      "oversized-block": "oversize-block",
      "missing-evidence": "schema-invalid",
    };
    for (const sample of PROTOCOL_BLOCK_CASES) {
      const result = extractProtocolBlock(sample.raw);
      if (sample.id === "escaped-fence-inside-string") {
        // The ``` sits inside a JSON string, so it is data and the block is valid.
        expect(result.status, sample.id).toBe("block");
        continue;
      }
      const outcome = result.status === "rejected" ? result.reason : result.status;
      expect(outcome, sample.id).toBe(expected[sample.id]);
    }
  });

  test("a block at the byte limit is parsed, one byte over is rejected before parsing", () => {
    const pad = (size: number) => {
      const base = JSON.stringify({ ...report(), pad: "" });
      return JSON.stringify({
        ...report(),
        pad: "x".repeat(size - Buffer.byteLength(base, "utf8")),
      });
    };
    const atLimit = pad(PROTOCOL_BLOCK_MAX_BYTES);
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(PROTOCOL_BLOCK_MAX_BYTES);
    // Strict schema: the pad field is unknown, so it is parsed and refused for schema reasons...
    expect(extractProtocolBlock(fence("task-report", atLimit))).toMatchObject({
      status: "rejected",
      reason: "schema-invalid",
    });
    // ...while one more byte never reaches JSON.parse at all.
    expect(extractProtocolBlock(fence("task-report", `${atLimit} `))).toMatchObject({
      status: "rejected",
      reason: "oversize-block",
    });
  });

  test("a reply over the whole-reply budget is unverifiable, never reported as silence", () => {
    const filler = "y".repeat(PROTOCOL_REPLY_MAX_BYTES + 1);
    expect(extractProtocolBlock(`${filler}\n${reportFence()}`)).toEqual({
      status: "unverifiable",
      reason: "reply-too-large",
    });
  });

  test("a protocol fence quoted inside another fence is not a block", () => {
    const quoted = `${"````"}markdown\n${reportFence()}\n${"````"}`;
    expect(extractProtocolBlock(quoted)).toEqual({ status: "none" });
    expect(extractProtocolBlock(fence("json", reportFence()))).toEqual({ status: "none" });
  });

  test("an unterminated protocol fence is rejected, not guessed at", () => {
    const open = `\`\`\`task-report\n${JSON.stringify(report())}`;
    expect(extractProtocolBlock(open)).toMatchObject({
      status: "rejected",
      reason: "unterminated-fence",
    });
  });

  test("an unexpected kind is rejected when the caller names the kind it is waiting for", () => {
    expect(extractProtocolBlock(reportFence(), { expected: "review-report" })).toMatchObject({
      status: "rejected",
      reason: "unexpected-kind",
      kind: "task-report",
    });
  });

  test("an unknown field rejects the whole block and issues carry paths, not submitted values", () => {
    const secret = "TOP-SECRET-VALUE";
    const result = extractProtocolBlock(reportFence({ ...report(), extra: secret }));
    expect(result).toMatchObject({ status: "rejected", reason: "schema-invalid" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("CRLF line endings do not change the outcome", () => {
    const crlf = reportFence().replaceAll("\n", "\r\n");
    expect(extractProtocolBlock(crlf).status).toBe("block");
  });
});

describe("buildReplyWindow", () => {
  const DISPATCH = "22222222-2222-4222-8222-222222222222";
  const entry = (
    seq: number,
    type: string,
    turnId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    item: { type, ...extra },
    turnId,
    seqStart: seq,
    seqEnd: seq,
  });
  const page = (entries: TimelinePageLike["entries"], over: Partial<TimelinePageLike> = {}) => ({
    entries,
    epoch: "e1",
    hasOlder: false,
    hasNewer: false,
    gap: false,
    staleCursor: false,
    reset: false,
    ...over,
  });

  test("joins the assistant text of the dispatched turn and ignores other turns", () => {
    const window = buildReplyWindow({
      dispatchMessageId: DISPATCH,
      pages: [
        page([
          entry(1, "user_message", "t-6", { messageId: "older" }),
          entry(2, "assistant_message", "t-6", { text: "OLD" }),
          entry(3, "user_message", "t-7", { messageId: DISPATCH }),
          entry(4, "assistant_message", "t-7", { text: "part one" }),
          entry(5, "assistant_message", "t-7", { text: "part two" }),
        ]),
      ],
    });
    expect(window).toMatchObject({ complete: true, turnId: "t-7", text: "part one\npart two" });
  });

  test("pages arriving out of order or overlapping give the same window", () => {
    const first = page(
      [
        entry(3, "user_message", "t-7", { messageId: DISPATCH }),
        entry(4, "assistant_message", "t-7", { text: "A" }),
      ],
      { hasNewer: true },
    );
    const second = page([
      entry(4, "assistant_message", "t-7", { text: "A" }),
      entry(5, "assistant_message", "t-7", { text: "B" }),
    ]);
    const forward = buildReplyWindow({ dispatchMessageId: DISPATCH, pages: [first, second] });
    const reversed = buildReplyWindow({ dispatchMessageId: DISPATCH, pages: [second, first] });
    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({ complete: true, text: "A\nB" });
  });

  test("an incomplete read is unverifiable for every sign of a partial read", () => {
    const base = [
      entry(3, "user_message", "t-7", { messageId: DISPATCH }),
      entry(4, "assistant_message", "t-7", { text: "A" }),
    ];
    const reason = (pages: TimelinePageLike[], maxPages?: number) => {
      const result = buildReplyWindow({ dispatchMessageId: DISPATCH, pages, maxPages });
      return result.complete ? "complete" : result.reason;
    };
    expect(reason([page(base, { gap: true })])).toBe("timeline-discontinuity");
    expect(reason([page(base, { staleCursor: true })])).toBe("timeline-discontinuity");
    expect(reason([page(base, { reset: true })])).toBe("timeline-discontinuity");
    expect(reason([page(base), page(base, { epoch: "e2" })])).toBe("epoch-changed");
    expect(reason([page(base), page(base)], 1)).toBe("too-many-pages");
    expect(reason([page(base, { hasNewer: true })])).toBe("turn-open");
    expect(
      reason([page([entry(4, "assistant_message", "t-7", { text: "A" })], { hasOlder: true })]),
    ).toBe("dispatch-not-found");
    expect(reason([page([{ ...base[0], turnId: undefined } as never, base[1] as never])])).toBe(
      "turn-unknown",
    );
  });

  test("a later turn proves the dispatched turn is over even when the page says hasNewer", () => {
    const window = buildReplyWindow({
      dispatchMessageId: DISPATCH,
      pages: [
        page(
          [
            entry(3, "user_message", "t-7", { messageId: DISPATCH }),
            entry(4, "assistant_message", "t-7", { text: "A" }),
            entry(5, "user_message", "t-8", { messageId: "next" }),
          ],
          { hasNewer: true },
        ),
      ],
    });
    expect(window).toMatchObject({ complete: true, text: "A" });
  });

  test("a reply over the budget is unverifiable", () => {
    const window = buildReplyWindow({
      dispatchMessageId: DISPATCH,
      pages: [
        page([
          entry(3, "user_message", "t-7", { messageId: DISPATCH }),
          entry(4, "assistant_message", "t-7", { text: "z".repeat(PROTOCOL_REPLY_MAX_BYTES + 1) }),
        ]),
      ],
    });
    expect(window).toEqual({ complete: false, reason: "reply-too-large" });
  });

  test("the dispatch can be matched through clientMessageId", () => {
    const window = buildReplyWindow({
      dispatchMessageId: DISPATCH,
      pages: [
        page([
          entry(1, "user_message", "t-1", { messageId: "x", clientMessageId: DISPATCH }),
          entry(2, "assistant_message", "t-1", { text: "ok" }),
        ]),
      ],
    });
    expect(window).toMatchObject({ complete: true, text: "ok" });
  });
});

describe("verifyReportOwnership", () => {
  const nonceEntry = (over: Partial<RunNonceEntry> = {}): RunNonceEntry => ({
    nonce: NONCE_T2,
    runId: RUN_ID,
    taskId: "t2",
    assignmentId: ASSIGNMENT_T2,
    attempt: 1,
    phase: "implementation",
    agentId: "agent-b1",
    seatId: "seat-b1",
    issuedAt: "2026-10-27T12:00:00.000Z",
    acceptedAt: null,
    acceptedEventKey: null,
    revokedAt: null,
    revokeReason: null,
    ...over,
  });
  const record = (
    assignmentOver: Record<string, unknown> = {},
    nonceOver: Partial<RunNonceEntry> = {},
  ) => ({
    runId: RUN_ID,
    assignments: [assignment(assignmentOver)],
    nonceRegistry: [nonceEntry(nonceOver)],
  });
  const block = (over: Record<string, unknown> = {}) =>
    ({
      protocolVersion: 1,
      runId: RUN_ID,
      taskId: "t2",
      assignmentId: ASSIGNMENT_T2,
      attempt: 1,
      nonce: NONCE_T2,
      ...over,
    }) as never;
  const observed = { agentId: "agent-b1", messageId: MESSAGE_T2 };
  const code = (
    rec: ReturnType<typeof record>,
    over: Record<string, unknown> = {},
    seen: Parameters<typeof verifyReportOwnership>[3] = observed,
    kind: "task-report" | "review-report" | "smoke-report" = "task-report",
  ) => {
    const result = verifyReportOwnership(rec, kind, block(over), seen);
    return result.ok ? "ok" : result.code;
  };

  test("the assigned agent reporting its own assignment is accepted", () => {
    expect(code(record())).toBe("ok");
  });

  test("identity is checked against the ledger, one mismatch at a time", () => {
    expect(code(record(), { runId: "run-other-a1" })).toBe("run-mismatch");
    expect(code(record(), { assignmentId: "assignment-t2-a2" })).toBe("assignment-unknown");
    expect(code(record(), { taskId: "t1" })).toBe("task-mismatch");
    expect(code(record(), { attempt: 2 })).toBe("attempt-mismatch");
    expect(code(record(), { nonce: "6f1c2a44-3b7e-4f0a-9a11-00000000dead" })).toBe(
      "nonce-mismatch",
    );
    expect(code(record(), { messageId: "33333333-3333-4333-8333-333333333333" })).toBe(
      "message-mismatch",
    );
  });

  test("the sender comes from the host: another agent holding the right nonce is refused", () => {
    expect(code(record(), {}, { agentId: "agent-evil", messageId: MESSAGE_T2 })).toBe(
      "sender-not-assignee",
    );
  });

  test("a reply to a different dispatch message or turn is refused", () => {
    expect(code(record(), {}, { agentId: "agent-b1", messageId: "other" })).toBe(
      "message-mismatch",
    );
    expect(code(record({ turnId: "turn-1" }), {}, { ...observed, turnId: "turn-2" })).toBe(
      "turn-mismatch",
    );
  });

  test("a review report cannot answer a task assignment, and a task report cannot answer a probe", () => {
    expect(code(record(), {}, observed, "review-report")).toBe("wrong-purpose");
    expect(code(record({ purpose: "probe" }))).toBe("wrong-purpose");
  });

  test("a judge may carry a task report (the reducer lets only a blocked one through)", () => {
    const judge = record({ purpose: "reviewer", delivery: { producerAssignmentId: "a" } });
    expect(code(judge)).toBe("ok");
    expect(code(record({ purpose: "smoker", delivery: { producerAssignmentId: "a" } }))).toBe("ok");
    // The judge's own kind is still its own: a smoke report does not answer a review.
    expect(code(judge, {}, observed, "smoke-report")).toBe("wrong-purpose");
  });

  test("registry disagreement, revocation and replay are refused or flagged as duplicate", () => {
    expect(code(record({}, { taskId: "t3" }))).toBe("nonce-registry-mismatch");
    expect(code(record({}, { agentId: "agent-b9" }))).toBe("sender-not-assignee");
    expect(
      code(record({}, { revokedAt: "2026-10-27T12:10:00.000Z", revokeReason: "cancelled" })),
    ).toBe("nonce-revoked");
    expect(code(record({}, { acceptedAt: "2026-10-27T12:20:00.000Z" }))).toBe("duplicate");
  });

  test("a cancelled or failed assignment no longer accepts reports", () => {
    expect(code(record({ state: "cancelled" }))).toBe("assignment-closed");
    expect(code(record({ state: "failed" }))).toBe("assignment-closed");
  });
});
