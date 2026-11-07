/**
 * Chinese copy for "why is this waiting, who clears it, and what happens next" (P07).
 *
 * Every reason code the Engine writes into a task's `waitingReason` has an entry here. The keys are
 * the frozen wire codes; `tests/run-view/waiting.test.ts` reads the server sources and fails when a
 * code is written that has no entry, so adding a code without words does not pass.
 *
 * `who` says who can clear it. Four kinds of answer are used on purpose:
 *   Engine   it goes on by itself once the cause is gone (no one has to do anything)
 *   成员 / 判官 / 协调者   the agent that owns the next step
 *   你       a person: either with a button on this page, or outside it (the repository, the Team setup)
 *   暂无入口  nothing in this build can clear it; the line says what to do by hand
 */

export type WaitingText = { why: string; who: string; next: string };

const ENGINE = "Engine 自动";
const YOU = "你";
const KICK = "处理好之后点“立即检查并推进”";

/** `dispatch-blocked:<code>`: the task could not be sent to a seat. */
export const DISPATCH_BLOCKED_ZH: Record<string, WaitingText> = {
  "template-missing": {
    why: "找不到这类派发要用的提示词模板版本",
    who: `${YOU}（升级插件）`,
    next: "升级插件到带有该模板的版本后再推进",
  },
  "delivery-missing": {
    why: "找不到这个任务上一次的交付（提交），无法在它的基础上继续",
    who: YOU,
    next: `检查任务和仓库里是否还有那次交付；${KICK}`,
  },
  "delivery-branch-changed": {
    why: "交付所在的分支已经变了",
    who: YOU,
    next: `把仓库切回交付所在的分支；${KICK}`,
  },
  "delivery-not-at-head": {
    why: "仓库当前的提交不是上一次交付的提交",
    who: YOU,
    next: `让仓库回到交付的提交，或确认后续提交是预期内的；${KICK}`,
  },
  "delivery-ref-unsupported": {
    why: "交付不是 git 提交，Engine 无法核对",
    who: YOU,
    next: "需要人工检查这个任务的交付",
  },
  "delivery-diff-mismatch": {
    why: "仓库里的实际改动与成员报告的不一致",
    who: YOU,
    next: `核对仓库里的改动；${KICK}`,
  },
  "ledger-capacity": {
    why: "这个 Run 的台账接近容量上限，停止了新的派发",
    who: `${YOU}（收尾后重新启动一个 Run）`,
    next: "进行中的工作会继续收尾；之后用新的 Run 做剩下的事",
  },
  "evidence-not-repairable": {
    why: "证据被退回的原因不是补齐就能解决的（例如检查真的失败了）",
    who: `${YOU}（暂无入口，需要决策）`,
    next: "在决策点处理，或人工检查这个任务",
  },
  "evidence-return-limit": {
    why: "证据已经被退回到上限，不再自动请成员补证",
    who: `${YOU}（暂无入口）`,
    next: "人工检查这个任务的证据；目前没有页面入口放宽次数",
  },
  "evidence-seat-unavailable": {
    why: "要补证的成员席位现在不可用",
    who: ENGINE,
    next: "席位恢复后会自己继续；也可以点“立即检查并推进”",
  },
  "scope-rejected": {
    why: "任务声明的文件范围不被接受（越界或不在仓库内）",
    who: `${YOU}（暂无入口）`,
    next: "这个任务的范围需要由协调者重新规划",
  },
  "scope-unverified": {
    why: "任务的文件范围暂时无法核对",
    who: ENGINE,
    next: "下一次推进会再核对一次",
  },
  "lock-conflict": {
    why: "任务要用的文件或目录被别的任务（或别的 Run）占着",
    who: ENGINE,
    next: "占用方完成并释放后自动继续",
  },
  "other-runs-untrusted": {
    why: "读不到其他 Run 的占用情况，为避免冲突不派发",
    who: YOU,
    next: `检查是否有 Run 的台账损坏或版本不一致；${KICK}`,
  },
  "duplicate-dispatch": {
    why: "这次派发已经做过了",
    who: ENGINE,
    next: "不用处理，Engine 不会重复派发",
  },
  "seat-unavailable": {
    why: "负责这个任务的席位现在不可用",
    who: ENGINE,
    next: "席位恢复后自动继续",
  },
  "seat-unresolved": {
    why: "找不到席位对应的 Profile",
    who: YOU,
    next: `检查 Team 里的 Profile 是否还在；${KICK}`,
  },
  "seat-unqualified": {
    why: "没有合格的席位可以承担这个步骤（审查或冒烟）",
    who: YOU,
    next: "在 Team 里补充带对应职责的席位",
  },
  "seat-not-independent": {
    why: "审查席位和生产席位是同一个，Engine 不允许自己审自己",
    who: YOU,
    next: "在 Team 里增加独立的审查席位",
  },
  "family-not-independent": {
    why: "审查者和生产者来自同一个模型家族，不满足独立审查",
    who: YOU,
    next: "在 Team 里为审查席位选不同家族的 Profile",
  },
  "task-missing": {
    why: "任务记录不存在",
    who: `${YOU}（暂无入口）`,
    next: "这是不一致，请上报",
  },
  "task-not-dispatchable": {
    why: "任务现在的状态不能派发",
    who: ENGINE,
    next: "状态变化后自动继续",
  },
  "smoke-checklist-invalid": {
    why: "冒烟检查清单不合规",
    who: `${YOU}（暂无入口）`,
    next: "需要协调者重新规划这个任务",
  },
  "dev-target-invalid": {
    why: "冒烟要用的 DEV 目标不可用",
    who: YOU,
    next: `检查 Team 里的 DEV 目标配置；${KICK}`,
  },
  "launch-unavailable": {
    why: "找不到启动时冻结的 Workspace 信息",
    who: `${YOU}（暂无入口）`,
    next: "这个 Run 无法继续派发，请上报",
  },
  "payload-unbuilt": {
    why: "无法生成要发给成员的提示词",
    who: `${YOU}（暂无入口）`,
    next: "请上报；Engine 不会发送不确定的内容",
  },
  "intent-missing": {
    why: "找不到要发送的消息记录",
    who: `${YOU}（暂无入口）`,
    next: "请上报这个不一致",
  },
  "no-result": {
    why: "派发没有得到结果",
    who: ENGINE,
    next: "下一次推进会再试",
  },
  "workspace-unresolved": {
    why: "找不到 Run 的 Workspace",
    who: YOU,
    next: `检查 Workspace 是否还在；${KICK}`,
  },
  "workspace-dirty": {
    why: "Workspace 的工作树不干净，Engine 不在有未提交改动的分支上派发",
    who: YOU,
    next: `提交或清理工作树；${KICK}`,
  },
};

/** `dispatch-blocked:<prefix>-<detail>`: families whose detail is a git or filesystem code. */
export const DISPATCH_FAMILIES_ZH: Record<string, WaitingText> = {
  "workspace-": {
    why: "Workspace 现在不适合派发（不是可用的 git 分支）",
    who: YOU,
    next: `检查仓库状态（分支、提交、是否游离 HEAD）；${KICK}`,
  },
  "delivery-": {
    why: "无法核对上一次交付与仓库是否一致",
    who: YOU,
    next: `检查仓库；${KICK}`,
  },
  "evidence-root-": {
    why: "证据目录不可用（不存在、不可写或在仓库里）",
    who: YOU,
    next: `检查证据目录；${KICK}`,
  },
  "repo-": {
    why: "读不了仓库",
    who: YOU,
    next: `检查仓库路径和 git；${KICK}`,
  },
  "reducer-": {
    why: "台账拒绝了这次派发",
    who: `${YOU}（暂无入口）`,
    next: "请上报；台账没有被改动",
  },
};

/** `waiting-for-seat:<denial>,...`: the task is ready, every seat is refused for one of these. */
export const SEAT_DENIAL_ZH: Record<string, string> = {
  disabled: "席位被停用",
  "agent-missing": "席位还没有对应的 Agent",
  busy: "席位正忙",
  permission: "席位在等权限回应",
  degraded: "席位所在的渠道状态不好",
  channel: "渠道暂不可用",
  "profile-unavailable": "Profile 不可用",
  tier: "层级不够",
  duty: "席位没有这项职责",
  mode: "席位的模式不满足要求",
  "disabled-profile": "Profile 被停用",
  "disabled-channel": "渠道被停用",
  "same-as-producer": "和生产者是同一个席位",
};

/** Exact `waitingReason` values. */
export const WAITING_EXACT_ZH: Record<string, WaitingText> = {
  "report-missing": {
    why: "成员的回合结束了，但回复里没有协议要求的报告块",
    who: ENGINE,
    next: "Engine 会请成员重发（有次数上限）；次数用完后会开一个决策点",
  },
  "report-repair-budget-exhausted": {
    why: "要成员重发报告，但它的预算用完了",
    who: `${YOU}（暂无入口）`,
    next: "任务保持原样；在决策点处理，或人工检查成员的回复",
  },
  "evidence-send-waiting": {
    why: "要发给成员的补证请求在发出前复核没过（成员忙、工作树变了或提交变了）",
    who: ENGINE,
    next: `条件恢复后自动发出一次；${KICK}`,
  },
  "evidence-send-outcome-unknown": {
    why: "补证请求发出后没有收到结果，不知道成员是否收到了；为避免重复，已冻结任务的占用",
    who: `${YOU}（暂无入口）`,
    next: "Engine 不会重发；需要人工去看成员的对话",
  },
  "retry-approved": {
    why: "你已经批准重试，等待下一次派发",
    who: ENGINE,
    next: "下一次推进会重新派发",
  },
  "S-quality-failure": {
    why: "S 层的质量阶梯用完了，任务失败",
    who: YOU,
    next: "在决策点里选择重试",
  },
  "implementation-attempts": {
    why: "任务的实现尝试次数到了上限，任务已冻结",
    who: YOU,
    next: "在决策点里选择重试",
  },
  "blocked-review": {
    why: "审查不通过，任务回到返工",
    who: "成员（返工）",
    next: "返工完成后重新送审",
  },
  "failed-smoke": {
    why: "冒烟没有通过，任务回到返工",
    who: "成员（返工）",
    next: "返工完成后重新冒烟",
  },
};

/** The reasons a refused evidence gate leaves on the task (the first issue's reason). */
export const EVIDENCE_GATE_ZH: Record<string, string> = {
  evidence: "证据不齐",
  "missing-done-producer": "找不到完成报告",
  "ref-mismatch": "证据对应的提交与交付不一致",
  "invalid-producer": "完成报告无效",
  "evidence-repair-delivery-changed": "补证报告改变了交付，补证只能补证据",
  "outside-scope": "改动了任务范围之外的文件",
  "workspace-mismatch": "报告的 Workspace 与指派的不一致",
  "duplicate-id": "证据编号重复",
  missing: "缺少必需的证据",
  command: "证据对应的命令与要求不符",
  "exit-code": "检查的退出码不是 0",
  "artifact-root": "证据文件不在指定的证据目录下",
  isolation: "证据没有在隔离环境里产生",
  "missing-delivery": "找不到这个任务的交付",
  "unsettled-producer": "生产者的回合还没有确认结束",
  "coverage-lines": "行覆盖率低于要求",
  "coverage-functions": "函数覆盖率低于要求",
};

export const EVIDENCE_GATE_WAITING: WaitingText = {
  why: "成员交付的证据没过证据门",
  who: ENGINE,
  next: "Engine 会请成员补证（有次数上限）；真实失败的检查不会重复请求",
};

/** `report-rejected:<code>` / `report-refused:<code>` / `report-ownership:<code>` / `report-repair-requested:<why>`. */
export const REPORT_FAMILIES_ZH: Record<string, WaitingText> = {
  "report-rejected:": {
    why: "成员的报告块被解析器拒绝（格式不对）",
    who: ENGINE,
    next: "Engine 会请成员按格式重发（有次数上限）",
  },
  "report-refused:": {
    why: "报告格式没问题，但台账拒绝接受它",
    who: `${YOU}（暂无入口）`,
    next: "任务保持原样；需要人工检查报告和任务状态",
  },
  "report-ownership:": {
    why: "报告不是这个任务当前指派的成员发的，或编号对不上",
    who: `${YOU}（暂无入口）`,
    next: "Engine 不会采信这份报告；需要人工检查",
  },
  "report-repair-requested:": {
    why: "已经请成员重发报告",
    who: "成员",
    next: "成员回复后 Engine 自动入账",
  },
};

export const WAITING_UNKNOWN: WaitingText = {
  why: "这个等待原因当前版本没有对应的说明",
  who: "未知",
  next: "展开任务查看详情，或升级插件",
};

export const WAITING_MEMBER_CODE: WaitingText = {
  why: "成员或判官报告了阻塞或失败，并给出了原因代码",
  who: YOU,
  next: "在决策点里选择重试，或人工处理它说的原因",
};

/**
 * The causal timeline: what each kind of history event means, and why it happens (what led to it
 * or what it leads to). Keys are the event kinds of the ledger; a kind with no entry falls back to
 * `EVENT_CAUSE_UNKNOWN`, and the test fails for a kind the server sources write that is not here.
 */
export type EventCause = { label: string; cause: string };

export const EVENT_CAUSE_ZH: Record<string, EventCause> = {
  "launch-state": {
    label: "启动阶段变化",
    cause: "启动流程往前走了一步（创建成员、发送计划请求），或失败了",
  },
  "seat-bound": { label: "成员已绑定席位", cause: "启动时创建的 Agent 记到了它的席位上" },
  "plan-request-prepared": {
    label: "计划请求已备好",
    cause: "启动完成后，向协调者要任务图的请求写进了待发队列",
  },
  "plan-request-settled": {
    label: "计划请求已了结",
    cause: "协调者的任务图被接纳（或不再需要这条请求），它离开了待发队列",
  },
  "plan-repair-requested": {
    label: "请协调者重发任务图",
    cause: "协调者的任务图格式不对，Engine 请它按格式重发",
  },
  "replan-requested": {
    label: "重新规划",
    cause: "有人要求重新规划，Engine 向协调者发了新的计划请求",
  },
  "dag-accepted": { label: "任务图已接受", cause: "协调者的任务图通过校验，Run 开始派发任务" },
  "dag-revised": { label: "任务图已修订", cause: "协调者提交了修订后的任务图并被接纳" },
  "task-dispatched": {
    label: "任务已派发",
    cause: "任务的依赖满足、有合格席位和锁，Engine 把它交给了成员或判官",
  },
  "turn-started": { label: "回合开始", cause: "成员或判官开始处理被派发的内容" },
  "turn-ended": { label: "回合结束", cause: "成员或判官这一回合结束；Engine 之后读它的回复" },
  "task-report": {
    label: "任务报告",
    cause: "成员回复里的报告被接纳；之后 Engine 核对证据，通过则送审",
  },
  "review-report": {
    label: "审查报告",
    cause: "判官的结论被接纳；通过则任务完成，不通过则返工或开决策",
  },
  "smoke-report": { label: "冒烟报告", cause: "冒烟结论被接纳；通过则任务完成，不通过则返工" },
  decision: { label: "决策回应", cause: "有人回应了一个决策点" },
  "decision-opened": {
    label: "决策点已开",
    cause: "任务停在 Engine 不会自己撤销的状态，需要人回应",
  },
  "decision-answered": {
    label: "决策点已回应",
    cause: "有人回应了决策点；Engine 按回应让任务再来一次",
  },
  "cancel-requested": {
    label: "请求取消",
    cause: "有人要求取消任务，Engine 开始确认在途的工作是否已静止",
  },
  "cancellation-checked": {
    label: "取消静止检查",
    cause: "Engine 核对在途的回合已经结束，才会释放占用",
  },
  "run-paused": { label: "Run 暂停", cause: "有人暂停了 Run；暂停期间不会再向成员发新消息" },
  "run-resumed": { label: "Run 恢复", cause: "Run 恢复运行，暂停时没发出的消息会发一次" },
  "run-control-requested": {
    label: "暂停或继续的请求",
    cause: "有人从 Runs 页要求暂停或继续这个 Run；请求编号记在台账里，同一个请求不会执行两次",
  },
  "run-cancel-requested": {
    label: "请求取消 Run",
    cause: "有人从 Runs 页要求取消整个 Run；不再派发新任务，等进行中的回合结束后才会取消",
  },
  "run-cancel-completed": {
    label: "Run 取消完成",
    cause: "进行中的回合都已确认结束，全部未完成的任务已取消，占用已释放",
  },
  "run-finished": { label: "Run 结束", cause: "所有任务都完成或取消，且没有未了结的消息" },
  "run-cancelled": { label: "Run 取消", cause: "Run 被取消，占用已释放" },
  "observation-recorded": {
    label: "观察记录",
    cause: "Engine 记下了一条来自宿主的事实（例如回合结束的回执）",
  },
  "task-note": {
    label: "任务备注",
    cause: "任务没有往前走，Engine 记下了原因（见任务里的“原因”）",
  },
  "report-repair-requested": {
    label: "请成员重发报告",
    cause: "成员的报告缺失或格式不对，Engine 请它按格式重发（有次数上限）",
  },
  "report-repair-settled": {
    label: "重发请求已了结",
    cause: "成员的报告被接纳，之前的重发请求不再需要",
  },
  "intent-sending": {
    label: "消息开始发送",
    cause: "Engine 先把“正在发送”写进台账，然后才调用宿主",
  },
  "intent-confirmed": {
    label: "消息已送达",
    cause: "宿主确认收到，或在对话里看到了这条消息的回显",
  },
  "intent-outcome-unknown": {
    label: "发送结果不明",
    cause: "调用没有明确返回；Engine 不会重发，只会用回显核对",
  },
  "intent-failed": { label: "消息作废", cause: "这条消息发出之前就不再需要或无法生成，没有发送" },
  "alert-raised": { label: "告警", cause: "出现了需要人知道的情况（见“渠道与告警”）" },
  "alert-resolved": { label: "告警解除", cause: "告警的原因消失了" },
  "history-compacted": {
    label: "历史已压缩",
    cause: "事件太多，更早的历史被折叠成摘要，任务、占用、预算和决策都没有变",
  },
  "read-retry-changed": {
    label: "重查宿主",
    cause: "宿主读取失败，Engine 按 1、2、4 秒间隔只读地重查（只提示，不自己恢复）",
  },
  rework_started: { label: "开始返工", cause: "审查或冒烟没通过，任务回到返工" },
  quality_failed: { label: "质量未通过", cause: "审查或冒烟没通过，质量失败计数加一" },
  evidence_returned: { label: "证据被退回", cause: "成员交付的证据没过证据门，计数加一" },
  run_created: { label: "Run 创建", cause: "启动对话框里确认了启动" },
  dag_accepted: { label: "任务图已接受", cause: "协调者的任务图通过校验，Run 开始派发任务" },
  task_assigned: { label: "任务已指派", cause: "任务被指派给了一个席位" },
  task_transition: { label: "任务状态变化", cause: "任务进入了下一个状态" },
  turn_started: { label: "回合开始", cause: "成员或判官开始处理被派发的内容" },
  turn_ended: { label: "回合结束", cause: "成员或判官这一回合结束；Engine 之后读它的回复" },
};

export const EVENT_CAUSE_UNKNOWN: EventCause = {
  label: "其他事件",
  cause: "当前版本没有这类事件的说明；它已写进台账，不影响其他显示",
};
