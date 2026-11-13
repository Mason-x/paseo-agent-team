import { randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Effect } from "../shared/machine";
import {
  familyOf,
  type Review,
  type Run,
  reportPath,
  reviewBranch,
  SEATS,
  TEAM_DIR,
} from "../shared/run";
import { failureReport } from "./gate";
import { branchesWithPrefix, deleteBranch, worktreesWithPrefix } from "./git";
import type { Host } from "./host";

export type Timing = { setupTimeoutMs: number; setupGraceMs: number; pollMs: number };
export const DEFAULT_TIMING: Timing = {
  setupTimeoutMs: 15 * 60_000,
  setupGraceMs: 4_000,
  pollMs: 500,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for `paseo.json` setup on a new workspace. No status after the grace period means no setup. */
export async function waitSetup(host: Host, id: string, t: Timing = DEFAULT_TIMING): Promise<void> {
  const start = Date.now();
  for (;;) {
    const s = await host.setupStatus(id);
    if (s === "completed") return;
    if (s === "failed") throw new Error("workspace setup failed");
    if (s === "blocked")
      throw new Error(`workspace setup is blocked; allow it with: paseo workspace setup ${id}`);
    const waited = Date.now() - start;
    if (s === null && waited >= t.setupGraceMs) return;
    if (waited >= t.setupTimeoutMs) throw new Error("workspace setup timed out");
    await sleep(t.pollMs);
  }
}

// ---- prompts: they carry paths, never the content of the task (Spec 7.1, 7.2) ----

export const writerPrompt = (run: Run) =>
  [
    "你是这个任务唯一的写手。先读 .team/task.md；如果存在 .team/scout.md，也先读它。",
    "要求：",
    "- 把过程记进 .team/progress.md：做了什么、试过但失败的路、下一步。",
    "- 做完后先 git commit，工作区必须干净，再调用工具 team_submit。调用后结束本回合，验收结果会作为新消息发给你。",
    `- 不许为了通过验收而删改或跳过测试，不许修改受保护路径：${run.task.protectedPaths.join("、") || "（无）"}。`,
    "- 不许创建会写文件的 agent，不许推送，不许合并。",
    "- 做不下去时调用 team_block，说明原因和需要人回答的问题，不要硬撑。",
  ].join("\n");

export const reviewerPrompt = (review: Review) =>
  [
    "你是独立审查者，没有看过写手的对话。先读 .team/task.md，再读 .team/review-brief.md，按其中的说明审查。",
    "要求：",
    "- 对照任务说明检查正确性和遗漏的测试，不评风格。每条意见标注“阻断”或“建议”，只有阻断项会触发返工。",
    "- 只在当前目录里工作，不推送，不操作其他分支和其他 worktree。可以跑测试、写探针，但交付物只有报告。",
    `- 把报告写到 ${review.reportFile}，然后调用工具 team_verdict。approve 时 blocking 必须为 0；request-changes 至少有一条阻断意见。`,
  ].join("\n");

export const reviewBrief = (
  run: Run,
  review: Pick<Review, "round" | "sha" | "seat" | "reportFile">,
  prev: boolean,
) =>
  [
    `# 审查说明（第 ${review.round} 轮，席位 ${review.seat}）`,
    "",
    `- 基线提交：${run.repo.baseSha}`,
    `- 候选提交：${review.sha}`,
    `- 查看改动：git diff ${run.repo.baseSha}...${review.sha}`,
    "- 你的当前目录已经检出候选提交。",
    "",
    "## 分级",
    "- 阻断：按任务说明，实现会导致错误行为，或遗漏了任务明确要求的内容。",
    "- 建议：其余一切（风格、命名、可选改进）。建议不触发返工。",
    "",
    prev
      ? "第二轮起：.team/reviews/ 里有上一轮的报告和写手的回应，先读它们。已经被写手合理回应的意见不要重复提。"
      : "这是第一轮。",
    "",
    `## 交付\n报告写到 ${review.reportFile}，然后调用 team_verdict。`,
    "",
  ].join("\n");

export const nudgeText = () =>
  "你的回合结束了，但没有调用 team_submit 或 team_block。做完了：先提交，再调用 team_submit。卡住了：调用 team_block 说明原因。";

export function reportsText(run: Run): string {
  const mine = run.reviews.filter((r) => r.round === run.round && !r.void);
  const list = mine.map(
    (r) => `- ${r.reportFile}（${r.seat}：${r.verdict}，阻断 ${r.blocking} 条）`,
  );
  return [
    `第 ${run.round} 轮审查没有全部通过。本轮报告：`,
    ...list,
    "只有标为“阻断”的意见需要处理。对照 .team/task.md 逐条判断；可以把“已改”或“不改及理由”写进",
    `${TEAM_DIR}/reviews/${run.round}-response.md，下一轮审查者会读到它。改完先提交，再调用 team_submit。`,
  ].join("\n");
}

export async function writerMessage(
  run: Run,
  eff: Extract<Effect, { t: "notify-writer" }>,
): Promise<string> {
  if (eff.kind === "nudge") return nudgeText();
  if (eff.kind === "reports") return reportsText(run);
  if (eff.kind === "text") return eff.text ?? "";
  const a = run.attempts.at(-1);
  if (!a) return "";
  const head = `验收没有通过（第 ${a.n} 次，最多 ${run.limits.maxGateAttempts} 次）。`;
  return `${head}\n\n${await failureReport(run, a)}\n\n修好后先提交，再调用 team_submit。`;
}

// ---- agents and workspaces ----

export async function startWriter(host: Host, run: Run): Promise<void> {
  await host.createAgent({
    agentId: run.writer.agentId,
    workspaceId: run.workspace.id,
    spec: run.specs.writer,
    title: `[Team ${run.id}] writer`,
    prompt: writerPrompt(run),
    labels: { "agent-team.run": run.id, "agent-team.role": "writer" },
  });
}

type Built = { wsId?: string; agentId?: string; branch: string };

/** Archives agent and workspace if they still exist, then deletes the branch. True when nothing is left. */
async function removeAll(host: Host, repo: string, built: Built): Promise<boolean> {
  let ok = true;
  const step = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch {
      ok = false;
    }
  };
  if (built.agentId) {
    const id = built.agentId;
    await step(async () => {
      const a = await host.agent(id);
      if (a.exists && !a.archived) await host.archiveAgent(id);
    });
  }
  if (built.wsId) {
    const id = built.wsId;
    await step(async () => {
      if ((await host.listWorkspaces()).some((w) => w.id === id)) await host.archiveWorkspace(id);
    });
  }
  await step(() => deleteBranch(repo, built.branch));
  return ok;
}

/** Spec 7.2.2 step 4. Returns true when the reviewer, its worktree and its branch are all gone. */
export const cleanupReview = (host: Host, run: Run, r: Review) =>
  removeAll(host, run.repo.sourceCheckout, {
    wsId: r.workspace.id,
    agentId: r.reviewer.agentId,
    branch: r.workspace.branch,
  });

/**
 * Archives the workspaces whose worktree has a branch under `prefix` (except `keep`), then deletes those
 * branches. Identified through git, not by workspace name: the host retitles a workspace after its first prompt.
 */
async function purge(host: Host, repo: string, prefix: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  const workspaces = await host.listWorkspaces();
  for (const tree of await worktreesWithPrefix(repo, prefix)) {
    if (keep.has(tree.branch)) continue;
    const here = await realpath(tree.path).catch(() => tree.path);
    for (const w of workspaces) {
      if (w.path && (await realpath(w.path).catch(() => w.path)) === here) {
        await host.archiveWorkspace(w.id);
        removed++;
      }
    }
  }
  for (const b of await branchesWithPrefix(repo, prefix)) {
    if (keep.has(b)) continue;
    await deleteBranch(repo, b).catch(() => undefined);
    removed++;
  }
  return removed;
}

/** Removes review worktrees and branches of this Run that no live Review owns (Spec 6.4). */
export function gcOrphans(host: Host, run: Run): Promise<number> {
  const keep = new Set(
    run.reviews.filter((r) => !r.workspace.removedAt).map((r) => r.workspace.branch),
  );
  return purge(host, run.repo.sourceCheckout, `team/${run.id}/review-`, keep);
}

async function copyPreviousReports(from: string, to: string, round: number) {
  const dir = path.join(from, TEAM_DIR, "reviews");
  const names = await readdir(dir).catch(() => [] as string[]);
  const rounds = names.map((n) => Number.parseInt(n, 10)).filter((n) => n < round);
  const prev = rounds.length ? Math.max(...rounds) : 0;
  if (!prev) return false;
  await mkdir(path.join(to, TEAM_DIR, "reviews"), { recursive: true });
  for (const n of names.filter((x) => x.startsWith(`${prev}-`))) {
    await copyFile(path.join(dir, n), path.join(to, TEAM_DIR, "reviews", n));
  }
  return true;
}

/**
 * Spec 7.2.1: one disposable worktree per seat at the candidate commit, files written, reviewer started.
 * Either every seat is ready or everything built here is removed and the error is thrown.
 */
export async function createReviewers(
  host: Host,
  run: Run,
  round: number,
  sha: string,
  timing: Timing = DEFAULT_TIMING,
): Promise<Review[]> {
  const repo = run.repo.sourceCheckout;
  await purge(host, repo, `team/${run.id}/review-${round}-`, new Set());

  const task = await readFile(path.join(run.workspace.path, run.task.file), "utf8");
  const built: Built[] = [];
  const seat = async (i: number): Promise<Review> => {
    const name = SEATS[i];
    const spec = run.specs.reviewers[i];
    if (!name || !spec) throw new Error(`no reviewer spec for seat ${i + 1}`);
    const branch = reviewBranch(run.id, round, name);
    const mine: Built = { branch };
    built.push(mine);
    const ws = await host.createWorkspace({
      sourceCheckout: repo,
      baseBranch: sha,
      branchName: branch,
      background: true,
    });
    mine.wsId = ws.id;
    await waitSetup(host, ws.id, timing);
    const k = run.reviews.filter((r) => r.round === round && r.seat === name).length + 1;
    const review: Review = {
      id: `rv-${round}-${name}-${k}`,
      round,
      sha,
      seat: name,
      reviewer: { agentId: randomUUID(), profile: spec.profile, family: familyOf(spec.provider) },
      workspace: { id: ws.id, path: ws.path, branch },
      blocking: 0,
      nudges: 0,
      reportFile: reportPath(round, name),
    };
    await mkdir(path.join(ws.path, TEAM_DIR, "reviews"), { recursive: true });
    await writeFile(path.join(ws.path, TEAM_DIR, "task.md"), task);
    const prev = await copyPreviousReports(run.workspace.path, ws.path, round);
    await writeFile(
      path.join(ws.path, TEAM_DIR, "review-brief.md"),
      reviewBrief(run, review, prev),
    );
    mine.agentId = review.reviewer.agentId;
    await host.createAgent({
      agentId: review.reviewer.agentId,
      workspaceId: ws.id,
      spec,
      title: `[Team ${run.id}] review r${round} ${name}`,
      prompt: reviewerPrompt(review),
      labels: {
        "agent-team.run": run.id,
        "agent-team.role": "reviewer",
        "agent-team.seat": name,
        "agent-team.round": String(round),
      },
    });
    return review;
  };

  const settled = await Promise.allSettled(run.specs.reviewers.map((_, i) => seat(i)));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) {
    await Promise.all(built.map((b) => removeAll(host, repo, b)));
    throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }
  return settled.map((s) => (s as PromiseFulfilledResult<Review>).value);
}

/** Spec 7.2.2 step 2: the report goes to the writer's worktree and to the archive. */
export async function saveReport(run: Run, review: Review, archiveDir: string): Promise<void> {
  const src = path.join(review.workspace.path, review.reportFile);
  if (!(await stat(src).catch(() => null))?.size)
    throw new Error(`报告文件 ${review.reportFile} 不存在或为空`);
  // The archive mirrors the contents of `.team/`, so it has no `.team` segment itself.
  const dests = [
    path.join(run.workspace.path, review.reportFile),
    path.join(archiveDir, path.relative(TEAM_DIR, review.reportFile)),
  ];
  for (const dest of dests) {
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
}

/** Spec 5.2: the whole `.team/` goes to the archive before the worktree is allowed to disappear. */
export async function archiveRun(host: Host, run: Run, archiveDir: string): Promise<void> {
  await cp(path.join(run.workspace.path, TEAM_DIR), archiveDir, {
    recursive: true,
    force: true,
  }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  });
  const writer = await host.agent(run.writer.agentId);
  if (writer.exists && !writer.archived) await host.archiveAgent(run.writer.agentId);
  if ((await host.listWorkspaces()).some((w) => w.id === run.workspace.id)) {
    await host.archiveWorkspace(run.workspace.id);
  }
}
