// Shared builders for the offline Run Engine fixtures. Data only: no IO, no product imports.
// The normal ledger is deliberately invariant-clean (I1–I8) so tests can copy it and break one
// rule at a time (see invariants.ts) instead of hand-writing a whole record per case.
import type {
  AssignmentFixture,
  IntentFixture,
  LedgerFixture,
  PolicyFixture,
  QuiescenceFixture,
  ResourceClaimFixture,
  ReviewFixture,
  TaskAttemptFixture,
  TaskFixture,
} from "./types";

export const REPO_ID = "repo-re-verify";
export const RUN_ID = "run-rec0re-a1";
export const AT_CREATED = "2026-10-27T12:00:00.000Z";
export const AT_UPDATED = "2026-10-27T12:34:56.000Z";

export const NONCE_T1 = "6f1c2a44-3b7e-4f0a-9a11-000000000001";
export const NONCE_T2 = "6f1c2a44-3b7e-4f0a-9a11-000000000002";
export const NONCE_REVIEW_T1 = "6f1c2a44-3b7e-4f0a-9a11-000000000003";
export const NONCE_T3 = "6f1c2a44-3b7e-4f0a-9a11-000000000004";
export const NONCE_CANCEL_T2 = "6f1c2a44-3b7e-4f0a-9a11-000000000005";
export const NONCE_PROBE = "6f1c2a44-3b7e-4f0a-9a11-000000000006";

export const PROFILE_HAIKU = {
  id: "profile-dev-haiku",
  name: "DEV Haiku 5.5",
  provider: "claude",
  model: "claude-haiku-5-5",
  family: "haiku",
  channelId: "claude",
} as const;

export const PROFILE_LUNA = {
  id: "profile-dev-luna",
  name: "DEV GPT-6-Luna",
  provider: "codex",
  model: "gpt-6-luna",
  family: "luna",
  channelId: "codex",
} as const;

export const POLICY: PolicyFixture = {
  policyVersion: 1,
  concurrency: { configuredLimit: 4, effectiveLimit: 4 },
  perTask: { protocolResends: 2, evidenceReturns: 3, reworkPerLevel: 2, totalAttempts: 6 },
  runLimits: { failedTasks: 3, strategicTurns: 12 },
  seatBudgets: { "seat-s1": 12, "seat-b1": 6, "seat-b2": 6 },
  disabledProfiles: [],
  disabledChannels: [],
  capabilityRulesVersion: "2026-10-27",
  archiveResumePolicy: "report-first",
  devTargets: [{ serverId: "dev-server-1", address: "127.0.0.1:6799" }],
  evidenceRoots: ["evidence/"],
  limits: {
    maxTasks: 64,
    softBytes: 7 * 1024 * 1024,
    maxBytes: 8 * 1024 * 1024,
    scanBytes: 256 * 1024,
    timelinePageBytes: 512 * 1024,
    timelineMaxPages: 20,
  },
};

export function task(
  overrides: Partial<TaskFixture> & Pick<TaskFixture, "id" | "title">,
): TaskFixture {
  const path = `src/${overrides.id.toLowerCase()}.ts`;
  return {
    goal: `Deliver ${overrides.id} within the declared scope.`,
    group: "core",
    deps: [],
    level: "L2",
    tier: "B",
    execution: "write",
    scopes: [{ repoId: REPO_ID, kind: "file", path, access: "write" }],
    acceptance: ["AC-1"],
    evidence: [
      {
        id: "five-gates",
        command: "npm run check && npm run typecheck && npm test",
        artifactKind: "command-output",
        requiresIsolatedHome: true,
      },
    ],
    devSmoke: false,
    smokeChecklist: [],
    irreversible: null,
    reviewPolicy: "required",
    implementationPolicy: "default",
    architectureTaskId: null,
    status: "pending",
    ref: null,
    workspace: null,
    attempts: [],
    phase: "planned",
    waitingReason: null,
    protocolFailures: 0,
    evidenceReturns: 0,
    reworkCount: 0,
    reviews: [],
    ...overrides,
  };
}

export function attempt(
  overrides: Partial<TaskAttemptFixture> & Pick<TaskAttemptFixture, "attempt" | "nonce">,
): TaskAttemptFixture {
  return {
    seatId: "seat-b1",
    agentId: "agent-b1",
    status: "in_progress",
    ...overrides,
  };
}

export function review(overrides: Partial<ReviewFixture> = {}): ReviewFixture {
  return {
    reviewerAgentId: "agent-b2",
    reviewerSeatId: "seat-b2",
    verdict: "可合入",
    reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
    blockers: [],
    ...overrides,
  };
}

export const QUIESCENT: QuiescenceFixture = {
  turnEnded: true,
  refreshState: "idle",
  cancelReceipt: "confirmed",
  quiescent: true,
};

export const NOT_QUIESCENT: QuiescenceFixture = {
  turnEnded: true,
  refreshState: "idle",
  cancelReceipt: "unconfirmed",
  quiescent: false,
};

export function assignment(
  overrides: Partial<AssignmentFixture> & Pick<AssignmentFixture, "attempt" | "nonce">,
): AssignmentFixture {
  return {
    seatId: "seat-b1",
    agentId: "agent-b1",
    purpose: "implement",
    tier: "B",
    profile: { ...PROFILE_HAIKU },
    reason: "L2/B: lowest load, last quality pass",
    workspace: {
      id: "ws-run-rec0re-a1-t2",
      branch: "re-rec0rea1-t2-a1-1",
      baseRef: "main",
    },
    messageId: `msg-t2-a${overrides.attempt}`,
    turnId: null,
    revoked: false,
    quiescence: { ...QUIESCENT },
    ...overrides,
  };
}

export function intent(
  overrides: Partial<IntentFixture> & Pick<IntentFixture, "id" | "messageId">,
): IntentFixture {
  return {
    kind: "send-task",
    recipient: "agent-b1",
    payloadHash: `sha256:${"a".repeat(64)}`,
    templateVersion: 1,
    semanticArgs: { taskId: "T2", attempt: 1, phase: "implement" },
    state: "confirmed",
    recoverySendCount: 0,
    createdAt: AT_CREATED,
    ...overrides,
  };
}

export function claim(
  overrides: Partial<ResourceClaimFixture> & Pick<ResourceClaimFixture, "id" | "taskId">,
): ResourceClaimFixture {
  return {
    repoId: REPO_ID,
    kind: "file",
    path: "src/core.ts",
    access: "write",
    state: "held",
    frozen: false,
    ...overrides,
  };
}

export const T1 = task({
  id: "T1",
  title: "Core API surface",
  goal: "Implement the core API surface and prove the five gates.",
  status: "done",
  phase: "done",
  ref: { kind: "git-commit", value: "9f3c1a7" },
  workspace: { id: "ws-run-rec0re-a1-t1", branch: "re-rec0rea1-t1-a1-1", baseRef: "main" },
  attempts: [attempt({ attempt: 1, nonce: NONCE_T1, status: "done" })],
  reviews: [review()],
});

export const T2 = task({
  id: "T2",
  title: "Core implementation",
  goal: "Implement the shared core path used by the DAG.",
  tier: "B",
  status: "in_progress",
  phase: "implement",
  workspace: { id: "ws-run-rec0re-a1-t2", branch: "re-rec0rea1-t2-a1-1", baseRef: "main" },
  attempts: [attempt({ attempt: 1, nonce: NONCE_T2 })],
});

export const T3 = task({
  id: "T3",
  title: "Operator docs",
  goal: "Document the operator workflow once T2 lands.",
  group: "docs",
  deps: ["T2"],
  status: "pending",
  phase: "planned",
  scopes: [{ repoId: REPO_ID, kind: "directory", path: "docs/run-engine", access: "write" }],
});

export const NORMAL_RUN_LEDGER: LedgerFixture = {
  schemaVersion: 1,
  runId: RUN_ID,
  revision: 7,
  previousDigest: `sha256:${"1".repeat(64)}`,
  createdAt: AT_CREATED,
  updatedAt: AT_UPDATED,
  hostBinding: { serverId: "srv-dev-1" },
  launch: {
    requestId: "req-rec0re-a1",
    requestHash: `sha256:${"2".repeat(64)}`,
    planHash: `sha256:${"3".repeat(64)}`,
    state: "started",
  },
  team: {
    id: "team-re-verify",
    name: "RE Verify Team",
    rawMode: "economy-all",
    modeContract: 2,
    plannerVersion: 2,
    modelPlanHash: `sha256:${"4".repeat(64)}`,
  },
  lifecycle: "active",
  policy: POLICY,
  roster: [
    {
      seatId: "seat-s1",
      tier: "S",
      roleId: "lead-orchestrator",
      agentId: "agent-s1",
      state: "idle",
    },
    {
      seatId: "seat-b1",
      tier: "B",
      roleId: "eng-fullstack",
      agentId: "agent-b1",
      state: "running",
    },
    { seatId: "seat-b2", tier: "B", roleId: "qa-review", agentId: "agent-b2", state: "idle" },
  ],
  dagRevision: 1,
  tasks: [T1, T2, T3],
  resources: [claim({ id: "lock-t2", taskId: "T2", path: "src/t2.ts" })],
  assignments: [
    assignment({
      attempt: 1,
      nonce: NONCE_T2,
      turnId: "turn-7",
      messageId: "msg-t2-a1",
    }),
  ],
  outbox: [
    intent({ id: "intent-t1-a1", messageId: "msg-t1-a1", confirmedAt: AT_CREATED }),
    intent({ id: "intent-t2-a1", messageId: "msg-t2-a1", confirmedAt: AT_CREATED }),
  ],
  nonceRegistry: [
    {
      nonce: NONCE_T1,
      runId: RUN_ID,
      taskId: "T1",
      attempt: 1,
      phase: "implement",
      agentId: "agent-b1",
      seatId: "seat-b1",
      consumedAt: AT_CREATED,
    },
    {
      nonce: NONCE_T2,
      runId: RUN_ID,
      taskId: "T2",
      attempt: 1,
      phase: "implement",
      agentId: "agent-b1",
      seatId: "seat-b1",
      consumedAt: AT_UPDATED,
    },
  ],
  eventReceipts: [
    {
      key: "agent-b1|turn-7|turn_ended",
      agentId: "agent-b1",
      turnId: "turn-7",
      kind: "turn_ended",
      outcome: "completed",
      seenAt: AT_UPDATED,
      digest: `sha256:${"5".repeat(64)}`,
    },
  ],
  events: [
    { seq: 1, id: "evt-1", kind: "run_created", at: AT_CREATED },
    { seq: 2, id: "evt-2", kind: "dag_accepted", at: AT_CREATED, dagRevision: 1 },
    { seq: 3, id: "evt-3", kind: "task_assigned", at: AT_CREATED, taskId: "T1" },
    { seq: 4, id: "evt-4", kind: "task_transition", at: AT_CREATED, taskId: "T1" },
    { seq: 5, id: "evt-5", kind: "task_assigned", at: AT_UPDATED, taskId: "T2" },
    { seq: 6, id: "evt-6", kind: "turn_started", at: AT_UPDATED, taskId: "T2", turnId: "turn-7" },
    { seq: 7, id: "evt-7", kind: "turn_ended", at: AT_UPDATED, taskId: "T2", turnId: "turn-7" },
  ],
  budgets: {
    strategic: { seatId: "seat-s1", limit: 12, reserved: 2, confirmed: 1 },
    seats: [
      { seatId: "seat-b1", limit: 6, reserved: 1, confirmed: 1, observedTurns: 1, partial: false },
      { seatId: "seat-b2", limit: 6, reserved: 0, confirmed: 0, observedTurns: 0, partial: true },
    ],
  },
  decisions: [],
  approvals: [],
  channels: [
    {
      channelId: "claude",
      provider: "claude",
      state: "available",
      pausedReason: null,
      unavailableUntil: null,
    },
    {
      channelId: "codex",
      provider: "codex",
      state: "available",
      pausedReason: null,
      unavailableUntil: null,
    },
  ],
  alerts: [],
  metrics: { tasks: { total: 3, done: 1, inFlight: 1 }, strategicTurns: 1, intentCount: 2 },
};

/** Copy the normal ledger with top-level overrides; nested arrays are replaced, not merged. */
export function withLedger(overrides: Partial<LedgerFixture>): LedgerFixture {
  return { ...NORMAL_RUN_LEDGER, ...overrides };
}
