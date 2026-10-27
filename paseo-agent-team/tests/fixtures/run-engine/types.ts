// Fixture-scoped shapes for the Run Engine verification samples. These mirror 05-arch-run-engine
// §2/§3 as *input data* only: no product module is imported, so the fixtures stay valid while
// R01/R05 are still being implemented. Unknown/extra keys are allowed on purpose (the storage
// contract keeps them), and the top-level object is a plain JSON value.
export type TaskStatus =
  | "pending"
  | "ready"
  | "assigned"
  | "in_progress"
  | "review"
  | "rework"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled";
export type TaskLevel = "L1" | "L2" | "L3" | "L4";
export type SeatTier = "B" | "A" | "S";
export type AccessMode = "read" | "write";

export type ScopeFixture = {
  repoId: string;
  kind: "file" | "directory";
  path: string;
  access: AccessMode;
};

export type EvidenceRequirementFixture = {
  id: string;
  command: string | null;
  artifactKind: string;
  minLines?: number;
  minFunctions?: number;
  requiresIsolatedHome: boolean;
};

export type ArtifactRefFixture =
  | { kind: "git-commit"; value: string }
  | { kind: "diff-sha256"; value: string; baseCommit: string; patchPath: string };

export type TaskAttemptFixture = {
  attempt: number;
  seatId: string;
  agentId: string;
  nonce: string;
  status: "assigned" | "in_progress" | "superseded" | "done" | "failed";
};

export type ReviewFixture = {
  reviewerAgentId: string;
  reviewerSeatId: string;
  verdict: "可合入" | "修改后合入" | "不可合入";
  reviewedRef: ArtifactRefFixture;
  blockers: { id: string; summary: string; path: string | null }[];
};

export type TaskFixture = {
  id: string;
  title: string;
  goal: string;
  group: string;
  deps: string[];
  level: TaskLevel;
  tier: SeatTier;
  execution: AccessMode;
  scopes: ScopeFixture[];
  acceptance: string[];
  evidence: EvidenceRequirementFixture[];
  devSmoke: boolean;
  smokeChecklist: string[];
  irreversible: { reason: string; approvalId: string | null } | null;
  reviewPolicy: "required";
  implementationPolicy: "default" | "a-with-s-plan";
  architectureTaskId: string | null;
  status: TaskStatus;
  ref: ArtifactRefFixture | null;
  workspace: { id: string; branch: string; baseRef: string } | null;
  attempts: TaskAttemptFixture[];
  phase: string;
  waitingReason: string | null;
  protocolFailures: number;
  evidenceReturns: number;
  reworkCount: number;
  reviews: ReviewFixture[];
  [key: string]: unknown;
};

export type QuiescenceFixture = {
  turnEnded: boolean;
  refreshState: "idle" | "running" | "closed" | "missing";
  cancelReceipt: "confirmed" | "unconfirmed" | "not-sent";
  quiescent: boolean;
};

export type AssignmentFixture = {
  seatId: string;
  agentId: string;
  purpose: "implement" | "review" | "smoke";
  tier: SeatTier;
  profile: {
    id: string;
    name: string;
    provider: string;
    model: string;
    family: string;
    channelId: string;
  };
  reason: string;
  workspace: { id: string; branch: string; baseRef: string };
  attempt: number;
  nonce: string;
  messageId: string;
  turnId: string | null;
  revoked: boolean;
  quiescence: QuiescenceFixture;
  [key: string]: unknown;
};

export type OutboxState = "prepared" | "sending" | "confirmed" | "outcome-unknown" | "failed";

export type IntentFixture = {
  id: string;
  kind:
    | "send-task"
    | "send-review"
    | "send-smoke"
    | "wake-strategic"
    | "probe-channel"
    | "cancel-task"
    | "reopen-session";
  recipient: string;
  messageId: string;
  payloadHash: string;
  templateVersion: number;
  semanticArgs: Record<string, string | number | boolean>;
  state: OutboxState;
  recoverySendCount: number;
  createdAt: string;
  confirmedAt?: string;
  [key: string]: unknown;
};

export type ResourceClaimFixture = {
  id: string;
  repoId: string;
  kind: "file" | "directory" | "channel" | "workspace" | "npm";
  path: string | null;
  taskId: string | null;
  access: AccessMode | "exclusive";
  state: "held" | "requested" | "frozen";
  frozen: boolean;
  [key: string]: unknown;
};

export type NonceFixture = {
  nonce: string;
  runId: string;
  taskId: string;
  attempt: number;
  phase: string;
  agentId: string;
  seatId: string;
  consumedAt: string;
};

export type EventReceiptFixture = {
  key: string;
  agentId: string;
  turnId: string | null;
  kind: "turn_started" | "turn_ended";
  outcome?: "completed" | "failed" | "cancelled";
  seenAt: string;
  digest: string;
};

export type RunEventFixture = {
  seq: number;
  id: string;
  kind: string;
  at: string;
  taskId?: string;
  [key: string]: unknown;
};

export type DecisionFixture = {
  id: string;
  kind: "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";
  state: "open" | "answered";
  reason: string;
  createdAt: string;
  answeredAt?: string;
  [key: string]: unknown;
};

export type ChannelFixture = {
  channelId: string;
  provider: string;
  state: "available" | "paused";
  pausedReason: string | null;
  unavailableUntil: string | null;
  [key: string]: unknown;
};

export type PolicyFixture = {
  policyVersion: number;
  concurrency: { configuredLimit: number; effectiveLimit: number };
  perTask: {
    protocolResends: number;
    evidenceReturns: number;
    reworkPerLevel: number;
    totalAttempts: number;
  };
  runLimits: { failedTasks: number; strategicTurns: number };
  seatBudgets: Record<string, number>;
  disabledProfiles: string[];
  disabledChannels: string[];
  capabilityRulesVersion: string;
  archiveResumePolicy: string;
  devTargets: { serverId: string; address: string }[];
  evidenceRoots: string[];
  limits: {
    maxTasks: number;
    softBytes: number;
    maxBytes: number;
    scanBytes: number;
    timelinePageBytes: number;
    timelineMaxPages: number;
  };
  [key: string]: unknown;
};

export type LedgerFixture = {
  schemaVersion: number;
  runId: string;
  revision: number;
  previousDigest: string;
  createdAt: string;
  updatedAt: string;
  hostBinding: { serverId: string };
  launch: { requestId: string; requestHash: string; planHash: string; state: string };
  team: {
    id: string;
    name: string;
    rawMode: string;
    modeContract: number;
    plannerVersion: number;
    modelPlanHash: string;
  };
  lifecycle: "bootstrapping" | "awaiting-dag" | "active" | "paused" | "finished" | "cancelled";
  policy: PolicyFixture;
  roster: {
    seatId: string;
    tier: SeatTier;
    roleId: string;
    agentId: string | null;
    state: "idle" | "running" | "closed" | "archived";
  }[];
  dagRevision: number;
  tasks: TaskFixture[];
  resources: ResourceClaimFixture[];
  assignments: AssignmentFixture[];
  outbox: IntentFixture[];
  nonceRegistry: NonceFixture[];
  eventReceipts: EventReceiptFixture[];
  events: RunEventFixture[];
  budgets: {
    strategic: { seatId: string; limit: number; reserved: number; confirmed: number };
    seats: {
      seatId: string;
      limit: number;
      reserved: number;
      confirmed: number;
      observedTurns: number;
      partial: boolean;
    }[];
  };
  decisions: DecisionFixture[];
  approvals: {
    id: string;
    requestId: string;
    subjectHash: string;
    reason: string;
    at: string;
    runId: string;
    taskId: string;
    ref: string;
    consumed: boolean;
  }[];
  channels: ChannelFixture[];
  alerts: {
    id: string;
    severity: "info" | "warning" | "critical";
    code: string;
    message: string;
    taskId: string | null;
    at: string;
    acked: boolean;
  }[];
  metrics: Record<string, unknown>;
  [key: string]: unknown;
};
