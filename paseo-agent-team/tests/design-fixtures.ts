import type {
  DesignJob,
  DesignProposal,
  DesignResult,
  NewDesignRole,
} from "../shared/schemas/design";
import { architect, codingTeam, NOW } from "./fixtures";

export const DESIGN_JOB_ID = "11111111-1111-4111-8111-111111111111";
export const DESIGN_CLIENT_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
export const DESIGN_STATE_REVISION = "33333333-3333-4333-8333-333333333333";
export const DESIGN_LEASE_ID = "44444444-4444-4444-8444-444444444444";
export const DESIGN_HASH = "a".repeat(64);
export const DESIGN_NONCE = "b".repeat(32);
export const DESIGN_PLANNING_FINGERPRINT = "c".repeat(64);

export function newDesignRole(overrides: Partial<NewDesignRole> = {}): NewDesignRole {
  return {
    id: "rework-specialist",
    name: "【工程】改版专员",
    description: "负责改版落地的专职 Role。",
    mission: "在既有架构内完成改版实现。",
    responsibilities: ["实现指定模块", "补充必要测试"],
    restrictions: ["不修改无关模块"],
    systemPrompt: "严格按协调者的范围实现，并报告验证结果。",
    outputContract: ["改动清单", "验证结果"],
    preferredProfiles: [{ profileId: "codex-xhigh" }],
    fallbackProfiles: [],
    executionPolicy: { tier: "execution", taskKind: "coding" },
    noveltyReason: "现有 Role 没有覆盖这次改版的专职实现。",
    ...overrides,
  };
}

export function designProposal(overrides: Partial<DesignProposal> = {}): DesignProposal {
  return {
    version: 1,
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: DESIGN_NONCE,
    summary: "由技术负责人统筹，架构与实现分工完成改版。",
    team: {
      id: "rework-team",
      name: "改版 Team",
      description: "负责后台改版。",
      mode: "sota",
      coordinatorRoleId: "tech-lead",
      members: [
        { key: "m1", roleId: "architect", instanceLabel: "架构" },
        { key: "m2", roleId: "developer", instanceLabel: "实现" },
      ],
    },
    reuse: [
      { roleId: "tech-lead", reason: "负责统筹与验收。" },
      { roleId: "architect", reason: "负责结构方案。" },
      { roleId: "developer", reason: "负责实现。" },
    ],
    newRoles: [],
    profileChoices: [
      { target: "coordinator", profileIds: ["claude-opus-high"], reason: "统筹需要强推理。" },
      { target: "m1", profileIds: ["codex-xhigh"], reason: "结构设计需要代码理解。" },
      { target: "m2", profileIds: ["claude-opus-high"], reason: "实现需要稳定执行。" },
    ],
    ...overrides,
  };
}

export function designJob(overrides: Partial<DesignJob> = {}): DesignJob {
  return {
    jobId: DESIGN_JOB_ID,
    clientRequestId: DESIGN_CLIENT_REQUEST_ID,
    stateRevision: DESIGN_STATE_REVISION,
    state: "starting",
    attempt: 0,
    mode: "sota",
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    requestExcerpt: "给后台做一次改版",
    agentId: DESIGN_JOB_ID,
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
    ...overrides,
  };
}

export function designResult(overrides: Partial<DesignResult> = {}): DesignResult {
  return {
    version: 1,
    jobId: DESIGN_JOB_ID,
    resultId: DESIGN_HASH,
    attempt: 1,
    materializedAt: NOW,
    request: "给后台做一次改版",
    mode: "sota",
    summary: "由技术负责人统筹，架构与实现分工完成改版。",
    carrierWorkspaceId: "ws-carrier",
    targetWorkspaceId: null,
    team: {
      ...codingTeam,
      mode: "sota",
      memberCreation: "eager",
      members: [
        { roleId: "architect", instanceLabel: "架构", seatId: "seat-m1", enabled: true },
        { roleId: "developer", instanceLabel: "实现", seatId: "seat-m2", enabled: true },
      ],
    },
    newRoles: [architect],
    reuse: [{ roleId: "architect", behaviorHash: DESIGN_HASH, reason: "负责结构方案。" }],
    memberReasons: [
      {
        target: "m1",
        logicalSeatId: "logical-m1",
        reason: "结构设计需要代码理解。",
        expectedProfileIds: ["codex-xhigh"],
      },
    ],
    preview: {
      requestedMode: "sota",
      coordinator: {
        roleId: "tech-lead",
        roleName: "Tech Lead",
        profile: {
          id: "claude-opus-high",
          name: "Claude Opus High",
          provider: "claude",
          model: "opus",
        },
        source: "role-preferred",
        issues: [],
      },
      seats: [
        {
          seatId: "seat-m1",
          logicalSeatId: "logical-m1",
          roleId: "architect",
          roleName: "Architect",
          purpose: "member",
          activation: "eager",
          profile: {
            id: "codex-xhigh",
            name: "Codex xhigh",
            provider: "codex",
            model: "gpt-5.5",
          },
          source: "role-preferred",
          alternates: [],
          budget: "sota",
          budgetBasis: "host",
          standby: false,
          unavailable: false,
          issues: [],
        },
      ],
      counts: {
        logical: 1,
        physical: 1,
        eager: 1,
        deferred: 0,
        escalation: 0,
        sotaPotential: 1,
      },
      budget: { economy: 0, sota: 1, unknown: 0, deferredSota: 0 },
      issues: [],
      warnings: [],
      planHash: DESIGN_HASH,
    },
    planningFingerprint: DESIGN_PLANNING_FINGERPRINT,
    warnings: [],
    ...overrides,
  };
}
