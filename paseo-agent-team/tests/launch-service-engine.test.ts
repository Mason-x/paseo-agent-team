import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLaunchService, type LaunchService } from "../server/launch-service";
import type { EngineLaunchHost } from "../server/run-engine/runtime";
import type { EngineStartInput, EngineStartResult } from "../server/run-engine/start";
import { LaunchJobSchema, type LaunchStartInput } from "../shared/rpc";
import { runEngineZh } from "../shared/zh/run-engine";
import { fakePort, preferences, ready, workspace } from "./fakes";
import { architect, codingTeam, developer, techLead } from "./fixtures";
import { policy } from "./fixtures/run-engine/base";

/**
 * Failure modes this file guards:
 *  - an Engine-enabled Team quietly running on the old coordinator chain (flag off, no host);
 *  - an Engine start that goes ahead although its ledger, server id or Workspace cannot support it;
 *  - a Team without the block being touched by the Engine at all;
 *  - the Run not getting the real directory of the Workspace the job reports.
 */

const zh = runEngineZh.launch;
const RUN_ID = "run-wire-1";

const engineTeam = {
  ...codingTeam,
  members: [
    { roleId: "architect", seatId: "seat-a", enabled: true },
    { roleId: "developer", instanceLabel: "Backend", seatId: "seat-d", enabled: true },
  ],
  runEngine: {
    version: 1,
    enabled: true,
    seats: ["seat-a", "seat-d"].map((seatId) => ({
      seatId,
      tier: "B",
      duties: ["implement"],
      channelId: "claude",
      enabled: true,
    })),
    policy: policy(),
  },
};

const onWorkspace: LaunchStartInput = {
  teamId: "coding-team",
  task: "Add Stripe",
  target: { kind: "workspace", workspaceId: "ws-1" },
};

let home: string;
let repoDir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args],
    { cwd, windowsHide: true, stdio: "ignore" },
  );
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "launch-engine-")));
  repoDir = path.join(home, "repo");
  await mkdir(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "a.txt"), "x");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function engineHost(
  overrides: {
    supported?: boolean;
    identity?: Awaited<ReturnType<EngineLaunchHost["identity"]>>;
    committer?: Awaited<ReturnType<EngineLaunchHost["commitIdentity"]>>;
    result?: EngineStartResult;
  } = {},
) {
  const start = vi.fn<EngineLaunchHost["start"]>(
    async (input: Omit<EngineStartInput, "serverId" | "paseoHome">) => {
      input.onProgress?.({ step: "coordinator" });
      return (
        overrides.result ?? {
          ok: true,
          runId: input.plan.runId,
          coordinatorId: "agent-coord",
          memberIds: ["agent-1", "agent-2"],
          launchState: "running",
        }
      );
    },
  );
  const host: EngineLaunchHost = {
    supported: overrides.supported ?? true,
    identity: async () =>
      overrides.identity ?? {
        ok: true,
        serverId: "srv-dev",
        paseoHome: home.replaceAll("\\", "/"),
      },
    // The machine's own git config must not decide these tests.
    commitIdentity: async () => overrides.committer ?? { ok: true },
    start,
  };
  return { host, start };
}

function setup(options: { team?: unknown; engine?: EngineLaunchHost; workspaceDir?: string } = {}) {
  const fake = fakePort();
  fake.refresh.mockResolvedValue({
    ...workspace,
    workspaceDirectory: options.workspaceDir ?? repoDir,
  });
  const service = createLaunchService({
    roles: ready({ roles: [techLead, architect, developer] }),
    teams: ready({ teams: [options.team ?? engineTeam] }) as never,
    preferences: ready(preferences),
    ...(options.engine ? { engine: options.engine } : {}),
    runId: () => RUN_ID,
    now: () => new Date("2026-11-06T10:00:00.000Z"),
    log: vi.fn(),
  });
  return { ...fake, service };
}

async function settled(service: LaunchService) {
  await vi.waitFor(() => expect(service.status(RUN_ID)?.state).not.toBe("running"));
  return service.status(RUN_ID);
}

async function blockedBy(service: LaunchService, port: Parameters<LaunchService["preview"]>[1]) {
  const preview = await service.preview(onWorkspace, port);
  if (preview.ok) throw new Error("expected the preview to be blocked");
  return preview.blockers;
}

describe("an Engine-enabled Team without a supported Engine", () => {
  test("is blocked in the preview and at start, with the reason, when no Engine host exists", async () => {
    const { service, port, created } = setup();
    expect(await blockedBy(service, port)).toContain(zh.unsupported);
    const started = await service.start(onWorkspace, port);
    expect(started).toMatchObject({ ok: false });
    expect(created).toHaveLength(0);
  });

  test("is blocked the same way when the switch is off, and the Engine is never asked", async () => {
    const { host, start } = engineHost({ supported: false });
    const { service, port, created } = setup({ engine: host });
    expect(await blockedBy(service, port)).toEqual([zh.unsupported]);
    expect(await service.start(onWorkspace, port)).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});

describe("an Engine-enabled Team on a supported Engine", () => {
  test("previews cleanly and starts through the Engine, not the coordinator chain", async () => {
    const { host, start } = engineHost();
    const { service, port, created, sent } = setup({ engine: host });
    expect(await service.preview(onWorkspace, port)).toMatchObject({ ok: true });

    const started = await service.start(onWorkspace, port);
    if (!started.ok) throw new Error(`unexpected blockers: ${started.blockers.join(", ")}`);
    expect(started.job).toMatchObject({
      runId: RUN_ID,
      state: "running",
      workspaceId: "ws-1",
    });
    // The job carries the Engine's launch state from the first moment (the fake host has already
    // reported its first step by the time the RPC answers).
    expect(started.job.engine?.launchState).toMatch(/^(preparing|creating)$/);

    const done = await settled(service);
    expect(done).toMatchObject({
      state: "succeeded",
      step: "done",
      coordinatorId: "agent-coord",
      memberIds: ["agent-1", "agent-2"],
      engine: { launchState: "running" },
    });
    expect(() => LaunchJobSchema.parse(done)).not.toThrow();

    expect(start).toHaveBeenCalledOnce();
    const input = start.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      workspaceDirectory: repoDir,
      requestId: RUN_ID,
      maxMembers: preferences.maxMembers,
      archiveOnLaunchFailure: true,
    });
    expect(input?.plan).toMatchObject({ runId: RUN_ID, workspaceId: "ws-1" });
    expect(input?.engine.seats.map((seat) => seat.seatId)).toEqual(["seat-a", "seat-d"]);
    expect(input?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    // The old chain created three agents; the Engine path creates none of its own here.
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("a plan request that is not proven delivered still reports the launch, and says so", async () => {
    const { host } = engineHost({
      result: {
        ok: true,
        runId: RUN_ID,
        coordinatorId: "agent-coord",
        memberIds: [],
        launchState: "kickoff-pending",
      },
    });
    const { service, port } = setup({ engine: host });
    await service.start(onWorkspace, port);
    expect(await settled(service)).toMatchObject({
      state: "succeeded",
      engine: { launchState: "kickoff-pending" },
    });
  });

  test("a failed start is a failed job with the step, the kept agents and the Engine state", async () => {
    const { host } = engineHost({
      result: {
        ok: false,
        step: "member",
        message: "无法创建第 1/2 个成员",
        detail: "boom",
        archived: false,
        agentIdsKept: ["agent-coord"],
      },
    });
    const { service, port } = setup({ engine: host });
    await service.start(onWorkspace, port);
    const done = await settled(service);
    expect(done).toMatchObject({
      state: "failed",
      engine: { launchState: "failed" },
      error: { step: "member", detail: "boom", archived: false, agentIdsKept: ["agent-coord"] },
    });
    expect(() => LaunchJobSchema.parse(done)).not.toThrow();
  });

  test("a preflight failure is shown on the first step, not on a step the old chain does not have", async () => {
    const { host } = engineHost({
      result: {
        ok: false,
        step: "preflight",
        message: "证据目录不可用",
        archived: false,
        agentIdsKept: [],
      },
    });
    const { service, port } = setup({ engine: host });
    await service.start(onWorkspace, port);
    expect((await settled(service))?.error?.step).toBe("coordinator");
  });

  test("an exception from the Engine fails the job instead of leaving it running", async () => {
    const { host, start } = engineHost();
    start.mockRejectedValue(new Error("ledger exploded"));
    const { service, port } = setup({ engine: host });
    await service.start(onWorkspace, port);
    expect(await settled(service)).toMatchObject({
      state: "failed",
      engine: { launchState: "failed" },
      error: { detail: "ledger exploded" },
    });
  });

  test("a new Workspace is created first and its real directory is what the Engine gets", async () => {
    const { host, start } = engineHost();
    const { service, port, refresh } = setup({ engine: host });
    refresh.mockResolvedValue({ ...workspace, id: "ws-1", workspaceDirectory: repoDir });
    // The created Workspace resolves to the fake host's own directory.
    const started = await service.start(
      { ...onWorkspace, target: { kind: "new-workspace", projectId: "p1" } },
      port,
    );
    if (!started.ok) throw new Error(`unexpected blockers: ${started.blockers.join(", ")}`);
    await settled(service);
    expect(port.workspaces.create).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      plan: { workspaceId: "ws-new" },
      workspaceDirectory: workspace.workspaceDirectory,
    });
    expect(service.status(RUN_ID)).toMatchObject({ workspaceId: "ws-new", state: "succeeded" });
  });
});

describe("what blocks an Engine start before anything is created", () => {
  test("an unreadable ledger or server id", async () => {
    for (const reason of ["home-unavailable", "ledger-unavailable", "server-id-unavailable"]) {
      const { host, start } = engineHost({ identity: { ok: false, reason } });
      const { service, port, created } = setup({ engine: host });
      expect(await blockedBy(service, port)).toEqual([zh.identityUnavailable(reason)]);
      expect(await service.start(onWorkspace, port)).toMatchObject({ ok: false });
      expect(start).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    }
  });

  test("a Workspace that is not a git repository", async () => {
    const plain = path.join(home, "plain");
    await mkdir(plain);
    const { host } = engineHost();
    const { service, port } = setup({ engine: host, workspaceDir: plain });
    const blockers = await blockedBy(service, port);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("git 仓库");
  });

  test("a detached HEAD", async () => {
    git(repoDir, "checkout", "-q", "--detach");
    const { host } = engineHost();
    const { service, port } = setup({ engine: host });
    expect(await blockedBy(service, port)).toEqual([zh.workspaceDetached]);
  });

  test("a repository without a commit", async () => {
    const empty = path.join(home, "empty");
    await mkdir(empty);
    git(empty, "init", "-q", "-b", "main");
    const { host } = engineHost();
    const { service, port } = setup({ engine: host, workspaceDir: empty });
    expect(await blockedBy(service, port)).toEqual([zh.workspaceNoCommit]);
  });

  test("a dirty working tree, and start is refused with it too", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "changed");
    const { host, start } = engineHost();
    const { service, port } = setup({ engine: host });
    expect(await blockedBy(service, port)).toEqual([zh.workspaceDirty]);
    expect(await service.start(onWorkspace, port)).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled();
  });

  test("a Workspace git cannot commit in, in the preview and at start", async () => {
    const detail = "fatal: unable to auto-detect email address";
    const { host, start } = engineHost({ committer: { ok: false, detail } });
    const { service, port, created } = setup({ engine: host });
    expect(await blockedBy(service, port)).toEqual([zh.commitIdentityMissing(detail)]);
    expect(await service.start(onWorkspace, port)).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  test("a Workspace the host gives no directory for", async () => {
    const { host } = engineHost();
    const { service, port, refresh } = setup({ engine: host });
    refresh.mockResolvedValue({
      ...workspace,
      workspaceDirectory: undefined,
      projectRootPath: "",
    });
    expect(await blockedBy(service, port)).toEqual([zh.workspaceNoDirectory]);
  });
});

describe("Teams without the block", () => {
  test("keep the original chain, with an Engine host present and switched on", async () => {
    const { host, start } = engineHost();
    const { service, port, created } = setup({ team: codingTeam, engine: host });
    const started = await service.start(onWorkspace, port);
    if (!started.ok) throw new Error(`unexpected blockers: ${started.blockers.join(", ")}`);
    expect(started.job).not.toHaveProperty("engine");
    const done = await settled(service);
    expect(done).toMatchObject({ state: "succeeded", coordinatorId: "coord-1" });
    expect(done).not.toHaveProperty("engine");
    expect(created).toHaveLength(3);
    expect(start).not.toHaveBeenCalled();
  });

  test("a block that is switched off also keeps the original chain", async () => {
    const off = { ...engineTeam, runEngine: { ...engineTeam.runEngine, enabled: false } };
    const { host, start } = engineHost();
    const { service, port, created } = setup({ team: off, engine: host });
    const started = await service.start(onWorkspace, port);
    expect(started.ok).toBe(true);
    await settled(service);
    expect(created).toHaveLength(3);
    expect(start).not.toHaveBeenCalled();
  });
});
