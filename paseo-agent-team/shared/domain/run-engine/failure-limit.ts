import type { RunRecord } from "../../schemas/run-engine/ledger";

/**
 * The failed-task limit of a Run (`policy.run.failedTasks`, frozen when the Run started).
 *
 * A task counts as failed while its state is `failed` right now: a cancelled task, a blocked one, a
 * finished one, and one that failed once and was taken back by a retry are not counted. The limit is
 * exceeded when there are MORE failed tasks than it allows, so a Run exactly at its limit goes on.
 * What the Engine does about it is the dispatcher's business: it starts no task that has not started
 * yet (a `ready` one) and lets what is already under way (reviews, smokes, supplements, reworks)
 * finish; this is only the count, a pure function of the record.
 */
export type FailedTaskLimit = { failed: number; limit: number; exceeded: boolean };

export function failedTaskLimit(record: RunRecord): FailedTaskLimit {
  const failed = record.tasks.filter((task) => task.state === "failed").length;
  const limit = record.policy.run.failedTasks;
  return { failed, limit, exceeded: failed > limit };
}

/**
 * The alert a Run carries while the limit is exceeded. It is found again by this prefix, so the text
 * after it may change without a second alert being written for the same problem. The text names the
 * limit but not the count of failed tasks: the alert is written once and stays as it was until the
 * count is back within the limit, so a count in it would go stale while the alert is still open.
 */
export const FAILED_LIMIT_ALERT_PREFIX = "失败的任务已超过策略允许的";

export function failedLimitAlert(limit: number): string {
  return `${FAILED_LIMIT_ALERT_PREFIX} ${limit} 个，不再开始尚未开始的任务；进行中的工作会继续收尾。请在决策点重试或取消失败的任务。`;
}
