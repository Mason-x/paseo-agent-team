// Fixed schemaVersion=1 ledger records, exactly as the baseline store wrote them. No P1 fields
// (`existingRolesOnly`, `requestHashVersion`, `outputContractVersion`, `roleGap`) appear here:
// the new reader must synthesize their defaults in memory without rewriting these bytes.
//
// File name on disk is `<job.jobId>.json` under `agent-team-designer/v1/jobs/`.
// Treat these objects as read-only; structuredClone before mutating a test copy.

const CREATED_AT = "2026-10-20T08:00:00.000Z";
const UPDATED_AT = "2026-10-20T08:05:00.000Z";
const FINISHED_AT = "2026-10-20T08:20:00.000Z";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NONCE_1 = "1".repeat(32);
const NONCE_2 = "2".repeat(32);
const NONCE_3 = "3".repeat(32);
const NONCE_4 = "4".repeat(32);
const NONCE_5 = "5".repeat(32);

const JOB_STARTING = "aaaaaaaa-0001-4000-8000-000000000001";
const JOB_DESIGNING = "aaaaaaaa-0002-4000-8000-000000000002";
const JOB_VALIDATING = "aaaaaaaa-0003-4000-8000-000000000003";
const JOB_READY = "aaaaaaaa-0004-4000-8000-000000000004";
const JOB_FAILED = "aaaaaaaa-0005-4000-8000-000000000005";

const REQUEST_STARTING = "bbbbbbbb-0001-4000-8000-000000000001";
const REQUEST_DESIGNING = "bbbbbbbb-0002-4000-8000-000000000002";
const REQUEST_VALIDATING = "bbbbbbbb-0003-4000-8000-000000000003";
const REQUEST_READY = "bbbbbbbb-0004-4000-8000-000000000004";
const REQUEST_FAILED = "bbbbbbbb-0005-4000-8000-000000000005";

const REVISION_STARTING = "cccccccc-0001-4000-8000-000000000001";
const REVISION_DESIGNING = "cccccccc-0002-4000-8000-000000000002";
const REVISION_VALIDATING = "cccccccc-0003-4000-8000-000000000003";
const REVISION_READY = "cccccccc-0004-4000-8000-000000000004";
const REVISION_FAILED = "cccccccc-0005-4000-8000-000000000005";

const MESSAGE_1 = "dddddddd-0001-4000-8000-000000000001";
const MESSAGE_2 = "dddddddd-0002-4000-8000-000000000002";
const MESSAGE_3 = "dddddddd-0003-4000-8000-000000000003";
const MESSAGE_4 = "dddddddd-0004-4000-8000-000000000004";
const MESSAGE_5 = "dddddddd-0005-4000-8000-000000000005";

const REQUEST = "为现有的后台改版需求设计一个复用现有 Role 的 Team。";
const CARRIER_WORKSPACE = "ws-compat-carrier";

const BASE_JOB = {
  state: "starting",
  attempt: 0,
  mode: "sota",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  finishedAt: null,
  requestExcerpt: "为现有的后台改版需求设计一个 Team。",
  agentCreated: false,
  carrierWorkspaceId: null,
  targetWorkspaceId: null,
  designerProfile: null,
  agentStatus: null,
  requiresAttention: false,
  attentionReason: null,
  pendingPermissions: [],
  permissionsTruncated: false,
  resultId: null,
  savedTeamId: null,
  saveState: "none",
  cancelRequested: false,
  needsCleanup: false,
  issues: [],
  issuesTruncated: 0,
  recovered: false,
  saveLeaseExpiresAt: null,
  allowed: { cancel: true, save: false, launch: false, continueAction: null },
};

const BASE_RECORD = {
  schemaVersion: 1,
  selectionIntent: null,
  creation: null,
  proposal: null,
  result: null,
  reuseFingerprints: {},
  leaseOwner: null,
  outcomeUnknown: false,
};

/** crash before the first message: no attempts, no creation intent. */
export const DESIGN_V1_RECORD_STARTING = {
  ...BASE_RECORD,
  job: {
    ...BASE_JOB,
    jobId: JOB_STARTING,
    clientRequestId: REQUEST_STARTING,
    stateRevision: REVISION_STARTING,
    state: "starting",
    attempt: 0,
    mode: "sota",
    agentId: JOB_STARTING,
  },
  request: REQUEST,
  requestHash: HASH_A,
  mode: "sota",
  attempts: [],
  receipts: {},
};

/** Baseline economy task in flight, including a persisted create request (recovery/labels). */
export const DESIGN_V1_RECORD_DESIGNING = {
  ...BASE_RECORD,
  job: {
    ...BASE_JOB,
    jobId: JOB_DESIGNING,
    clientRequestId: REQUEST_DESIGNING,
    stateRevision: REVISION_DESIGNING,
    state: "designing",
    attempt: 1,
    mode: "economy",
    agentId: JOB_DESIGNING,
    agentCreated: true,
    carrierWorkspaceId: CARRIER_WORKSPACE,
    agentStatus: "running",
  },
  request: REQUEST,
  requestHash: HASH_B,
  mode: "economy",
  creation: {
    intentHash: HASH_C,
    idempotencyKey: "design-create-compat-0002",
    request: {
      agentId: JOB_DESIGNING,
      idempotencyKey: "design-create-compat-0002",
      workspaceId: CARRIER_WORKSPACE,
      title: "设计：后台改版 Team",
      labels: {
        "agent-team.design": JOB_DESIGNING,
        "agent-team.design.version": "1",
        "agent-team.design.request-id": REQUEST_DESIGNING,
        "agent-team.design.request-hash": HASH_B,
        "agent-team.design.mode": "economy",
        "agent-team.design.request": "后台改版设计",
      },
      profile: {
        provider: "claude",
        model: "opus",
        modeId: "high",
        thinkingOptionId: "high",
        featureValues: { fast: false },
      },
      systemPrompt: "你是团队设计师，只输出合同要求的 JSON。",
      prompt: "请为后台改版设计一个 Team。",
      clientMessageId: REQUEST_DESIGNING,
    },
  },
  attempts: [
    {
      attempt: 1,
      nonce: NONCE_2,
      messageId: MESSAGE_2,
      promptHash: HASH_B,
      epoch: "epoch-compat-2",
      endCursor: null,
      summary: null,
      ack: "pending",
    },
  ],
  receipts: { [REQUEST_DESIGNING]: JOB_DESIGNING },
};

/** A complete v1 proposal under the old economy semantics (coordinator keeps its binding). */
export const DESIGN_V1_RECORD_VALIDATING = {
  ...BASE_RECORD,
  job: {
    ...BASE_JOB,
    jobId: JOB_VALIDATING,
    clientRequestId: REQUEST_VALIDATING,
    stateRevision: REVISION_VALIDATING,
    state: "validating",
    attempt: 1,
    mode: "economy",
    agentId: JOB_VALIDATING,
    agentCreated: true,
    carrierWorkspaceId: CARRIER_WORKSPACE,
    agentStatus: "idle",
  },
  request: REQUEST,
  requestHash: HASH_C,
  mode: "economy",
  attempts: [
    {
      attempt: 1,
      nonce: NONCE_3,
      messageId: MESSAGE_3,
      promptHash: HASH_C,
      epoch: "epoch-compat-3",
      endCursor: null,
      summary: "已产出复用现有 Role 的方案。",
      ack: "acked",
      turnId: "turn-compat-3",
    },
  ],
  proposal: {
    version: 1,
    jobId: JOB_VALIDATING,
    attempt: 1,
    nonce: NONCE_3,
    summary: "复用技术负责人、架构与实现三个现有 Role，执行层走经济池。",
    team: {
      id: "compat-mode-economy",
      name: "兼容：标准（旧经济）",
      description: "复用现有 Role 的后台改版 Team。",
      mode: "economy",
      coordinatorRoleId: "tech-lead",
      members: [
        { key: "m1", roleId: "architect", instanceLabel: "架构" },
        { key: "m2", roleId: "developer", instanceLabel: "实现" },
      ],
      operatingRules: "实现与审查由不同成员承担。",
    },
    reuse: [
      { roleId: "tech-lead", reason: "负责拆解、协调与最终验收。" },
      { roleId: "architect", reason: "负责结构与模块边界。" },
      { roleId: "developer", reason: "负责实现与自测。" },
    ],
    newRoles: [],
    profileChoices: [
      {
        target: "coordinator",
        profileIds: ["profile-claude-opus-high"],
        reason: "标准模式协调者保留原绑定。",
      },
      {
        target: "m1",
        profileIds: ["profile-deepseek-chat"],
        reason: "执行层使用经济池中的 DeepSeek。",
      },
      {
        target: "m2",
        profileIds: ["profile-grok-code"],
        reason: "执行层按任务顺序使用经济池中的 Grok。",
      },
    ],
  },
  receipts: { [REQUEST_VALIDATING]: JOB_VALIDATING },
};

/** Ready-to-save v1 task with a complete result; mark-saved/reopen probe. */
export const DESIGN_V1_RECORD_READY = {
  ...BASE_RECORD,
  job: {
    ...BASE_JOB,
    jobId: JOB_READY,
    clientRequestId: REQUEST_READY,
    stateRevision: REVISION_READY,
    state: "ready",
    attempt: 1,
    mode: "economy",
    agentId: JOB_READY,
    agentCreated: true,
    carrierWorkspaceId: CARRIER_WORKSPACE,
    agentStatus: "idle",
    requiresAttention: true,
    attentionReason: "finished",
    resultId: HASH_A,
    allowed: { cancel: true, save: true, launch: false, continueAction: null },
  },
  request: REQUEST,
  requestHash: HASH_A,
  mode: "economy",
  attempts: [
    {
      attempt: 1,
      nonce: NONCE_4,
      messageId: MESSAGE_4,
      promptHash: HASH_A,
      epoch: "epoch-compat-4",
      endCursor: null,
      summary: "方案校验通过。",
      ack: "acked",
      turnId: "turn-compat-4",
    },
  ],
  result: {
    version: 1,
    jobId: JOB_READY,
    resultId: HASH_A,
    attempt: 1,
    materializedAt: UPDATED_AT,
    request: REQUEST,
    mode: "economy",
    summary: "复用现有 Role 的后台改版 Team。",
    carrierWorkspaceId: CARRIER_WORKSPACE,
    targetWorkspaceId: null,
    team: {
      id: "compat-mode-economy",
      name: "兼容：标准（旧经济）",
      description: "复用现有 Role 的后台改版 Team。",
      mode: "economy",
      coordinatorRoleId: "tech-lead",
      members: [
        {
          roleId: "architect",
          instanceLabel: "架构",
          seatId: "seat-architect",
          enabled: true,
        },
        {
          roleId: "developer",
          instanceLabel: "实现",
          seatId: "seat-developer",
          enabled: true,
        },
      ],
      operatingRules: "实现与审查由不同成员承担。",
      enabled: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      memberCreation: "eager",
      futureTeamField: { keep: "result-team" },
    },
    newRoles: [],
    reuse: [
      { roleId: "tech-lead", behaviorHash: HASH_A, reason: "负责拆解、协调与最终验收。" },
      { roleId: "architect", behaviorHash: HASH_B, reason: "负责结构与模块边界。" },
      { roleId: "developer", behaviorHash: HASH_C, reason: "负责实现与自测。" },
    ],
    memberReasons: [
      {
        target: "m1",
        logicalSeatId: "logical-architect",
        reason: "结构设计需要代码理解。",
        expectedProfileIds: ["profile-deepseek-chat"],
      },
      {
        target: "m2",
        logicalSeatId: "logical-developer",
        reason: "实现需要稳定执行。",
        expectedProfileIds: ["profile-grok-code"],
      },
    ],
    preview: {
      requestedMode: "economy",
      coordinator: {
        roleId: "tech-lead",
        roleName: "Tech Lead",
        profile: {
          id: "profile-claude-opus-high",
          name: "Claude Opus High",
          provider: "claude",
          model: "opus",
        },
        source: "role-preferred",
        budget: "sota",
        budgetBasis: "host",
        issues: [],
      },
      seats: [
        {
          seatId: "seat-architect",
          logicalSeatId: "logical-architect",
          roleId: "architect",
          roleName: "架构",
          instanceLabel: "架构",
          purpose: "member",
          activation: "eager",
          profile: {
            id: "profile-deepseek-chat",
            name: "DeepSeek Chat",
            provider: "deepseek",
            model: "deepseek-chat",
          },
          source: "economy-pool",
          family: "deepseek",
          alternates: ["profile-grok-code"],
          budget: "economy",
          budgetBasis: "pool",
          standby: false,
          unavailable: false,
          issues: [],
        },
        {
          seatId: "seat-developer",
          logicalSeatId: "logical-developer",
          roleId: "developer",
          roleName: "实现",
          instanceLabel: "实现",
          purpose: "member",
          activation: "eager",
          profile: {
            id: "profile-grok-code",
            name: "Grok Code",
            provider: "grok",
            model: "grok-4.6",
          },
          source: "economy-pool",
          family: "grok",
          alternates: ["profile-deepseek-chat"],
          budget: "economy",
          budgetBasis: "pool",
          standby: false,
          unavailable: false,
          issues: [],
        },
      ],
      counts: {
        logical: 2,
        physical: 2,
        eager: 2,
        deferred: 0,
        escalation: 0,
        sotaPotential: 0,
      },
      budget: { economy: 2, sota: 0, unknown: 0, deferredSota: 0 },
      issues: [],
      warnings: [],
      planHash: HASH_B,
    },
    planningFingerprint: HASH_C,
    warnings: [],
  },
  receipts: { [REQUEST_READY]: JOB_READY },
};

/** Old terminal failure: must stay readable and terminal after upgrade. */
export const DESIGN_V1_RECORD_FAILED = {
  ...BASE_RECORD,
  job: {
    ...BASE_JOB,
    jobId: JOB_FAILED,
    clientRequestId: REQUEST_FAILED,
    stateRevision: REVISION_FAILED,
    state: "failed",
    attempt: 3,
    mode: "sota",
    agentId: JOB_FAILED,
    agentCreated: true,
    carrierWorkspaceId: CARRIER_WORKSPACE,
    agentStatus: "error",
    requiresAttention: true,
    attentionReason: "error",
    finishedAt: FINISHED_AT,
    issues: [
      {
        code: "DESIGN_OUTPUT_SCHEMA",
        severity: "error",
        path: [],
        params: { attempt: 3 },
        action: "refresh",
      },
    ],
    allowed: { cancel: false, save: false, launch: false, continueAction: null },
  },
  request: REQUEST,
  requestHash: HASH_B,
  mode: "sota",
  attempts: [
    {
      attempt: 1,
      nonce: NONCE_5,
      messageId: MESSAGE_5,
      promptHash: HASH_B,
      epoch: "epoch-compat-5",
      endCursor: null,
      summary: null,
      ack: "acked",
      turnId: "turn-compat-5",
    },
    {
      attempt: 2,
      nonce: NONCE_1,
      messageId: MESSAGE_1,
      promptHash: HASH_C,
      epoch: "epoch-compat-5",
      endCursor: null,
      summary: null,
      ack: "acked",
      turnId: "turn-compat-5b",
    },
    {
      attempt: 3,
      nonce: NONCE_2,
      messageId: MESSAGE_2,
      promptHash: HASH_A,
      epoch: "epoch-compat-5",
      endCursor: null,
      summary: null,
      ack: "acked",
      turnId: "turn-compat-5c",
    },
  ],
  receipts: { [REQUEST_FAILED]: JOB_FAILED },
};

export const DESIGN_V1_RECORDS = [
  DESIGN_V1_RECORD_STARTING,
  DESIGN_V1_RECORD_DESIGNING,
  DESIGN_V1_RECORD_VALIDATING,
  DESIGN_V1_RECORD_READY,
  DESIGN_V1_RECORD_FAILED,
];
