/**
 * The alert a Run carries while a task that is ready for a seat is held back only by closed seats (a
 * daemon restart leaves every member that was not mid-turn closed). It is found again by this prefix,
 * so the text after it may change without a second alert being written for the same problem. The text
 * names no seat and no task: it is written once and stays as it was until the situation is gone.
 */
export const SEAT_CLOSED_ALERT_PREFIX = "有任务在等一个已关闭的席位：";

export const SEAT_CLOSED_ALERT = `${SEAT_CLOSED_ALERT_PREFIX}Engine 不会自己重新打开它，也不会改派。它在 Paseo 里重新变为空闲后，点“立即检查并推进”继续；否则取消这个 Run 后重新启动（从没开过回合的成员，尤其是 Codex，重启后可能再也打不开）。Run 进行中不要给它发消息去唤醒它，消息会和随后的派发撞在一起。`;
