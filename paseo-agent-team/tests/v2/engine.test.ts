import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchesWithPrefix, branchSha, head } from "../../v2/server/git";
import { harness, TASK } from "./harness";
import { commit, sh, write } from "./repo";

const open: ReturnType<typeof harness>[] = [];
const setup = (opts?: Parameters<typeof harness>[0]) => {
  const h = harness(opts);
  open.push(h);
  return h;
};
afterEach(async () => {
  while (open.length) {
    const h = open.pop();
    await h?.engine.dispose();
    h?.cleanup();
  }
});

describe("start (FR1-FR3, FR17)", () => {
  it("creates the worktree, .team/task.md and a writer that is told paths, not the task", async () => {
    const h = setup();
    const run = await h.start();
    expect(run.state).toBe("writing");
    expect(run.workspace.branch).toBe(`team/${run.id}/writer`);
    expect(readFileSync(path.join(run.workspace.path, ".team/task.md"), "utf8")).toBe(TASK);
    expect(sh(run.workspace.path, "status", "--porcelain")).toBe(""); // .team/ is excluded, .gitignore untouched
    expect(await head(run.workspace.path)).toBe(run.repo.baseSha);
    const writer = h.host.writerAgent();
    expect(writer?.id).toBe(run.writer.agentId);
    expect(writer?.labels).toEqual({ "agent-team.run": run.id, "agent-team.role": "writer" });
    expect(writer?.prompt).toContain(".team/task.md");
    expect(writer?.prompt).not.toContain("add a"); // task body is never pasted into the prompt
    expect(await h.engine.get(run.id)).toMatchObject({ state: "writing", id: run.id });
  });

  it("refuses to start without a verification command or section", async () => {
    const h = setup();
    await expect(h.start({ gateCommands: [] })).rejects.toThrow("没有验收命令");
    await expect(h.start({ taskMarkdown: "# x\n\n## 要什么结果\nfoo\n" })).rejects.toThrow(
      "怎么验证",
    );
    expect(h.host.liveWorkspaceNames()).toEqual([]);
  });

  it("limits reviewers to 1..3 and active Runs to the cap", async () => {
    const h = setup({ maxActive: 2 });
    await expect(h.start({ reviewers: [] })).rejects.toThrow("1 到 3");
    const four = Array.from({ length: 4 }, (_, i) => ({ profile: `r${i}`, provider: "codex/x" }));
    await expect(h.start({ reviewers: four })).rejects.toThrow("1 到 3");
    await h.start();
    await h.start();
    await expect(h.start()).rejects.toThrow("上限 2");
  });

  it("refuses to start when Paseo would not hand the team tools to the agents", async () => {
    const h = setup();
    h.host.daemonConfig = { mcp: { injectIntoAgents: false } };
    await expect(h.start()).rejects.toThrow("注入");
    h.host.daemonConfig = { mcp: { enabled: false } };
    await expect(h.start()).rejects.toThrow("MCP");
    h.host.daemonConfig = { providers: { codex: { paseoTools: { enabled: false } } } };
    await expect(h.start()).rejects.toThrow("codex");
    h.host.daemonConfig = "something from a future version";
    expect((await h.start()).state).toBe("writing"); // unknown shapes do not block
    expect(h.host.liveWorkspaceNames()).toHaveLength(1);
  });

  it("warns when a reviewer is the same family as the writer, without blocking", async () => {
    const h = setup();
    const { run, warnings } = await h.engine.start(
      h.input({ reviewers: [{ profile: "same", provider: "claude/opus", modeId: "auto" }] }),
    );
    expect(run.state).toBe("writing");
    expect(warnings[0]).toContain("claude");
  });

  it("warns about profiles without a modeId, since an asking mode stalls the agent", async () => {
    const h = setup();
    const { warnings } = await h.engine.start(
      h.input({
        writer: { profile: "w", provider: "claude/sonnet", modeId: "auto" },
      }),
    );
    expect(warnings).toEqual([]);
    const bare = await h.engine.start(
      h.input({ writer: { profile: "w", provider: "claude/sonnet" } }),
    );
    expect(bare.warnings).toEqual(["w 没有指定 modeId，写手可能停在权限请求上等人批准"]);
  });

  it("rejects a reviewer whose mode asks before acting, before creating anything (7.2.3)", async () => {
    const h = setup();
    const rev = (provider: string, modeId?: string) => ({ profile: "rev", provider, modeId });
    await expect(h.start({ reviewers: [rev("codex/gpt-5.4")] })).rejects.toThrow("r1");
    await expect(h.start({ reviewers: [rev("codex/gpt-5.4", "auto-review")] })).rejects.toThrow(
      "full-access",
    );
    await expect(h.start({ reviewers: [rev("claude/opus", "default")] })).rejects.toThrow("auto");
    await expect(h.start({ reviewers: [rev("pi/x", "default")] })).rejects.toThrow("没有实测过");
    const two = [rev("claude/opus", "auto"), rev("codex/gpt-5.4")];
    await expect(h.start({ reviewers: two })).rejects.toThrow("审查席位 r2");
    expect(h.host.liveWorkspaceNames()).toEqual([]);
    expect(h.host.agents.size).toBe(0);
    expect((await h.start({ reviewers: [rev("claude/opus", "auto")] })).state).toBe("writing");
  });

  it("leaves nothing behind when the writer cannot be created", async () => {
    const h = setup();
    h.host.failCreateAgent = () => true;
    await expect(h.start()).rejects.toThrow("injected");
    expect(await h.engine.list()).toEqual([]);
    expect(h.host.liveWorkspaceNames()).toEqual([]);
  });

  it("stops when the workspace setup fails", async () => {
    const h = setup();
    h.host.setup.set("team/", "failed");
    await expect(h.start()).rejects.toThrow("setup failed");
    expect(h.host.liveWorkspaceNames()).toEqual([]);
    expect(h.host.agents.size).toBe(0);
  });
});

describe("write, gate, review, ready (S1)", () => {
  it("rejects submit with uncommitted files and leaves the state alone (AC1)", async () => {
    const h = setup();
    const run = await h.start();
    write(run.workspace.path, "src/wip.ts", "x");
    const res = await h.call(
      h.writerTools(run).team_submit as never,
      { summary: "s" },
      run.writer.agentId,
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("src/wip.ts");
    expect((await h.get(run.id)).state).toBe("writing");
  });

  it("sends the real gate output back to a failing writer (AC2) and lets it retry", async () => {
    const h = setup({ gate: 'echo "boom: a is missing" >&2; test -f src/a.txt' });
    const run = await h.start();
    await h.submit(run, "src/b.txt", "b");
    await h.engine.idle();
    const failed = await h.get(run.id);
    expect(failed.state).toBe("writing");
    const log = readFileSync(
      path.join(run.workspace.path, failed.attempts[0]?.checks[0]?.logFile as string),
      "utf8",
    );
    expect(log).toBe("boom: a is missing\n");
    const message = h.host.writerAgent()?.sent.at(-1) ?? "";
    expect(message).toContain(log.trim());
    expect(message).toContain(".team/gate/1/test.log");

    await h.submit(run); // the fix
    await h.engine.idle();
    expect((await h.get(run.id)).state).toBe("reviewing");
  });

  it("builds a disposable worktree per reviewer with only what 5.2.1 allows", async () => {
    const h = setup();
    const run = await h.start();
    write(run.workspace.path, ".team/progress.md", "private notes");
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    if (!rv) throw new Error("no review");
    const sha = r.attempts[0]?.sha;
    expect(await head(rv.workspace.path)).toBe(sha);
    expect(rv.workspace.branch).toBe(`team/${run.id}/review-1-r1`);
    for (const f of [".team/task.md", ".team/review-brief.md"])
      expect(existsSync(path.join(rv.workspace.path, f))).toBe(true);
    for (const f of [".team/progress.md", ".team/gate"])
      expect(existsSync(path.join(rv.workspace.path, f))).toBe(false);
    expect(readFileSync(path.join(rv.workspace.path, ".team/review-brief.md"), "utf8")).toContain(
      `git diff ${run.repo.baseSha}...${sha}`,
    );
    const agent = h.host.reviewerAgents()[0];
    expect(agent?.cwd).toBe(rv.workspace.path);
    expect(agent?.labels).toMatchObject({
      "agent-team.role": "reviewer",
      "agent-team.seat": "r1",
      "agent-team.round": "1",
    });
    expect(agent?.prompt).toContain(rv.reportFile);
    expect(agent?.prompt).not.toContain("private notes");
  });

  it("approval makes the Run ready and removes the reviewer completely (AC5, AC6)", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    if (!rv) throw new Error("no review");
    const writerTip = await head(run.workspace.path);

    // the reviewer edits and commits in its own worktree; none of it may reach the writer
    commit(rv.workspace.path, "probe.test.ts", "probe");
    write(rv.workspace.path, "scratch.log", "junk");
    const res = await h.verdict(r, rv, "approve");
    expect(res.isError).toBeUndefined();
    await h.engine.idle();

    const ready = await h.get(run.id);
    expect(ready.state).toBe("ready");
    expect(ready.approved).toEqual({ sha: writerTip, reviewIds: [rv.id] });
    expect(await head(run.workspace.path)).toBe(writerTip);
    expect(sh(run.workspace.path, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(run.workspace.path, "probe.test.ts"))).toBe(false);
    expect(existsSync(rv.workspace.path)).toBe(false);
    expect(await branchSha(run.repo.sourceCheckout, rv.workspace.branch)).toBeNull();
    expect(ready.reviews[0]?.workspace.removedAt).toBeTruthy();
    expect(h.host.reviewerAgents().every((a) => a.archived)).toBe(true);
    expect(existsSync(path.join(run.workspace.path, rv.reportFile))).toBe(true);
    expect(existsSync(path.join(h.engine.store.archiveDir(run.id), "reviews/1-r1.md"))).toBe(true);
  });

  it("a commit after approval takes the Run out of ready (AC5)", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    await h.verdict(r, r.reviews[0] as never, "approve");
    await h.engine.idle();
    expect((await h.get(run.id)).state).toBe("ready");
    commit(run.workspace.path, "late.ts", "late");
    const after = await h.engine.reconcile(run.id);
    expect(after?.state).toBe("writing");
    expect(after?.approved).toBeUndefined();
  });

  it("request-changes sends all reports once and the next round reads them", async () => {
    const h = setup({ reviewers: 2 });
    const run = await h.start();
    const r = await h.toReviewing(run);
    const [r1, r2] = r.reviews;
    if (!r1 || !r2) throw new Error("two reviews expected");

    // AC14: each reviewer only has its own worktree and report
    h.report(r1, "# r1 report\n阻断: broken\n");
    expect(existsSync(path.join(r2.workspace.path, r1.reportFile))).toBe(false);
    expect(
      readFileSync(path.join(r2.workspace.path, ".team/review-brief.md"), "utf8"),
    ).not.toContain("r1 report");

    await h.verdict(r, r1, "request-changes", 1);
    await h.engine.idle();
    expect((await h.get(run.id)).state).toBe("reviewing"); // waits for r2
    expect(h.host.writerAgent()?.sent).toEqual([]);

    await h.verdict(r, r2, "approve");
    await h.engine.idle();
    const back = await h.get(run.id);
    expect(back.state).toBe("writing");
    const sent = h.host.writerAgent()?.sent ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(".team/reviews/1-r1.md");
    expect(sent[0]).toContain(".team/reviews/1-r2.md");

    write(run.workspace.path, ".team/reviews/1-response.md", "fixed it");
    await h.submit(run, "src/b.txt", "b");
    await h.engine.idle();
    const second = await h.get(run.id);
    expect(second).toMatchObject({ state: "reviewing", round: 2 });
    const next = second.reviews.find((x) => x.round === 2 && x.seat === "r1");
    for (const f of [
      ".team/reviews/1-r1.md",
      ".team/reviews/1-r2.md",
      ".team/reviews/1-response.md",
    ]) {
      expect(existsSync(path.join(next?.workspace.path as string, f))).toBe(true);
    }
  });

  it("merging archives .team/, the worktree and leaves no review branches (AC15)", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    await h.verdict(r, r.reviews[0] as never, "approve");
    await h.engine.idle();
    await h.engine.dispatch(run.id, { kind: "close", outcome: "merged" });
    await h.engine.idle();
    const archive = h.engine.store.archiveDir(run.id);
    for (const f of ["task.md", "reviews/1-r1.md", "gate/1/test.log"])
      expect(existsSync(path.join(archive, f))).toBe(true);
    expect(existsSync(run.workspace.path)).toBe(false);
    expect(await branchesWithPrefix(run.repo.sourceCheckout, `team/${run.id}/review-`)).toEqual([]);
    expect(h.host.liveWorkspaceNames()).toEqual([]);
    expect(await branchSha(run.repo.sourceCheckout, run.workspace.branch)).not.toBeNull(); // the branch is the deliverable
  });
});

describe("review isolation (7.3, AC13)", () => {
  it("voids the round when the writer worktree has uncommitted changes at verdict time", async () => {
    const h = setup({ reviewers: 2 });
    const run = await h.start();
    const r = await h.toReviewing(run);
    const [r1, r2] = r.reviews;
    if (!r1 || !r2) throw new Error("two reviews expected");
    write(run.workspace.path, "sneaky.ts", "x"); // someone touched the writer worktree
    await h.verdict(r, r1, "approve");
    await h.engine.idle();
    const blocked = await h.get(run.id);
    expect(blocked).toMatchObject({
      state: "blocked",
      blockedReason: "writer-worktree-changed-during-review",
    });
    expect(blocked.reviews.every((x) => x.void === "writer-worktree-changed")).toBe(true);
    expect(blocked.reviews.every((x) => x.workspace.removedAt)).toBe(true);
    expect(await branchesWithPrefix(run.repo.sourceCheckout, `team/${run.id}/review-`)).toEqual([]);
    expect(blocked.approved).toBeUndefined();
  });

  it("reconcile notices a moved writer HEAD during review", async () => {
    const h = setup();
    const run = await h.start();
    await h.toReviewing(run);
    commit(run.workspace.path, "moved.ts", "x");
    const after = await h.engine.reconcile(run.id);
    expect(after).toMatchObject({
      state: "blocked",
      blockedReason: "writer-worktree-changed-during-review",
    });
    await h.engine.idle();
    expect(h.host.liveWorkspaceNames().filter((n) => n.includes("review"))).toEqual([]);
  });

  it("blocks with review-setup-failed and cleans up when a reviewer worktree setup fails", async () => {
    const h = setup();
    const run = await h.start();
    h.host.setup.set(`team/${run.id}/review-`, "failed");
    await h.submit(run);
    await h.engine.idle();
    const blocked = await h.get(run.id);
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "review-setup-failed" });
    expect(h.host.liveWorkspaceNames().filter((n) => n.includes("review"))).toEqual([]);
    expect(await branchesWithPrefix(run.repo.sourceCheckout, `team/${run.id}/review-`)).toEqual([]);

    // the human fixes the setup and retries: reviewers are built again for the same round
    h.host.setup.clear();
    await h.engine.dispatch(run.id, { kind: "resolve", choice: { kind: "retry" } });
    await h.engine.idle();
    expect(await h.get(run.id)).toMatchObject({ state: "reviewing", round: 1 });
  });

  it("one reviewer failing to start removes the others that were already built", async () => {
    const h = setup({ reviewers: 2 });
    const run = await h.start();
    h.host.failCreateAgent = (o) => o.labels["agent-team.seat"] === "r2";
    await h.submit(run);
    await h.engine.idle();
    expect(await h.get(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "review-setup-failed",
    });
    expect(h.host.liveWorkspaceNames().filter((n) => n.includes("review"))).toEqual([]);
    expect(h.host.reviewerAgents().every((a) => a.archived)).toBe(true);
  });

  it("a cleanup that fails midway is finished by reconcile", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    if (!rv) throw new Error("no review");
    h.host.failArchiveWorkspaceOnce = true;
    await h.verdict(r, rv, "approve");
    await h.engine.idle();
    const mid = await h.get(run.id);
    expect(mid.state).toBe("ready"); // the verdict stands
    expect(mid.reviews[0]?.workspace.removedAt).toBeUndefined();
    await h.engine.reconcile(run.id);
    await h.engine.idle();
    const done = await h.get(run.id);
    expect(done.reviews[0]?.workspace.removedAt).toBeTruthy();
    expect(await branchSha(run.repo.sourceCheckout, rv.workspace.branch)).toBeNull();
  });

  it("reconcile removes review workspaces and branches that no Review owns", async () => {
    const h = setup();
    const run = await h.start();
    const stray = `team/${run.id}/review-1-r9`;
    await h.host.createWorkspace({
      sourceCheckout: run.repo.sourceCheckout,
      baseBranch: "main",
      branchName: stray,
    });
    sh(run.repo.sourceCheckout, "branch", `team/${run.id}/review-2-r1`);
    await h.engine.reconcile(run.id);
    await h.engine.idle();
    expect(h.host.liveWorkspaceNames()).not.toContain(stray);
    expect(await branchesWithPrefix(run.repo.sourceCheckout, `team/${run.id}/review-`)).toEqual([]);
  });
});

describe("limits and stops (AC7, AC9, S3)", () => {
  it("stops after the last allowed gate attempt without sending another message (AC7)", async () => {
    const h = setup();
    const run = await h.start({ limits: { maxGateAttempts: 1 } });
    await h.submit(run, "src/b.txt", "b"); // gate wants src/a.txt
    await h.engine.idle();
    expect(await h.get(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "gate-attempts-exhausted",
    });
    expect(h.host.writerAgent()?.sent).toEqual([]);

    // a human gives two more attempts and the writer is told what failed
    await h.engine.dispatch(run.id, { kind: "resolve", choice: { kind: "more-attempts", n: 2 } });
    await h.engine.idle();
    expect((await h.get(run.id)).state).toBe("writing");
    expect(h.host.writerAgent()?.sent[0]).toContain("验收没有通过");
  });

  it("stops after the last allowed review round (AC7)", async () => {
    const h = setup();
    const run = await h.start({ limits: { maxReviewRounds: 1 } });
    const r = await h.toReviewing(run);
    await h.verdict(r, r.reviews[0] as never, "request-changes", 2);
    await h.engine.idle();
    expect(await h.get(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "review-rounds-exhausted",
    });
    await h.engine.dispatch(run.id, {
      kind: "resolve",
      choice: { kind: "accept-current", sha: await head(run.workspace.path) },
    });
    expect((await h.get(run.id)).approved?.override).toBe("human");
  });

  it("a writer that stops without submitting is blocked on the second time (AC9)", async () => {
    const h = setup();
    const run = await h.start();
    await h.engine.dispatch(run.id, { kind: "writer-turn-ended" });
    await h.engine.idle();
    expect(h.host.writerAgent()?.sent[0]).toContain("team_submit");
    await h.engine.dispatch(run.id, { kind: "writer-turn-ended" });
    expect(await h.get(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "writer-stopped-without-submit",
    });
  });

  it("team_block stops the Run and keeps the question", async () => {
    const h = setup();
    const run = await h.start();
    const res = await h.call(
      h.writerTools(run).team_block as never,
      { reason: "stuck", question: "which db?" },
      run.writer.agentId,
    );
    expect(res.isError).toBeUndefined();
    const blocked = await h.get(run.id);
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "writer-asked-human" });
    expect(blocked.blockedNote).toContain("which db?");
  });

  it("a tool call from someone who is not the writer is refused", async () => {
    const h = setup();
    const run = await h.start();
    const res = await h.call(
      h.writerTools(run).team_submit as never,
      { summary: "s" },
      "some-other-agent",
    );
    expect(res.isError).toBe(true);
    expect((await h.get(run.id)).state).toBe("writing");
  });

  it("verdict rules: approve needs 0 blocking, request-changes needs >=1, path must match", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    if (!rv) throw new Error("no review");
    const tool = h.reviewerTool(r, rv);
    const id = rv.reviewer.agentId;
    expect(
      (await h.call(tool, { verdict: "approve", blocking: 1, reportFile: rv.reportFile }, id))
        .isError,
    ).toBe(true);
    expect(
      (
        await h.call(
          tool,
          { verdict: "request-changes", blocking: 0, reportFile: rv.reportFile },
          id,
        )
      ).isError,
    ).toBe(true);
    expect(
      (await h.call(tool, { verdict: "approve", blocking: 0, reportFile: "elsewhere.md" }, id))
        .isError,
    ).toBe(true);
    const noReport = await h.call(
      tool,
      { verdict: "approve", blocking: 0, reportFile: rv.reportFile },
      id,
    );
    expect(noReport.isError).toBe(true); // report file not written yet
    expect(noReport.text).toContain("报告");
    expect((await h.get(run.id)).state).toBe("reviewing");
  });

  it("a reviewer that ends twice without a verdict voids its review and blocks", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    if (!rv) throw new Error("no review");
    await h.engine.dispatch(run.id, { kind: "reviewer-turn-ended", reviewId: rv.id });
    await h.engine.dispatch(run.id, { kind: "reviewer-turn-ended", reviewId: rv.id });
    await h.engine.idle();
    const blocked = await h.get(run.id);
    expect(blocked).toMatchObject({ state: "blocked", blockedReason: "agent-failed" });
    expect(blocked.reviews[0]?.void).toBe("no-verdict");
    expect(h.host.liveWorkspaceNames().filter((n) => n.includes("review"))).toEqual([]);
  });
});

describe("reconcile after restarts and idle agents (6.4, AC8)", () => {
  it("re-runs a gate that was interrupted by a daemon restart (AC8)", async () => {
    const marker = (dir: string) => path.join(dir, "gate-marker");
    const h = setup({
      gate: "if [ -f ../gate-marker ]; then echo second; else touch ../gate-marker; sleep 30; fi",
    });
    const run = await h.start();
    commit(run.workspace.path, "src/a.txt", "a");
    const submit = h.call(
      h.writerTools(run).team_submit as never,
      { summary: "s" },
      run.writer.agentId,
    );
    await submit;
    for (let i = 0; i < 100 && !existsSync(marker(path.dirname(run.workspace.path))); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await h.get(run.id)).state).toBe("gating");

    await h.engine.dispose(); // the daemon stops: the child is killed and nothing is reported
    const stuck = await h.get(run.id);
    expect(stuck.state).toBe("gating");
    expect(stuck.attempts[0]?.result).toBeUndefined();

    const restarted = h.make(); // a new process reads the same files
    await restarted.reconcileAll();
    await restarted.idle();
    const done = await restarted.get(run.id);
    expect(done?.state).toBe("reviewing");
    expect(done?.attempts[0]?.result).toBe("pass");
    await restarted.dispose();
  });

  it("resumes reviewer creation that a restart interrupted after the gate passed", async () => {
    const h = setup();
    const run = await h.start();
    await h.engine.store.update(run.id, (r) => ({
      ...r,
      state: "gating",
      round: 1,
      attempts: [
        {
          n: 1,
          sha: r.repo.baseSha,
          startedAt: r.createdAt,
          finishedAt: r.createdAt,
          result: "pass",
          checks: [],
          policyViolations: [],
        },
      ],
    }));
    await h.engine.reconcile(run.id);
    await h.engine.idle();
    expect(await h.get(run.id)).toMatchObject({ state: "reviewing", round: 1 });
  });

  it("an idle writer past stallMinutes is blocked as stalled", async () => {
    const h = setup();
    const run = await h.start();
    const writer = h.host.writerAgent();
    if (writer) writer.status = "idle";
    h.advance(10 * 60_000);
    expect((await h.engine.reconcile(run.id))?.state).toBe("writing");
    h.advance(6 * 60_000);
    expect(await h.engine.reconcile(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "stalled",
    });
  });

  it("a writer whose session the host closed is idle, not dead (a machine sleep must not kill a Run)", async () => {
    const h = setup();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const writer = h.host.writerAgent();
    if (writer) writer.status = "closed";
    h.advance(90 * 60_000);
    const after = await h.engine.reconcile(run.id);
    expect(after?.state).toBe("reviewing"); // reviewing does not stall, and the reviewer lives on
    expect(h.host.reviewerAgents().every((a) => !a.archived)).toBe(true);
    expect(r.reviews[0]?.workspace.removedAt).toBeUndefined();
  });

  it("a closed writer in writing stalls only after stallMinutes", async () => {
    const h = setup();
    const run = await h.start();
    const writer = h.host.writerAgent();
    if (writer) writer.status = "closed";
    expect((await h.engine.reconcile(run.id))?.state).toBe("writing");
    h.advance(16 * 60_000);
    expect(await h.engine.reconcile(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "stalled",
    });
  });

  it("a failed read of agent facts leaves the Run alone", async () => {
    const h = setup();
    const run = await h.start();
    h.host.agent = async () => {
      throw new Error("request timed out");
    };
    expect((await h.engine.reconcile(run.id))?.state).toBe("writing");
  });

  it("an archived writer or a vanished workspace blocks as agent-failed", async () => {
    const h = setup();
    const run = await h.start();
    const writer = h.host.writerAgent();
    if (writer) writer.archived = true;
    expect(await h.engine.reconcile(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "agent-failed",
    });
  });

  it("reports a pending permission request so the panel can show it (AC10)", async () => {
    const h = setup();
    const run = await h.start();
    expect(await h.engine.pendingPermission(run)).toBe(false);
    const writer = h.host.writerAgent();
    if (writer) writer.pending = 1;
    expect(await h.engine.pendingPermission(run)).toBe(true);
  });

  it("never lets two submits start two gates for one Run", async () => {
    const h = setup();
    const run = await h.start();
    commit(run.workspace.path, "src/a.txt", "a");
    const t = h.writerTools(run).team_submit as never;
    const [a, b] = await Promise.all([
      h.call(t, { summary: "1" }, run.writer.agentId),
      h.call(t, { summary: "2" }, run.writer.agentId),
    ]);
    expect([a.isError, b.isError].filter(Boolean)).toHaveLength(1);
    await h.engine.idle();
    expect((await h.get(run.id)).attempts).toHaveLength(1);
  });

  it("waits for writer idle before gating and ignores late writer-turn-ended before notify", async () => {
    const h = setup({ gate: "true" });
    const run = await h.start();
    const writer = h.host.writerAgent();
    if (!writer) throw new Error("writer missing");
    writer.status = "running";

    const origSend = h.host.send.bind(h.host);
    let dispatchedInFlight = false;
    h.host.send = async (agentId: string, text: string) => {
      if (!dispatchedInFlight) {
        dispatchedInFlight = true;
        // Late turn.after from the submitting turn arrives while notifyWriter is sending.
        await h.engine.dispatch(run.id, { kind: "writer-turn-ended" });
      }
      await origSend(agentId, text);
    };

    const submitRes = await h.call(
      h.writerTools(run).team_submit as never,
      { summary: "empty" },
      run.writer.agentId,
    );
    expect(submitRes.isError).toBeUndefined();

    // While the writer is still running, gate waits and isGateRunning remains true.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.engine.isGateRunning(run.id)).toBe(true);
    expect((await h.get(run.id)).state).toBe("gating");
    expect((await h.get(run.id)).attempts[0]?.finishedAt).toBeUndefined();

    // Writer turn ends; gate runs, fails on AC17 empty commit, and sends exactly one message.
    writer.status = "idle";
    await h.engine.idle();

    const after = await h.get(run.id);
    expect(after.state).toBe("writing");
    expect(after.nudges).toBe(0);
    expect(after.attempts[0]?.result).toBe("fail");
    expect(after.attempts[0]?.policyViolations).toEqual(["no files changed relative to base"]);
    expect(dispatchedInFlight).toBe(true);
    expect(writer.sent).toHaveLength(1);
    expect(writer.sent[0]).toContain("no files changed relative to base");
  });
});
