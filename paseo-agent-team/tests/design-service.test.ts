import { describe, expect, test } from "vitest";
import type { DesignSettingsReaders } from "../server/designer/context";
import { createDesignHooks } from "../server/designer/hooks";
import { createDesignService, type DesignServiceDeps } from "../server/designer/service";
import type { DesignJobStore, StoredDesignJob } from "../server/designer/store";
import { DESIGN_RECORD_VERSION } from "../server/designer/store";
import type { DesignPlanningPort } from "../shared/domain/design-planning";
import type { PaseoProfile, ProviderAvailability } from "../shared/paseo/adapter";
import type {
  DesignAdapter,
  DesignAgentSummary,
  DesignTimelinePage,
  DesignWorkspaceSummary,
} from "../shared/paseo/design-port";
import { PreferencesSchema } from "../shared/schemas/preferences";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import { DESIGN_HASH, designJob, designProposal, newDesignRole } from "./design-fixtures";
import {
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  NOW,
  techLead,
} from "./fixtures";

const DESIGNER: PaseoProfile = {
  id: "designer-opus",
  name: "Claude-Opus-5.5-Max",
  provider: "claude",
  model: "claude-opus-5-5",
  modeId: "auto",
  thinkingOptionId: "max",
};
const profiles = [DESIGNER, claudeOpus, codexXhigh];
const availability: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: true },
];
const carrier: DesignWorkspaceSummary = {
  id: "ws-carrier",
  name: "Carrier",
  title: "Carrier",
  projectId: "project-1",
  projectName: "Project",
  directory: "C:/project",
  internal: false,
  archivingAt: null,
  background: false,
  status: "ready",
  activityAt: NOW,
};

class FakeStore implements DesignJobStore {
  records = new Map<string, StoredDesignJob>();
  problemsValue: { name: string; reason: "corrupt" | "unknown-version" }[] = [];
  getFails = false;
  getError: unknown = null;
  listFails = false;
  conflictOnce = false;
  conflictAlways = false;

  async initialize() {}
  async dispose() {}
  async list() {
    if (this.listFails) throw { issue: "corrupt" };
    return [...this.records.values()].map((record) => structuredClone(record));
  }
  async problems() {
    return this.problemsValue;
  }
  async get(jobId: string) {
    if (this.getError) throw this.getError;
    if (this.getFails) throw { issue: "corrupt" };
    const record = this.records.get(jobId);
    return record ? structuredClone(record) : null;
  }
  async findRequest(clientRequestId: string) {
    for (const record of this.records.values()) {
      if (record.job.clientRequestId === clientRequestId) return structuredClone(record);
    }
    return null;
  }
  async create(job: StoredDesignJob) {
    if (this.records.has(job.job.jobId)) throw { issue: "exists" };
    this.records.set(job.job.jobId, structuredClone(job));
  }
  async update(jobId: string, expectedRevision: string, next: StoredDesignJob) {
    if (this.conflictAlways) throw { issue: "conflict" };
    if (this.conflictOnce) {
      this.conflictOnce = false;
      throw { issue: "conflict" };
    }
    const current = this.records.get(jobId);
    if (!current) throw { issue: "missing" };
    if (current.job.stateRevision !== expectedRevision) throw { issue: "conflict" };
    this.records.set(jobId, structuredClone(next));
  }
}

class FakeAdapter implements DesignAdapter {
  agents = new Map<string, DesignAgentSummary>();
  created: Array<Parameters<DesignAdapter["createDesignAgent"]>[0]> = [];
  sent: string[] = [];
  archived: string[] = [];
  entries: DesignTimelinePage["entries"] = [];
  entriesByAgent: Record<string, DesignTimelinePage["entries"]> = {};
  archiveFails = false;
  createFails = false;
  createError: unknown = null;
  sendFails = false;
  readFails = false;
  profilesValue = profiles;
  delayCreate = false;
  createStarted = Promise.withResolvers<void>();
  releaseCreate = Promise.withResolvers<void>();

  async readConfig() {
    return { agentProfiles: this.profilesValue };
  }
  async listProviderAvailability() {
    return availability;
  }
  async listRecentWorkspaces() {
    return { workspaces: [carrier], nextCursor: null, hasMore: false };
  }
  async getDesignWorkspace(workspaceId: string) {
    return workspaceId === carrier.id ? carrier : null;
  }
  async createDesignAgent(input: Parameters<DesignAdapter["createDesignAgent"]>[0]) {
    this.createStarted.resolve();
    if (this.delayCreate) await this.releaseCreate.promise;
    if (this.createError) throw this.createError;
    if (this.createFails) throw new Error("create failed");
    this.created.push(input);
    this.agents.set(input.agentId, {
      id: input.agentId,
      labels: input.labels,
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    return { agentId: input.agentId };
  }
  async getDesignAgent(agentId: string) {
    return this.agents.get(agentId) ?? null;
  }
  async listDesignAgents() {
    return { agents: [...this.agents.values()], nextCursor: null, hasMore: false };
  }
  async readDesignTimeline(input: { agentId: string }): Promise<DesignTimelinePage> {
    return {
      epoch: "epoch-1",
      direction: "before",
      projection: "projected",
      entries: structuredClone(this.entriesByAgent[input.agentId] ?? this.entries),
      startCursor: null,
      endCursor: null,
      hasOlder: false,
      hasNewer: false,
      reset: false,
      gap: false,
      staleCursor: false,
    };
  }
  async sendDesignMessage(input: { agentId: string; text: string; messageId: string }) {
    if (this.sendFails) throw new Error("send failed");
    this.sent.push(input.text);
  }
  async archiveDesignAgent(agentId: string) {
    if (this.archiveFails) throw new Error("archive failed");
    this.archived.push(agentId);
  }
}

function readers(
  values: { roles?: Role[]; teams?: Team[]; preferences?: unknown } = {},
): DesignSettingsReaders {
  return {
    roles: {
      read: async () => ({
        status: "ready",
        revision: "roles-r1",
        values: { roles: values.roles ?? [techLead, architect, developer] },
      }),
    },
    teams: {
      read: async () => ({
        status: "ready",
        revision: "teams-r1",
        values: { teams: values.teams ?? [codingTeam] },
      }),
    },
    preferences: {
      read: async () => ({
        status: "ready",
        revision: "prefs-r1",
        values: PreferencesSchema.parse(values.preferences ?? { maxMembers: 24 }),
      }),
    },
  };
}

const planner: DesignPlanningPort = {
  plan(input) {
    const ids = { coordinator: "claude-opus-high", m1: "codex-xhigh", m2: "claude-opus-high" };
    const profileOf = (id: string) => {
      const profile = profiles.find((item) => item.id === id);
      if (!profile) throw new Error(`unknown test profile ${id}`);
      return {
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        ...(profile.model !== undefined ? { model: profile.model } : {}),
        ...(profile.modeId !== undefined ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId !== undefined
          ? { thinkingOptionId: profile.thinkingOptionId }
          : {}),
      };
    };
    const seats = input.team.members.map((member, index) => ({
      seatId: `${member.seatId}-p1`,
      logicalSeatId: member.seatId ?? "",
      roleId: member.roleId,
      roleName: "Member",
      purpose: "member" as const,
      activation: "eager" as const,
      profile: profileOf(ids[`m${index + 1}` as keyof typeof ids]),
      source: "role-preferred" as const,
      alternates: [],
      budget: "sota" as const,
      budgetBasis: "host" as const,
      standby: false,
      unavailable: false,
      issues: [],
    }));
    return {
      ok: true,
      preview: {
        requestedMode: input.mode,
        coordinator: {
          roleId: input.team.coordinatorRoleId,
          roleName: "Coordinator",
          profile: profileOf(ids.coordinator),
          source: "role-preferred",
          issues: [],
        },
        seats,
        counts: {
          logical: seats.length,
          physical: seats.length,
          eager: seats.length,
          deferred: 0,
          escalation: 0,
          sotaPotential: seats.length,
        },
        budget: { economy: 0, sota: seats.length, unknown: 0, deferredSota: 0 },
        issues: [],
        warnings: [],
        planHash: DESIGN_HASH,
      },
      issues: [],
      launchWarnings: [],
    };
  },
};

let serviceSequence = 0;

function serviceDeps(
  store: FakeStore,
  adapter: FakeAdapter,
  overrides: Partial<DesignServiceDeps> = {},
) {
  return {
    store,
    readers: readers(),
    getAdapter: () => adapter,
    planner,
    clock: { now: () => NOW },
    ids: {
      next: () => `00000000-0000-4000-8000-${String(++serviceSequence).padStart(12, "0")}`,
    },
    hasher: (content: string) => DESIGN_HASH.slice(0, 0) + createHash(content),
    capabilities: { onDemand: true, expansion: true, collaboration: false },
    ...overrides,
  } satisfies DesignServiceDeps;
}

function createHash(content: string): string {
  // Node-free test hash with a stable 64-hex shape.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const char of content) {
    h1 = Math.imul(h1 ^ char.charCodeAt(0), 0x01000193);
    h2 = Math.imul(h2 ^ char.charCodeAt(0), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0").repeat(4)}${(h2 >>> 0)
    .toString(16)
    .padStart(8, "0")
    .repeat(4)}`.slice(0, 64);
}

function input(
  request = "给后台做一次改版",
  clientRequestId = "11111111-1111-4111-8111-111111111111",
) {
  return {
    clientRequestId,
    request,
    mode: "sota" as const,
    profileId: DESIGNER.id,
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not met");
}

function retryRequestFor(jobId: string) {
  return {
    agentId: jobId,
    idempotencyKey: `agent-team-design:${jobId}`,
    workspaceId: "ws-carrier",
    title: "原始请求",
    labels: {
      "agent-team.design": jobId,
      "agent-team.design.version": "1",
      "agent-team.design.request-id": "44444444-4444-4444-8444-444444444444",
      "agent-team.design.request-hash": DESIGN_HASH,
      "agent-team.design.mode": "sota",
    },
    profile: { provider: "claude", model: "claude-opus-5-5" },
    systemPrompt: "原始系统提示",
    prompt: "原始首轮消息",
    clientMessageId: "55555555-5555-4555-8555-555555555599",
  };
}

function proposalFor(record: StoredDesignJob, attempt = 1) {
  const attemptRecord = record.attempts.find((item) => item.attempt === attempt);
  return designProposal({
    jobId: record.job.jobId,
    attempt: attempt as 1 | 2 | 3,
    nonce: attemptRecord?.nonce,
  });
}

function answerFor(record: StoredDesignJob, proposal: unknown, attempt = 1) {
  const attemptRecord = record.attempts.find((item) => item.attempt === attempt);
  return [
    { seqStart: 1, seqEnd: 1, type: "user_message" as const, messageId: attemptRecord?.messageId },
    {
      seqStart: 2,
      seqEnd: 2,
      type: "assistant_message" as const,
      text: `\`\`\`agent-team-design\n${JSON.stringify(proposal)}\n\`\`\``,
      turnId: "turn-1",
    },
  ];
}

function seededJob(
  jobId: string,
  state: "starting" | "designing" | "fixing" | "ready" | "needs_continue",
  overrides: Partial<StoredDesignJob> = {},
): StoredDesignJob {
  return {
    schemaVersion: DESIGN_RECORD_VERSION,
    job: designJob({
      jobId,
      clientRequestId: "44444444-4444-4444-8444-444444444444",
      state,
      attempt: state === "starting" ? 0 : 1,
      agentCreated: state !== "starting",
      agentStatus: state === "starting" ? null : "idle",
      carrierWorkspaceId: "ws-carrier",
    }),
    request: "给后台做一次改版",
    requestHash: DESIGN_HASH,
    mode: "sota",
    selectionIntent: JSON.stringify({
      request: "给后台做一次改版",
      mode: "sota",
      workspaceId: null,
      profileId: DESIGNER.id,
      useDefaultProfileHints: false,
    }),
    creation:
      state === "starting"
        ? null
        : { intentHash: DESIGN_HASH, idempotencyKey: `agent-team-design:${jobId}` },
    attempts:
      state === "starting"
        ? []
        : [
            {
              attempt: 1,
              nonce: "b".repeat(32),
              messageId: "55555555-5555-4555-8555-555555555555",
              promptHash: DESIGN_HASH,
              epoch: null,
              endCursor: null,
              summary: null,
              ack: state === "fixing" ? "pending" : "acked",
            },
          ],
    proposal: null,
    result: null,
    reuseFingerprints: {},
    leaseOwner: null,
    receipts: { "44444444-4444-4444-8444-444444444444": jobId },
    outcomeUnknown: false,
    ...overrides,
  };
}

describe("design service", () => {
  test("accepts immediately, creates in the background, and is idempotent", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.job.state).toBe("starting");
    await until(
      () =>
        adapter.created.length === 1 &&
        store.records.get(started.job.jobId)?.job.agentCreated === true,
    );
    const stored = await store.get(started.job.jobId);
    expect(stored?.job.state).toBe("designing");
    expect(stored?.attempts[0]?.ack).toBe("acked");
    expect(adapter.created[0]?.idempotencyKey).toBe(`agent-team-design:${started.job.jobId}`);
    const replay = await service.start(input());
    expect(replay).toMatchObject({ ok: true, job: { jobId: started.job.jobId } });
    expect(adapter.created).toHaveLength(1);
    const conflict = await service.start(input("另一项需求"));
    expect(conflict).toMatchObject({ ok: false, issues: [{ code: "DESIGN_REQUEST_CONFLICT" }] });
    await service.dispose();
  });

  test("admits at most three active design jobs", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    for (const suffix of ["1", "2", "3"]) {
      const accepted = await service.start(
        input(`需求 ${suffix}`, `11111111-1111-4111-8111-11111111111${suffix}`),
      );
      expect(accepted.ok).toBe(true);
    }
    const busy = await service.start(input("第四个", "11111111-1111-4111-8111-111111111114"));
    expect(busy).toMatchObject({ ok: false, issues: [{ code: "DESIGN_BUSY" }] });
    await service.dispose();
  });

  test("status reconciles a missed hook to ready and exposes the result", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing record");
    adapter.entries = answerFor(stored, proposalFor(stored));
    const status = await service.status({ jobId: started.job.jobId });
    expect(status.ok).toBe(true);
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const result = await service.result({ jobId: started.job.jobId });
    expect(result).toMatchObject({ ok: true, result: { jobId: started.job.jobId } });
    await service.dispose();
  });

  test("hooks only accept owned labels and can complete a job", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const hooks = createDesignHooks({ service });
    await hooks.onTurnEnded({
      agent: { id: "foreign", labels: { "agent-team.design.version": "1" } },
    });
    expect(adapter.created).toHaveLength(0);
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing record");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await hooks.onTurnEnded({
      agent: {
        id: started.job.jobId,
        labels: stored.job ? adapter.agents.get(started.job.jobId)?.labels : {},
      },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    await service.dispose();
  });

  test("spends at most three model rounds and never sends a fourth", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stored = await store.get(started.job.jobId);
      if (!stored) throw new Error("missing");
      const attemptRecord = stored.attempts.find((item) => item.attempt === attempt);
      adapter.entries = [
        { seqStart: 1, seqEnd: 1, type: "user_message", messageId: attemptRecord?.messageId },
        { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "没有设计块", turnId: "turn-1" },
      ];
      await service.onTurnEnded({
        agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
        outcome: { kind: "completed" },
      });
      if (attempt < 3) {
        expect(store.records.get(started.job.jobId)?.attempts).toHaveLength(attempt + 1);
      }
    }
    expect(adapter.sent).toHaveLength(2);
    expect(store.records.get(started.job.jobId)?.job.state).toBe("failed");
    await service.dispose();
  });

  test("cancels idempotently and archives only the owned agent", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const first = await service.cancel({ jobId: started.job.jobId });
    expect(first).toMatchObject({ ok: true, job: { state: "canceled", cancelRequested: true } });
    expect(adapter.archived).toEqual([started.job.jobId]);
    await service.cancel({ jobId: started.job.jobId });
    expect(adapter.archived).toHaveLength(1);
    await service.dispose();
  });

  test("prepareSave leases, markSaved verifies refs, and already-saved is idempotent", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("no result");
    const prepared = await service.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "22222222-2222-4222-8222-222222222222",
    });
    expect(prepared).toMatchObject({ ok: true, prepared: { outcome: "write" } });
    if (!prepared.ok) return;
    if (prepared.prepared.outcome !== "write") return;
    // The client would write the two documents; simulate the resulting documents for readback.
    const deps = serviceDeps(store, adapter, {
      readers: readers({
        roles: [...[techLead, architect, developer], ...ready.result.newRoles],
        teams: [codingTeam, ready.result.team],
      }),
    });
    // Recreate the service with writable-looking readers while holding the same store.
    const saver = createDesignService(deps);
    const wrongMark = await saver.markSaved({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    expect(wrongMark).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_LEASE_EXPIRED" }] });
    const saved = await saver.markSaved({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      leaseId: prepared.prepared.lease.id,
    });
    expect(saved).toMatchObject({
      ok: true,
      job: { state: "saved", savedTeamId: ready.result.team.id },
    });
    const again = await saver.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "22222222-2222-4222-8222-222222222222",
    });
    expect(again).toMatchObject({ ok: true, prepared: { outcome: "already-saved" } });
    await saver.dispose();
    await service.dispose();
  });

  test("prepareSave revalidates the frozen result against fresh settings", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("no result");
    const changed = createDesignService(
      serviceDeps(store, adapter, {
        readers: readers({ roles: [techLead, architect] }),
      }),
    );
    const stale = await changed.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "22222222-2222-4222-8222-222222222222",
    });
    expect(stale).toMatchObject({ ok: false });
    expect(store.records.get(ready.job.jobId)?.job.state).toBe("needs_continue");
    const afterNeedsContinue = await changed.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "22222222-2222-4222-8222-222222222222",
    });
    expect(afterNeedsContinue).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_STATE_CHANGED" }],
    });
    await changed.dispose();
    await service.dispose();
  });

  test("lists jobs, reports missing result jobs, and rechecks a ready result", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const list = await service.status({});
    expect(list).toMatchObject({ ok: true, scopeId: expect.any(String) });
    if (list.ok) expect(list.jobs.map((job) => job.jobId)).toContain(started.job.jobId);
    expect(await service.result({ jobId: "99999999-9999-4999-8999-999999999999" })).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_JOB_NOT_FOUND" }],
    });
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready) throw new Error("missing");
    const rechecked = await service.continue({
      jobId: ready.job.jobId,
      expectedRevision: ready.job.stateRevision,
      action: "recheck",
    });
    expect(rechecked).toMatchObject({ ok: true, job: { state: "ready" } });
    await service.dispose();
  });

  test("refuses compensation while a write receipt is still unknown", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("no result");
    ready.outcomeUnknown = true;
    const current = await store.get(ready.job.jobId);
    if (!current) throw new Error("missing current");
    await store.update(ready.job.jobId, current.job.stateRevision, {
      ...current,
      outcomeUnknown: true,
      job: {
        ...current.job,
        state: "save_conflict",
        saveState: "unknown",
        stateRevision: "99999999-9999-4999-8999-999999999999",
      },
    });
    const compensated = await service.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "22222222-2222-4222-8222-222222222222",
      intent: "compensate",
    });
    expect(compensated).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_UNKNOWN" }] });
    await service.dispose();
  });

  test("rejects a second save client and releases the lease after saveFailed", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("no result");
    const first = await service.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "22222222-2222-4222-8222-222222222222",
    });
    expect(first).toMatchObject({ ok: true, prepared: { outcome: "write" } });
    if (!first.ok || first.prepared.outcome !== "write") return;
    const busy = await service.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "33333333-3333-4333-8333-333333333333",
    });
    expect(busy).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_BUSY" }] });
    const wrongLease = await service.saveFailed({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      leaseId: "44444444-4444-4444-8444-444444444444",
      phase: "team",
      reason: "write-failed",
    });
    expect(wrongLease).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_SAVE_LEASE_EXPIRED" }],
    });
    await service.saveFailed({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      leaseId: first.prepared.lease.id,
      phase: "team",
      reason: "write-failed",
    });
    const after = await service.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId: "33333333-3333-4333-8333-333333333333",
    });
    expect(after).toMatchObject({ ok: true, prepared: { outcome: "write" } });
    await service.dispose();
  });

  test("rejects stale revisions and reports missing jobs", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    expect(await service.status({ jobId: "99999999-9999-4999-8999-999999999999" })).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_JOB_NOT_FOUND" }],
    });
    const current = await store.get(started.job.jobId);
    if (!current) throw new Error("missing");
    expect(
      await service.continue({
        jobId: started.job.jobId,
        expectedRevision: current.job.stateRevision,
        action: "repair",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_RECOVERY_INCOMPLETE" }] });
    await service.dispose();
  });

  test("fails cleanly when the designer profile or settings are unavailable", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const missingProfile = await service.start({ ...input(), profileId: "missing" });
    if (!missingProfile.ok) throw new Error("start failed");
    await until(() => store.records.get(missingProfile.job.jobId)?.job.state === "failed");
    expect(store.records.get(missingProfile.job.jobId)?.job.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DESIGN_PROFILE_UNAVAILABLE" })]),
    );

    const broken = createDesignService(
      serviceDeps(store, adapter, {
        readers: {
          roles: { read: async () => ({ status: "invalid", revision: "r", error: "bad" }) },
          teams: readers().teams,
          preferences: readers().preferences,
        },
      }),
    );
    const settingsFailure = await broken.start(
      input("需求", "11111111-1111-4111-8111-111111111119"),
    );
    if (!settingsFailure.ok) throw new Error("start failed");
    await until(() => store.records.get(settingsFailure.job.jobId)?.job.state === "failed");
    expect(store.records.get(settingsFailure.job.jobId)?.job.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DESIGN_SETTINGS_INVALID" })]),
    );
    await broken.dispose();
    await service.dispose();
  });

  test("surfaces archive failure on cancel and can retry", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    adapter.archiveFails = true;
    const failed = await service.cancel({ jobId: started.job.jobId });
    expect(failed).toMatchObject({ ok: true, job: { state: "needs_continue" } });
    adapter.archiveFails = false;
    const retried = await service.cancel({ jobId: started.job.jobId });
    expect(retried).toMatchObject({ ok: true, job: { state: "canceled" } });
    await service.dispose();
  });

  test("continue.repair sends the stored validation issues", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    stored.job.state = "needs_continue";
    stored.job.issues = [
      {
        code: "DESIGN_TEAM_INVALID",
        severity: "error",
        path: ["team"],
        params: {},
        action: "repair",
      },
    ];
    await store.update(stored.job.jobId, stored.job.stateRevision, {
      ...stored,
      job: { ...stored.job, stateRevision: "99999999-9999-4999-8999-999999999999" },
    });
    const current = await store.get(started.job.jobId);
    if (!current) throw new Error("missing");
    const repaired = await service.continue({
      jobId: started.job.jobId,
      expectedRevision: current.job.stateRevision,
      action: "repair",
    });
    expect(repaired).toMatchObject({ ok: true, job: { attempt: 2 } });
    expect(adapter.sent).toHaveLength(1);
    await service.dispose();
  });

  test("rejects collaboration when the capability is closed and failed hooks stay terminal", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const blocked = await service.start({ ...input(), mode: "collaborative" });
    expect(blocked).toMatchObject({ ok: false, issues: [{ code: "DESIGN_MODE_UNAVAILABLE" }] });
    const started = await service.start(input("需求", "11111111-1111-4111-8111-111111111118"));
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const hooks = createDesignHooks({ service });
    const attemptMessageId = store.records.get(started.job.jobId)?.attempts[0]?.messageId;
    await hooks.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      turnId: attemptMessageId,
      outcome: { kind: "failed" },
    });
    expect(store.records.get(started.job.jobId)?.job.state).toBe("failed");
    await service.dispose();
  });

  test("status never rewrites a ready or saving job and keeps resultId stable", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("no result");
    for (let index = 0; index < 3; index += 1) await service.status({ jobId: ready.job.jobId });
    const after = await store.get(ready.job.jobId);
    expect(after?.job.stateRevision).toBe(ready.job.stateRevision);
    expect(after?.job.resultId).toBe(ready.result.resultId);
    const live = store.records.get(ready.job.jobId);
    if (!live) throw new Error("missing live");
    live.job.state = "saving";
    live.job.saveLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    live.leaseOwner = JSON.stringify({ clientId: "x", leaseId: "y" });
    const savingRevision = live.job.stateRevision;
    await service.status({ jobId: ready.job.jobId });
    const saving = await store.get(ready.job.jobId);
    expect(saving?.job.state).toBe("saving");
    expect(saving?.job.stateRevision).toBe(savingRevision);
    expect(saving?.job.resultId).toBe(ready.result.resultId);
    await service.dispose();
  });

  test("late failed hooks cannot kill ready or saving jobs", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const record = seededJob(jobId, "ready", {
      job: designJob({ jobId, state: "ready", attempt: 1, agentCreated: true }),
    });
    await store.create(record);
    const savingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
    const saving = seededJob(savingId, "ready", {
      job: designJob({ jobId: savingId, state: "ready", attempt: 1, agentCreated: true }),
    });
    saving.job.state = "saving";
    saving.job.saveLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    saving.leaseOwner = JSON.stringify({ clientId: "x", leaseId: "y" });
    await store.create(saving);
    const service = createDesignService(serviceDeps(store, adapter));
    await service.onTurnEnded({
      agent: {
        id: jobId,
        labels: { "agent-team.design": jobId, "agent-team.design.version": "1" },
      },
      turnId: "old-turn",
      outcome: { kind: "failed" },
    });
    expect(store.records.get(jobId)?.job.state).toBe("ready");
    await service.onTurnEnded({
      agent: {
        id: savingId,
        labels: { "agent-team.design": savingId, "agent-team.design.version": "1" },
      },
      turnId: "old-turn",
      outcome: { kind: "failed" },
    });
    expect(store.records.get(savingId)?.job.state).toBe("saving");
    await service.dispose();
  });

  test("cancel during an in-flight create archives the agent when create returns", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    adapter.delayCreate = true;
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await adapter.createStarted.promise;
    const canceled = await service.cancel({ jobId: started.job.jobId });
    expect(canceled).toMatchObject({ ok: true, job: { state: "canceling" } });
    adapter.releaseCreate.resolve();
    await until(() => store.records.get(started.job.jobId)?.job.state === "canceled");
    expect(adapter.archived).toEqual([started.job.jobId]);
    await service.dispose();
  });

  test("resumes a persisted starting job and recovers a pending fixing send", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const startingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await store.create(seededJob(startingId, "starting"));
    const service = createDesignService(serviceDeps(store, adapter));
    await service.status({});
    await until(() => store.records.get(startingId)?.job.agentCreated === true);
    expect(store.records.get(startingId)?.job.state).toBe("designing");

    const fixingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fixing = seededJob(fixingId, "fixing");
    await store.create(fixing);
    adapter.agents.set(fixingId, {
      id: fixingId,
      labels: { "agent-team.design": fixingId, "agent-team.design.version": "1" },
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    adapter.entries = [
      {
        seqStart: 1,
        seqEnd: 1,
        type: "user_message",
        messageId: "55555555-5555-4555-8555-555555555555",
      },
    ];
    await service.status({});
    await until(() => store.records.get(fixingId)?.attempts[0]?.ack === "acked");
    await service.dispose();
  });

  test("reconcile maps every provider fact without mutating ready/saving", async () => {
    const scenarios = [
      { kind: "attempt-error", expect: "failed" },
      { kind: "external-input", expect: "needs_continue" },
      { kind: "unclaimed", expect: "needs_continue" },
      { kind: "waiting", expect: "designing" },
      { kind: "unknown", expect: "designing" },
      { kind: "needs-continue", expect: "needs_continue" },
      { kind: "receipt-pending", expect: "designing" },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      const store = new FakeStore();
      const adapter = new FakeAdapter();
      const jobId = `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`;
      const base = seededJob(jobId, "designing", {
        job: designJob({
          jobId,
          state: "designing",
          attempt: 1,
          agentCreated: true,
          agentId: jobId,
        }),
      });
      const attemptRecord = base.attempts[0];
      if (!attemptRecord) throw new Error("missing attempt");
      if (scenario.kind === "receipt-pending") attemptRecord.ack = "pending";
      await store.create(base);
      if (scenario.kind !== "unknown") {
        adapter.agents.set(jobId, {
          id: jobId,
          labels: {
            "agent-team.design": jobId,
            "agent-team.design.version": "1",
            "agent-team.design.request-hash":
              scenario.kind === "unclaimed" ? "e".repeat(64) : DESIGN_HASH,
          },
          status: "idle",
          activeTurn: scenario.kind === "waiting",
          archivedAt: null,
          requiresAttention: false,
          attentionReason: null,
          pendingPermissions: [],
          lastError: null,
          providerUnavailable: false,
        });
      }
      const boundary = attemptRecord.messageId;
      adapter.entriesByAgent[jobId] =
        scenario.kind === "attempt-error"
          ? [
              { seqStart: 1, seqEnd: 1, type: "user_message", messageId: boundary },
              { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "x", turnId: "turn-1" },
              { seqStart: 3, seqEnd: 3, type: "notification", level: "error", text: "boom" },
            ]
          : scenario.kind === "external-input"
            ? [
                { seqStart: 1, seqEnd: 1, type: "user_message", messageId: boundary },
                { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "x", turnId: "turn-1" },
                { seqStart: 3, seqEnd: 3, type: "user_message", text: "other" },
              ]
            : scenario.kind === "needs-continue"
              ? [{ seqStart: 2, seqEnd: 2, type: "assistant_message", text: "x", turnId: "turn-1" }]
              : [{ seqStart: 1, seqEnd: 1, type: "user_message", messageId: boundary }];
      const service = createDesignService(serviceDeps(store, adapter));
      await service.status({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.records.get(jobId)?.job.state).toBe(scenario.expect);
      await service.dispose();
    }
  });

  test("uses saved designer preferences, default hints, and reports missing adapter/create/send", async () => {
    const savedStore = new FakeStore();
    const savedAdapter = new FakeAdapter();
    const savedService = createDesignService(
      serviceDeps(savedStore, savedAdapter, {
        readers: readers({
          preferences: { maxMembers: 24, designerProfile: { profileId: DESIGNER.id } },
        }),
      }),
    );
    const saved = await savedService.start({ ...input(), profileId: undefined });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      await until(() => savedStore.records.get(saved.job.jobId)?.job.agentCreated === true);
    }
    await savedService.dispose();

    const hintStore = new FakeStore();
    const hintAdapter = new FakeAdapter();
    const hintService = createDesignService(serviceDeps(hintStore, hintAdapter));
    const hinted = await hintService.start({
      ...input(),
      profileId: undefined,
      useDefaultProfileHints: true,
    });
    expect(hinted.ok).toBe(true);
    if (hinted.ok) {
      await until(() => hintStore.records.get(hinted.job.jobId)?.job.agentCreated === true);
    }
    await hintService.dispose();

    const noAdapterStore = new FakeStore();
    const noAdapter = createDesignService(
      serviceDeps(noAdapterStore, new FakeAdapter(), { getAdapter: () => null }),
    );
    const failed = await noAdapter.start({
      ...input(),
      clientRequestId: "11111111-1111-4111-8111-111111111115",
    });
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      await until(() => noAdapterStore.records.get(failed.job.jobId)?.job.state === "failed");
    }
    await noAdapter.dispose();

    const createStore = new FakeStore();
    const createAdapter = new FakeAdapter();
    createAdapter.createFails = true;
    const createService = createDesignService(serviceDeps(createStore, createAdapter));
    const createFailed = await createService.start({
      ...input(),
      clientRequestId: "11111111-1111-4111-8111-111111111116",
    });
    if (!createFailed.ok) throw new Error("start failed");
    await until(() => createStore.records.get(createFailed.job.jobId)?.job.state === "failed");
    await createService.dispose();
  });

  test("cold-start status never sends a paid correction", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const original = createDesignService(serviceDeps(store, adapter));
    const started = await original.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = [
      { seqStart: 1, seqEnd: 1, type: "user_message", messageId: stored.attempts[0]?.messageId },
      { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "没有设计块", turnId: "turn-1" },
    ];
    const cold = createDesignService(serviceDeps(store, adapter));
    await cold.status({});
    await until(() => store.records.get(started.job.jobId)?.job.state === "needs_continue");
    expect(adapter.sent).toHaveLength(0);
    await cold.dispose();
    await original.dispose();
  });

  test("all RPCs report missing jobs and continue guards reject invalid states", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const missing = "99999999-9999-4999-8999-999999999999";
    for (const result of [
      await service.status({ jobId: missing }),
      await service.result({ jobId: missing }),
      await service.prepareSave({
        jobId: missing,
        resultId: DESIGN_HASH,
        clientId: "22222222-2222-4222-8222-222222222222",
      }),
      await service.markSaved({ jobId: missing, resultId: DESIGN_HASH }),
      await service.saveFailed({
        jobId: missing,
        resultId: DESIGN_HASH,
        leaseId: "44444444-4444-4444-8444-444444444444",
        phase: "team",
        reason: "write-failed",
      }),
      await service.cancel({ jobId: missing }),
      await service.continue({ jobId: missing, expectedRevision: missing, action: "repair" }),
    ]) {
      expect(result).toMatchObject({ ok: false, issues: [{ code: "DESIGN_JOB_NOT_FOUND" }] });
    }

    const needs = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await store.create(
      seededJob(needs, "needs_continue", {
        job: designJob({ jobId: needs, state: "needs_continue", attempt: 1, agentCreated: true }),
      }),
    );
    const noResult = await service.continue({
      jobId: needs,
      expectedRevision: (await store.get(needs))?.job.stateRevision ?? "",
      action: "recheck",
    });
    expect(noResult).toMatchObject({ ok: false, issues: [{ code: "DESIGN_NOT_SAVED" }] });

    const exhausted = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const exhaustedRecord = seededJob(exhausted, "needs_continue", {
      job: designJob({ jobId: exhausted, state: "needs_continue", attempt: 3, agentCreated: true }),
      attempts: [1, 2, 3].map((value) => ({
        attempt: value as 1 | 2 | 3,
        nonce: "b".repeat(32),
        messageId: `55555555-5555-4555-8555-55555555555${value}`,
        promptHash: DESIGN_HASH,
        epoch: null,
        endCursor: null,
        summary: null,
        ack: "acked" as const,
      })),
    });
    await store.create(exhaustedRecord);
    expect(
      await service.continue({
        jobId: exhausted,
        expectedRevision: exhaustedRecord.job.stateRevision,
        action: "repair",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_RETRY_EXHAUSTED" }] });

    const sent = "12345678-1234-4234-8234-123456789012";
    const sentRecord = seededJob(sent, "needs_continue", {
      job: designJob({ jobId: sent, state: "needs_continue", attempt: 1, agentCreated: true }),
      attempts: [
        {
          attempt: 1,
          nonce: "b".repeat(32),
          messageId: "55555555-5555-4555-8555-555555555555",
          promptHash: DESIGN_HASH,
          epoch: null,
          endCursor: null,
          summary: null,
          ack: "acked",
        },
        {
          attempt: 2,
          nonce: "c".repeat(32),
          messageId: "55555555-5555-4555-8555-555555555556",
          promptHash: DESIGN_HASH,
          epoch: null,
          endCursor: null,
          summary: null,
          ack: "acked",
        },
      ],
    });
    await store.create(sentRecord);
    expect(
      await service.continue({
        jobId: sent,
        expectedRevision: sentRecord.job.stateRevision,
        action: "repair",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STATE_CHANGED" }] });
    await service.dispose();
  });

  test("save workflow rejects stale, canceled, busy, and compensates", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const record = store.records.get(started.job.jobId);
    if (!record?.result) throw new Error("missing result");
    const resultId = record.result.resultId;
    const current = () => {
      const value = store.records.get(started.job.jobId);
      if (!value) throw new Error("missing live record");
      return value;
    };
    const clientId = "22222222-2222-4222-8222-222222222222";

    expect(
      await service.prepareSave({ jobId: started.job.jobId, resultId: DESIGN_HASH, clientId }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_RESULT_STALE" }] });
    expect(
      await service.markSaved({ jobId: started.job.jobId, resultId: DESIGN_HASH }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_RESULT_STALE" }] });
    expect(
      await service.saveFailed({
        jobId: started.job.jobId,
        resultId: DESIGN_HASH,
        leaseId: "44444444-4444-4444-8444-444444444444",
        phase: "team",
        reason: "write-failed",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_RESULT_STALE" }] });

    current().job.cancelRequested = true;
    expect(
      await service.prepareSave({ jobId: started.job.jobId, resultId, clientId }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STATE_CHANGED" }] });
    current().job.cancelRequested = false;

    current().job.state = "saving";
    current().job.saveLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    current().leaseOwner = JSON.stringify({
      clientId: "33333333-3333-4333-8333-333333333333",
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    expect(
      await service.prepareSave({ jobId: started.job.jobId, resultId, clientId }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_BUSY" }] });
    current().job.state = "save_conflict";
    current().job.saveState = "none";
    current().job.saveLeaseExpiresAt = null;
    current().leaseOwner = null;

    const compensable = await service.prepareSave({
      jobId: started.job.jobId,
      resultId,
      clientId,
      intent: "compensate",
    });
    expect(compensable).toMatchObject({ ok: true, prepared: { outcome: "compensate" } });
    current().job.state = "ready";
    current().leaseOwner = JSON.stringify({
      clientId,
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    current().job.saveLeaseExpiresAt = null;

    const partial = await service.saveFailed({
      jobId: started.job.jobId,
      resultId,
      leaseId: "44444444-4444-4444-8444-444444444444",
      phase: "team",
      reason: "partial",
    });
    expect(partial).toMatchObject({
      ok: true,
      job: { state: "save_conflict", saveState: "roles-only", needsCleanup: true },
    });
    current().leaseOwner = JSON.stringify({
      clientId,
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    const unknown = await service.saveFailed({
      jobId: started.job.jobId,
      resultId,
      leaseId: "44444444-4444-4444-8444-444444444444",
      phase: "team",
      reason: "unknown",
    });
    expect(unknown).toMatchObject({ ok: true, job: { saveState: "unknown" } });
    await service.dispose();
  });

  test("recovery catches pending timeout, create ambiguity, cancel events, and missing adapter", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const clock = { now: () => "2026-10-26T00:00:00.000Z" };
    const service = createDesignService(serviceDeps(store, adapter, { clock }));
    const pending = "abcdef01-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(pending, "fixing", {
        job: designJob({
          jobId: pending,
          state: "fixing",
          attempt: 1,
          agentCreated: true,
          agentId: pending,
          updatedAt: "2026-10-25T00:00:00.000Z",
        }),
        attempts: [
          {
            attempt: 1,
            nonce: "b".repeat(32),
            messageId: "55555555-5555-4555-8555-555555555557",
            promptHash: DESIGN_HASH,
            epoch: null,
            endCursor: null,
            summary: null,
            ack: "pending",
          },
        ],
      }),
    );
    adapter.agents.set(pending, {
      id: pending,
      labels: {
        "agent-team.design": pending,
        "agent-team.design.version": "1",
        "agent-team.design.request-hash": DESIGN_HASH,
      },
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    adapter.entries = [];
    await service.status({ jobId: pending });
    await until(() => store.records.get(pending)?.job.state === "needs_continue");

    const created = "abcdef02-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(created, "starting", {
        job: designJob({
          jobId: created,
          state: "starting",
          attempt: 0,
          agentCreated: true,
          agentId: created,
        }),
        creation: { intentHash: DESIGN_HASH, idempotencyKey: `agent-team-design:${created}` },
      }),
    );
    await service.status({ jobId: created });
    await until(() => store.records.get(created)?.job.state === "failed");

    const invalid = "abcdef03-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(invalid, "starting", {
        job: designJob({ jobId: invalid, state: "starting", attempt: 0 }),
        selectionIntent: "{bad",
      }),
    );
    await service.status({ jobId: invalid });
    await until(() => store.records.get(invalid)?.job.state === "failed");

    const noAdapterJob = "abcdef05-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(noAdapterJob, "designing", {
        job: designJob({
          jobId: noAdapterJob,
          state: "designing",
          attempt: 1,
          agentCreated: true,
          agentId: noAdapterJob,
        }),
      }),
    );
    const noAdapter = createDesignService(serviceDeps(store, adapter, { getAdapter: () => null }));
    expect(await noAdapter.cancel({ jobId: noAdapterJob })).toMatchObject({
      ok: true,
      job: { state: "needs_continue" },
    });
    await noAdapter.dispose();

    const canceled = "abcdef04-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(canceled, "designing", {
        job: designJob({
          jobId: canceled,
          state: "designing",
          attempt: 1,
          agentCreated: true,
          agentId: canceled,
        }),
      }),
    );
    await service.onTurnEnded({
      agent: {
        id: canceled,
        labels: {
          "agent-team.design": canceled,
          "agent-team.design.version": "1",
          "agent-team.design.request-hash": DESIGN_HASH,
        },
      },
      turnId: "55555555-5555-4555-8555-555555555555",
      outcome: { kind: "canceled" },
    });
    expect(store.records.get(canceled)?.job.state).toBe("canceled");
    await service.dispose();
  });

  test("storage, adapter, lease, and archive failures stay typed", async () => {
    const failedStore = new FakeStore();
    failedStore.getFails = true;
    const failedService = createDesignService(serviceDeps(failedStore, new FakeAdapter()));
    expect(
      await failedService.status({ jobId: "99999999-9999-4999-8999-999999999999" }),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_SETTINGS_INVALID" }],
    });
    expect(
      await failedService.result({ jobId: "99999999-9999-4999-8999-999999999999" }),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_SETTINGS_INVALID" }],
    });
    failedStore.getFails = false;
    failedStore.listFails = true;
    expect(await failedService.status({})).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_SETTINGS_INVALID" }],
    });
    await failedService.dispose();

    const disposed = createDesignService(serviceDeps(new FakeStore(), new FakeAdapter()));
    await disposed.dispose();
    expect(
      await disposed.start({ ...input(), clientRequestId: "11111111-1111-4111-8111-111111111199" }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STORAGE_UNAVAILABLE" }] });

    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const jobId = "abcdef11-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(jobId, "designing", {
        job: designJob({
          jobId,
          state: "designing",
          attempt: 1,
          agentCreated: true,
          agentId: jobId,
        }),
      }),
    );
    adapter.readFails = true;
    await service.status({ jobId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(jobId)?.job.state).toBe("designing");

    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("missing result");
    const clientId = "22222222-2222-4222-8222-222222222222";
    const live = () => {
      const value = store.records.get(started.job.jobId);
      if (!value) throw new Error("missing live");
      return value;
    };
    live().job.state = "saving";
    live().leaseOwner = JSON.stringify({
      clientId,
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    live().job.saveLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(
      await service.prepareSave({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        leaseId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_LEASE_EXPIRED" }] });

    const emptyReaders = createDesignService(
      serviceDeps(store, adapter, { readers: readers({ roles: [] }) }),
    );
    live().job.state = "ready";
    expect(
      await emptyReaders.markSaved({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        leaseId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_NOT_SAVED" }] });
    await emptyReaders.dispose();

    live().job.state = "ready";
    live().job.saveLeaseExpiresAt = null;
    const compensated = await service.saveFailed({
      jobId: started.job.jobId,
      resultId: ready.result.resultId,
      leaseId: "44444444-4444-4444-8444-444444444444",
      phase: "team",
      reason: "compensated",
    });
    expect(compensated).toMatchObject({ ok: true, job: { state: "canceled" } });

    live().job.state = "ready";
    live().leaseOwner = JSON.stringify({
      clientId,
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    live().job.cancelRequested = false;
    adapter.archiveFails = true;
    expect(
      await service.saveFailed({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        leaseId: "44444444-4444-4444-8444-444444444444",
        phase: "team",
        reason: "compensated",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_CANCEL_FAILED" }] });

    const noAdapterSave = createDesignService(
      serviceDeps(store, new FakeAdapter(), { getAdapter: () => null }),
    );
    expect(
      await noAdapterSave.saveFailed({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        leaseId: "44444444-4444-4444-8444-444444444444",
        phase: "team",
        reason: "compensated",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_CANCEL_FAILED" }] });
    await noAdapterSave.dispose();

    expect(
      await service.continue({
        jobId: started.job.jobId,
        expectedRevision: "99999999-9999-4999-8999-999999999999",
        action: "repair",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STATE_CHANGED" }] });
    await service.dispose();
  });

  test("continue rejects active leases and survives repair send failure", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("missing result");
    const live = () => {
      const value = store.records.get(started.job.jobId);
      if (!value) throw new Error("missing live");
      return value;
    };
    live().job.state = "needs_continue";
    live().job.stateRevision = "77777777-7777-4777-8777-777777777777";
    live().job.saveLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    live().leaseOwner = JSON.stringify({
      clientId: "22222222-2222-4222-8222-222222222222",
      leaseId: "44444444-4444-4444-8444-444444444444",
    });
    expect(
      await service.continue({
        jobId: started.job.jobId,
        expectedRevision: live().job.stateRevision,
        action: "repair",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_BUSY" }] });
    live().job.saveLeaseExpiresAt = null;
    live().leaseOwner = null;
    live().job.issues = [];
    adapter.sendFails = true;
    const failed = await service.continue({
      jobId: started.job.jobId,
      expectedRevision: live().job.stateRevision,
      action: "repair",
    });
    expect(failed).toMatchObject({ ok: true, job: { state: "needs_continue" } });
    if (failed.ok)
      expect(failed.job.issues.some((issue) => issue.code === "DESIGN_STATE_CHANGED")).toBe(true);
    await service.dispose();
  });

  test("covers resume, pending-wait, archive, enqueue, and guard failures", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const resume = "abcdef21-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(resume, "starting", {
        job: designJob({
          jobId: resume,
          state: "starting",
          attempt: 0,
          agentCreated: true,
          agentId: resume,
        }),
        creation: { intentHash: DESIGN_HASH, idempotencyKey: `agent-team-design:${resume}` },
      }),
    );
    adapter.agents.set(resume, {
      id: resume,
      labels: {},
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    await service.status({ jobId: resume });
    await until(() => store.records.get(resume)?.job.state === "designing");

    const recent = "abcdef22-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(recent, "fixing", {
        job: designJob({
          jobId: recent,
          state: "fixing",
          attempt: 1,
          agentCreated: true,
          agentId: recent,
        }),
      }),
    );
    await service.status({ jobId: recent });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(recent)?.job.state).toBe("fixing");

    const archive = "abcdef23-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(archive, "designing", {
        job: designJob({
          jobId: archive,
          state: "designing",
          attempt: 1,
          agentCreated: true,
          agentId: archive,
        }),
      }),
    );
    const noAdapter = createDesignService(serviceDeps(store, adapter, { getAdapter: () => null }));
    await noAdapter.onTurnEnded({
      agent: {
        id: archive,
        labels: {
          "agent-team.design": archive,
          "agent-team.design.version": "1",
          "agent-team.design.request-hash": DESIGN_HASH,
        },
      },
      turnId: "55555555-5555-4555-8555-555555555555",
      outcome: { kind: "canceled" },
    });
    await until(() => store.records.get(archive)?.job.state === "needs_continue");
    await noAdapter.dispose();

    adapter.archiveFails = true;
    const archiveFail = "abcdef24-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(archiveFail, "designing", {
        job: designJob({
          jobId: archiveFail,
          state: "designing",
          attempt: 1,
          agentCreated: true,
          agentId: archiveFail,
        }),
      }),
    );
    await service.onTurnEnded({
      agent: {
        id: archiveFail,
        labels: {
          "agent-team.design": archiveFail,
          "agent-team.design.version": "1",
          "agent-team.design.request-hash": DESIGN_HASH,
        },
      },
      turnId: "55555555-5555-4555-8555-555555555555",
      outcome: { kind: "canceled" },
    });
    await until(() => store.records.get(archiveFail)?.job.state === "needs_continue");

    const recheckState = "abcdef26-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(recheckState, "designing", {
        job: designJob({
          jobId: recheckState,
          state: "designing",
          attempt: 1,
          agentCreated: true,
        }),
      }),
    );
    expect(
      await service.continue({
        jobId: recheckState,
        expectedRevision: (await store.get(recheckState))?.job.stateRevision ?? "",
        action: "recheck",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STATE_CHANGED" }] });

    const guard = "abcdef25-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(guard, "needs_continue", {
        job: designJob({
          jobId: guard,
          state: "needs_continue",
          attempt: 1,
          agentCreated: true,
          agentStatus: "running",
        }),
      }),
    );
    expect(
      await service.continue({
        jobId: guard,
        expectedRevision: (await store.get(guard))?.job.stateRevision ?? "",
        action: "repair",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STATE_CHANGED" }] });

    const noAdapterRepair = createDesignService(
      serviceDeps(store, adapter, { getAdapter: () => null }),
    );
    const repair = await noAdapterRepair.continue({
      jobId: guard,
      expectedRevision: (await store.get(guard))?.job.stateRevision ?? "",
      action: "repair",
    });
    expect(repair).toMatchObject({ ok: false });
    await noAdapterRepair.dispose();
    service.enqueueReconcile(guard);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failedStore = new FakeStore();
    failedStore.getFails = true;
    const failed = createDesignService(serviceDeps(failedStore, adapter));
    for (const result of [
      await failed.prepareSave({
        jobId: guard,
        resultId: DESIGN_HASH,
        clientId: "22222222-2222-4222-8222-222222222222",
      }),
      await failed.markSaved({ jobId: guard, resultId: DESIGN_HASH }),
      await failed.saveFailed({
        jobId: guard,
        resultId: DESIGN_HASH,
        leaseId: "44444444-4444-4444-8444-444444444444",
        phase: "team",
        reason: "write-failed",
      }),
      await failed.continue({ jobId: guard, expectedRevision: guard, action: "repair" }),
    ]) {
      expect(result).toMatchObject({ ok: false });
    }
    await failed.dispose();
    await service.dispose();
  });

  test("maps raw store errors and retries revision conflicts", async () => {
    for (const [raw, code] of [
      [{ issue: "corrupt" }, "DESIGN_SETTINGS_INVALID"],
      [{ issue: "too-large" }, "DESIGN_OUTPUT_TOO_LARGE"],
      [{ other: true }, "DESIGN_STORAGE_UNAVAILABLE"],
    ] as const) {
      const store = new FakeStore();
      store.getError = raw;
      const service = createDesignService(serviceDeps(store, new FakeAdapter()));
      expect(await service.status({ jobId: "99999999-9999-4999-8999-999999999999" })).toMatchObject(
        {
          ok: false,
          issues: [{ code }],
        },
      );
      await service.dispose();
    }

    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("missing result");
    store.conflictOnce = true;
    expect(
      await service.prepareSave({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        clientId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toMatchObject({ ok: true });
    const reset = store.records.get(started.job.jobId);
    if (reset) reset.job.state = "ready";
    store.conflictAlways = true;
    expect(
      await service.prepareSave({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        clientId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STORAGE_UNAVAILABLE" }] });
    await service.dispose();
  });

  test("correction expected choices only carry mismatch targets", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const missingSeatPlanner: DesignPlanningPort = {
      ...planner,
      plan(input) {
        const result = planner.plan(input);
        if (result.ok) {
          result.preview.seats = result.preview.seats.filter((seat) => seat.logicalSeatId !== "m2");
        }
        return result;
      },
    };
    const service = createDesignService(
      serviceDeps(store, adapter, { planner: missingSeatPlanner }),
    );
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    const proposal = {
      ...proposalFor(stored),
      profileChoices: [
        { target: "coordinator", profileIds: ["claude-opus-high"], reason: "统筹。" },
        { target: "m1", profileIds: ["claude-opus-high"], reason: "错误选择。" },
        { target: "m2", profileIds: ["claude-opus-high"], reason: "实现。" },
      ],
    };
    adapter.entries = answerFor(stored, proposal);
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => adapter.sent.length === 1);
    const match = /## 准确期望\n(\[.*\])/.exec(adapter.sent[0] ?? "");
    if (!match?.[1]) throw new Error("missing expected choices");
    expect(JSON.parse(match[1])).toEqual([
      { target: "m1", roleId: "architect", expectedProfileIds: ["codex-xhigh"] },
    ]);
    await service.dispose();
  });

  test("agent titles and request excerpts clip by code point", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const request = "😀".repeat(220);
    const started = await service.start(input(request, "11111111-1111-4111-8111-111111111188"));
    if (!started.ok) throw new Error("start failed");
    await until(() => adapter.created.length === 1);
    expect(Array.from(adapter.created[0]?.title ?? "")).toHaveLength(40);
    const stored = await store.get(started.job.jobId);
    expect(Array.from(stored?.job.requestExcerpt ?? "")).toHaveLength(160);
    await service.dispose();
  });

  test("learns turnId and rejects late or unidentified failed hooks", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    const messageId = stored.attempts[0]?.messageId;
    adapter.entries = [
      { seqStart: 1, seqEnd: 1, type: "user_message", messageId },
      { seqStart: 2, seqEnd: 2, type: "assistant_message", text: "不是设计块", turnId: "turn-1" },
    ];
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      turnId: "turn-1",
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.attempt === 2);
    expect(store.records.get(started.job.jobId)?.attempts[0]?.turnId).toBe("turn-1");
    expect(store.records.get(started.job.jobId)?.job.state).toBe("designing");
    expect(adapter.sent).toHaveLength(1);

    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      turnId: "turn-1",
      outcome: { kind: "failed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(started.job.jobId)?.job.state).toBe("designing");

    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "failed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(started.job.jobId)?.job.state).not.toBe("failed");
    await service.dispose();
  });

  test("recovers designing-without-create and claims provider-created agents", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const retry = "abcdef31-2345-4678-8abc-def012345678";
    const retryRequest = {
      agentId: retry,
      idempotencyKey: `agent-team-design:${retry}`,
      workspaceId: "ws-carrier",
      title: "原始请求",
      labels: {
        "agent-team.design": retry,
        "agent-team.design.version": "1",
        "agent-team.design.request-id": "44444444-4444-4444-8444-444444444444",
        "agent-team.design.request-hash": DESIGN_HASH,
        "agent-team.design.mode": "sota",
      },
      profile: { provider: "claude", model: "claude-opus-5-5" },
      systemPrompt: "原始系统提示",
      prompt: "原始首轮消息",
      clientMessageId: "55555555-5555-4555-8555-555555555599",
    };
    const retryRecord = seededJob(retry, "designing", {
      job: designJob({ jobId: retry, state: "designing", attempt: 1, agentCreated: false }),
      creation: {
        intentHash: DESIGN_HASH,
        idempotencyKey: `agent-team-design:${retry}`,
        request: retryRequest,
      },
    });
    await store.create(retryRecord);
    await service.status({ jobId: retry });
    await until(() => store.records.get(retry)?.job.agentCreated === true);
    expect(adapter.created).toHaveLength(1);
    expect(adapter.created[0]).toEqual(retryRequest);

    const claim = "abcdef32-2345-4678-8abc-def012345678";
    const claimRecord = seededJob(claim, "designing", {
      job: designJob({
        jobId: claim,
        state: "designing",
        attempt: 1,
        agentCreated: false,
        agentId: claim,
      }),
    });
    await store.create(claimRecord);
    adapter.agents.set(claim, {
      id: claim,
      labels: {
        "agent-team.design": claim,
        "agent-team.design.version": "1",
        "agent-team.design.request-hash": DESIGN_HASH,
      },
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    await service.status({ jobId: claim });
    await until(() => store.records.get(claim)?.job.agentCreated === true);
    expect(store.records.get(claim)?.attempts[0]?.ack).toBe("acked");
    expect(adapter.created.map((item) => item.agentId)).toEqual([retry]);

    const cancelUncreated = "abcdef33-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(cancelUncreated, "designing", {
        job: designJob({
          jobId: cancelUncreated,
          state: "designing",
          attempt: 1,
          agentCreated: false,
          agentId: cancelUncreated,
        }),
      }),
    );
    const canceled = await service.cancel({ jobId: cancelUncreated });
    expect(canceled).toMatchObject({ ok: true, job: { state: "canceled" } });

    const cancelCreated = "abcdef34-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(cancelCreated, "designing", {
        job: designJob({
          jobId: cancelCreated,
          state: "designing",
          attempt: 1,
          agentCreated: false,
          agentId: cancelCreated,
        }),
      }),
    );
    adapter.agents.set(cancelCreated, {
      id: cancelCreated,
      labels: {
        "agent-team.design": cancelCreated,
        "agent-team.design.version": "1",
        "agent-team.design.request-hash": DESIGN_HASH,
      },
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    const canceledWithAgent = await service.cancel({ jobId: cancelCreated });
    expect(canceledWithAgent).toMatchObject({ ok: true, job: { state: "canceled" } });
    expect(adapter.archived).toContain(cancelCreated);
    await service.dispose();
  });

  test("settles a late uncertain create and rejects repair before confirmation", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const jobId = "abcdef37-2345-4678-8abc-def012345678";
    const request = retryRequestFor(jobId);
    const record = seededJob(jobId, "needs_continue", {
      job: designJob({
        jobId,
        state: "needs_continue",
        attempt: 1,
        agentCreated: false,
        agentId: jobId,
      }),
      creation: {
        intentHash: DESIGN_HASH,
        idempotencyKey: `agent-team-design:${jobId}`,
        request,
      },
      outcomeUnknown: true,
    });
    await store.create(record);
    expect(
      await service.continue({
        jobId,
        expectedRevision: record.job.stateRevision,
        action: "repair",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ code: "DESIGN_RECOVERY_INCOMPLETE", action: "refresh" }],
    });
    await service.status({ jobId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(jobId)?.job.state).toBe("needs_continue");

    adapter.agents.set(jobId, {
      id: jobId,
      labels: request.labels,
      status: "running",
      activeTurn: true,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    await service.status({ jobId });
    await until(() => store.records.get(jobId)?.job.agentCreated === true);
    expect(store.records.get(jobId)?.job.state).toBe("designing");
    expect(store.records.get(jobId)?.creation?.request).toBeFalsy();
    await service.dispose();
  });

  test("authorizes canceled cleanup only for written roles", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    const role = newDesignRole({ id: "eng-observability", name: "【工程】可观测" });
    const base = proposalFor(stored);
    const proposal = {
      ...base,
      team: {
        ...base.team,
        members: base.team.members.map((member) =>
          member.key === "m2" ? { ...member, roleId: role.id } : member,
        ),
      },
      newRoles: [role],
      reuse: base.reuse.filter((entry) => entry.roleId !== "developer"),
    };
    adapter.entries = answerFor(stored, proposal);
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (ready?.result?.newRoles.length !== 1) throw new Error("missing new role");
    const written = ready.result.newRoles[0];
    if (!written) throw new Error("missing written role");
    const clientId = "22222222-2222-4222-8222-222222222222";
    const prepared = await service.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId,
    });
    if (!prepared.ok || prepared.prepared.outcome !== "write") throw new Error("prepare failed");
    await service.saveFailed({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      leaseId: prepared.prepared.lease.id,
      phase: "team",
      reason: "canceled",
    });
    expect(store.records.get(ready.job.jobId)?.job).toMatchObject({
      saveState: "roles-only",
      needsCleanup: true,
    });
    await service.cancel({ jobId: ready.job.jobId });
    const canceled = await store.get(ready.job.jobId);
    expect(canceled?.job).toMatchObject({
      state: "canceled",
      cancelRequested: true,
      saveState: "roles-only",
      needsCleanup: true,
    });
    const cleaner = createDesignService(
      serviceDeps(store, adapter, {
        readers: readers({
          roles: [...[techLead, architect, developer], written],
          teams: [codingTeam],
        }),
      }),
    );
    const cleanup = await cleaner.prepareSave({
      jobId: ready.job.jobId,
      resultId: ready.result.resultId,
      clientId,
      intent: "compensate",
    });
    expect(cleanup).toMatchObject({
      ok: true,
      prepared: { outcome: "compensate", removableRoleIds: [written.id] },
    });
    expect(
      await cleaner.prepareSave({
        jobId: ready.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        intent: "save",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_STATE_CHANGED" }] });

    const live = store.records.get(ready.job.jobId);
    if (!live) throw new Error("missing live");
    live.outcomeUnknown = true;
    live.job.state = "canceled";
    live.job.cancelRequested = true;
    live.job.needsCleanup = true;
    live.job.saveState = "roles-only";
    live.leaseOwner = null;
    live.job.saveLeaseExpiresAt = null;
    expect(
      await cleaner.prepareSave({
        jobId: ready.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        intent: "compensate",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_UNKNOWN" }] });

    live.outcomeUnknown = false;
    live.leaseOwner = JSON.stringify({ clientId, leaseId: "44444444-4444-4444-8444-444444444444" });
    live.job.saveLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(
      await cleaner.prepareSave({
        jobId: ready.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        intent: "compensate",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_BUSY" }] });
    await cleaner.dispose();
    await service.dispose();
  });

  test("does not authorize canceled cleanup without written roles", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("missing result");
    await service.cancel({ jobId: ready.job.jobId });
    expect(store.records.get(ready.job.jobId)?.job).toMatchObject({
      state: "canceled",
      needsCleanup: false,
    });
    expect(
      await service.prepareSave({
        jobId: ready.job.jobId,
        resultId: ready.result.resultId,
        clientId: "22222222-2222-4222-8222-222222222222",
        intent: "compensate",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_NOT_SAVED" }] });
    await service.dispose();
  });

  test("records create before dispatch and recovers uncertain create errors", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    adapter.profilesValue = [
      { ...DESIGNER, featureValues: { token: "FEATURE_SECRET_VALUE" } },
      claudeOpus,
      codexXhigh,
    ];
    adapter.delayCreate = true;
    adapter.createFails = true;
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(
      input("创建失败但已存在", "11111111-1111-4111-8111-111111111177"),
    );
    if (!started.ok) throw new Error("start failed");
    await adapter.createStarted.promise;
    const stored = await store.get(started.job.jobId);
    if (!stored?.creation?.request) throw new Error("create request not persisted before dispatch");
    expect(stored.creation.request.agentId).toBe(started.job.jobId);
    expect(stored.creation.request.prompt.length).toBeGreaterThan(0);
    expect(stored.creation.request.profile.featureValues).toEqual({
      token: "FEATURE_SECRET_VALUE",
    });
    const originalPrompt = stored.creation.request.prompt;
    const originalSystemPrompt = stored.creation.request.systemPrompt;
    adapter.agents.set(started.job.jobId, {
      id: started.job.jobId,
      labels: stored.creation.request.labels,
      status: "idle",
      activeTurn: false,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    adapter.releaseCreate.resolve();
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    expect(store.records.get(started.job.jobId)?.job.state).toBe("designing");
    expect(adapter.archived).toHaveLength(0);
    const settled = store.records.get(started.job.jobId);
    expect(settled?.creation?.request).toBeFalsy();
    const settledJson = JSON.stringify(settled);
    expect(settledJson).not.toContain("FEATURE_SECRET_VALUE");
    expect(settledJson).not.toContain(originalPrompt);
    expect(settledJson).not.toContain(originalSystemPrompt);

    const terminal = "abcdef36-2345-4678-8abc-def012345678";
    const terminalRequest = {
      ...retryRequestFor(terminal),
      profile: { provider: "claude", featureValues: { token: "FEATURE_SECRET_VALUE" } },
      prompt: "TERMINAL_SECRET_PROMPT",
      systemPrompt: "TERMINAL_SECRET_SYSTEM",
    };
    await store.create(
      seededJob(terminal, "needs_continue", {
        job: designJob({
          jobId: terminal,
          state: "needs_continue",
          attempt: 1,
          agentCreated: false,
          agentId: terminal,
        }),
        creation: {
          intentHash: DESIGN_HASH,
          idempotencyKey: `agent-team-design:${terminal}`,
          request: terminalRequest,
        },
      }),
    );
    await service.cancel({ jobId: terminal });
    const terminalRecord = store.records.get(terminal);
    expect(terminalRecord?.creation?.request).toBeFalsy();
    expect(JSON.stringify(terminalRecord)).not.toContain("FEATURE_SECRET_VALUE");
    expect(JSON.stringify(terminalRecord)).not.toContain("TERMINAL_SECRET_PROMPT");

    adapter.delayCreate = false;
    adapter.createFails = false;
    adapter.createError = new Error("agent_request_key_conflict");
    const uncertain = await service.start(
      input("未知创建结果", "11111111-1111-4111-8111-111111111176"),
    );
    if (!uncertain.ok) throw new Error("start failed");
    await until(() => store.records.get(uncertain.job.jobId)?.job.state === "needs_continue");
    expect(store.records.get(uncertain.job.jobId)?.job.state).not.toBe("failed");
    expect(store.records.get(uncertain.job.jobId)?.outcomeUnknown).toBe(true);
    await service.dispose();
  });

  test("clears unknown after readback and rejects compensation under any live lease", async () => {
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const started = await service.start(input());
    if (!started.ok) throw new Error("start failed");
    await until(() => store.records.get(started.job.jobId)?.job.agentCreated === true);
    const stored = await store.get(started.job.jobId);
    if (!stored) throw new Error("missing");
    adapter.entries = answerFor(stored, proposalFor(stored));
    await service.onTurnEnded({
      agent: { id: started.job.jobId, labels: adapter.agents.get(started.job.jobId)?.labels },
      turnId: stored.attempts[0]?.messageId,
      outcome: { kind: "completed" },
    });
    await until(() => store.records.get(started.job.jobId)?.job.state === "ready");
    const ready = await store.get(started.job.jobId);
    if (!ready?.result) throw new Error("missing result");
    const clientId = "22222222-2222-4222-8222-222222222222";
    const prepared = await service.prepareSave({
      jobId: started.job.jobId,
      resultId: ready.result.resultId,
      clientId,
    });
    if (!prepared.ok || prepared.prepared.outcome !== "write") throw new Error("prepare failed");
    expect(
      await service.prepareSave({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        intent: "compensate",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_BUSY" }] });
    await service.saveFailed({
      jobId: started.job.jobId,
      resultId: ready.result.resultId,
      leaseId: prepared.prepared.lease.id,
      phase: "team",
      reason: "unknown",
    });
    expect(store.records.get(started.job.jobId)?.job.saveState).toBe("unknown");
    expect(
      await service.prepareSave({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        intent: "compensate",
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_SAVE_UNKNOWN" }] });
    await service.markSaved({
      jobId: started.job.jobId,
      resultId: ready.result.resultId,
      leaseId: prepared.prepared.lease.id,
    });
    expect(store.records.get(started.job.jobId)?.outcomeUnknown).toBe(false);
    expect(store.records.get(started.job.jobId)?.job.saveState).not.toBe("unknown");
    expect(
      await service.prepareSave({
        jobId: started.job.jobId,
        resultId: ready.result.resultId,
        clientId,
        intent: "compensate",
      }),
    ).toMatchObject({ ok: true, prepared: { outcome: "compensate" } });
    await service.dispose();
  });

  test("uses the pending send timestamp rather than polling writes", async () => {
    let now = Date.parse("2026-10-26T00:00:20.000Z");
    const clock = { now: () => new Date(now).toISOString() };
    const store = new FakeStore();
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter, { clock }));
    const jobId = "abcdef35-2345-4678-8abc-def012345678";
    await store.create(
      seededJob(jobId, "fixing", {
        job: designJob({
          jobId,
          state: "fixing",
          attempt: 1,
          agentCreated: true,
          agentId: jobId,
          agentStatus: "initializing",
          updatedAt: new Date(now).toISOString(),
        }),
        attempts: [
          {
            attempt: 1,
            nonce: "b".repeat(32),
            messageId: "55555555-5555-4555-8555-555555555588",
            promptHash: DESIGN_HASH,
            epoch: null,
            endCursor: null,
            summary: null,
            ack: "pending",
            sentAt: "2026-10-26T00:00:00.000Z",
          },
        ],
      }),
    );
    adapter.agents.set(jobId, {
      id: jobId,
      labels: {
        "agent-team.design": jobId,
        "agent-team.design.version": "1",
        "agent-team.design.request-hash": DESIGN_HASH,
      },
      status: "running",
      activeTurn: true,
      archivedAt: null,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      lastError: null,
      providerUnavailable: false,
    });
    adapter.entries = [];
    await service.status({ jobId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get(jobId)?.job.state).toBe("fixing");
    now += 11_000;
    await service.status({ jobId });
    await until(() => store.records.get(jobId)?.job.state === "needs_continue");
    await service.dispose();
  });

  test("hooks forward turnId to the service", async () => {
    const seen: Array<string | null | undefined> = [];
    const hooks = createDesignHooks({
      service: {
        async onTurnEnded(event) {
          seen.push(event.turnId);
        },
      },
    });
    await hooks.onTurnEnded({
      agent: {
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
        labels: {
          "agent-team.design": "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
          "agent-team.design.version": "1",
        },
      },
      turnId: "turn-9",
    });
    expect(seen).toEqual(["turn-9"]);
  });

  test("hooks log a rejected service callback", async () => {
    const messages: string[] = [];
    const hooks = createDesignHooks({
      service: {
        async onTurnEnded() {
          throw new Error("hook failed");
        },
      },
      log: (message) => messages.push(message),
    });
    const event = {
      agent: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        labels: {
          "agent-team.design": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          "agent-team.design.version": "1",
        },
      },
    };
    await hooks.onTurnEnded(event);
    expect(messages).toEqual(["design turn-ended hook failed"]);
    const silent = createDesignHooks({
      service: {
        async onTurnEnded() {
          throw new Error("hook failed");
        },
      },
    });
    await silent.onTurnEnded(event);
  });

  test("scope status reports store problems and unowned hooks exit", async () => {
    const store = new FakeStore();
    store.problemsValue = [{ name: "bad.json", reason: "corrupt" }];
    const adapter = new FakeAdapter();
    const service = createDesignService(serviceDeps(store, adapter));
    const status = await service.status({});
    expect(status).toMatchObject({
      ok: true,
      discoveryIssues: [{ code: "DESIGN_RECOVERY_INCOMPLETE" }],
    });
    await service.dispose();
  });
});
