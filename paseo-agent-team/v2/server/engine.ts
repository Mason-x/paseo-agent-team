import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Effect,
  type Event,
  type Facts,
  type Result,
  reconcile as reconcileFacts,
  transition,
} from "../shared/machine";
import {
  type AgentSpec,
  DEFAULT_LIMITS,
  familyOf,
  type GateCommand,
  isActive,
  newRunId,
  type Run,
  RunSchema,
  reviewerModeProblem,
  TEAM_DIR,
  writerBranch,
} from "../shared/run";
import { createGateRunner } from "./gate";
import { branchSha, excludeTeamDir, git, head, revParse } from "./git";
import { type Host, toolsBlocker } from "./host";
import {
  archiveRun,
  cleanupReview,
  createReviewers,
  DEFAULT_TIMING,
  gcOrphans,
  startWriter,
  type Timing,
  waitSetup,
  writerMessage,
} from "./roles";
import type { RunStore } from "./store";

export type StartInput = {
  title: string;
  repoPath: string;
  baseRef: string;
  taskMarkdown: string;
  gateCommands: GateCommand[];
  protectedPaths: string[];
  allowedPaths?: string[];
  env?: Record<string, string>;
  limits?: Partial<Run["limits"]>;
  writer: AgentSpec;
  reviewers: AgentSpec[];
};

export type EngineDeps = {
  store: RunStore;
  host: () => Host | null;
  gate?: ReturnType<typeof createGateRunner>;
  now?: () => string;
  log?: (message: string, error?: unknown) => void;
  timing?: Timing;
  maxActive?: () => number | Promise<number>;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const finished = (r: Run) => r.state === "merged" || r.state === "abandoned";

export function createEngine(deps: EngineDeps) {
  const { store } = deps;
  const gate = deps.gate ?? createGateRunner();
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => undefined);
  const timing = deps.timing ?? DEFAULT_TIMING;
  const requireHost = () => {
    const h = deps.host();
    if (!h) throw new Error("Paseo is not connected yet");
    return h;
  };

  // One chain per Run: tool calls, hooks, the gate and the timer never interleave their read-modify-write.
  const tails = new Map<string, Promise<unknown>>();
  function withRun<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (tails.get(id) ?? Promise.resolve()).then(fn, fn);
    tails.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  const pending = new Set<Promise<unknown>>();
  function background(job: Promise<unknown>, what: string) {
    const tracked: Promise<unknown> = job
      .catch((e) => log(`${what} failed`, e))
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  }
  const idle = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  const creating = new Set<string>();
  const notifying = new Map<string, number>();

  // ---- effects ----

  function execute(run: Run, eff: Effect) {
    switch (eff.t) {
      case "reject-submit":
        return;
      case "run-gate": {
        const a = run.attempts.at(-1);
        if (!a || gate.isRunning(run.id)) return;
        background(
          gate
            .run(run, a.n, a.sha, {
              now,
              beforeRun: async (signal) => {
                const h = deps.host();
                if (h) await waitWriterIdle(h, run.writer.agentId, signal);
              },
            })
            .then((attempt) => dispatch(run.id, { kind: "gate-finished", attempt })),
          "gate",
        );
        return;
      }
      case "create-reviewers":
        return startReviewers(run, eff.round, eff.sha);
      case "cleanup-reviewers":
        return background(cleanup(run.id), "reviewer cleanup");
      case "notify-writer": {
        const track = eff.kind === "gate-failed" || eff.kind === "reports";
        if (track) notifying.set(run.id, (notifying.get(run.id) ?? 0) + 1);
        return background(
          notifyWriter(run.id, eff).finally(() => {
            if (!track) return;
            const left = (notifying.get(run.id) ?? 1) - 1;
            if (left > 0) notifying.set(run.id, left);
            else notifying.delete(run.id);
          }),
          "notify writer",
        );
      }
      case "remind-reviewer": {
        const r = run.reviews.find((x) => x.id === eff.reviewId);
        if (!r) return;
        const text = `请调用 team_verdict 给出结论，报告文件是 ${r.reportFile}。`;
        return background(requireHost().send(r.reviewer.agentId, text), "remind reviewer");
      }
      case "archive":
        return background(archive(run.id), "archive run");
    }
  }

  function startReviewers(run: Run, round: number, sha: string) {
    if (creating.has(run.id)) return;
    creating.add(run.id);
    background(
      (async () => {
        const host = requireHost();
        try {
          const reviews = await createReviewers(host, run, round, sha, timing);
          const res = await dispatch(run.id, { kind: "reviewers-ready", round, reviews });
          if (res?.run.state !== "reviewing") {
            for (const r of reviews) await cleanupReview(host, run, r); // the Run moved on meanwhile
          }
        } catch (e) {
          await dispatch(run.id, { kind: "reviewers-failed", error: msg(e) });
        } finally {
          creating.delete(run.id);
        }
      })(),
      "create reviewers",
    );
  }

  async function waitWriterIdle(host: Host, agentId: string, signal?: AbortSignal) {
    const until = Date.now() + 30_000;
    while (Date.now() < until && !signal?.aborted) {
      if ((await host.agent(agentId)).status !== "running") return;
      await new Promise((r) => setTimeout(r, timing.pollMs));
    }
  }

  async function notifyWriter(id: string, eff: Extract<Effect, { t: "notify-writer" }>) {
    const run = await store.get(id);
    if (!run) return;
    const text = await writerMessage(run, eff);
    if (!text) return;
    const host = requireHost();
    await waitWriterIdle(host, run.writer.agentId);
    await host.send(run.writer.agentId, text);
  }

  /** Removes reviewers whose work is over: verdict given, voided, or the Run finished. */
  async function cleanup(id: string) {
    const run = await store.get(id);
    if (!run) return;
    const host = requireHost();
    const eligible = run.reviews.filter(
      (r) => !r.workspace.removedAt && (r.verdict || r.void || finished(run)),
    );
    const done: string[] = [];
    await Promise.all(
      eligible.map(async (r) => {
        if (await cleanupReview(host, run, r)) done.push(r.id);
      }),
    );
    if (!done.length) return;
    await withRun(id, () =>
      store.update(id, (cur) => ({
        ...cur,
        reviews: cur.reviews.map((r) =>
          done.includes(r.id) ? { ...r, workspace: { ...r.workspace, removedAt: now() } } : r,
        ),
      })),
    );
  }

  async function archive(id: string) {
    const run = await store.get(id);
    if (!run) return;
    await archiveRun(requireHost(), run, store.archiveDir(id));
    await cleanup(id);
    await gcOrphans(requireHost(), run);
  }

  // ---- events ----

  async function applyLocked(id: string, ev: Event): Promise<Result | null> {
    const run = await store.get(id);
    if (!run) return null;
    if (ev.kind === "writer-turn-ended" && !ev.failed && notifying.has(id)) {
      return { run, effects: [] };
    }
    const res = transition(run, ev, now());
    const saved = res.run === run ? run : await store.update(id, () => res.run);
    for (const eff of res.effects) execute(saved, eff);
    return { run: saved, effects: res.effects };
  }
  const dispatch = (id: string, ev: Event) => withRun(id, () => applyLocked(id, ev));

  // ---- reconcile (Spec 6.4) ----

  async function gather(host: Host, run: Run, workspaces: { id: string }[]): Promise<Facts> {
    const fact = async (agentId: string) => {
      const a = await host.agent(agentId);
      return {
        // "closed" is the host releasing an idle agent's session; it resumes on the next message.
        alive: a.exists && !a.archived,
        idle: a.status === "idle" || a.status === "closed",
        error: a.status === "error",
      };
    };
    const open = run.reviews.filter((r) => r.round === run.round && !r.void && !r.verdict);
    const reviewers: Facts["reviewers"] = {};
    for (const r of open) reviewers[r.reviewer.agentId] = await fact(r.reviewer.agentId);
    return {
      now: now(),
      head: await head(run.workspace.path).catch(() => null),
      workspaceAlive: workspaces.some((w) => w.id === run.workspace.id),
      writer: await fact(run.writer.agentId),
      reviewers,
      gateRunning: gate.isRunning(run.id),
      creatingReviewers: creating.has(run.id),
    };
  }

  async function reconcileRun(id: string, workspaces?: { id: string }[]): Promise<Run | null> {
    const run = await store.get(id);
    const host = deps.host();
    if (!run || !host) return run;
    if (run.state === "blocked" || finished(run)) {
      background(
        cleanup(id).then(() => (finished(run) ? gcOrphans(host, run) : undefined)),
        "sweep",
      );
      return run;
    }
    let facts: Facts;
    try {
      facts = await gather(host, run, workspaces ?? (await host.listWorkspaces()));
    } catch (e) {
      log(`reconcile ${id}: could not read the facts, leaving the Run as it is`, e);
      return run; // a failed read is not evidence that anything died
    }
    const out = await withRun(id, async () => {
      const fresh = await store.get(id);
      if (!fresh) return null;
      let current = fresh;
      for (const ev of reconcileFacts(fresh, facts)) {
        const r = await applyLocked(id, ev);
        if (r) current = r.run;
      }
      return current;
    });
    if (out) {
      background(cleanup(id), "cleanup");
      if (out.state !== "gating" && !creating.has(id)) background(gcOrphans(host, out), "gc");
    }
    return out ?? run;
  }

  async function reconcileAll(opts: { sweepFinished?: boolean } = {}) {
    const host = deps.host();
    if (!host) return;
    const workspaces = await host.listWorkspaces();
    for (const run of await store.list()) {
      if (finished(run) && !opts.sweepFinished) continue;
      await reconcileRun(run.id, workspaces).catch((e) => log(`reconcile ${run.id} failed`, e));
    }
  }

  // ---- queries ----

  async function findByAgent(agentId: string) {
    for (const run of await store.list()) {
      if (run.writer.agentId === agentId) return { run, role: "writer" as const };
      const review = run.reviews.find((r) => r.reviewer.agentId === agentId);
      if (review) return { run, role: "reviewer" as const, review };
    }
    return null;
  }

  /** First agent of this Run stopped on an unanswered permission request, or null. */
  async function pendingPermissionAgent(run: Run): Promise<string | null> {
    const host = deps.host();
    if (!host || finished(run)) return null;
    const ids = [
      run.writer.agentId,
      ...run.reviews.filter((r) => !r.verdict && !r.void).map((r) => r.reviewer.agentId),
    ];
    for (const id of ids) if ((await host.agent(id)).pendingPermissions > 0) return id;
    return null;
  }
  const pendingPermission = async (run: Run) => (await pendingPermissionAgent(run)) !== null;

  // ---- start (Spec 6.1 first row) ----

  async function start(input: StartInput): Promise<{ run: Run; warnings: string[] }> {
    const host = requireHost();
    if (!input.gateCommands.length)
      throw new Error("没有验收命令，不能启动：任务说明的“怎么验证”必须能解析出至少一条命令");
    if (!/^##\s*怎么验证\s*\n+\S/m.test(input.taskMarkdown))
      throw new Error("任务说明缺少“怎么验证”一节");
    if (input.reviewers.length < 1 || input.reviewers.length > 3)
      throw new Error("审查者数量必须在 1 到 3 之间");
    const modeProblems = input.reviewers.flatMap(
      (r, i) => reviewerModeProblem(`r${i + 1}`, r) ?? [],
    );
    if (modeProblems.length) throw new Error(modeProblems.join("\n"));
    const blocker = toolsBlocker(await host.config(), [
      input.writer.provider,
      ...input.reviewers.map((r) => r.provider),
    ]);
    if (blocker) throw new Error(blocker);
    const limit = (await deps.maxActive?.()) ?? 3;
    const active = (await store.list()).filter(isActive).length;
    if (active >= limit) throw new Error(`已有 ${active} 个活跃任务，达到上限 ${limit}`);

    const repo = await git(input.repoPath, "rev-parse", "--show-toplevel");
    const baseSha = await revParse(repo, input.baseRef);
    let id = newRunId(new Date(now()));
    for (
      let i = 0;
      i < 20 && ((await store.get(id)) || (await branchSha(repo, writerBranch(id))));
      i++
    ) {
      id = newRunId(new Date(now()));
    }
    const branch = writerBranch(id);
    const ws = await host.createWorkspace({
      sourceCheckout: repo,
      baseBranch: input.baseRef,
      branchName: branch,
      background: false,
    });
    let stored = false;
    try {
      await waitSetup(host, ws.id, timing);
      await excludeTeamDir(ws.path);
      await mkdir(path.join(ws.path, TEAM_DIR), { recursive: true });
      await writeFile(path.join(ws.path, TEAM_DIR, "task.md"), input.taskMarkdown);
      const run = RunSchema.parse({
        schemaVersion: 1,
        revision: 1,
        id,
        title: input.title,
        state: "writing",
        repo: { sourceCheckout: repo, baseRef: input.baseRef, baseSha },
        workspace: { id: ws.id, path: ws.path, branch },
        task: {
          file: ".team/task.md",
          gateCommands: input.gateCommands,
          protectedPaths: input.protectedPaths,
          allowedPaths: input.allowedPaths,
          env: input.env ?? {},
        },
        specs: { writer: input.writer, reviewers: input.reviewers },
        writer: {
          agentId: randomUUID(),
          profile: input.writer.profile,
          family: familyOf(input.writer.provider),
        },
        limits: { ...DEFAULT_LIMITS, ...input.limits },
        attempts: [],
        reviews: [],
        lastProgressAt: now(),
        createdAt: now(),
      });
      const created = await store.create(run);
      stored = true;
      await startWriter(host, created);
      const warnings = input.reviewers
        .filter((r) => familyOf(r.provider) === created.writer.family)
        .map(
          (r) =>
            `审查者 ${r.profile} 与写手同属 ${created.writer.family} 家族，盲区可能重叠，建议换一个家族`,
        );
      // A writer stopped on a permission request is visible in the panel, so this stays a warning.
      if (!input.writer.modeId) {
        warnings.push(`${input.writer.profile} 没有指定 modeId，写手可能停在权限请求上等人批准`);
      }
      return { run: created, warnings };
    } catch (e) {
      if (stored) await store.remove(id).catch(() => undefined);
      await host.archiveWorkspace(ws.id).catch(() => undefined);
      throw e;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    dispatch,
    withRun,
    start,
    reconcile: reconcileRun,
    reconcileAll,
    findByAgent,
    pendingPermission,
    pendingPermissionAgent,
    get: (id: string) => store.get(id),
    list: () => store.list(),
    store,
    idle,
    isGateRunning: gate.isRunning,
    startTimer(ms = 60_000) {
      timer ??= setInterval(() => void reconcileAll().catch((e) => log("reconcile failed", e)), ms);
      timer.unref?.();
    },
    async dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      gate.stopAll();
      await idle();
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
