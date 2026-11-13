import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine, type StartInput } from "../../v2/server/engine";
import { createRunStore } from "../../v2/server/store";
import { createTools } from "../../v2/server/tools";
import type { Review, Run } from "../../v2/shared/run";
import { FakeHost } from "./fake-host";
import { NOW } from "./fixtures";
import { commit, tempRepo } from "./repo";

export const TASK = "# demo\n\n## 要什么结果\nadd a\n\n## 怎么验证\n`test -f src/a.txt`\n";

export function harness(opts: { maxActive?: number; gate?: string; reviewers?: number } = {}) {
  const r = tempRepo();
  const storeRoot = mkdtempSync(path.join(tmpdir(), "v2-engine-"));
  const host = new FakeHost(r.root);
  let clock = Date.parse(NOW);
  const make = (hostRef: () => FakeHost | null = () => host) =>
    createEngine({
      store: createRunStore(storeRoot),
      host: hostRef,
      now: () => new Date(clock).toISOString(),
      timing: { setupTimeoutMs: 2000, setupGraceMs: 0, pollMs: 5 },
      maxActive: () => opts.maxActive ?? 3,
    });
  const engine = make();
  const input = (patch: Partial<StartInput> = {}): StartInput => ({
    title: "demo",
    repoPath: r.dir,
    baseRef: "main",
    taskMarkdown: TASK,
    gateCommands: [{ name: "test", command: opts.gate ?? "test -f src/a.txt", timeoutSec: 20 }],
    protectedPaths: ["tests/**"],
    writer: { profile: "writer", provider: "claude/sonnet" },
    reviewers: Array.from({ length: opts.reviewers ?? 1 }, (_, i) => ({
      profile: `rev${i + 1}`,
      provider: "codex/gpt-5.4",
      modeId: "full-access",
    })),
    ...patch,
  });

  const toolsOf = (ctx: Parameters<typeof createTools>[1]) =>
    Object.fromEntries(createTools(engine, ctx).map((t) => [t.name, t]));
  const call = async (
    tool: { execute: (i: never, c: never) => unknown },
    args: object,
    agentId: string,
  ) =>
    (await tool.execute(
      args as never,
      { agent: { id: agentId }, signal: new AbortController().signal } as never,
    )) as {
      text?: string;
      isError?: boolean;
    };

  return {
    r,
    host,
    engine,
    make,
    input,
    storeRoot,
    advance: (ms: number) => {
      clock += ms;
    },
    cleanup: () => {
      r.cleanup();
      rmSync(storeRoot, { recursive: true, force: true });
    },

    async start(patch: Partial<StartInput> = {}) {
      return (await engine.start(input(patch))).run;
    },
    get: async (id: string) => (await engine.get(id)) as Run,
    /** The writer commits `file` and calls team_submit. */
    async submit(run: Run, file = "src/a.txt", content = "a\n") {
      commit(run.workspace.path, file, content);
      const t = toolsOf({ runId: run.id, role: "writer" });
      return call(t.team_submit as never, { summary: "done" }, run.writer.agentId);
    },
    reviewerTool: (run: Run, review: Review) =>
      toolsOf({ runId: run.id, role: "reviewer", seat: review.seat, round: review.round })
        .team_verdict as never,
    writerTools: (run: Run) => toolsOf({ runId: run.id, role: "writer" }),
    call,
    report(review: Review, text = "# report\n- 建议: none\n") {
      writeFileSync(path.join(review.workspace.path, review.reportFile), text);
    },
    async verdict(run: Run, review: Review, verdict: "approve" | "request-changes", blocking = 0) {
      this.report(review);
      return call(
        this.reviewerTool(run, review),
        { verdict, blocking, reportFile: review.reportFile },
        review.reviewer.agentId,
      );
    },
    /** Submit and wait until the gate and reviewer creation are done. */
    async toReviewing(run: Run) {
      await this.submit(run);
      await engine.idle();
      return this.get(run.id);
    },
  };
}
