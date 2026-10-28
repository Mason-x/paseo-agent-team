// Baseline and future-shaped Preferences documents. The baseline file has no `allSeats`; the P1
// file adds the 04-arch-p1.md §4.1 block. Unknown top-level keys and unknown keys inside
// `economy`/`allSeats` are intentional round-trip probes (X6): a preferences write must keep them.
//
// Treat these objects as read-only; structuredClone before mutating a test copy.

const CREATED_AT = "2026-10-20T08:00:00.000Z";
const IMPORTED_AT = "2026-10-19T07:15:00.000Z";

export const PREFERENCES_WITHOUT_ALL_SEATS = {
  maxMembers: 24,
  archiveOnLaunchFailure: true,
  recentRuns: [
    {
      runId: "run-compat-1",
      teamId: "compat-mode-economy",
      teamName: "兼容：标准（旧经济）",
      workspaceId: "ws-compat-1",
      coordinatorAgentId: "agent-compat-coordinator",
      memberAgentIds: ["agent-compat-member-1", "agent-compat-member-2"],
      taskExcerpt: "按既有计划推进后台改版。",
      createdAt: CREATED_AT,
    },
  ],
  templatesImportedAt: IMPORTED_AT,
  economy: {
    // Order is meaningful: X6 asserts a write does not reorder the legacy pool.
    pool: [
      {
        profileId: "profile-deepseek-chat",
        nameSnapshot: "DeepSeek Chat",
        family: "deepseek",
        enabled: true,
        boundModel: { provider: "deepseek", model: "deepseek-chat" },
        futurePoolEntryField: { keep: "pool-deepseek" },
      },
      {
        profileId: "profile-grok-code",
        nameSnapshot: "Grok Code",
        family: "grok",
        enabled: true,
        boundModel: { provider: "grok", model: "grok-4.6" },
      },
      {
        profileId: "profile-sonnet",
        nameSnapshot: "Claude Sonnet",
        family: "claude-sonnet",
        enabled: true,
        boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
      },
    ],
    taskOrder: {
      coding: ["profile-deepseek-chat", "profile-grok-code"],
      ops: ["profile-grok-code", "profile-deepseek-chat"],
    },
    profileBudget: {
      "profile-deepseek-chat": "economy",
      "profile-grok-code": "economy",
      "profile-sonnet": "economy",
    },
    futureEconomyField: { keep: "legacy-economy" },
  },
  quotaRecovery: { mode: "manual", futureQuotaField: { keep: "quota" } },
  designerProfile: {
    profileId: "profile-designer-opus",
    nameSnapshot: "Designer Opus",
    hint: { name: "Designer Opus", provider: "claude", model: "opus" },
    futureProfileField: { keep: "designer-profile" },
  },
  defaultPresets: {
    catalogRevision: "rev-compat-1",
    seenRoleIds: ["architect", "developer"],
    lastSyncedAt: IMPORTED_AT,
  },
  futureTopLevelField: { keep: "preferences-top-level" },
};

/** No pool and no allSeats: the X3 blocker input, still carrying the unknown-field probes. */
export const PREFERENCES_BASELINE_EMPTY_POOL = {
  ...PREFERENCES_WITHOUT_ALL_SEATS,
  economy: {
    pool: [],
    taskOrder: {},
    profileBudget: {},
    futureEconomyField: { keep: "legacy-economy-empty-pool" },
  },
};

export const ALL_SEATS_POLICY_V1 = {
  version: 1,
  profiles: [
    {
      profileId: "profile-sonnet",
      nameSnapshot: "Claude Sonnet",
      enabled: true,
      costClass: "low",
      family: "claude-sonnet",
      boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
      futureAllSeatsProfileField: { keep: "all-seats-profile" },
    },
    {
      profileId: "profile-deepseek-chat",
      nameSnapshot: "DeepSeek Chat",
      enabled: true,
      costClass: "low",
      family: "deepseek",
      boundModel: { provider: "deepseek", model: "deepseek-chat" },
    },
    {
      profileId: "profile-grok-code",
      nameSnapshot: "Grok Code",
      enabled: true,
      costClass: "low",
      family: "grok",
      boundModel: { provider: "grok", model: "grok-4.6" },
    },
    {
      profileId: "profile-haiku-disabled",
      nameSnapshot: "Claude Haiku (disabled)",
      enabled: false,
      costClass: "low",
      family: "claude-haiku",
      boundModel: { provider: "claude", model: "claude-haiku-4-5" },
    },
  ],
  routes: {
    coordinator: ["profile-sonnet"],
    decision: ["profile-sonnet"],
    execution: ["profile-deepseek-chat", "profile-grok-code"],
    escalation: ["profile-sonnet"],
    retain: ["profile-sonnet"],
  },
  executionTaskOrder: {
    coding: ["profile-deepseek-chat", "profile-grok-code"],
    ops: ["profile-grok-code", "profile-deepseek-chat"],
  },
  futureAllSeatsField: { keep: "all-seats-block" },
};

/** Unknown allSeats version and an unknown route layer: normalize must report, not reset. */
export const ALL_SEATS_POLICY_FUTURE_VERSION = {
  ...ALL_SEATS_POLICY_V1,
  version: 99,
  routes: {
    ...ALL_SEATS_POLICY_V1.routes,
    review: ["profile-sonnet"],
  },
  futureAllSeatsField: { keep: "all-seats-block-future-version" },
};

export const PREFERENCES_WITH_ALL_SEATS = {
  ...PREFERENCES_WITHOUT_ALL_SEATS,
  economy: {
    ...PREFERENCES_WITHOUT_ALL_SEATS.economy,
    allSeats: ALL_SEATS_POLICY_V1,
  },
};

export const PREFERENCES_ALL_SEATS_FUTURE_VERSION = {
  ...PREFERENCES_WITH_ALL_SEATS,
  economy: {
    ...PREFERENCES_WITH_ALL_SEATS.economy,
    allSeats: ALL_SEATS_POLICY_FUTURE_VERSION,
  },
};
