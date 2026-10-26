import { describe, expect, test, vi } from "vitest";
import {
  createLaunchService,
  type LaunchService,
  type SettingsReader,
} from "../server/launch-service";
import { LaunchJobSchema, type LaunchStartInput } from "../shared/rpc";
import { LaunchPreviewResultSchema } from "../shared/schemas/launch-preview";
import type { RolesDocument, TeamsDocument } from "../shared/settings";
import { zh } from "../shared/zh";
import { fakePort, healthyConfig, invalid, preferences, ready } from "./fakes";
import { architect, claudeOpus, codingTeam, developer, role, techLead } from "./fixtures";

const onWorkspace: LaunchStartInput = {
  teamId: "coding-team",
  task: "Add Stripe",
  target: { kind: "workspace", workspaceId: "ws-1" },
};

function setup(
  options: {
    config?: unknown;
    prefs?: typeof preferences;
    runId?: () => string;
    now?: () => Date;
    roles?: SettingsReader<RolesDocument>;
    teams?: SettingsReader<TeamsDocument>;
  } = {},
) {
  const fake = fakePort(options.config);
  const log = vi.fn();
  const service = createLaunchService({
    roles: options.roles ?? ready({ roles: [techLead, architect, developer] }),
    teams: options.teams ?? ready({ teams: [codingTeam] }),
    preferences: ready(options.prefs ?? preferences),
    runId: options.runId ?? (() => "run-test"),
    now: options.now ?? (() => new Date("2026-10-01T10:00:00.000Z")),
    log,
  });
  return { ...fake, service, log };
}

async function settled(service: LaunchService, runId: string) {
  await vi.waitFor(() => expect(service.status(runId)?.state).not.toBe("running"));
  return service.status(runId);
}

describe("launch start", () => {
  test("returns a running job at once and reports it through to success", async () => {
    const { service, port, created, sent } = setup();
    const result = await service.start(onWorkspace, port);
    if (!result.ok) throw new Error(`unexpected blockers: ${result.blockers.join(", ")}`);
    expect(result.job).toMatchObject({
      runId: "run-test",
      teamId: "coding-team",
      teamName: "Coding Team",
      state: "running",
      memberTotal: 2,
      workspaceId: "ws-1",
    });
    expect(() => LaunchJobSchema.parse(result.job)).not.toThrow();

    const done = await settled(service, "run-test");
    expect(done).toMatchObject({
      state: "succeeded",
      step: "done",
      coordinatorId: "coord-1",
      memberIds: ["member-2", "member-3"],
      finishedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(() => LaunchJobSchema.parse(done)).not.toThrow();

    expect(created.map((agent) => agent.workspaceId)).toEqual(["ws-1", "ws-1", "ws-1"]);
    expect(created.map((agent) => agent.options.parent)).toEqual([undefined, "coord-1", "coord-1"]);
    expect(created[0]?.options.labels).toMatchObject({
      "agent-team.run": "run-test",
      "agent-team.kind": "coordinator",
      "agent-team.task": "Add Stripe",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe("coord-1");
    expect(sent[0]?.text).toContain("Add Stripe");
  });

  test("hands out copies, so callers cannot change a job", async () => {
    const { service, port } = setup();
    await service.start(onWorkspace, port);
    const first = service.status("run-test");
    if (first) first.state = "failed";
    expect(service.status("run-test")?.state).not.toBe("failed");
    expect(service.status("nope")).toBeNull();
  });

  test("creates the workspace first when asked for a new one", async () => {
    const { service, port, created } = setup();
    await service.start(
      { ...onWorkspace, target: { kind: "new-workspace", projectId: "p1", title: " Billing " } },
      port,
    );
    const done = await settled(service, "run-test");
    expect(port.workspaces.create).toHaveBeenCalledWith({
      title: "Billing",
      source: { kind: "worktree", projectId: "p1", cwd: "/repo", action: "branch-off" },
    });
    expect(done).toMatchObject({ state: "succeeded", workspaceId: "ws-new" });
    expect(created.every((agent) => agent.workspaceId === "ws-new")).toBe(true);
  });

  test("names a new workspace after the Team when no title is given", async () => {
    const { service, port } = setup();
    await service.start(
      { ...onWorkspace, target: { kind: "new-workspace", projectId: "p1" } },
      port,
    );
    await settled(service, "run-test");
    expect(port.workspaces.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Coding Team" }),
    );
  });

  test("refuses unreadable settings before touching Paseo", async () => {
    const { service, port } = setup({ roles: invalid() });
    const result = await service.start(onWorkspace, port);
    expect(result).toMatchObject({ ok: false, warnings: [] });
    expect(result.ok === false && result.blockers[0]).toContain("Role");
    expect(port.config.get).not.toHaveBeenCalled();
    expect(service.status("run-test")).toBeNull();
  });

  test("blocks a workspace that does not exist", async () => {
    const { service, port, refresh } = setup();
    refresh.mockResolvedValueOnce(null);
    const missing = await service.start(onWorkspace, port);
    expect(missing.ok === false && missing.blockers).toContain("所选工作区不存在或已归档。");

    refresh.mockRejectedValueOnce(new Error("unknown workspace"));
    const thrown = await service.start(onWorkspace, port);
    expect(thrown.ok).toBe(false);
  });

  test("blocks a project that does not exist, or cannot be listed", async () => {
    const { service, port } = setup();
    const target = { kind: "new-workspace", projectId: "nope" } as const;
    const unknown = await service.start({ ...onWorkspace, target }, port);
    expect(unknown.ok === false && unknown.blockers).toContain("所选项目不存在。");

    port.projects.list.mockRejectedValue(new Error("offline"));
    port.workspaces.list.mockRejectedValue(new Error("offline"));
    const unlisted = await service.start({ ...onWorkspace, target }, port);
    expect(unlisted.ok === false && unlisted.blockers).toContain("所选项目不存在。");
  });

  test("returns the plan's blockers and warnings", async () => {
    const { service, port } = setup();
    const result = await service.start({ ...onWorkspace, teamId: "nope" }, port);
    expect(result.ok === false && result.blockers).toContain("Team 不存在。");
    expect(service.status("run-test")).toBeNull();
  });

  test("blocks when Paseo will not give the coordinator its tools", async () => {
    const { service, port } = setup({
      config: { ...healthyConfig, mcp: { enabled: true, injectIntoAgents: false } },
    });
    const result = await service.start(onWorkspace, port);
    expect(result.ok === false && result.blockers.join("\n")).toContain("注入 Paseo tools");
  });

  test("a daemon that cannot report its config or providers ends at the Profile blocker", async () => {
    const { service, port } = setup();
    port.config.get.mockRejectedValue(new Error("no config"));
    port.providers.listAvailable.mockRejectedValue(new Error("no providers"));
    const result = await service.start(onWorkspace, port);
    expect(result.ok === false && result.blockers).toContain(zh.modes.contextUnavailable);
    // Without the config there are also no Profiles, so the coordinator blocker remains.
    expect(result.ok === false && result.blockers.join("\n")).toContain("Profile");
  });
});

describe("launch preview and hash", () => {
  test("previews without creating anything and returns a usable hash", async () => {
    const { service, port, created, sent } = setup();
    const result = await service.preview(onWorkspace, port);
    expect(() => LaunchPreviewResultSchema.parse(result)).not.toThrow();
    if (!result.ok) throw new Error(`unexpected blockers: ${result.blockers.join(", ")}`);
    expect(result.preview.requestedMode).toBe("sota");
    expect(result.preview.seats).toHaveLength(2);
    expect(result.preview.counts.physical).toBe(2);
    expect(result.preview.coordinator.profile?.id).toBe(claudeOpus.id);
    expect(result.preview.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.preview)).not.toContain('"notes"');
    expect(JSON.stringify(result.preview)).not.toContain("systemPrompt");
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(port.workspaces.create).not.toHaveBeenCalled();
    expect(service.status("run-test")).toBeNull();
  });

  test("accepts the preview hash and rejects a stale one before creating", async () => {
    const { service, port, created } = setup();
    const preview = await service.preview(onWorkspace, port);
    if (!preview.ok) throw new Error("unexpected preview blockers");

    const stale = await service.start(
      { ...onWorkspace, task: "Changed task", expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(stale).toMatchObject({ ok: false, blockers: [zh.modes.planChanged] });
    expect(created).toHaveLength(0);
    expect(service.status("run-test")).toBeNull();

    const started = await service.start(
      { ...onWorkspace, expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.job.planHash).toBe(preview.preview.planHash);
    expect(started.job.mode).toBe("sota");
    await settled(service, started.job.runId);
    expect(created).toHaveLength(3);
  });

  test("a mode override affects the preview and job without changing the Team", async () => {
    const { service, port } = setup();
    const preview = await service.preview({ ...onWorkspace, mode: "economy" }, port);
    if (!preview.ok) throw new Error(`unexpected blockers: ${preview.blockers.join(", ")}`);
    expect(preview.preview.requestedMode).toBe("economy");
    expect(preview.preview.issues).toContainEqual(
      expect.objectContaining({ code: "MODE_ONDEMAND_FALLBACK_EAGER" }),
    );
    expect(
      preview.preview.issues.filter((issue) => issue.code === "MODE_ONDEMAND_FALLBACK_EAGER"),
    ).toHaveLength(1);

    const started = await service.start(
      { ...onWorkspace, mode: "economy", expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.job.mode).toBe("economy");
  });

  test("previewing a new workspace validates the project without creating it", async () => {
    const { service, port } = setup();
    const preview = await service.preview(
      { ...onWorkspace, target: { kind: "new-workspace", projectId: "p1", title: "Billing" } },
      port,
    );
    expect(preview.ok).toBe(true);
    expect(port.projects.list).toHaveBeenCalled();
    expect(port.workspaces.create).not.toHaveBeenCalled();
  });

  test("availability failure keeps SOTA launching like HEAD, with a warning", async () => {
    const normal = setup();
    const degraded = setup();
    degraded.port.providers.listAvailable.mockRejectedValue(new Error("providers offline"));
    const preview = await degraded.service.preview(onWorkspace, degraded.port);
    if (!preview.ok) throw new Error(`unexpected blockers: ${preview.blockers.join(", ")}`);
    expect(preview.preview.warnings).toContain(zh.modes.availabilityUnverified);

    await normal.service.start(onWorkspace, normal.port);
    await settled(normal.service, "run-test");
    const started = await degraded.service.start(
      { ...onWorkspace, expectedPlanHash: preview.preview.planHash },
      degraded.port,
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await settled(degraded.service, "run-test");
    expect(started.job.warnings).toContain(zh.modes.availabilityUnverified);
    const pick = (agents: typeof normal.created) =>
      agents.map((agent) => ({
        title: agent.options.title,
        labels: agent.options.labels,
        parent: agent.options.parent,
        config: agent.options.config,
      }));
    expect(pick(degraded.created)).toEqual(pick(normal.created));
    expect(degraded.sent[0]?.text).toBe(normal.sent[0]?.text);
  });

  test("availability failure blocks economy and collaborative modes with one issue", async () => {
    for (const mode of ["economy", "collaborative"] as const) {
      const { service, port, created } = setup();
      port.providers.listAvailable.mockRejectedValue(new Error("providers offline"));
      const preview = await service.preview({ ...onWorkspace, mode }, port);
      expect(preview.ok, mode).toBe(false);
      if (preview.ok) continue;
      expect(preview.blockers).toContain(zh.modes.contextUnavailable);
      expect(
        preview.issues.filter((issue) => issue.code === "MODE_CONTEXT_UNAVAILABLE"),
        mode,
      ).toHaveLength(1);
      expect(created).toHaveLength(0);

      const started = await service.start({ ...onWorkspace, mode }, port);
      expect(started.ok, mode).toBe(false);
      expect(created).toHaveLength(0);
    }
  });

  test("raw host errors never reach the RPC result", async () => {
    const secret = "connect ECONNREFUSED /secret/path token=ABC";
    const { service, port, log, created } = setup();
    port.config.get.mockRejectedValue(new Error(secret));
    const configFailure = await service.preview(onWorkspace, port);
    expect(configFailure.ok).toBe(false);
    expect(JSON.stringify(configFailure)).not.toContain("/secret/path");
    expect(JSON.stringify(configFailure)).not.toContain("token=ABC");
    if (!configFailure.ok) {
      expect(configFailure.issues).toContainEqual(
        expect.objectContaining({
          code: "MODE_CONTEXT_UNAVAILABLE",
          params: expect.objectContaining({ reason: "config-read-failed" }),
        }),
      );
    }
    expect(log).toHaveBeenCalled();
    expect(created).toHaveLength(0);

    const availability = setup();
    availability.port.providers.listAvailable.mockRejectedValue(new Error(secret));
    const availabilityFailure = await availability.service.preview(
      { ...onWorkspace, mode: "economy" },
      availability.port,
    );
    expect(availabilityFailure.ok).toBe(false);
    expect(JSON.stringify(availabilityFailure)).not.toContain("/secret/path");
    expect(JSON.stringify(availabilityFailure)).not.toContain("token=ABC");
    if (!availabilityFailure.ok) {
      expect(availabilityFailure.issues).toContainEqual(
        expect.objectContaining({
          code: "MODE_CONTEXT_UNAVAILABLE",
          params: expect.objectContaining({ reason: "availability-unverified" }),
        }),
      );
    }
  });

  test("unrelated Role and Team edits do not invalidate a preview hash", async () => {
    const rolesDoc = { roles: [techLead, architect, developer] };
    const teamsDoc = { teams: [codingTeam] };
    const rolesReader = {
      read: async () => ({ status: "ready" as const, values: rolesDoc }),
    };
    const teamsReader = {
      read: async () => ({ status: "ready" as const, values: teamsDoc }),
    };
    const { service, port } = setup({ roles: rolesReader, teams: teamsReader });
    const preview = await service.preview(onWorkspace, port);
    if (!preview.ok) throw new Error("unexpected preview blockers");

    rolesDoc.roles.push(role({ id: "unrelated", name: "Unrelated" }));
    teamsDoc.teams.push({ ...codingTeam, id: "unrelated-team", name: "Unrelated Team" });
    const started = await service.start(
      { ...onWorkspace, expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(started.ok).toBe(true);
  });

  test("a referenced Role or Profile change rejects the old hash", async () => {
    const rolesDoc = { roles: [techLead, architect, developer] };
    const { service, port, created } = setup({
      roles: { read: async () => ({ status: "ready" as const, values: rolesDoc }) },
    });
    const preview = await service.preview(onWorkspace, port);
    if (!preview.ok) throw new Error("unexpected preview blockers");
    rolesDoc.roles = rolesDoc.roles.map((entry) =>
      entry.id === "architect" ? { ...entry, systemPrompt: "Changed prompt" } : entry,
    );
    const staleRole = await service.start(
      { ...onWorkspace, expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(staleRole).toMatchObject({ ok: false, blockers: [zh.modes.planChanged] });
    expect(created).toHaveLength(0);

    const profile = setup();
    const profilePreview = await profile.service.preview(onWorkspace, profile.port);
    if (!profilePreview.ok) throw new Error("unexpected preview blockers");
    profile.port.config.get.mockResolvedValue({
      config: {
        ...healthyConfig,
        agentProfiles: healthyConfig.agentProfiles.map((entry) =>
          entry.id === claudeOpus.id ? { ...entry, modeId: "manual" } : entry,
        ),
      },
    });
    const staleProfile = await profile.service.start(
      { ...onWorkspace, expectedPlanHash: profilePreview.preview.planHash },
      profile.port,
    );
    expect(staleProfile).toMatchObject({ ok: false, blockers: [zh.modes.planChanged] });
    expect(profile.created).toHaveLength(0);
  });

  test("start warnings match preview warnings for pool problems", async () => {
    const { service, port } = setup({
      prefs: {
        ...preferences,
        economy: {
          pool: [
            { profileId: "ghost", enabled: true },
            { profileId: "ghost2", enabled: true },
          ],
        },
      },
    });
    const preview = await service.preview({ ...onWorkspace, mode: "economy" }, port);
    if (!preview.ok) throw new Error(`unexpected blockers: ${preview.blockers.join(", ")}`);
    expect(
      preview.preview.warnings.filter((warning) => warning.includes("经济池条目")),
    ).toHaveLength(2);
    const started = await service.start(
      { ...onWorkspace, mode: "economy", expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.job.warnings).toEqual(preview.preview.warnings);
  });

  test("an economy pool participates in the hash and accepts a matching start", async () => {
    const { service, port } = setup({
      prefs: {
        ...preferences,
        economy: {
          pool: [
            {
              profileId: claudeOpus.id,
              family: "claude",
              enabled: true,
              boundModel: { provider: "claude", model: "opus" },
            },
          ],
        },
      },
    });
    const preview = await service.preview({ ...onWorkspace, mode: "economy" }, port);
    if (!preview.ok) throw new Error(`unexpected blockers: ${preview.blockers.join(", ")}`);
    const started = await service.start(
      { ...onWorkspace, mode: "economy", expectedPlanHash: preview.preview.planHash },
      port,
    );
    expect(started.ok).toBe(true);
  });

  test("freezes the legacy SOTA creation output", async () => {
    const { service, port, created, sent } = setup();
    await service.start(onWorkspace, port);
    await settled(service, "run-test");
    expect(
      created.map((agent) => ({
        title: agent.options.title,
        labels: agent.options.labels,
        parent: agent.options.parent,
        config: agent.options.config,
      })),
    ).toMatchSnapshot();
    expect(sent[0]?.text).toMatchSnapshot();
  });
});

describe("launch failures", () => {
  test("a member that cannot be created fails the job, cleaning up when configured", async () => {
    const { service, port, create, archived, log } = setup();
    create.mockImplementation(async (_workspaceId, options) => {
      if (options.parent) throw new Error("model not found");
      return { id: "coord-1" };
    });
    await service.start(onWorkspace, port);
    const job = await settled(service, "run-test");
    expect(job).toMatchObject({
      state: "failed",
      error: {
        step: "member",
        archived: true,
        agentIdsKept: [],
        detail: "model not found",
      },
    });
    expect(() => LaunchJobSchema.parse(job)).not.toThrow();
    expect(archived).toEqual(["coord-1"]);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("run-test");
  });

  test("keeps the agents when the preference says so", async () => {
    const { service, port, create, archived } = setup({
      prefs: { ...preferences, archiveOnLaunchFailure: false },
    });
    create.mockImplementation(async (_workspaceId, options) => {
      if (options.parent) throw new Error("model not found");
      return { id: "coord-1" };
    });
    await service.start(onWorkspace, port);
    const job = await settled(service, "run-test");
    expect(job?.error).toMatchObject({ archived: false, agentIdsKept: ["coord-1"] });
    expect(archived).toEqual([]);
  });

  test("a kickoff that cannot be delivered hands back the text to paste", async () => {
    const { service, port } = setup();
    port.agents.ref.mockImplementation(() => ({
      send: async () => {
        throw new Error("send failed");
      },
      archive: async () => ({}),
    }));
    await service.start(onWorkspace, port);
    const job = await settled(service, "run-test");
    expect(job?.error?.step).toBe("kickoff");
    expect(job?.error?.kickoffMessage).toContain("# Task");
    expect(job?.error?.detail).toBe("send failed");
  });

  test("explains a workspace that could not be created", async () => {
    const { service, port } = setup();
    port.workspaces.create.mockRejectedValueOnce(new Error("disk full"));
    await service.start(
      { ...onWorkspace, target: { kind: "new-workspace", projectId: "p1" } },
      port,
    );
    const job = await settled(service, "run-test");
    expect(job).toMatchObject({
      state: "failed",
      error: { step: "workspace", message: "无法创建 Workspace", detail: "disk full" },
    });
  });

  test("reports a string cause, and no detail for a cause with no message", async () => {
    const text = setup();
    text.create.mockRejectedValue("plain string");
    await text.service.start(onWorkspace, text.port);
    expect((await settled(text.service, "run-test"))?.error?.detail).toBe("plain string");

    const opaque = setup();
    opaque.create.mockRejectedValue({ code: 1 });
    await opaque.service.start(onWorkspace, opaque.port);
    expect((await settled(opaque.service, "run-test"))?.error?.detail).toBeUndefined();
  });
});

describe("job retention", () => {
  test("forgets finished jobs after an hour", async () => {
    let clock = new Date("2026-10-01T10:00:00.000Z");
    let count = 0;
    const { service, port } = setup({
      now: () => clock,
      runId: () => `run-${++count}`,
    });
    await service.start(onWorkspace, port);
    await settled(service, "run-1");

    clock = new Date("2026-10-01T11:01:00.000Z");
    await service.start(onWorkspace, port);
    expect(service.status("run-1")).toBeNull();
    expect(service.status("run-2")).not.toBeNull();
  });

  test("keeps at most fifty jobs, dropping the oldest", async () => {
    let count = 0;
    const { service, port } = setup({ runId: () => `run-${++count}` });
    for (let index = 0; index < 52; index += 1) await service.start(onWorkspace, port);
    expect(service.status("run-1")).toBeNull();
    expect(service.status("run-2")).toBeNull();
    expect(service.status("run-3")).not.toBeNull();
    expect(service.status("run-52")).not.toBeNull();
  });
});
