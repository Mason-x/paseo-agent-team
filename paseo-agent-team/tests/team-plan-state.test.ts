import { describe, expect, test, vi } from "vitest";
import {
  buildTeamModelRows,
  buildTeamPlanIssues,
  buildTeamSummaries,
  buildTeamSummary,
  createTeamPlanClient,
  draftInputProblem,
  draftRowKey,
  familyHintsFromEconomy,
  isMethodNotFound,
  modelRowMeta,
  shouldShowPlanError,
  stableJson,
  TEAM_PLAN_DEBOUNCE_MS,
  type TeamPlanRevisions,
  type TeamPlanScope,
} from "../client/teams/team-plan-state";
import type { PaseoProfile } from "../shared/paseo/adapter";
import type { Team } from "../shared/schemas/team";
import {
  TEAM_PLAN_SCHEMA_VERSION,
  type TeamPlanInput,
  type TeamPlanOutput,
  type TeamPlanResult,
  type TeamPlanRow,
} from "../shared/schemas/team-plan";
import { codingTeam } from "./fixtures";

const revisions: TeamPlanRevisions = { roles: "r1", teams: "t1", preferences: "p1" };
const profiles: PaseoProfile[] = [
  { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" },
  { id: "p-opus", name: "Opus", provider: "claude", model: "opus" },
];
const scope: TeamPlanScope = { hostId: "host-1", profiles, revisions };

function row(overrides: Partial<TeamPlanRow> = {}): TeamPlanRow {
  return {
    rowKey: "member:0",
    kind: "member",
    roleId: "developer",
    roleName: "Developer",
    tier: "execution",
    enabled: true,
    profile: { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" },
    source: "role-preferred",
    budget: "sota",
    budgetBasis: "host",
    availability: "available",
    configuredProfiles: [],
    issues: [],
    ...overrides,
  };
}

function result(key: string, overrides: Partial<TeamPlanResult> = {}): TeamPlanResult {
  return {
    key,
    status: "ready",
    effectiveMode: "sota",
    selectionFingerprint: "fp",
    rows: [row()],
    issues: [],
    ...overrides,
  };
}

function output(
  results: TeamPlanResult[],
  options: {
    modeContract?: number;
    checkedAt?: string;
    context?: TeamPlanOutput["context"];
  } = {},
): TeamPlanOutput {
  return {
    schemaVersion: TEAM_PLAN_SCHEMA_VERSION,
    capabilities: {
      modeContract: options.modeContract ?? 2,
      designRolePolicy: 1,
      supportedModes: ["sota", "economy", "economy-all", "collaborative"],
      runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
    },
    checkedAt: options.checkedAt ?? "2026-10-01T10:00:00.000Z",
    context:
      options.context === undefined
        ? {
            revisions,
            profilesFingerprint: "pf",
            availabilityFingerprint: "af",
          }
        : options.context,
    results,
  };
}

function teams(count: number): Team[] {
  return Array.from({ length: count }, (_, index) => ({
    ...codingTeam,
    id: `team-${index + 1}`,
    name: `Team ${index + 1}`,
  }));
}

function clock() {
  let now = 0;
  let serial = 0;
  const timers: Array<{ id: number; at: number; run: () => void; done: boolean }> = [];
  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => {
      serial += 1;
      timers.push({ id: serial, at: now + ms, run, done: false });
      return serial;
    },
    cancel: (handle: unknown) => {
      const timer = timers.find((entry) => entry.id === handle);
      if (timer) timer.done = true;
    },
    advance: (ms: number) => {
      now += ms;
      for (const timer of [...timers].sort((left, right) => left.at - right.at)) {
        if (timer.done || timer.at > now) continue;
        timer.done = true;
        timer.run();
      }
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function pendingSend() {
  const calls: TeamPlanInput[] = [];
  const waiters: Array<{
    resolve: (value: TeamPlanOutput) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const send = (input: TeamPlanInput) => {
    calls.push(input);
    const { promise, resolve, reject } = Promise.withResolvers<TeamPlanOutput>();
    waiters.push({ resolve, reject });
    return promise;
  };
  return {
    send,
    calls,
    resolve(index: number, value: TeamPlanOutput) {
      waiters[index]?.resolve(value);
    },
    reject(index: number, reason: unknown) {
      waiters[index]?.reject(reason);
    },
  };
}

function autoSend() {
  const calls: TeamPlanInput[] = [];
  const send = vi.fn(async (input: TeamPlanInput) => {
    calls.push(input);
    return output(input.items.map((item) => result(item.key)));
  });
  return { send, calls };
}

describe("saved batch", () => {
  test("ten Teams make one request and a cache hit makes none", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.planTeams(teams(10));
    await flush();
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.items).toHaveLength(10);
    expect(client.getBatchView().results.size).toBe(10);
    expect(client.getBatchView().modeContract).toBe("v2");

    client.planTeams(teams(10));
    await flush();
    expect(port.calls).toHaveLength(1);

    fake.advance(60_001);
    client.planTeams(teams(10));
    await flush();
    expect(port.calls).toHaveLength(2);
  });

  test("twenty-one Teams split in two chunks with at most two in flight", async () => {
    const fake = clock();
    const port = pendingSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
      chunkSize: 20,
      maxConcurrent: 2,
    });
    client.setScope(scope);
    client.planTeams(teams(21));
    await flush();
    expect(port.calls).toHaveLength(2);
    expect(port.calls[0]?.items).toHaveLength(20);
    expect(port.calls[1]?.items).toHaveLength(1);

    port.resolve(0, output(port.calls[0]?.items.map((item) => result(item.key)) ?? []));
    await flush();
    expect(port.calls).toHaveLength(2);
    const second = port.calls[1];
    if (second) port.resolve(1, output(second.items.map((item) => result(item.key))));
    await flush();
    expect(client.getBatchView().results.size).toBe(21);
  });

  test("a scope change invalidates results and the cache", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.planTeams(teams(2));
    await flush();
    expect(client.getBatchView().results.size).toBe(2);
    client.setScope({ ...scope, revisions: { ...revisions, teams: "t2" } });
    expect(client.getBatchView().results.size).toBe(0);
    client.planTeams(teams(2));
    await flush();
    expect(port.calls).toHaveLength(2);

    // A Profile runtime tuple change is its own cache key.
    client.setScope({
      ...scope,
      profiles: [
        ...profiles,
        { id: "p-third", name: "Third", provider: "claude", model: "claude-haiku-4-5" },
      ],
    });
    expect(client.getBatchView().results.size).toBe(0);
    client.planTeams(teams(2));
    await flush();
    expect(port.calls).toHaveLength(3);
  });

  test("legacy is silent and unknown is retryable", async () => {
    const fake = clock();
    const legacySend = vi.fn(async () => {
      throw new Error("rpc method not found");
    });
    const legacy = createTeamPlanClient({
      send: legacySend,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    legacy.setScope(scope);
    legacy.probe();
    await flush();
    expect(legacy.getBatchView().modeContract).toBe("legacy");
    expect(legacy.getBatchView().loaded).toBe(true);
    legacy.planTeams(teams(1));
    expect(legacySend).toHaveBeenCalledTimes(1);

    const brokenSend = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const unknown = createTeamPlanClient({
      send: brokenSend,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    unknown.setScope(scope);
    unknown.probe();
    await flush();
    expect(unknown.getBatchView().modeContract).toBe("unknown");
    expect(unknown.getBatchView().error).toBeTruthy();
  });

  test("the empty list probes once per scope", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.probe();
    client.probe();
    await flush();
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.items).toEqual([]);
  });
});

describe("draft debounce and identity", () => {
  const draft = (
    overrides: Partial<Parameters<ReturnType<typeof createTeamPlanClient>["requestDraft"]>[0]> = {},
  ) => ({
    sessionId: "session-1",
    mode: "sota",
    coordinatorRoleId: "tech-lead",
    members: [
      { rowKey: "member:0", roleId: "developer", enabled: true },
      { rowKey: "seat:abc", roleId: "architect", enabled: false },
    ],
    ...overrides,
  });

  test("199ms waits and 200ms sends the minimal draft shape", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft(
      draft({ members: [{ rowKey: "member:0", roleId: "developer", enabled: true }] }),
    );
    fake.advance(TEAM_PLAN_DEBOUNCE_MS - 1);
    await flush();
    expect(port.calls).toHaveLength(0);
    fake.advance(1);
    await flush();
    expect(port.calls).toHaveLength(1);
    const item = port.calls[0]?.items[0];
    expect(item).toMatchObject({
      kind: "draft",
      draft: {
        mode: "sota",
        coordinatorRoleId: "tech-lead",
        members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
      },
    });
    expect(JSON.stringify(port.calls[0])).not.toContain("seatId");
    expect(client.getDraftState("session-1").status).toBe("result");
  });

  test("a newer edit cancels the pending request", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft(draft());
    fake.advance(100);
    client.requestDraft(draft({ mode: "economy" }));
    fake.advance(200);
    await flush();
    expect(port.calls).toHaveLength(1);
    const item = port.calls[0]?.items[0];
    if (item?.kind !== "draft") throw new Error("expected a draft item");
    expect(item.draft.mode).toBe("economy");
  });

  test("an older response never overwrites the latest one", async () => {
    const fake = clock();
    const port = pendingSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft(draft({ mode: "sota" }));
    fake.advance(TEAM_PLAN_DEBOUNCE_MS);
    await flush();
    client.requestDraft(draft({ mode: "economy" }));
    fake.advance(TEAM_PLAN_DEBOUNCE_MS);
    await flush();
    expect(port.calls).toHaveLength(2);

    const newest = port.calls[1]?.items[0];
    port.resolve(
      1,
      output([
        result(newest?.key ?? "newest", {
          effectiveMode: "economy",
          rows: [row({ rowKey: "coordinator", kind: "coordinator", seatId: "coordinator" })],
        }),
      ]),
    );
    await flush();
    const first = port.calls[0]?.items[0];
    port.resolve(0, output([result(first?.key ?? "first", { effectiveMode: "sota", rows: [] })]));
    await flush();
    const state = client.getDraftState("session-1");
    expect(state.status).toBe("result");
    if (state.status === "result") expect(state.result.effectiveMode).toBe("economy");
  });

  test("a reserved or duplicate row key is rejected before any request", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft(
      draft({ members: [{ rowKey: "coordinator", roleId: "tech-lead", enabled: true }] }),
    );
    expect(client.getDraftState("session-1")).toMatchObject({
      status: "error",
      reason: "invalid",
    });
    client.requestDraft(
      draft({
        sessionId: "session-2",
        members: [
          { rowKey: "member:0", roleId: "a", enabled: true },
          { rowKey: "member:0", roleId: "b", enabled: true },
        ],
      }),
    );
    expect(client.getDraftState("session-2")).toMatchObject({ status: "error", reason: "invalid" });
    await flush();
    expect(port.calls).toHaveLength(0);
  });
});

describe("view models", () => {
  test("the missing-Team signal needs a context and an empty issue list", () => {
    const missing = result("t", {
      status: "unavailable",
      effectiveMode: null,
      rows: [],
      issues: [],
    });
    expect(buildTeamSummary({ result: missing, hasContext: true })).toEqual({
      kind: "missing-team",
      text: expect.any(String),
    });
    expect(buildTeamSummary({ result: missing, hasContext: false }).kind).toBe("unavailable");
  });

  test("an unknown mode keeps the raw value and never counts rows", () => {
    const summary = buildTeamSummary({
      result: result("t", { status: "blocked", effectiveMode: null, rawMode: "turbo" }),
      hasContext: true,
    });
    expect(summary.kind).toBe("unknown-mode");
    if (summary.kind === "unknown-mode") expect(summary.text).toContain("turbo");
  });

  test("summary counts the coordinator, standby seats, and unresolved reasons", () => {
    const summary = buildTeamSummary({
      result: result("t", {
        status: "blocked",
        rows: [
          row({
            rowKey: "coordinator",
            kind: "coordinator",
            profile: { id: "p-opus", name: "Opus", provider: "claude", model: "opus" },
            budget: "sota",
          }),
          row({
            rowKey: "seat:a",
            activation: "escalation-only",
            profile: {
              id: "p-sonnet",
              name: "Sonnet",
              provider: "claude",
              model: "claude-sonnet-4-6",
            },
          }),
          row({
            rowKey: "member:1",
            profile: null,
            budget: "unknown",
            budgetBasis: "conservative-default",
          }),
          row({ rowKey: "member:2", enabled: false, profile: null }),
        ],
      }),
      hasContext: true,
    });
    expect(summary.kind).toBe("summary");
    if (summary.kind !== "summary") return;
    expect(summary.total).toBe(3);
    expect(summary.groupsText).toContain("Opus ×1");
    expect(summary.groupsText).toContain("待命 1");
    expect(summary.unresolvedText).toContain("未解析 ×1");
    expect(summary.tone).toBe("warning");
  });

  test("rows keep unknown sources, disabled states, and pool entry points", () => {
    const views = buildTeamModelRows({
      result: result("t", {
        status: "blocked",
        effectiveMode: "economy-all",
        rows: [
          row({
            rowKey: "member:0",
            source: "custom-source",
            route: "execution",
            profile: null,
            budget: "unknown",
            issues: [
              {
                code: "MODE_CHEAP_ROUTE_UNAVAILABLE",
                severity: "blocker",
                params: { route: "execution", reason: "route-empty" },
              },
            ],
          }),
          row({ rowKey: "member:1", enabled: false, profile: null }),
          row({
            rowKey: "member:2",
            profile: null,
            configuredProfiles: [
              { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" },
            ],
            issues: [
              {
                code: "MODE_PROFILE_UNRESOLVED",
                severity: "blocker",
                roleId: "developer",
                params: { reason: "all-missing" },
              },
            ],
          }),
        ],
      }),
      labels: new Map([["member:0", "Backend"]]),
    });
    const pooled = views[0];
    expect(pooled?.source).toBe("custom-source");
    expect(pooled?.instanceLabel).toBe("Backend");
    expect(pooled?.actions).toEqual([{ kind: "economy", layer: "allSeats", route: "execution" }]);
    expect(pooled?.reasons[0]).toContain("路由");
    expect(views[1]?.enabled).toBe(false);
    expect(views[1]?.actions).toEqual([]);
    expect(views[2]?.actions).toEqual([
      { kind: "role", roleId: "developer", profileId: "p-sonnet" },
    ]);
  });

  test("a standard-mode pool problem targets the standard pool", () => {
    const views = buildTeamModelRows({
      result: result("t", {
        status: "blocked",
        effectiveMode: "economy",
        rows: [
          row({
            rowKey: "member:0",
            profile: null,
            configuredProfiles: [
              { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" },
            ],
            issues: [
              { code: "MODE_POOL_EMPTY", severity: "warning", params: {} },
              {
                code: "MODE_PROFILE_UNRESOLVED",
                severity: "blocker",
                roleId: "developer",
                params: { reason: "provider-unavailable" },
              },
            ],
          }),
        ],
      }),
    });
    expect(views[0]?.actions).toContainEqual({ kind: "economy", layer: "standard" });
    expect(views[0]?.actions).toContainEqual({
      kind: "role",
      roleId: "developer",
      profileId: "p-sonnet",
    });
  });

  test("result issues are surfaced once and row keys follow the stored identity", () => {
    const issues = buildTeamPlanIssues(
      result("t", {
        issues: [
          { code: "MODE_MEMBER_LIMIT", severity: "blocker", params: { members: 5, limit: 4 } },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("blocker");
    expect(draftRowKey({ seatId: "abc" }, 3)).toBe("seat:abc");
    expect(draftRowKey({}, 3)).toBe("member:3");
    expect(
      draftInputProblem({
        sessionId: "s",
        members: [{ rowKey: "coordinator", enabled: true }],
      }),
    ).toBe("reserved-coordinator");
  });
});

describe("family hints", () => {
  test("only live tuple-matched explicit classifications become hints", () => {
    const hints = familyHintsFromEconomy(
      {
        pool: [
          {
            profileId: "p-sonnet",
            family: "sonnet",
            enabled: true,
            boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
          },
          {
            profileId: "p-opus",
            family: "sonnet",
            enabled: true,
            boundModel: { provider: "claude", model: "different" },
          },
          {
            profileId: "p-auto",
            family: "sonnet",
            enabled: true,
            boundModel: { provider: "claude", model: "auto" },
          },
        ],
        allSeats: {
          version: 1,
          profiles: [
            {
              profileId: "p-sonnet",
              enabled: true,
              costClass: "low",
              family: "sonnet",
              boundModel: { provider: "claude", model: "claude-sonnet-4-6" },
            },
          ],
          routes: {},
        },
      },
      [...profiles, { id: "p-auto", name: "Auto", provider: "claude", model: "auto" }],
    );
    expect(hints).toEqual([
      {
        profileId: "p-sonnet",
        provider: "claude",
        model: "claude-sonnet-4-6",
        family: "sonnet",
      },
    ]);
  });

  test("stableJson ignores key order", () => {
    expect(stableJson({ a: 1, b: { c: 2, d: 3 } })).toBe(stableJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe("rework 1 regressions", () => {
  test("I1: a scope change replans the same saved list without a new array", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.setActive(true);
    const list = teams(3);
    client.planTeams(list);
    await flush();
    expect(port.calls).toHaveLength(1);
    client.setScope({ ...scope, revisions: { ...revisions, preferences: "p2" } });
    await flush();
    expect(port.calls).toHaveLength(2);
    expect(client.getBatchView().results.size).toBe(3);
  });

  test("I2: invalidate re-requests the active draft", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft({
      sessionId: "editor",
      mode: "sota",
      coordinatorRoleId: "tech-lead",
      members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
    });
    fake.advance(200);
    await flush();
    expect(port.calls).toHaveLength(1);
    client.invalidate();
    fake.advance(200);
    await flush();
    expect(port.calls).toHaveLength(2);
    expect(client.getDraftState("editor").status).toBe("result");
  });

  test("I3/D1: an older draft failure cannot overwrite the newer result", async () => {
    const fake = clock();
    const port = pendingSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    const draft = (mode: string) => ({
      sessionId: "editor",
      mode,
      coordinatorRoleId: "tech-lead",
      members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
    });
    client.requestDraft(draft("sota"));
    fake.advance(200);
    await flush();
    client.requestDraft(draft("economy"));
    fake.advance(200);
    await flush();
    const newest = port.calls[1]?.items[0];
    port.resolve(1, output([result(newest?.key ?? "newest", { effectiveMode: "economy" })]));
    await flush();
    port.reject(0, new Error("socket hang up"));
    await flush();
    const state = client.getDraftState("editor");
    expect(state.status).toBe("result");
    if (state.status === "result") expect(state.result.effectiveMode).toBe("economy");
  });

  test("I3/S1: an older saved batch failure cannot delete the newer batch results", async () => {
    const fake = clock();
    const port = pendingSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.planTeams([teams(1)[0] as Team]);
    await flush();
    client.planTeams(teams(2));
    await flush();
    port.resolve(1, output(port.calls[1]?.items.map((item) => result(item.key)) ?? []));
    await flush();
    port.reject(0, new Error("socket hang up"));
    await flush();
    const view = client.getBatchView();
    expect(view.results.has("team-1")).toBe(true);
    expect(view.results.has("team-2")).toBe(true);
    expect(view.failedKeys.has("team-1")).toBe(false);
  });

  test("I3/D2: an invalid draft advances the identity and blocks an older success", async () => {
    const fake = clock();
    const port = pendingSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft({
      sessionId: "editor",
      mode: "sota",
      members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
    });
    fake.advance(200);
    await flush();
    client.requestDraft({
      sessionId: "editor",
      mode: "sota",
      members: [{ rowKey: "coordinator", roleId: "tech-lead", enabled: true }],
    });
    const firstKey = port.calls[0]?.items[0]?.key;
    port.resolve(0, output([result(firstKey ?? "old")]));
    await flush();
    expect(client.getDraftState("editor")).toMatchObject({
      status: "error",
      reason: "invalid",
    });
  });

  test("I3/unmount: cancelDraft drops an in-flight response", async () => {
    const fake = clock();
    const port = pendingSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.requestDraft({
      sessionId: "editor",
      mode: "sota",
      members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
    });
    fake.advance(200);
    await flush();
    client.cancelDraft("editor");
    const key = port.calls[0]?.items[0]?.key;
    port.resolve(0, output([result(key ?? "old")]));
    await flush();
    expect(client.getDraftState("editor")).toEqual({ status: "idle" });
  });

  test("I4: capability resets on host change and only a method-shaped 404 is legacy", async () => {
    const fake = clock();
    let host = "A";
    let calls = 0;
    const client = createTeamPlanClient({
      send: async () => {
        calls += 1;
        if (host === "A") throw new Error("method not found: agent-team.team.plan");
        return output([]);
      },
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.probe();
    await flush();
    expect(client.modeContract()).toBe("legacy");

    host = "B";
    client.setScope({ ...scope, hostId: "host-2" });
    expect(client.modeContract()).toBe("unknown");
    client.probe();
    await flush();
    expect(calls).toBe(2);
    expect(client.modeContract()).toBe("v2");

    expect(isMethodNotFound(new Error("transport: host not registered"))).toBe(false);
    expect(isMethodNotFound(new Error("rpc method not found"))).toBe(true);
    expect(isMethodNotFound(new Error("host is not registered"))).toBe(false);
  });

  test("I4: renegotiate lets a same-host upgrade escape legacy", async () => {
    const fake = clock();
    let upgraded = false;
    let calls = 0;
    const client = createTeamPlanClient({
      send: async () => {
        calls += 1;
        if (!upgraded) throw new Error("method not found: agent-team.team.plan");
        return output([]);
      },
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.probe();
    await flush();
    expect(client.modeContract()).toBe("legacy");
    upgraded = true;
    client.renegotiate();
    await flush();
    expect(client.modeContract()).toBe("v2");
    expect(calls).toBe(2);
  });

  test("I5: a visible list refreshes after 60s; hidden pauses; stale resume refreshes", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: port.send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.setActive(true);
    client.planTeams(teams(2));
    await flush();
    expect(port.calls).toHaveLength(1);
    fake.advance(60_000);
    await flush();
    expect(port.calls).toHaveLength(2);

    client.setActive(false);
    fake.advance(120_000);
    await flush();
    expect(port.calls).toHaveLength(2);

    client.setActive(true);
    await flush();
    expect(port.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("I6: a cheap-route outage never offers Role rebinding and keeps the route", () => {
    const views = buildTeamModelRows({
      result: result("t", {
        status: "blocked",
        effectiveMode: "economy-all",
        rows: [
          row({
            rowKey: "member:0",
            route: undefined,
            profile: null,
            issues: [
              {
                code: "MODE_CHEAP_ROUTE_UNAVAILABLE",
                severity: "blocker",
                params: { route: "execution", reason: "provider-unavailable" },
              },
            ],
          }),
        ],
      }),
    });
    expect(views[0]?.actions).toEqual([{ kind: "economy", layer: "allSeats", route: "execution" }]);
  });

  test("I7: null rows distinguish disabled, unbound, and blocked selections", () => {
    const views = buildTeamModelRows({
      result: result("t", {
        status: "blocked",
        effectiveMode: "economy",
        rows: [
          row({ rowKey: "a", enabled: false, profile: null }),
          row({
            rowKey: "b",
            profile: null,
            issues: [
              {
                code: "MODE_PROFILE_UNRESOLVED",
                severity: "blocker",
                params: { reason: "no-candidates" },
              },
            ],
          }),
          row({
            rowKey: "d",
            profile: null,
            issues: [
              {
                code: "MODE_PROFILE_UNRESOLVED",
                severity: "blocker",
                params: { reason: "all-missing" },
              },
            ],
          }),
          row({
            rowKey: "c",
            profile: null,
            availability: "unavailable",
            issues: [
              {
                code: "MODE_PROFILE_UNRESOLVED",
                severity: "blocker",
                params: { reason: "provider-unavailable" },
              },
            ],
          }),
        ],
      }),
    });
    expect(views[0]?.profileStatus).toBeNull();
    expect(views[1]?.profileStatus).toBe("未绑定");
    expect(views[3]?.profileStatus).toBe("当前无可运行的选中 Profile");
    expect(views[2]?.profileStatus).toBe("当前无可运行的选中 Profile");
    expect(views[2]?.availability).toBe("available");
    expect(views[1]?.budget).toContain("SOTA");
    expect(modelRowMeta(views[3] as NonNullable<(typeof views)[3]>)).toContain("不可用");
  });

  test("N2: an open source string cannot resolve Object.prototype members", () => {
    const views = buildTeamModelRows({
      result: result("t", { rows: [row({ source: "__proto__" })] }),
    });
    expect(views[0]?.source).toBe("__proto__");
    expect(typeof views[0]?.source).toBe("string");
  });

  test("I8: failed keys become unavailable summaries and global errors survive empties", () => {
    const summaries = buildTeamSummaries({
      results: new Map([["t-one", result("t-one")]]),
      failedKeys: new Set(["t-two"]),
      hasContext: true,
      error: "暂无法读取模型",
    });
    expect(summaries.get("t-one")?.kind).toBe("summary");
    expect(summaries.get("t-two")).toEqual({
      kind: "unavailable",
      text: "暂无法读取模型",
    });
    expect(shouldShowPlanError({ modeContract: "unknown", error: "x", summaryCount: 0 })).toBe(
      true,
    );
    expect(shouldShowPlanError({ modeContract: "v2", error: "x", summaryCount: 0 })).toBe(true);
    expect(shouldShowPlanError({ modeContract: "v2", error: "x", summaryCount: 3 })).toBe(false);
    expect(shouldShowPlanError({ modeContract: "legacy", error: "x", summaryCount: 0 })).toBe(
      false,
    );
  });

  test("I8/U3: a known legacy host never sends a draft request", async () => {
    const fake = clock();
    const port = autoSend();
    const client = createTeamPlanClient({
      send: async () => {
        throw new Error("method not found: agent-team.team.plan");
      },
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.probe();
    await flush();
    expect(client.modeContract()).toBe("legacy");
    client.requestDraft({
      sessionId: "editor",
      mode: "sota",
      members: [{ rowKey: "member:0", roleId: "developer", enabled: true }],
    });
    fake.advance(200);
    await flush();
    expect(port.calls).toHaveLength(0);
    expect(client.getDraftState("editor")).toEqual({ status: "idle" });
  });

  test("I5: a changed server snapshot clears the plan cache and is exposed", async () => {
    const fake = clock();
    let call = 0;
    const send = async (input: TeamPlanInput) => {
      call += 1;
      const payload = input.items.map((item) => result(item.key));
      return output(payload, {
        context: {
          revisions,
          profilesFingerprint: call === 1 ? "pf-1" : "pf-2",
          availabilityFingerprint: "af",
        },
      });
    };
    const client = createTeamPlanClient({
      send,
      now: fake.now,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    client.setScope(scope);
    client.planTeams(teams(2));
    await flush();
    expect(client.getBatchView().context?.profilesFingerprint).toBe("pf-1");
    client.planTeams(teams(2));
    await flush();
    expect(call).toBe(1);
    client.planTeams(teams(3));
    await flush();
    expect(call).toBe(2);
    expect(client.getBatchView().context?.profilesFingerprint).toBe("pf-2");
    // The old two-Team cache entry was produced from the previous snapshot and is gone.
    client.planTeams(teams(2));
    await flush();
    expect(call).toBe(3);
  });
});
