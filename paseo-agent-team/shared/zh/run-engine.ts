/**
 * Chinese copy for the Runs page Engine view (RE-R07). `shared/zh.ts` is a hot file owned by W01;
 * until it merges this table, the view imports it directly. Keys are the frozen wire values
 * (task states, phases, failure codes, event kinds), never display strings.
 */
export const runEngineZh = {
  title: "Run 引擎",
  refresh: "刷新",
  loading: "正在读取 Run 台账…",
  readOnly: "只读观察模式：此处不提供任何写入操作",

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
    workspaceDirty: "Workspace 的工作树不干净，Run 引擎只能在干净的分支上开始；请先提交或清理",
    workspaceNoCommit: "Workspace 还没有任何提交，Run 引擎需要一个基准提交",
  },

  lifecycle: {
    bootstrapping: "启动中",
    "awaiting-dag": "等待任务图",
    active: "运行中",
    paused: "已暂停",
    finished: "已结束",
    cancelled: "已取消",
  } as Record<string, string>,

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
