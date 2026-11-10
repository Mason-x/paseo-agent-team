/**
 * The alert a Run carries while a task that is ready for a seat is held back only by closed seats (a
 * daemon restart leaves every member that was not mid-turn closed). It is found again by this prefix,
 * so the text after it may change without a second alert being written for the same problem. The text
 * names no seat and no task: it is written once and stays as it was until the situation is gone.
 */
export const SEAT_CLOSED_ALERT_PREFIX = "有任务在等一个已关闭的席位：";

export const SEAT_CLOSED_ALERT = `${SEAT_CLOSED_ALERT_PREFIX}Engine 已经对能读的席位试过重新打开（只读它的历史，不发消息，不调用模型），没有成功，也不会改派。读不出来的有：从没开过回合的 Codex 成员，和第一个回合开头几秒就被打断的成员；这两种 Engine 会按启动时冻结的配置给席位新建一个 Agent（另有告警说明，每个席位最多两次；补证、已经完成过回合的成员、已有被接受的交付证明的成员，不重建，后者另有告警）；第一个回合被打断的成员和会被同家族规则拒绝的评审席位，Engine 根本不读（前者直接重建）。它在 Paseo 里重新变为空闲后，点“立即检查并推进”继续（读得了的席位，Engine 会再读一次）；否则取消这个 Run 后重新启动。Run 进行中不要给它发消息去唤醒它，消息会和随后的派发撞在一起。`;

/**
 * The alert a Run carries while a producer's or a reviewer's turn was cut off under a member that is only
 * closed (T11e). Found again by this prefix; it is raised by the first look that sees the member closed and
 * taken down in the same commit that settles the turn, or when the turn is no longer waiting.
 */
export const CLOSING_TURN_ALERT_PREFIX = "有成员的回合被切断，成员已被关闭：";

export const CLOSING_TURN_ALERT = `${CLOSING_TURN_ALERT_PREFIX}Engine 先读一次它的历史，尝试把它重新打开（只读，不发消息，不调用模型），并等至少 30 秒再判定。之后的第一次检查：成员重新变为空闲且没有回合在跑，会给出“重试或取消”的决策（重试前请先看它的分支、清理被切断的回合留下的改动）；仍是关闭或打不开，会给出只能取消的决策。约 30 秒后点“立即检查并推进”即可（点它也会让 Engine 再读一次历史）。Run 进行中不要给成员发消息去唤醒它。`;
