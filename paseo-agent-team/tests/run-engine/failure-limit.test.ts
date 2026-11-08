import { describe, expect, test } from "vitest";
import {
  FAILED_LIMIT_ALERT_PREFIX,
  failedLimitAlert,
  failedTaskLimit,
} from "../../shared/domain/run-engine/failure-limit";
import type { RunRecord, RunTaskState } from "../../shared/schemas/run-engine/ledger";
import { task } from "../fixtures/run-engine/base";
import { bootstrapRun } from "./support/bootstrap-run";

/**
 * Failure modes this file guards (the pure side of the failed-task gate; the Run that really stops
 * dispatching is in failure-limit-driver.test.ts):
 *  - a task that was cancelled, blocked, or finished being counted as a failure, or a failed one
 *    not being counted;
 *  - the limit being compared one off (a Run exactly at its limit stopping, or one over it going on);
 *  - the limit being read from somewhere other than the policy the Run froze at its start;
 *  - the alert text drifting from the prefix the service finds it by.
 */

function runWith(states: readonly RunTaskState[], failedTasks = 3, strategicTurns = 12): RunRecord {
  const record = bootstrapRun({ runId: "run-fl0001-a1" });
  record.tasks = states.map((state, index) =>
    task(`f${index + 1}`, `Task ${index + 1}`, { state }),
  );
  record.policy.run = { failedTasks, strategicTurns };
  return record;
}

describe("failedTaskLimit", () => {
  test("counts only tasks that are failed now", () => {
    const states: RunTaskState[] = [
      "pending",
      "ready",
      "assigned",
      "in_progress",
      "review",
      "rework",
      "done",
      "blocked",
      "cancelled",
      "failed",
    ];
    expect(failedTaskLimit(runWith(states))).toEqual({ failed: 1, limit: 3, exceeded: false });
    expect(failedTaskLimit(runWith(["cancelled", "cancelled", "blocked", "done"]))).toMatchObject({
      failed: 0,
      exceeded: false,
    });
  });

  test("exactly at the limit is not over it; one more is", () => {
    expect(failedTaskLimit(runWith(["failed", "failed", "failed"], 3))).toEqual({
      failed: 3,
      limit: 3,
      exceeded: false,
    });
    expect(failedTaskLimit(runWith(["failed", "failed", "failed", "failed"], 3))).toEqual({
      failed: 4,
      limit: 3,
      exceeded: true,
    });
  });

  test("with a limit of zero the first failure is over it", () => {
    expect(failedTaskLimit(runWith([], 0))).toMatchObject({ failed: 0, exceeded: false });
    expect(failedTaskLimit(runWith(["done", "failed"], 0))).toEqual({
      failed: 1,
      limit: 0,
      exceeded: true,
    });
  });

  test("reads the limit the Run froze, not the coordinator turn budget", () => {
    // failedTasks 1 with a large turn budget, and failedTasks 5 with a tiny one: only the first is over.
    const states: RunTaskState[] = ["failed", "failed"];
    expect(failedTaskLimit(runWith(states, 1, 256))).toMatchObject({ limit: 1, exceeded: true });
    expect(failedTaskLimit(runWith(states, 5, 0))).toMatchObject({ limit: 5, exceeded: false });
  });

  test("is a pure function of the record: it does not change it", () => {
    const record = runWith(["failed", "failed", "failed", "failed"]);
    const before = structuredClone(record);
    failedTaskLimit(record);
    expect(record).toEqual(before);
  });
});

describe("failedLimitAlert", () => {
  test("is the fixed text, and starts with the prefix the service looks for", () => {
    const text = failedLimitAlert(3);
    expect(text).toBe(
      "失败的任务已超过策略允许的 3 个，不再开始尚未开始的任务；进行中的工作会继续收尾。请在决策点重试或取消失败的任务。",
    );
    expect(text.startsWith(FAILED_LIMIT_ALERT_PREFIX)).toBe(true);
    expect(FAILED_LIMIT_ALERT_PREFIX).toBe("失败的任务已超过策略允许的");
  });

  test("names the limit and no count of failed tasks, so an alert that stays open cannot go stale", () => {
    expect(failedLimitAlert(3)).not.toContain("现有");
    expect(failedLimitAlert(3).match(/\d+ 个/gu)).toEqual(["3 个"]);
    expect(failedLimitAlert(5)).toContain("5 个");
  });
});
