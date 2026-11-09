import { describe, expect, test } from "vitest";
import {
  LOST_TURN_CODE,
  LOST_TURN_HINT,
  type ReadRetryItem,
  readRetryAlertSummary,
} from "../../shared/domain/run-engine/read-retry";
import { alertRows } from "../../shared/domain/run-engine/view";
import { explainAlert } from "../../shared/domain/run-engine/waiting";
import { RunAlertViewSchema } from "../../shared/schemas/run-engine/rpc";

/**
 * A Run's alert says why a person should look and what to do. The page used to cut every alert
 * text after 300 characters, and the longest one the server writes (the used-up re-check of a lost
 * turn) is longer than that: the sentence stopped in the middle of the way out ("...也不会…").
 * The ledger keeps up to 1000 characters of an alert, so the page shows as many.
 */

const AT = "2026-11-09T12:17:04.000Z";
const AGENT = "e9d3f6fd-1a19-492c-8247-42e98cf409f4";

const lostTurn: ReadRetryItem = {
  key: `reply:${AGENT}:assignment-fix-add-bug-a1-dc3990f3`,
  generation: 1,
  target: {
    type: "reply",
    agentId: AGENT,
    taskId: "fix-add-sign",
    assignmentId: "assignment-fix-add-bug-a1-dc3990f3",
    anchorMessageId: "msg-1",
  },
  sourceKey: "epoch-1:assignment-fix-add-bug-a1-dc3990f3:msg-1",
  attemptsStarted: 3,
  scheduledAt: AT,
  nextAt: null,
  state: "held",
  lastCode: LOST_TURN_CODE,
};

const alert = (summary: string, state: "open" | "acknowledged" | "resolved" = "open") => ({
  alertId: "alert-0001",
  severity: "warning" as const,
  state,
  summary,
  createdAt: AT,
});

describe("the text of an alert on the Runs page", () => {
  const written = readRetryAlertSummary(lostTurn);

  test("the longest text the server writes is longer than the old cut of 300 characters", () => {
    // Guards the premise: if the wording is ever shortened below 300 this test says the cut no longer matters.
    expect(written.length).toBeGreaterThan(300);
    expect(written.endsWith("等它回复后再点“立即检查并推进”")).toBe(true);
    expect(written).toContain(LOST_TURN_HINT);
  });

  test("is shown whole, so the sentence about what to do is not cut in the middle", () => {
    const said = explainAlert(alert(written));
    expect(said.why).toBe(written);
    expect(said.why.endsWith("…")).toBe(false);
  });

  test("is shown whole in the row of the alerts panel as well", () => {
    const [row] = alertRows([alert(written)]);
    expect(row?.summary).toBe(written);
    expect(row?.explain.why).toBe(written);
  });

  test("shows up to the 1000 characters the ledger keeps, and says so with an ellipsis past that", () => {
    const limit = 1000;
    expect(explainAlert(alert("字".repeat(limit))).why).toBe("字".repeat(limit));
    expect(alertRows([alert("字".repeat(limit))])[0]?.summary).toBe("字".repeat(limit));
    const over = explainAlert(alert("字".repeat(limit + 1))).why;
    expect([...over]).toHaveLength(limit);
    expect(over.endsWith("…")).toBe(true);
  });

  test("the limit is the one the wire format allows for an alert, not a number of its own", () => {
    const wire = (summary: string) => RunAlertViewSchema.safeParse(alert(summary)).success;
    expect(wire("字".repeat(1000))).toBe(true);
    expect(wire("字".repeat(1001))).toBe(false);
  });
});
