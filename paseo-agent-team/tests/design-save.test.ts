import { describe, expect, test, vi } from "vitest";
import { createDesignSaveGateway, type DesignSaveGateway } from "../client/designer/design-gateway";
import {
  compensateDesign,
  type DesignSaveDeps,
  saveDesign,
} from "../client/designer/design-save-service";
import {
  buildDesignSaveGateway,
  clearDesignSaveRuns,
  createDesignSaveRunner,
  type DesignSaveHookRpcs,
} from "../client/designer/use-design-save";
import type {
  DesignIssue,
  DesignJob,
  DesignMarkSavedOutput,
  DesignPrepareSaveOutput,
  DesignResult,
} from "../shared/schemas/design";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { RoleSchema } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import {
  DESIGN_CLIENT_REQUEST_ID,
  DESIGN_HASH,
  DESIGN_JOB_ID,
  DESIGN_LEASE_ID,
  designJob,
  designResult,
} from "./design-fixtures";
import { architect, developer, NOW, techLead } from "./fixtures";
import { DesignSettingsStore, type StoreDocuments } from "./helpers/design-settings-store";

const NOW_MS = Date.parse(NOW);
const LEASE = { id: DESIGN_LEASE_ID, expiresAt: new Date(NOW_MS + 120_000).toISOString() };
const EXPIRED_LEASE = { id: DESIGN_LEASE_ID, expiresAt: new Date(NOW_MS - 1_000).toISOString() };
const ORIGIN = { jobId: DESIGN_JOB_ID, createdAt: NOW, requestExcerpt: "给后台做一次改版" };
const OTHER_JOB = "99999999-9999-4999-8999-999999999999";
const INPUT = { jobId: DESIGN_JOB_ID, resultId: DESIGN_HASH, clientId: DESIGN_CLIENT_REQUEST_ID };

const newRole = RoleSchema.parse({
  ...architect,
  id: "eng-rework",
  name: "【工程】改版专员",
  source: "team-designer",
  designer: ORIGIN,
  createdAt: NOW,
  updatedAt: NOW,
});

const reusedRoles = [techLead, architect, developer];

function saveTeam(overrides: Partial<Team> = {}): Team {
  return {
    ...designResult().team,
    id: "rework-team",
    name: "改版 Team",
    mode: "sota",
    memberCreation: "eager",
    source: "team-designer",
    designer: ORIGIN,
    coordinatorRoleId: "tech-lead",
    members: [
      { roleId: "architect", instanceLabel: "架构", seatId: "seat-m1", enabled: true },
      { roleId: "developer", instanceLabel: "实现", seatId: "seat-m2", enabled: true },
      { roleId: "eng-rework", instanceLabel: "新增", seatId: "seat-m3", enabled: true },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function saveResult(overrides: Partial<DesignResult> = {}): DesignResult {
  return designResult({
    resultId: DESIGN_HASH,
    jobId: DESIGN_JOB_ID,
    team: saveTeam(),
    newRoles: [newRole],
    reuse: reusedRoles.map((role) => ({
      roleId: role.id,
      behaviorHash: DESIGN_HASH,
      reason: `复用 ${role.name}`,
    })),
    ...overrides,
  });
}

function makeStore(overrides: Partial<StoreDocuments> = {}): DesignSettingsStore {
  return new DesignSettingsStore({
    roles: { roles: reusedRoles },
    teams: { teams: [] },
    preferences: PreferencesSchema.parse({ maxMembers: 24 }),
    ...overrides,
  });
}

function saveJob(result: DesignResult, overrides: Partial<DesignJob> = {}): DesignJob {
  return designJob({
    state: "saving",
    resultId: result.resultId,
    allowed: { cancel: true, save: true, launch: false, continueAction: null },
    ...overrides,
  });
}

function preparedReply(
  store: DesignSettingsStore,
  result: DesignResult,
  options: {
    base?: { roles: string; teams: string; preferences: string };
    lease?: { id: string; expiresAt: string };
  } = {},
): DesignPrepareSaveOutput {
  return {
    ok: true,
    prepared: {
      outcome: "write",
      job: saveJob(result),
      result,
      lease: options.lease ?? LEASE,
      base: options.base ?? store.revisions(),
    },
  };
}

function compensationReply(
  store: DesignSettingsStore,
  result: DesignResult,
  removableRoleIds: string[] = [result.newRoles[0]?.id ?? ""],
): DesignPrepareSaveOutput {
  return {
    ok: true,
    prepared: {
      outcome: "compensate",
      job: saveJob(result, { state: "canceling" }),
      result,
      lease: LEASE,
      base: store.revisions(),
      removableRoleIds,
    },
  };
}

function markedReply(result: DesignResult): DesignMarkSavedOutput {
  return {
    ok: true,
    job: designJob({
      state: "saved",
      saveState: "committed",
      savedTeamId: result.team.id,
      resultId: result.resultId,
    }),
  };
}

function designIssue(code: DesignIssue["code"]): DesignIssue {
  return { code, severity: "error", path: [], params: {}, action: "retry-save" };
}

function prepareFailure(code: DesignIssue["code"], job: DesignJob | null = null) {
  return {
    ok: false as const,
    issues: [designIssue(code)],
    issuesTruncated: 0,
    job,
  };
}

function saveDeps(gateway: DesignSaveGateway, overrides: Partial<DesignSaveDeps> = {}) {
  return { gateway, now: () => NOW_MS, timeoutMs: 1_000, ...overrides } satisfies DesignSaveDeps;
}

function gatewayFor(
  store: DesignSettingsStore,
  result: DesignResult,
  options: {
    prepareSave?: DesignSaveGateway["prepareSave"];
    markSaved?: DesignSaveGateway["markSaved"];
    saveFailed?: DesignSaveGateway["saveFailed"];
    overrides?: Partial<DesignSaveGateway>;
  } = {},
): DesignSaveGateway {
  const gateway = createDesignSaveGateway({
    readRoles: async () => store.read("roles"),
    readTeams: async () => store.read("teams"),
    readPreferences: async () => store.read("preferences"),
    roles: {
      write: (values, revision) => store.write("roles", values as RolesDocument, revision),
      reload: async () => {},
    },
    teams: {
      write: (values, revision) => store.write("teams", values as TeamsDocument, revision),
      reload: async () => {},
    },
    prepareSave: options.prepareSave ?? vi.fn(async () => preparedReply(store, result)),
    markSaved: options.markSaved ?? vi.fn(async () => markedReply(result)),
    saveFailed:
      options.saveFailed ??
      vi.fn(async () => ({ ok: true as const, job: designJob({ state: "save_conflict" }) })),
  });
  return {
    ...gateway,
    saveRoles: vi.fn(gateway.saveRoles),
    saveTeams: vi.fn(gateway.saveTeams),
    ...options.overrides,
  };
}

function roleIds(store: DesignSettingsStore): string[] {
  return store.values("roles").roles.map((role) => role.id);
}

describe("design gateway", () => {
  test("returns both parsed values and the raw read, and keeps host write statuses", async () => {
    const rawRoles = { roles: [], futureDocKey: { keep: true } };
    const gateway = createDesignSaveGateway({
      readRoles: async () => ({ status: "ready", revision: "roles-x", values: rawRoles }),
      readTeams: async () => ({ status: "invalid", revision: "teams-x", error: "broken" }),
      readPreferences: async () => ({
        status: "ready",
        revision: "preferences-x",
        values: { maxMembers: "many" },
      }),
      roles: {
        write: async () => ({ status: "conflict", error: "stale" }),
        reload: async () => {},
      },
      teams: {
        write: async () => ({ status: "invalid", error: "schema" }),
        reload: async () => {},
      },
      prepareSave: vi.fn(),
      markSaved: vi.fn(),
      saveFailed: vi.fn(),
    });
    expect(await gateway.readRoles()).toEqual({
      status: "ready",
      values: { roles: [] },
      raw: rawRoles,
      revision: "roles-x",
    });
    expect(await gateway.readTeams()).toEqual({ status: "invalid", error: "broken" });
    expect((await gateway.readPreferences()).status).toBe("invalid");
    expect(await gateway.saveRoles(rawRoles, "roles-x")).toBe("conflict");
    expect(await gateway.saveTeams({ teams: [] }, "teams-x")).toBe("invalid");
  });

  test("maps a thrown settings request or write to failed/invalid", async () => {
    const gateway = createDesignSaveGateway({
      readRoles: async () => {
        throw new Error("offline");
      },
      readTeams: async () => ({ status: "ready", revision: "teams-x", values: { teams: [] } }),
      readPreferences: async () => ({
        status: "ready",
        revision: "preferences-x",
        values: PreferencesSchema.parse({}),
      }),
      roles: {
        write: async () => {
          throw new Error("offline");
        },
        reload: async () => {},
      },
      teams: {
        write: async () => ({ status: "saved", revision: "teams-y", values: { teams: [] } }),
        reload: async () => {},
      },
      prepareSave: vi.fn(),
      markSaved: vi.fn(),
      saveFailed: vi.fn(),
    });
    expect((await gateway.readRoles()).status).toBe("invalid");
    expect(await gateway.saveRoles({ roles: [] }, "roles-x")).toBe("failed");
    expect(await gateway.saveTeams({ teams: [] }, "teams-x")).toBe("saved");
  });
});

describe("saveDesign", () => {
  test("writes Roles first, re-prepares, then writes the Team with the fresh revision", async () => {
    const store = makeStore();
    const result = saveResult();
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () =>
      preparedReply(store, result),
    );
    const markSaved = vi.fn<DesignSaveGateway["markSaved"]>(async () => markedReply(result));
    const gateway = gatewayFor(store, result, { prepareSave, markSaved });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome).toEqual({ status: "saved", teamId: result.team.id });
    expect(prepareSave).toHaveBeenCalledTimes(2);
    expect(prepareSave.mock.calls[1]?.[0]).toMatchObject({ leaseId: DESIGN_LEASE_ID });
    expect(gateway.saveRoles).toHaveBeenCalledWith(expect.anything(), "roles-1");
    expect(gateway.saveTeams).toHaveBeenCalledWith(expect.anything(), "teams-1");
    expect(vi.mocked(gateway.saveRoles).mock.invocationCallOrder[0]).toBeLessThan(
      prepareSave.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(prepareSave.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(gateway.saveTeams).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(markSaved).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: DESIGN_JOB_ID, leaseId: DESIGN_LEASE_ID }),
    );
    expect(roleIds(store)).toEqual(["tech-lead", "architect", "developer", "eng-rework"]);
    expect(store.values("teams").teams).toHaveLength(1);
  });

  test("writes back only new rows and preserves raw documents and unrelated rows", async () => {
    const {
      enabled: _enabled,
      fallbackProfiles: _fallback,
      ...legacyLead
    } = RoleSchema.parse({
      ...techLead,
      futureRoleKey: "keep-me",
    });
    const roles = { roles: [legacyLead, architect, developer], futureDocKey: { keep: true } };
    const teams = { teams: [], futureTeamsKey: "keep" };
    const store = new DesignSettingsStore({
      roles: roles as unknown as RolesDocument,
      teams: teams as unknown as TeamsDocument,
      preferences: PreferencesSchema.parse({ maxMembers: 24 }),
    });
    const result = saveResult();
    const gateway = gatewayFor(store, result);

    expect((await saveDesign(INPUT, saveDeps(gateway))).status).toBe("saved");
    const stored = store.values("roles");
    expect(stored.futureDocKey).toEqual({ keep: true });
    expect(stored.roles.find((role) => role.id === techLead.id)).toEqual(legacyLead);
    expect(stored.roles.find((role) => role.id === techLead.id)).not.toHaveProperty("enabled");
    expect(store.values("teams").futureTeamsKey).toBe("keep");
    expect(stored.roles.find((role) => role.id === "eng-rework")).toBeDefined();
  });

  test("a Role write always uses the revision from the read it merged", async () => {
    const result = saveResult();
    const roles: RolesDocument = { roles: reusedRoles };
    const teams: TeamsDocument = { teams: [] };
    const preferences = PreferencesSchema.parse({ maxMembers: 24 });
    let prepares = 0;
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () => {
      prepares += 1;
      return prepares === 1
        ? preparedReply(makeStore(), result, {
            base: {
              roles: "roles-read",
              teams: "teams-read",
              preferences: "preferences-read",
            },
          })
        : prepareFailure("DESIGN_SAVE_LEASE_EXPIRED", saveJob(result));
    });
    const gateway: DesignSaveGateway = {
      readRoles: async () => ({
        status: "ready",
        values: roles,
        raw: roles,
        revision: "roles-read",
      }),
      readTeams: async () => ({
        status: "ready",
        values: teams,
        raw: teams,
        revision: "teams-read",
      }),
      readPreferences: async () => ({
        status: "ready",
        values: preferences,
        raw: preferences,
        revision: "preferences-read",
      }),
      saveRoles: vi.fn(async () => "saved" as const),
      saveTeams: vi.fn(async () => "saved" as const),
      prepareSave,
      markSaved: vi.fn(async () => markedReply(result)),
      saveFailed: vi.fn(),
      reloadRoles: async () => {},
      reloadTeams: async () => {},
    };

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).toHaveBeenCalledWith(expect.anything(), "roles-read");
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_LEASE_EXPIRED");
    }
  });

  test("retries explicit conflicts three times, then records conflict-exhausted", async () => {
    const store = makeStore();
    const result = saveResult();
    const saveFailed = vi.fn(async () => ({
      ok: true as const,
      job: saveJob(result, { state: "save_conflict" }),
    }));
    const gateway = gatewayFor(store, result, {
      saveFailed,
      overrides: { saveRoles: vi.fn(async () => "conflict" as const) },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).toHaveBeenCalledTimes(3);
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "roles", reason: "conflict-exhausted" }),
    );
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_CONFLICT");
    }
    expect(roleIds(store)).toEqual(["tech-lead", "architect", "developer"]);
  });

  test("keeps three conflict attempts per phase after Roles commits", async () => {
    const store = makeStore();
    const result = saveResult();
    let roleWrites = 0;
    const saveRoles = vi.fn(async (values: unknown, revision: string) => {
      roleWrites += 1;
      if (roleWrites <= 2) return "conflict" as const;
      return (await store.write("roles", values as RolesDocument, revision)).status;
    });
    const gateway = gatewayFor(store, result, {
      overrides: { saveRoles, saveTeams: vi.fn(async () => "conflict" as const) },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(saveRoles).toHaveBeenCalledTimes(3);
    expect(gateway.saveRoles).toHaveBeenCalledTimes(3);
    expect(gateway.saveTeams).toHaveBeenCalledTimes(3);
    expect(roleIds(store)).toContain("eng-rework");
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_CONFLICT");
    }
  });

  test("bounds stale revision retries without writing", async () => {
    const store = makeStore();
    const result = saveResult();
    const prepareSave = vi.fn(async () =>
      preparedReply(store, result, {
        base: {
          roles: "roles-0",
          teams: store.revision("teams"),
          preferences: store.revision("preferences"),
        },
      }),
    );
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, { prepareSave, saveFailed });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(prepareSave).toHaveBeenCalledTimes(3);
    expect(saveFailed).toHaveBeenCalledWith(expect.objectContaining({ phase: "roles" }));
    expect(outcome.status).toBe("waiting");
  });

  test("an invalid Role write is not retried, touches nothing, and records nothing", async () => {
    const store = makeStore();
    const result = saveResult();
    const saveFailed = vi.fn();
    const gateway = gatewayFor(store, result, {
      saveFailed,
      overrides: { saveRoles: vi.fn(async () => "invalid" as const) },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(saveFailed).not.toHaveBeenCalled();
    expect(roleIds(store)).toEqual(["tech-lead", "architect", "developer"]);
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_FAILED");
    }
  });

  test("an unknown Role write is read back, recorded, and never deleted", async () => {
    const store = makeStore();
    const result = saveResult();
    store.failNextWrite("roles", "throw-after-commit");
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, { saveFailed });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(roleIds(store)).toContain("eng-rework");
    expect(store.values("teams").teams).toHaveLength(0);
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "roles", reason: "unknown" }),
    );
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_UNKNOWN");
    }
  });

  test("a Team write whose response was lost is confirmed by read-back, not rewritten", async () => {
    const store = makeStore();
    const result = saveResult();
    store.failNextWrite("teams", "throw-after-commit");
    const gateway = gatewayFor(store, result);

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome).toEqual({ status: "saved", teamId: result.team.id });
    expect(gateway.saveTeams).toHaveBeenCalledTimes(1);
    expect(store.values("teams").teams).toHaveLength(1);
  });

  test("a failed Team write keeps Roles, records unknown, and never compensates", async () => {
    const store = makeStore();
    const result = saveResult();
    store.failNextWrite("teams", "throw-before-commit");
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, { saveFailed });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveTeams).toHaveBeenCalledTimes(1);
    expect(roleIds(store)).toHaveLength(4);
    expect(store.values("teams").teams).toHaveLength(0);
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "unknown" }),
    );
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_UNKNOWN");
    }
  });

  test("an invalid Team write records write-failed and keeps partial Roles", async () => {
    const store = makeStore();
    const result = saveResult();
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, {
      saveFailed,
      overrides: { saveTeams: vi.fn(async () => "invalid" as const) },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "write-failed" }),
    );
    expect(roleIds(store)).toContain("eng-rework");
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_FAILED");
    }
  });

  test("a lost markSaved response is repaired by read-back and one receipt retry", async () => {
    const store = makeStore();
    const result = saveResult();
    const markSaved = vi
      .fn<DesignSaveGateway["markSaved"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(markedReply(result));
    const gateway = gatewayFor(store, result, { markSaved });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome).toEqual({ status: "saved", teamId: result.team.id });
    expect(markSaved).toHaveBeenCalledTimes(2);
    expect(gateway.saveTeams).toHaveBeenCalledTimes(1);
    expect(store.values("teams").teams).toHaveLength(1);
  });

  test("a failed receipt retry is reported instead of claiming saved", async () => {
    const store = makeStore();
    const result = saveResult();
    const markSaved = vi
      .fn<DesignSaveGateway["markSaved"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: false as const,
        issues: [designIssue("DESIGN_NOT_SAVED")],
        issuesTruncated: 0,
        job: saveJob(result),
      });
    const gateway = gatewayFor(store, result, { markSaved });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_NOT_SAVED");
    }
    expect(gateway.saveTeams).toHaveBeenCalledTimes(1);
    expect(store.values("teams").teams).toHaveLength(1);
  });

  test("an already-saved job only records its receipt and never recreates a deleted Team", async () => {
    const store = makeStore();
    const result = saveResult();
    const markSaved = vi.fn<DesignSaveGateway["markSaved"]>(async () => markedReply(result));
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () => ({
      ok: true as const,
      prepared: {
        outcome: "already-saved" as const,
        job: designJob({
          state: "saved",
          saveState: "committed",
          savedTeamId: result.team.id,
          resultId: result.resultId,
        }),
      },
    }));
    const gateway = gatewayFor(store, result, { prepareSave, markSaved });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome).toEqual({ status: "saved", teamId: result.team.id });
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(markSaved.mock.calls[0]?.[0]?.leaseId).toBeUndefined();
    expect(store.values("teams").teams).toHaveLength(0);
  });

  test.each(["DESIGN_SAVE_LEASE_EXPIRED", "DESIGN_RESULT_STALE"] as const)(
    "a %s prepare failure blocks before any document is read or written",
    async (code) => {
      const store = makeStore();
      const result = saveResult();
      const prepareSave = vi.fn(async () => prepareFailure(code, saveJob(result)));
      const gateway = gatewayFor(store, result, { prepareSave });

      const outcome = await saveDesign(INPUT, saveDeps(gateway));
      expect(outcome.status).toBe("blocked");
      if (outcome.status === "blocked") {
        expect(outcome.issues[0]?.code).toBe(code);
      }
      expect(gateway.saveRoles).not.toHaveBeenCalled();
      expect(gateway.saveTeams).not.toHaveBeenCalled();
    },
  );

  test("a failed prepare RPC blocks and writes nothing", async () => {
    const store = makeStore();
    const result = saveResult();
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () => {
      throw new Error("offline");
    });
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_FAILED");
    }
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(gateway.saveTeams).not.toHaveBeenCalled();
  });

  test("a second prepare failure after Roles commits is recorded as partial", async () => {
    const store = makeStore();
    const result = saveResult();
    let prepares = 0;
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () => {
      prepares += 1;
      if (prepares === 1) return preparedReply(store, result);
      throw new Error("offline");
    });
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, { prepareSave, saveFailed });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "partial" }),
    );
    expect(outcome.status).toBe("waiting");
  });

  test("a Team id conflict after Roles commits is recorded as partial", async () => {
    const store = makeStore();
    const result = saveResult();
    const foreign = {
      ...saveTeam(),
      id: result.team.id,
      source: "preset",
      designer: { jobId: OTHER_JOB },
    };
    const gateway = gatewayFor(store, result, {
      overrides: {
        reloadRoles: vi.fn(async () => {
          const teams = store.values("teams");
          if (!teams.teams.some((team) => team.id === foreign.id)) {
            await store.write(
              "teams",
              { ...teams, teams: [...teams.teams, foreign] },
              store.revision("teams"),
            );
          }
        }),
      },
    });
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const withFailure = { ...gateway, saveFailed };

    const outcome = await saveDesign(INPUT, saveDeps(withFailure));
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "partial" }),
    );
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues.some((entry) => entry.code === "DESIGN_TEAM_ID_CONFLICT")).toBe(true);
    }
  });

  test("a compensate lease is never used to write a Team", async () => {
    const store = makeStore();
    const result = saveResult();
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () =>
      compensationReply(store, result),
    );
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_UNKNOWN");
    }
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(gateway.saveTeams).not.toHaveBeenCalled();
  });

  test("an abort before the first prepare writes nothing", async () => {
    const store = makeStore();
    const result = saveResult();
    const controller = new AbortController();
    controller.abort();
    const gateway = gatewayFor(store, result);

    const outcome = await saveDesign(INPUT, saveDeps(gateway, { signal: controller.signal }));
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_NOT_SAVED");
    }
    expect(gateway.prepareSave).not.toHaveBeenCalled();
  });

  test("an abort after Roles commits is recorded as canceled", async () => {
    const store = makeStore();
    const result = saveResult();
    const controller = new AbortController();
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, {
      saveFailed,
      overrides: {
        reloadRoles: vi.fn(async () => {
          controller.abort();
        }),
      },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway, { signal: controller.signal }));
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "canceled" }),
    );
    expect(roleIds(store)).toContain("eng-rework");
    expect(outcome.status).toBe("waiting");
  });

  test("an invalid settings document stops before writing", async () => {
    const store = makeStore();
    const result = saveResult();
    const gateway = gatewayFor(store, result, {
      overrides: {
        readTeams: async () => ({ status: "invalid", error: "broken" }),
      },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SETTINGS_INVALID");
    }
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(gateway.saveTeams).not.toHaveBeenCalled();
  });

  test("a timed-out Team write is treated as unknown and read back", async () => {
    const store = makeStore();
    const result = saveResult();
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const gateway = gatewayFor(store, result, {
      saveFailed,
      overrides: { saveTeams: vi.fn(() => new Promise<never>(() => {})) },
    });

    const outcome = await saveDesign(INPUT, saveDeps(gateway, { timeoutMs: 10 }));
    expect(gateway.saveTeams).toHaveBeenCalledTimes(1);
    expect(roleIds(store)).toContain("eng-rework");
    expect(store.values("teams").teams).toHaveLength(0);
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "unknown" }),
    );
    expect(outcome.status).toBe("waiting");
  });

  test("a timed-out read or prepare ends the run instead of hanging", async () => {
    const store = makeStore();
    const result = saveResult();
    const never = () => new Promise<never>(() => {});
    const readTimeout = gatewayFor(store, result, {
      overrides: { readRoles: never },
    });
    expect((await saveDesign(INPUT, saveDeps(readTimeout, { timeoutMs: 10 }))).status).toBe(
      "blocked",
    );

    const prepareTimeout = gatewayFor(store, result, {
      overrides: { prepareSave: never },
    });
    expect((await saveDesign(INPUT, saveDeps(prepareTimeout, { timeoutMs: 10 }))).status).toBe(
      "blocked",
    );
  });

  test("an abort during the reads before the Team write records canceled", async () => {
    const store = makeStore();
    const result = saveResult();
    const controller = new AbortController();
    let preferenceReads = 0;
    const saveFailed = vi.fn(async () => ({ ok: true as const, job: saveJob(result) }));
    const base = gatewayFor(store, result);
    const readPreferences = base.readPreferences;
    const gateway = {
      ...base,
      saveFailed,
      readPreferences: vi.fn(async () => {
        preferenceReads += 1;
        if (preferenceReads >= 2) controller.abort();
        return readPreferences();
      }),
    };

    const outcome = await saveDesign(INPUT, saveDeps(gateway, { signal: controller.signal }));
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "team", reason: "canceled" }),
    );
    expect(roleIds(store)).toContain("eng-rework");
    expect(outcome.status).toBe("waiting");
  });

  test("a timed-out Team write blocks compensation even when the late write lands", async () => {
    const store = makeStore();
    const result = saveResult();
    const runner = createDesignSaveRunner({
      initialHostId: "A",
      now: () => NOW_MS,
      timeoutMs: 10,
    });
    const late = Promise.withResolvers<void>();
    const saveTeams = vi.fn(async (values: unknown, revision: string) => {
      await late.promise;
      return (await store.write("teams", values as TeamsDocument, revision)).status;
    });
    const gateway = gatewayFor(store, result, { overrides: { saveTeams } });

    const outcome = await runner.run({ hostId: "A", ...INPUT, gateway });
    expect(outcome?.status).toBe("waiting");
    expect(runner.unknownWrites.has(DESIGN_JOB_ID)).toBe(true);

    const compensationPrepare = vi.fn(async () => compensationReply(store, result));
    const compensationGateway = gatewayFor(store, result, {
      prepareSave: compensationPrepare,
    });
    const refused = await compensateDesign(INPUT, {
      ...saveDeps(compensationGateway),
      unknownWrites: runner.unknownWrites,
    });
    expect(refused.status).toBe("waiting");
    if (refused.status === "waiting") {
      expect(refused.issues[0]?.code).toBe("DESIGN_SAVE_UNKNOWN");
      expect(refused.issues[0]?.params).toMatchObject({ reason: "unknown-write" });
    }
    expect(compensationGateway.saveRoles).not.toHaveBeenCalled();
    expect(roleIds(store)).toContain("eng-rework");

    late.resolve();
    await vi.waitFor(() => expect(store.values("teams").teams).toHaveLength(1));
    expect(roleIds(store)).toContain("eng-rework");
  });

  test("an expired lease is not used to write; a re-prepare with a valid lease proceeds", async () => {
    const store = makeStore();
    const result = saveResult();
    let prepares = 0;
    const prepareSave = vi.fn<DesignSaveGateway["prepareSave"]>(async () => {
      prepares += 1;
      return preparedReply(store, result, {
        lease: prepares === 1 ? EXPIRED_LEASE : LEASE,
      });
    });
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(outcome).toEqual({ status: "saved", teamId: result.team.id });
    expect(prepareSave).toHaveBeenCalledTimes(3);
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
  });

  test("a lease that never becomes valid performs no writes", async () => {
    const store = makeStore();
    const result = saveResult();
    const prepareSave = vi.fn(async () => preparedReply(store, result, { lease: EXPIRED_LEASE }));
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await saveDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(gateway.saveTeams).not.toHaveBeenCalled();
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_LEASE_EXPIRED");
    }
  });
});

describe("compensateDesign", () => {
  test("removes an untouched, unreferenced, authorized Role and records compensation", async () => {
    const result = saveResult();
    const store = makeStore({ roles: { roles: [...reusedRoles, newRole] } });
    const prepareSave = vi.fn(async () => compensationReply(store, result));
    const saveFailed = vi.fn(async () => ({
      ok: true as const,
      job: saveJob(result, { state: "canceled" }),
    }));
    const gateway = gatewayFor(store, result, { prepareSave, saveFailed });

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(outcome.status).toBe("compensated");
    expect(roleIds(store)).toEqual(["tech-lead", "architect", "developer"]);
    expect(saveFailed).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "compensation", reason: "compensated" }),
    );
  });

  test.each([
    ["modified", () => RoleSchema.parse({ ...newRole, systemPrompt: "edited" })],
    ["source lost", () => ({ ...newRole, source: "user" })],
    ["unauthorized", () => newRole],
  ])("keeps a %s Role", async (kind, roleOf) => {
    const result = saveResult();
    const store = makeStore({ roles: { roles: [...reusedRoles, roleOf()] } });
    const prepareSave = vi.fn(async () =>
      compensationReply(store, result, kind === "unauthorized" ? [] : [newRole.id]),
    );
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(roleIds(store)).toContain("eng-rework");
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting");
  });

  test("keeps a Role referenced by any Team", async () => {
    const result = saveResult();
    const foreign = {
      ...saveTeam(),
      id: "other-team",
      source: "preset",
      designer: undefined,
    };
    const store = makeStore({
      roles: { roles: [...reusedRoles, newRole] },
      teams: { teams: [foreign] },
    });
    const prepareSave = vi.fn(async () => compensationReply(store, result));
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(roleIds(store)).toContain("eng-rework");
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting");
  });

  test("an unknown compensation write never deletes", async () => {
    const result = saveResult();
    const store = makeStore({ roles: { roles: [...reusedRoles, newRole] } });
    store.failNextWrite("roles", "throw-before-commit");
    const prepareSave = vi.fn(async () => compensationReply(store, result));
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(roleIds(store)).toContain("eng-rework");
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("waiting");
  });

  test("does not compensate a committed Team", async () => {
    const result = saveResult();
    const store = makeStore();
    const prepareSave = vi.fn(async () => ({
      ok: true as const,
      prepared: {
        outcome: "already-saved" as const,
        job: saveJob(result, { state: "saved" }),
      },
    }));
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(outcome.status).toBe("waiting");
    expect(gateway.saveRoles).not.toHaveBeenCalled();
  });

  test("restores a missing own Role when a concurrent Team starts referencing it", async () => {
    const result = saveResult();
    const store = makeStore({ roles: { roles: [...reusedRoles, newRole] } });
    const prepareSave = vi.fn(async () => compensationReply(store, result));
    const base = gatewayFor(store, result, { prepareSave });
    let inserted = false;
    const saveRoles = vi.fn(async (values: unknown, revision: string) => {
      const reply = await store.write("roles", values as RolesDocument, revision);
      if (reply.status === "saved" && !inserted) {
        inserted = true;
        const teams = store.values("teams");
        await store.write(
          "teams",
          {
            ...teams,
            teams: [
              ...teams.teams,
              { ...saveTeam(), id: "racing-team", source: "user", designer: undefined },
            ],
          },
          store.revision("teams"),
        );
      }
      return reply.status;
    });
    const gateway = { ...base, saveRoles };

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(saveRoles).toHaveBeenCalledTimes(2);
    expect(roleIds(store)).toContain("eng-rework");
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues.some((entry) => entry.code === "DESIGN_COMPENSATION_UNSAFE")).toBe(
        true,
      );
    }
  });

  test("does not use a compensation lease that expired during the read", async () => {
    const result = saveResult();
    const store = makeStore({ roles: { roles: [...reusedRoles, newRole] } });
    const prepareSave = vi.fn(async () => compensationReply(store, result));
    const gateway = gatewayFor(store, result, { prepareSave });
    let nowCalls = 0;

    const outcome = await compensateDesign(INPUT, {
      ...saveDeps(gateway),
      now: () => (nowCalls++ === 0 ? NOW_MS : NOW_MS + 200_000),
    });
    expect(gateway.saveRoles).not.toHaveBeenCalled();
    expect(roleIds(store)).toContain("eng-rework");
    expect(outcome.status).toBe("waiting");
    if (outcome.status === "waiting") {
      expect(outcome.issues[0]?.code).toBe("DESIGN_SAVE_LEASE_EXPIRED");
    }
  });

  test("reads back a compensation write whose response was lost", async () => {
    const result = saveResult();
    const store = makeStore({ roles: { roles: [...reusedRoles, newRole] } });
    store.failNextWrite("roles", "throw-after-commit");
    const prepareSave = vi.fn(async () => compensationReply(store, result));
    const gateway = gatewayFor(store, result, { prepareSave });

    const outcome = await compensateDesign(INPUT, saveDeps(gateway));
    expect(gateway.saveRoles).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("compensated");
    expect(roleIds(store)).toEqual(["tech-lead", "architect", "developer"]);
  });
});

describe("design save hook helpers", () => {
  test("maps hook RPCs onto revision-paired settings writes", async () => {
    const rpcs: DesignSaveHookRpcs = {
      readRoles: vi.fn(async () => ({
        status: "ready" as const,
        revision: "roles-1",
        values: { roles: [] },
      })),
      writeRoles: vi.fn<DesignSaveHookRpcs["writeRoles"]>(async (input) => ({
        status: "saved" as const,
        revision: input.revision,
        values: input.values,
      })),
      readTeams: vi.fn(async () => ({
        status: "ready" as const,
        revision: "teams-1",
        values: { teams: [] },
      })),
      writeTeams: vi.fn<DesignSaveHookRpcs["writeTeams"]>(async (input) => ({
        status: "saved" as const,
        revision: input.revision,
        values: input.values,
      })),
      readPreferences: vi.fn(async () => ({
        status: "ready" as const,
        revision: "preferences-1",
        values: PreferencesSchema.parse({}),
      })),
      prepareSave: vi.fn(),
      markSaved: vi.fn(),
      saveFailed: vi.fn(),
      reloadRoles: vi.fn(async () => {}),
      reloadTeams: vi.fn(async () => {}),
    };
    const gateway = buildDesignSaveGateway(rpcs);

    expect((await gateway.readRoles()).status).toBe("ready");
    expect(rpcs.readRoles).toHaveBeenCalledWith({});
    expect(await gateway.saveRoles({ roles: [], gone: undefined }, "roles-1")).toBe("saved");
    expect(rpcs.writeRoles).toHaveBeenCalledWith({
      revision: "roles-1",
      values: { roles: [] },
    });
    expect(await gateway.saveTeams({ teams: [], gone: undefined }, "teams-1")).toBe("saved");
    expect(rpcs.writeTeams).toHaveBeenCalledWith({
      revision: "teams-1",
      values: { teams: [] },
    });
    await gateway.reloadRoles();
    await gateway.reloadTeams();
    expect(rpcs.reloadRoles).toHaveBeenCalledTimes(1);
    expect(rpcs.reloadTeams).toHaveBeenCalledTimes(1);
  });

  test("clearDesignSaveRuns aborts every controller and empties both maps", () => {
    const first = new AbortController();
    const second = new AbortController();
    const controllers = new Map([
      ["first", first],
      ["second", second],
    ]);
    const inFlight = new Map([["first", Promise.resolve(null)]]);

    clearDesignSaveRuns(controllers, inFlight);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(controllers.size).toBe(0);
    expect(inFlight.size).toBe(0);
  });
});

describe("createDesignSaveRunner", () => {
  test("an in-flight save keeps its original host gateway after a host switch", async () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const result = saveResult();
    const gatewayA = gatewayFor(storeA, result);
    const gatewayB = gatewayFor(storeB, result);
    const delivery: string[] = [];
    const runner = createDesignSaveRunner({
      now: () => NOW_MS,
      timeoutMs: 1_000,
      onOutcome: (_outcome, host) => delivery.push(host),
    });
    runner.switchHost("A");

    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let paused = false;
    storeA.beforeWrite = async (key) => {
      if (key !== "teams" || paused) return;
      paused = true;
      entered.resolve();
      await gate.promise;
    };

    const runA = runner.run({ hostId: "A", ...INPUT, gateway: gatewayA });
    await entered.promise;
    runner.switchHost("B");
    const outcomeB = await runner.run({ hostId: "B", ...INPUT, gateway: gatewayB });
    gate.resolve();
    const outcomeA = await runA;

    expect(outcomeB).toEqual({ status: "saved", teamId: result.team.id });
    expect(outcomeA).toBeNull();
    expect(delivery).toEqual(["B"]);
    // B only saw B's own run; A's receipt and read-back stayed on A.
    expect(gatewayB.prepareSave).toHaveBeenCalledTimes(2);
    expect(gatewayB.saveRoles).toHaveBeenCalledTimes(1);
    expect(gatewayB.saveTeams).toHaveBeenCalledTimes(1);
    expect(gatewayB.markSaved).toHaveBeenCalledTimes(1);
    expect(gatewayA.markSaved).toHaveBeenCalledTimes(1);
    expect(storeB.values("teams").teams).toHaveLength(1);
    expect(storeA.values("teams").teams).toHaveLength(1);
  });

  test("joins an identical in-flight run and frees the key after a timeout", async () => {
    const store = makeStore();
    const result = saveResult();
    const hanging = gatewayFor(store, result, {
      overrides: { saveRoles: vi.fn(() => new Promise<never>(() => {})) },
    });
    const runner = createDesignSaveRunner({ now: () => NOW_MS, timeoutMs: 10 });
    runner.switchHost("A");

    const first = runner.run({ hostId: "A", ...INPUT, gateway: hanging });
    expect(runner.run({ hostId: "A", ...INPUT, gateway: hanging })).toBe(first);
    expect((await first)?.status).toBe("waiting");

    const healthyStore = makeStore();
    const healthy = gatewayFor(healthyStore, result);
    const second = await runner.run({ hostId: "A", ...INPUT, gateway: healthy });
    expect(second).toEqual({ status: "saved", teamId: result.team.id });
    expect(healthy.prepareSave).toHaveBeenCalledTimes(2);
  });

  test("rejects a stale host's run and leaves the current host undisturbed", async () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const result = saveResult();
    const gatewayA = gatewayFor(storeA, result);
    const gatewayB = gatewayFor(storeB, result);
    const delivery: string[] = [];
    const runner = createDesignSaveRunner({
      initialHostId: "B",
      now: () => NOW_MS,
      timeoutMs: 1_000,
      onOutcome: (_outcome, host) => delivery.push(host),
    });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let paused = false;
    storeB.beforeWrite = async (key) => {
      if (key !== "teams" || paused) return;
      paused = true;
      entered.resolve();
      await gate.promise;
    };

    const runB = runner.run({ hostId: "B", ...INPUT, gateway: gatewayB });
    await entered.promise;
    const stale = await runner.run({ hostId: "A", ...INPUT, gateway: gatewayA });
    expect(stale).toBeNull();
    expect(gatewayA.prepareSave).not.toHaveBeenCalled();
    gate.resolve();
    expect(await runB).toEqual({ status: "saved", teamId: result.team.id });
    expect(delivery).toEqual(["B"]);
  });

  test("dispose aborts in-flight work and drops its outcome", async () => {
    const store = makeStore();
    const result = saveResult();
    const gateway = gatewayFor(store, result);
    const delivery: string[] = [];
    const active: number[] = [];
    const runner = createDesignSaveRunner({
      initialHostId: "A",
      now: () => NOW_MS,
      onOutcome: (_outcome, host) => delivery.push(host),
      onActiveChange: (count) => active.push(count),
    });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let paused = false;
    store.beforeWrite = async (key) => {
      if (key !== "teams" || paused) return;
      paused = true;
      entered.resolve();
      await gate.promise;
    };

    const run = runner.run({ hostId: "A", ...INPUT, gateway });
    await entered.promise;
    runner.dispose();
    gate.resolve();
    expect(await run).toBeNull();
    expect(delivery).toEqual([]);
    expect(active.at(-1)).toBe(0);

    const nextStore = makeStore();
    const nextGateway = gatewayFor(nextStore, result);
    expect(await runner.run({ hostId: "A", ...INPUT, gateway: nextGateway })).toEqual({
      status: "saved",
      teamId: result.team.id,
    });
  });
});
