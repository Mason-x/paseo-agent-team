import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpc, summarize } from "../../v2/server/rpc";
import { ResolveChoiceSchema, StartInputSchema } from "../../v2/shared/rpc";
import { harness } from "./harness";
import { commit } from "./repo";

const open: ReturnType<typeof harness>[] = [];
const setup = (opts?: Parameters<typeof harness>[0]) => {
  const h = harness(opts);
  open.push(h);
  return { h, rpc: createRpc(h.engine) };
};
afterEach(async () => {
  while (open.length) {
    const h = open.pop();
    await h?.engine.dispose();
    h?.cleanup();
  }
});

describe("run.list / run.get", () => {
  it("lists every Run with who it is waiting for", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    const { runs } = await rpc.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: run.id,
      state: "writing",
      waiting: { who: "writer" },
      branch: run.workspace.branch,
      workspaceId: run.workspace.id,
      writerAgentId: run.writer.agentId,
      writerProfile: run.writer.profile,
    });
    expect(summarize(run).waiting.options).toContain("abandon");
  });

  it("get reconciles, reports how far the base moved, and surfaces a pending permission", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    commit(run.repo.sourceCheckout, "other.txt", "x"); // main moves on
    const writer = h.host.writerAgent();
    if (writer) writer.pending = 1;
    const view = await rpc.get(run.id);
    expect(view.behindBase).toBe(1);
    expect(view.pendingPermission).toBe(true);
    expect(view.pendingPermissionAgentId).toBe(run.writer.agentId);
    expect(view.waiting.why).toContain("权限");
    if (writer) writer.pending = 0;
    const cleared = await rpc.get(run.id);
    expect(cleared.pendingPermission).toBe(false);
    expect(cleared.pendingPermissionAgentId).toBeNull();
    if (writer) writer.archived = true; // reconcile inside get notices this
    expect((await rpc.get(run.id)).run.state).toBe("blocked");
  });

  it("get on an unknown Run fails clearly", async () => {
    const { rpc } = setup();
    await expect(rpc.get("r-20261112-ffff")).rejects.toThrow("不存在");
  });
});

describe("run.artifact", () => {
  it("reads live artifacts, tails logs to 200 lines, rejects traversal, and falls back to archive", async () => {
    const { h, rpc } = setup();
    const run = await h.start();

    const task = await rpc.artifact(run.id, run.task.file);
    expect(task.archived).toBe(false);
    expect(task.content).toContain("# demo");

    const missing = await rpc.artifact(run.id, ".team/progress.md");
    expect(missing).toMatchObject({ content: null, archived: false });

    const gateDir = path.join(run.workspace.path, ".team/gate");
    mkdirSync(gateDir, { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`).join("\n");
    writeFileSync(path.join(gateDir, "a1-1.log"), lines);
    const log = await rpc.artifact(run.id, ".team/gate/a1-1.log");
    expect(log.content).not.toContain("line-1\n");
    expect(log.content).toContain("line-250");

    await expect(rpc.artifact(run.id, "../secret")).rejects.toThrow();
    await expect(rpc.artifact(run.id, ".team/../secret")).rejects.toThrow();
    await expect(rpc.artifact(run.id, ".team/other.md")).rejects.toThrow();

    mkdirSync(path.join(run.workspace.path, ".team/reviews"), { recursive: true });
    const escapeLink = path.join(run.workspace.path, ".team/reviews/1-r1.md");
    symlinkSync("/etc/hosts", escapeLink);
    await expect(rpc.artifact(run.id, ".team/reviews/1-r1.md")).rejects.toThrow();
    unlinkSync(escapeLink);

    await rpc.resolve(run.id, { kind: "abandon" });
    await h.engine.idle();
    const archivedTask = await rpc.artifact(run.id, run.task.file);
    expect(archivedTask.archived).toBe(true);
    expect(archivedTask.content).toContain("# demo");
  });
});

describe("run.resolve / run.close", () => {
  it("answers a writer's question and resumes it", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    await h.call(
      h.writerTools(run).team_block as never,
      { reason: "stuck", question: "which db?" },
      run.writer.agentId,
    );
    const { run: after } = await rpc.resolve(run.id, { kind: "message", text: "use sqlite" });
    expect(after.state).toBe("writing");
    await h.engine.idle();
    expect(h.host.writerAgent()?.sent).toEqual(["use sqlite"]);
  });

  it("rejects a choice that does not fit the blocked reason", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    await h.call(h.writerTools(run).team_block as never, { reason: "stuck" }, run.writer.agentId);
    await expect(rpc.resolve(run.id, { kind: "retry" })).rejects.toThrow("不适用");
    await expect(rpc.resolve(run.id, { kind: "more-round" })).rejects.toThrow("不适用");
  });

  it("resubmit refuses a dirty tree and names the files", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    commit(run.workspace.path, "moved.ts", "x");
    await h.engine.reconcile(run.id);
    writeFileSync(path.join(run.workspace.path, "dirty.txt"), "x");
    await expect(rpc.resolve(r.id, { kind: "resubmit" })).rejects.toThrow("dirty.txt");
  });

  it("abandon works from any state and cleans up", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    const { run: gone } = await rpc.resolve(run.id, { kind: "abandon" });
    expect(gone.state).toBe("abandoned");
    await h.engine.idle();
    expect(h.host.liveWorkspaceNames()).toEqual([]);
  });

  it("merged is only allowed from ready", async () => {
    const { h, rpc } = setup();
    const run = await h.start();
    await expect(rpc.close(run.id, "merged")).rejects.toThrow("不能标记");
    const r = await h.toReviewing(run);
    await h.verdict(r, r.reviews[0] as never, "approve");
    await h.engine.idle();
    expect((await rpc.close(run.id, "merged")).run.state).toBe("merged");
    await expect(rpc.close(run.id, "abandoned")).rejects.toThrow("不能标记");
  });
});

describe("project.config", () => {
  it("returns null without a file, parses a valid one and reports an invalid one", async () => {
    const { h, rpc } = setup();
    expect(await rpc.projectConfig(h.r.dir)).toEqual({ config: null, error: null });
    writeFileSync(
      path.join(h.r.dir, "paseo-team.json"),
      JSON.stringify({
        gate: [{ name: "t", command: "npm test", timeoutSec: 60 }],
        protectedPaths: ["tests/**"],
      }),
    );
    expect((await rpc.projectConfig(h.r.dir)).config?.gate?.[0]?.command).toBe("npm test");
    writeFileSync(path.join(h.r.dir, "paseo-team.json"), "{nope");
    expect((await rpc.projectConfig(h.r.dir)).error).toBeTruthy();
    writeFileSync(
      path.join(h.r.dir, "paseo-team.json"),
      JSON.stringify({ gate: [{ name: "", command: "x", timeoutSec: 1 }] }),
    );
    expect((await rpc.projectConfig(h.r.dir)).config).toBeNull();
  });
});

describe("contracts", () => {
  it("validate what the UI may send", () => {
    expect(ResolveChoiceSchema.safeParse({ kind: "more-attempts", n: 0 }).success).toBe(false);
    expect(ResolveChoiceSchema.safeParse({ kind: "accept-current" }).success).toBe(true);
    expect(ResolveChoiceSchema.safeParse({ kind: "accept-current", sha: "x" }).success).toBe(true); // extra keys are stripped
    const base = {
      title: "t",
      repoPath: "/r",
      baseRef: "main",
      taskMarkdown: "x",
      gateCommands: [],
      protectedPaths: [],
      writer: { profile: "w", provider: "claude/sonnet" },
      reviewers: [{ profile: "r", provider: "codex/gpt" }],
    };
    expect(StartInputSchema.safeParse(base).success).toBe(true);
    expect(StartInputSchema.safeParse({ ...base, reviewers: [] }).success).toBe(false);
    const bare = { ...base, reviewers: [{ profile: "r", provider: "codex" }] };
    expect(StartInputSchema.safeParse(bare).success).toBe(false); // caught at launch, not mid-run
  });
});
