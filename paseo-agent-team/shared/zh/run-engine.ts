/**
 * Chinese copy for the Runs page Engine view (RE-R07). `shared/zh.ts` is a hot file owned by W01;
 * until it merges this table, the view imports it directly. Keys are the frozen wire values
 * (task states, phases, failure codes, event kinds), never display strings.
 */
const LIFECYCLE_ZH: Record<string, string> = {
  bootstrapping: "启动中",
  "awaiting-dag": "等待任务图",
  active: "运行中",
  paused: "已暂停",
  finished: "已结束",
  cancelled: "已取消",
};

const TASK_NOT_RELEASABLE_ZH: Record<string, string> = {
  "effects-unsettled": "还有发给成员的消息是否送达没有确定",
  "actors-unsettled": "还有成员的回合没有确认结束",
  "turn-not-ended": "最后一个回合还没有确认结束",
  "decision-stale": "这个决策已经过期，任务的状态变了",
  "state-changed": "任务的状态已经变了",
  "delivery-missing": "找不到可以返工的交付",
  cancellation: "任务正在取消",
  "task-missing": "找不到这个任务",
};

function own(map: Record<string, string>, key: string): string {
  return Object.hasOwn(map, key) ? (map[key] as string) : key;
}

export const runEngineZh = {
  title: "Run 引擎",
  refresh: "刷新",
  loading: "正在读取 Run 台账…",
  /** Shown when the Run has no control to offer (finished, cancelled, or nothing to answer). */
  noControls: "这个 Run 现在没有可用的控制操作",

  /** The controls of the Runs page. Every refusal code of `run.replan`, `run.decide` and `run.kick` has copy here. */
  controls: {
    title: "控制",
    pending: "正在提交…",
    replan: {
      title: "重新规划",
      help: "让协调者重新给出一份任务图。只在 Run 还在等待任务图时可用；发出的是一条新的计划请求，旧的未发出的会作废。",
      reasonLabel: "原因（必填）",
      reasonPlaceholder: "说明为什么要重新规划，会写进给协调者的请求里",
      submit: "请求重新规划",
      needReason: "请先写明原因",
    },
    retry: {
      button: "重试",
      confirmTitle: "确认重试这个任务？",
      confirm: "确认重试",
      cancel: "取消",
      reason: (category: string) => `从 Runs 页确认重试（${category}）`,
      explain: {
        D3: "任务的质量阶梯已用完，任务处于失败状态。重试会再给它一次尝试：已有交付但没过审查或冒烟的，带着原来的占用回到返工；没有交付的，释放占用后重新来一次。计数不会清零，再失败会再开一个决策。",
        D4: "任务的尝试次数已达上限，任务阻塞并冻结了占用。重试会再给它一次尝试，规则同上：有交付则返工，没有则释放占用后重新来一次。",
        D1: "有成员或判官报告了阻塞或失败，或成员的回合已结束但没有可用报告、而且已追问到上限。重试只做一件事：交付仍在且审查没过，回到返工；成员没有交付，释放占用后重新来一次；判官做不了，重新送审；回合结束没有可用报告，先关闭这次尝试再重新来一次。所有相关回合都必须确实已结束，否则会被拒绝。",
      } as Record<string, string>,
      explainOther: "重试会让这个任务再来一次；不确定它为什么停下时，先看任务详情再决定。",
    },
    kick: {
      title: "催办",
      help: "立即核对宿主、补收漏掉的报告、发出还没发出的消息，并推进一次。不会替成员完成任何任务，也不会放开冻结的占用。",
      button: "立即检查并推进",
    },
    result: {
      applied: "已提交",
      replayed: "这个请求已经提交过，没有重复执行",
      refreshed: "已重新读取最新状态",
      transport: "请求没有送达，请稍后重试（同一个请求不会重复执行）",
      unknownCode: (code: string) => `被拒绝（原因代码 ${code}）`,
      kick: {
        idle: "没有需要推进的内容",
        dispatched: (count: number) => `已发出 ${count} 条消息`,
        waiting: "有任务在等席位",
        blocked: (reason: string | null) =>
          reason ? `有任务发不出去（${reason}）` : "有任务发不出去",
        finished: "Run 已全部完成",
        notActive: "Run 现在不在运行中（已结束、已取消、已暂停或还在等任务图）",
      },
    },
    /** One entry for every code in `RUN_ACTION_CODES`; a test fails when a code has no copy. */
    codes: {
      "run-missing": () => "找不到这个 Run 的台账，可能已被清理",
      "run-corrupt": () => "这个 Run 的台账已损坏，无法操作；需要人工检查",
      "run-unknown-version": () => "这个 Run 由更新版本写入，请升级插件后再操作",
      "revision-conflict": (params: Record<string, string | number | boolean>) =>
        `Run 在你查看之后又有了变化${typeof params.current === "number" ? `（现在是第 ${params.current} 版）` : ""}，已重新读取；请确认后再试一次`,
      "request-id-reused": () => "这个请求编号已经用于另一项内容，请重新发起",
      "replan-not-allowed": (params: Record<string, string | number | boolean>) =>
        `现在不能重新规划${typeof params.lifecycle === "string" ? `（Run 当前${own(LIFECYCLE_ZH, params.lifecycle)}）` : ""}：只有还在等任务图、且协调者尚未交出可用任务图时才可以`,
      "plan-request-missing": () => "找不到当前的计划请求，无法重新规划",
      "delivery-unresolved": () =>
        "上一条发给协调者的消息是否送达还没有确定，为避免重复发送，暂时不能重新规划；稍后再试，或先点“立即检查并推进”",
      "plan-unbuildable": () => "无法生成新的计划请求，请上报这个问题",
      "decision-missing": () => "找不到这个决策点",
      "decision-answered": () => "这个决策点已经被回应过了",
      "decision-not-answerable": (params: Record<string, string | number | boolean>) =>
        `这个决策点目前不能在这里回应${typeof params.category === "string" ? `（${params.category}）` : ""}`,
      "action-unsupported": () => "当前版本不支持这个回应方式",
      "task-not-releasable": (params: Record<string, string | number | boolean>) =>
        `任务还没有被证明已经停下，不能重试${typeof params.reason === "string" ? `（${own(TASK_NOT_RELEASABLE_ZH, params.reason)}）` : ""}`,
      "run-not-active": (params: Record<string, string | number | boolean>) =>
        `Run 现在不在运行中${typeof params.lifecycle === "string" ? `（${own(LIFECYCLE_ZH, params.lifecycle)}）` : ""}，不能执行这个操作`,
      "ledger-refused": () => "台账拒绝了这次修改，没有任何改动；请刷新后再试，持续出现请上报",
    },
    taskNotReleasable: TASK_NOT_RELEASABLE_ZH,
  },

  /** Launch gate for `Team.runEngine`; reasons are shown as blockers/warnings in the launch preview. */
  launch: {
    invalid: (issues: readonly string[]) =>
      `团队的 Run 引擎配置无效，已阻止启动（不会改用旧流程）：${issues.join("；")}`,
    invalidButDisabled: (issues: readonly string[]) =>
      `团队的 Run 引擎配置无效，但已标记为关闭，按旧流程启动：${issues.join("；")}`,
    seatDuplicate: (seatId: string) => `Run 引擎配置里的席位 ${seatId} 重复`,
    seatUnknown: (seatId: string) => `Run 引擎配置里的席位 ${seatId} 不在团队的启用成员中`,
    seatMissing: (seatId: string) => `团队成员席位 ${seatId} 没有对应的 Run 引擎席位配置`,
    noEnabledSeat: "Run 引擎配置里没有启用的席位",
    unsupported:
      "该团队已启用 Run 引擎，但当前版本尚不能执行 Engine Run；为避免静默改用旧流程，已阻止启动",
    /** Engine start needs the ledger and the daemon's server id; `reason` is a short code. */
    identityUnavailable: (reason: string) =>
      `Run 引擎无法确定运行记录的存放位置（${reason}），已阻止启动；不会改用旧流程`,
    workspaceNoDirectory: "无法读取该 Workspace 的目录，Run 引擎不能启动",
    workspaceNotGit: (detail: string) =>
      `Run 引擎需要 git 仓库作为 Workspace，当前目录不可用${detail ? `：${detail}` : ""}`,
    workspaceDetached: "Workspace 处于游离 HEAD（没有分支），Run 引擎不能在上面提交",
    reviewerTierMissing: (producerSeat: string, level: string, tier: string) =>
      `席位 ${producerSeat} 生产的 ${level} 任务需要另一个 ${tier} 层、带 review 职责的独立审查席位，目前没有；协调者会如实声明无法为这类任务成计划`,
    codexNeedsFullAccess: (seatId: string, duty: string) =>
      `席位 ${seatId} 用 Codex 承担 ${duty}，但 Profile 不是 full-access 模式：沙箱模式下它可能无法提交，也写不进仓库外的证据目录`,
    commitIdentityMissing: (detail: string) =>
      `Workspace 的 git 没有可用的提交身份（user.name、user.email），成员无法提交；请先配置${detail ? `：${detail}` : ""}`,
    workspaceDirty: "Workspace 的工作树不干净，Run 引擎只能在干净的分支上开始；请先提交或清理",
    workspaceNoCommit: "Workspace 还没有任何提交，Run 引擎需要一个基准提交",
  },

  lifecycle: LIFECYCLE_ZH,

  level: {
    needsYou: "需处理",
    waiting: "等待",
    ok: "正常",
  },

  taskState: {
    pending: "待依赖",
    ready: "就绪",
    assigned: "已指派",
    in_progress: "进行中",
    review: "审查中",
    rework: "返工",
    done: "完成",
    failed: "失败",
    blocked: "阻塞",
    cancelled: "已取消",
  } as Record<string, string>,

  taskPhase: {
    implementation: "实现",
    review: "审查",
    smoke: "冒烟",
    "awaiting-rework": "待返工",
    frozen: "冻结待静止",
  } as Record<string, string>,
  frozenSuffix: "已冻结",

  blockedBy: {
    dependency: (task: string | null) => (task ? `等待依赖 ${task}` : "等待依赖"),
    lockHeld: (holder: string) => `被 ${holder} 持有的锁阻塞`,
    lockClaim: (claim: string) => `被锁阻塞（${claim}）`,
    lock: "被锁阻塞",
    decision: (category: string | null) => (category ? `等待决策 ${category}` : "等待决策"),
    permission: (agent: string | null) => (agent ? `等待权限回应（${agent}）` : "等待权限回应"),
    capacity: "并发名额已满",
    channel: (channel: string | null) => (channel ? `渠道暂不可用（${channel}）` : "渠道暂不可用"),
    seat: "缺少合格席位",
    other: "等待处理",
  },

  /** The three lines under a task, a decision and a history event. */
  explain: { why: "为什么在等", who: "谁来解除", next: "下一步" },

  sections: {
    dag: "任务依赖",
    tasks: "任务",
    locks: "锁与并发",
    budgets: "预算",
    decisions: "决策点",
    channels: "渠道与告警",
    history: "最近事件",
  },
  empty: {
    dag: "还没有任务图",
    tasks: "没有任务",
    locks: "当前没有任何锁",
    budgets: "没有预算记录",
    decisions: "没有决策点",
    channels: "没有渠道与告警记录",
    history: "还没有事件",
  },
  layerTitle: (layer: number) => `第 ${layer + 1} 层`,
  dependsOn: (deps: string) => `依赖：${deps}`,
  noDeps: "无依赖",
  anomalies: (count: number) => `有 ${count} 条依赖关系无法显示`,
  truncated: (shown: number, total: number) => `仅显示前 ${shown} 个任务（共 ${total} 个）`,

  taskRow: {
    expand: "展开",
    collapse: "收起",
    attempts: (n: number) => `尝试 ${n}`,
    rework: (n: number) => `返工 ${n}`,
    evidenceReturns: (n: number) => `证据退回 ${n}`,
    protocolFailures: (n: number) => `协议失败 ${n}`,
    qualityFailures: (total: number, layer: number) => `质量失败 ${total}（本层 ${layer}）`,
    tier: (execution: string, level: string) => `${level} · 当前层 ${execution}`,
    escalated: (from: string, to: string, attempt: number) =>
      `第 ${attempt} 次尝试后升层 ${from}→${to}`,
    noAssignee: "尚未指派",
    lastEvent: (label: string) => `最近事件：${label}`,
    reasonLabel: "原因",
  },

  locks: {
    kind: { file: "文件", directory: "目录", hot: "热点", tool: "工具" } as Record<string, string>,
    access: { read: "读", write: "写" } as Record<string, string>,
    frozen: "已冻结",
    holder: (task: string) => `持有：${task}`,
    waiters: (tasks: string) => `等待：${tasks}`,
    capacity: (inUse: number, configured: number, effective: number) =>
      `占用 ${inUse} / 配置 ${configured}（有效 ${effective}）`,
    over: "超出配置（含冻结任务的占用）",
  },

  budgets: {
    seat: "席位",
    group: "分组",
    reserved: (n: number) => `预扣 ${n}`,
    confirmed: (n: number) => `确认 ${n}`,
    observed: (n: number) => `观察回合 ${n}`,
    limit: (n: number) => `上限 ${n}`,
    ratio: (value: number | null) =>
      value === null ? "比例 n/a" : `比例 ${Math.round(value * 100)}%`,
    exhausted: "已用尽",
    na: "n/a",
  },

  decisions: {
    category: {
      D1: "D1 任务图/席位",
      D2: "D2 需求分歧",
      D3: "D3 S 层仍失败",
      D4: "D4 预算",
      D5: "D5 需人批准",
      D6: "D6 阶段结束",
      D7: "D7 引擎不一致",
    } as Record<string, string>,
    state: {
      open: "待回应",
      "waiting-human": "等待人工",
      answered: "已回应",
      superseded: "已失效",
    } as Record<string, string>,
    action: {
      replan: "重新规划",
      "assign-seat": "改派席位",
      "increase-budget": "追加预算",
      retry: "重试",
      cancel: "取消",
      "defer-channel": "暂缓渠道",
      "resume-seat": "恢复席位",
      reject: "驳回",
    } as Record<string, string>,
    subject: (label: string) => `对象：${label}`,
    chose: (action: string) => `已选择：${action}`,
  },

  channels: {
    state: { available: "可用", paused: "已暂停", unknown: "未知" } as Record<string, string>,
    until: (when: string) => `恢复下界 ${when}`,
    noUntil: "恢复下界未设置",
    code: (code: string) => `原因代码 ${code}`,
  },
  alerts: {
    severity: { critical: "严重", warning: "警告", info: "提示" } as Record<string, string>,
    state: { open: "未处理", acknowledged: "已知悉", resolved: "已解决" } as Record<string, string>,
  },

  needsYou: {
    decisions: (n: number) => `${n} 个决策点等待回应`,
    blockedTasks: (n: number) => `${n} 个任务阻塞或失败`,
    permissions: (n: number) => `${n} 个任务等待权限处理`,
    criticalAlerts: (n: number) => `${n} 条严重告警未处理`,
    pausedChannels: (n: number) => `${n} 个渠道暂停`,
    overCapacity: "并发占用超出配置",
    paused: "Run 已暂停",
    failure: "此 Run 暂时无法显示",
  },

  history: {
    loadOlder: "加载更早",
    noMore: "没有更早的事件",
    kind: {
      "dag-accepted": "任务图已接受",
      "dag-revised": "任务图已修订",
      "task-dispatched": "任务已派发",
      "turn-started": "回合开始",
      "turn-ended": "回合结束",
      "task-report": "任务报告",
      "review-report": "审查报告",
      "smoke-report": "冒烟报告",
      decision: "决策回应",
      "cancel-requested": "请求取消",
      "cancellation-checked": "取消静止检查",
      "run-paused": "Run 暂停",
      "run-resumed": "Run 恢复",
      "run-finished": "Run 结束",
      "run-cancelled": "Run 取消",
      "observation-recorded": "观察记录",
      run_created: "Run 创建",
      dag_accepted: "任务图已接受",
      task_assigned: "任务已指派",
      task_transition: "任务状态变化",
      turn_started: "回合开始",
      turn_ended: "回合结束",
    } as Record<string, string>,
  },

  list: {
    title: "Engine 运行",
    controlsHint:
      "展开一个运行后可以重新规划、重试停下的任务或催办；取消、暂停和批准还不能在这里做",
    observeOnly: "目前只读观察：不会派发或改动任务",
    open: "查看",
    close: "收起",
    needsAttention: "需关注",
    loadFailed: "读取 Engine 运行列表失败",
    health: {
      corrupt: "台账损坏，已保留原文件",
      "unknown-version": "由更新版本写入，已保留原文件",
      unavailable: "暂时无法读取",
      ok: "正常",
    } as Record<string, string>,
    healthRun: (id: string) => `运行 ${id}`,
    healthStore: "台账存储",
  },

  notices: {
    "history-cursor-expired": "历史翻页位置已失效，已回到最新一页",
    unknown: (code: string) => `服务端提示：${code}`,
  },

  failure: {
    missing: { title: "找不到这个 Run 的台账", body: "它可能已被清理，或属于不带台账的旧 Run。" },
    corrupt: {
      title: "这个 Run 的台账无法读取",
      body: "台账已被保护为只读，需要人工检查，插件不会自动修复。",
    },
    "unknown-version": {
      title: "此 Run 由更新版本写入",
      body: "请升级插件后再查看；在此之前它保持只读，不会被改动。",
    },
    "projection-invalid": {
      title: "此 Run 暂时无法显示（服务端错误）",
      body: "请刷新；如果持续出现，请上报。台账本身没有被判定为损坏。",
    },
    "refresh-plugin": {
      title: "请刷新插件",
      body: "收到了当前版本无法识别的数据，通常是插件版本不一致。",
    },
    unknownCode: (code: string) => `原因代码：${code}`,
  },
} as const;
