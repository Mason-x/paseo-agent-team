import { readFile } from "node:fs/promises";
import path from "node:path";
import { type Choice, waiting } from "../shared/machine";
import type { ResolveChoice, RunSummary } from "../shared/rpc";
import { isActive, ProjectConfigSchema, type Run } from "../shared/run";
import type { Engine, StartInput } from "./engine";
import { behindBase, dirtyFiles, head } from "./git";

export const summarize = (run: Run): RunSummary => ({
  id: run.id,
  title: run.title,
  state: run.state,
  blockedReason: run.blockedReason,
  round: run.round,
  gateAttempts: run.attempts.length,
  createdAt: run.createdAt,
  lastProgressAt: run.lastProgressAt,
  closedAt: run.closedAt,
  waiting: waiting(run),
});

/** Handlers behind the RPC contracts in shared/rpc.ts. Plain functions so tests need no daemon. */
export function createRpc(engine: Engine) {
  const must = async (id: string) => {
    const run = await engine.get(id);
    if (!run) throw new Error(`Run ${id} 不存在`);
    return run;
  };

  return {
    async list() {
      return { runs: (await engine.list()).map(summarize) };
    },

    async get(id: string) {
      const run = (await engine.reconcile(id)) ?? (await must(id));
      const behind = isActive(run)
        ? await behindBase(run.repo.sourceCheckout, run.repo.baseRef, run.workspace.branch).catch(
            () => null,
          )
        : null;
      const pendingPermission = await engine.pendingPermission(run);
      return {
        run,
        waiting: waiting(run, pendingPermission),
        behindBase: behind,
        pendingPermission,
      };
    },

    async start(input: StartInput) {
      return engine.start(input);
    },

    async resolve(id: string, choice: ResolveChoice) {
      const run = await must(id);
      if (choice.kind === "abandon") return this.close(id, "abandoned");
      let full: Choice;
      if (choice.kind === "accept-current") {
        full = { kind: "accept-current", sha: await head(run.workspace.path) };
      } else if (choice.kind === "resubmit") {
        const [sha, dirty] = await Promise.all([
          head(run.workspace.path),
          dirtyFiles(run.workspace.path),
        ]);
        full = { kind: "resubmit", sha, dirty };
      } else {
        full = choice;
      }
      const res = await engine.dispatch(id, { kind: "resolve", choice: full });
      const rejected = res?.effects.find((e) => e.t === "reject-submit");
      if (rejected) throw new Error(`工作区有未提交的改动，先处理：${rejected.files.join("、")}`);
      if (!res || res.run.revision === run.revision)
        throw new Error(
          `处置“${choice.kind}”不适用于当前状态（${run.state}/${run.blockedReason ?? "-"}）`,
        );
      return { run: res.run };
    },

    async close(id: string, outcome: "merged" | "abandoned") {
      const before = await must(id);
      const res = await engine.dispatch(id, { kind: "close", outcome });
      if (!res || res.run.revision === before.revision)
        throw new Error(`Run 现在是 ${before.state}，不能标记为 ${outcome}`);
      return { run: res.run };
    },

    async projectConfig(dir: string) {
      try {
        const text = await readFile(path.join(dir, "paseo-team.json"), "utf8");
        return { config: ProjectConfigSchema.parse(JSON.parse(text)), error: null };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: null, error: null };
        return { config: null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
