import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { type Choice, waiting } from "../shared/machine";
import type { ResolveChoice, RunSummary } from "../shared/rpc";
import { isActive, ProjectConfigSchema, type Run } from "../shared/run";
import type { Engine, StartInput } from "./engine";
import { tailLines } from "./gate";
import { behindBase, dirtyFiles, head } from "./git";

const ARTIFACT_MAX_BYTES = 64 * 1024;

function safeTeamRel(file: string): string {
  const norm = path.posix.normalize(file.replaceAll("\\", "/"));
  const ok =
    norm === ".team/task.md" ||
    norm === ".team/progress.md" ||
    ((norm.startsWith(".team/gate/") || norm.startsWith(".team/reviews/")) &&
      norm.length > norm.lastIndexOf("/") + 1);
  if (!ok || norm.includes("..")) throw new Error(`非法构件路径：${file}`);
  return norm.slice(".team/".length);
}

async function readArtifactFile(filePath: string): Promise<string> {
  if (filePath.endsWith(".log")) return tailLines(filePath, 200);
  const buf = await readFile(filePath);
  if (buf.byteLength <= ARTIFACT_MAX_BYTES) return buf.toString("utf8");
  const headText = buf
    .subarray(0, ARTIFACT_MAX_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${headText}\n\n…（内容超过 64 KiB，已截断）`;
}

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
  branch: run.workspace.branch,
  workspaceId: run.workspace.id,
  writerAgentId: run.writer.agentId,
  writerProfile: run.writer.profile,
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
      const pendingPermissionAgentId = await engine.pendingPermissionAgent(run);
      const pendingPermission = pendingPermissionAgentId !== null;
      return {
        run,
        waiting: waiting(run, pendingPermission),
        behindBase: behind,
        pendingPermission,
        pendingPermissionAgentId,
      };
    },

    async artifact(id: string, file: string) {
      const run = await must(id);
      const rel = safeTeamRel(file);
      const live = path.join(run.workspace.path, ".team");
      const arch = engine.store.archiveDir(id);
      for (const [root, archived] of [
        [live, false],
        [arch, true],
      ] as const) {
        try {
          const rootReal = await realpath(root);
          const fileReal = await realpath(path.join(root, rel));
          if (!fileReal.startsWith(rootReal + path.sep)) throw new Error(`非法构件路径：${file}`);
          return {
            content: await readArtifactFile(fileReal),
            path: path.join(root, rel),
            archived,
          };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const fallback = path.join(isActive(run) ? live : arch, rel);
      return { content: null, path: fallback, archived: !isActive(run) };
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
