import type { BlockedReason, GateAttempt, Review, Run } from "./run";

/** What a human may choose when a Run is blocked, per reason (Spec 6.3). "abandon" is always allowed. */
export type Choice =
  | { kind: "more-attempts"; n: number }
  | { kind: "message"; text: string }
  | { kind: "more-round" }
  | { kind: "accept-current"; sha: string }
  | { kind: "resubmit"; sha: string; dirty: string[] }
  | { kind: "retry" };

export const CHOICES: Record<BlockedReason, Choice["kind"][]> = {
  "gate-attempts-exhausted": ["more-attempts", "message"],
  "review-rounds-exhausted": ["more-round", "accept-current"],
  "writer-stopped-without-submit": ["message"],
  "writer-asked-human": ["message"],
  "writer-worktree-changed-during-review": ["resubmit"],
  "review-setup-failed": ["retry"],
  "agent-failed": ["retry"],
  stalled: ["retry"],
};

export type Event =
  | { kind: "submit"; sha: string; dirty: string[]; summary?: string }
  | { kind: "writer-turn-ended"; failed?: string }
  | { kind: "block"; question: string }
  | { kind: "gate-finished"; attempt: GateAttempt }
  | { kind: "reviewers-ready"; round: number; reviews: Review[] }
  | { kind: "reviewers-failed"; error: string }
  | {
      kind: "verdict";
      reviewId: string;
      verdict: "approve" | "request-changes";
      blocking: number;
      writerOk: boolean;
    }
  | { kind: "reviewer-turn-ended"; reviewId: string; failed?: string }
  | { kind: "fail"; reason: BlockedReason; note?: string }
  | { kind: "head-changed" }
  | { kind: "resume-gating" }
  | { kind: "close"; outcome: "merged" | "abandoned" }
  | { kind: "resolve"; choice: Choice };

/** Descriptions of work for the engine to do. The machine never does I/O itself. */
export type Effect =
  | { t: "reject-submit"; files: string[] }
  | { t: "run-gate" }
  | { t: "create-reviewers"; round: number; sha: string }
  | { t: "cleanup-reviewers" }
  | { t: "notify-writer"; kind: "gate-failed" | "reports" | "text" | "nudge"; text?: string }
  | { t: "remind-reviewer"; reviewId: string }
  | { t: "archive" };

export type Result = { run: Run; effects: Effect[] };

const CLEANUP: Effect = { t: "cleanup-reviewers" };
const lastOf = (run: Run) => run.attempts.at(-1);
const inRound = (run: Run) => run.reviews.filter((r) => r.round === run.round && !r.void);

function voidRound(run: Run, why: NonNullable<Review["void"]>, includeDone: boolean): Review[] {
  return run.reviews.map((r) =>
    r.round === run.round && !r.void && (includeDone || !r.verdict) ? { ...r, void: why } : r,
  );
}

export function transition(run: Run, ev: Event, now: string): Result {
  const none: Result = { run, effects: [] };
  const go = (patch: Partial<Run>, effects: Effect[] = []): Result => {
    const leaving = patch.state !== undefined && patch.state !== "blocked";
    const clear = leaving
      ? { blockedReason: undefined, blockedFrom: undefined, blockedNote: undefined }
      : {};
    return { run: { ...run, ...clear, ...patch, lastProgressAt: now }, effects };
  };
  const block = (
    reason: BlockedReason,
    note?: string,
    effects: Effect[] = [],
    patch: Partial<Run> = {},
  ) =>
    go(
      {
        ...patch,
        state: "blocked",
        blockedReason: reason,
        blockedFrom: run.state,
        blockedNote: note,
      },
      effects,
    );
  const startGate = (sha: string, summary?: string) =>
    go(
      {
        state: "gating",
        nudges: 0,
        attempts: [
          ...run.attempts,
          {
            n: run.attempts.length + 1,
            sha,
            startedAt: now,
            checks: [],
            policyViolations: [],
            summary,
          },
        ],
      },
      [{ t: "run-gate" }],
    );

  switch (ev.kind) {
    case "submit":
      if (run.state !== "writing") return none;
      if (ev.dirty.length) return { run, effects: [{ t: "reject-submit", files: ev.dirty }] };
      return startGate(ev.sha, ev.summary);

    case "writer-turn-ended":
      if (run.state !== "writing") return none;
      if (ev.failed) return block("agent-failed", ev.failed);
      if (run.nudges === 0) return go({ nudges: 1 }, [{ t: "notify-writer", kind: "nudge" }]);
      return block("writer-stopped-without-submit");

    case "block":
      return run.state === "writing" ? block("writer-asked-human", ev.question) : none;

    case "gate-finished": {
      const last = lastOf(run);
      if (run.state !== "gating" || !last || last.n !== ev.attempt.n || last.finishedAt)
        return none;
      const attempts = [...run.attempts.slice(0, -1), ev.attempt];
      if (ev.attempt.result === "pass") {
        const round = run.round + 1;
        return go({ attempts, round }, [{ t: "create-reviewers", round, sha: ev.attempt.sha }]);
      }
      if (attempts.length >= run.limits.maxGateAttempts) {
        return block("gate-attempts-exhausted", undefined, [], { attempts });
      }
      return go({ state: "writing", nudges: 0, attempts }, [
        { t: "notify-writer", kind: "gate-failed" },
      ]);
    }

    case "reviewers-ready":
      if (run.state !== "gating" || ev.round !== run.round) return none;
      return go({ state: "reviewing", reviews: [...run.reviews, ...ev.reviews] });

    case "reviewers-failed":
      return run.state === "gating" ? block("review-setup-failed", ev.error, [CLEANUP]) : none;

    case "verdict": {
      const rv = run.reviews.find((r) => r.id === ev.reviewId);
      if (run.state !== "reviewing" || !rv || rv.void || rv.verdict) return none;
      if (!ev.writerOk) {
        return block("writer-worktree-changed-during-review", undefined, [CLEANUP], {
          reviews: voidRound(run, "writer-worktree-changed", true),
        });
      }
      const reviews = run.reviews.map((r) =>
        r.id === rv.id ? { ...r, verdict: ev.verdict, blocking: ev.blocking } : r,
      );
      const mine = reviews.filter((r) => r.round === run.round && !r.void);
      if (mine.some((r) => !r.verdict)) return go({ reviews }, [CLEANUP]);
      if (mine.every((r) => r.verdict === "approve")) {
        const approved = { sha: rv.sha, reviewIds: mine.map((r) => r.id) };
        return go({ state: "ready", reviews, approved }, [CLEANUP]);
      }
      if (run.round >= run.limits.maxReviewRounds) {
        return block("review-rounds-exhausted", undefined, [CLEANUP], { reviews });
      }
      return go({ state: "writing", nudges: 0, reviews }, [
        CLEANUP,
        { t: "notify-writer", kind: "reports" },
      ]);
    }

    case "reviewer-turn-ended": {
      const rv = run.reviews.find((r) => r.id === ev.reviewId);
      if (run.state !== "reviewing" || !rv || rv.void || rv.verdict) return none;
      if (!ev.failed && rv.nudges === 0) {
        const reviews = run.reviews.map((r) => (r.id === rv.id ? { ...r, nudges: 1 } : r));
        return go({ reviews }, [{ t: "remind-reviewer", reviewId: rv.id }]);
      }
      const note = ev.failed ?? `审查者 ${rv.seat} 两次回合结束都没有给出结论`;
      return block("agent-failed", note, [CLEANUP], {
        reviews: voidRound(run, "no-verdict", false),
      });
    }

    case "fail": {
      if (!["writing", "gating", "reviewing", "ready"].includes(run.state)) return none;
      if (run.state !== "reviewing" && run.state !== "gating") return block(ev.reason, ev.note);
      const moved = ev.reason === "writer-worktree-changed-during-review";
      const reviews = voidRound(run, moved ? "writer-worktree-changed" : "no-verdict", moved);
      return block(ev.reason, ev.note, [CLEANUP], { reviews });
    }

    case "head-changed":
      return run.state === "ready"
        ? go({ state: "writing", nudges: 0, approved: undefined })
        : none;

    case "resume-gating": {
      const last = lastOf(run);
      if (run.state !== "gating" || !last) return none;
      const eff: Effect = last.finishedAt
        ? { t: "create-reviewers", round: run.round, sha: last.sha }
        : { t: "run-gate" };
      return { run, effects: [eff] };
    }

    case "close": {
      const terminal = run.state === "merged" || run.state === "abandoned";
      if (terminal || (ev.outcome === "merged" && run.state !== "ready")) return none;
      return go({ state: ev.outcome, closedAt: now }, [CLEANUP, { t: "archive" }]);
    }

    case "resolve": {
      const c = ev.choice;
      if (run.state !== "blocked" || !run.blockedReason) return none;
      if (!CHOICES[run.blockedReason].includes(c.kind)) return none;
      const limits = run.limits;
      switch (c.kind) {
        case "more-attempts":
          return go(
            {
              state: "writing",
              nudges: 0,
              limits: { ...limits, maxGateAttempts: limits.maxGateAttempts + c.n },
            },
            [{ t: "notify-writer", kind: "gate-failed" }],
          );
        case "message": {
          const more =
            run.blockedReason === "gate-attempts-exhausted"
              ? {
                  limits: {
                    ...limits,
                    maxGateAttempts: Math.max(limits.maxGateAttempts, run.attempts.length + 1),
                  },
                }
              : {};
          return go({ state: "writing", nudges: 0, ...more }, [
            { t: "notify-writer", kind: "text", text: c.text },
          ]);
        }
        case "more-round":
          return go(
            {
              state: "writing",
              nudges: 0,
              limits: { ...limits, maxReviewRounds: limits.maxReviewRounds + 1 },
            },
            [{ t: "notify-writer", kind: "reports" }],
          );
        case "accept-current":
          return go({ state: "ready", approved: { sha: c.sha, reviewIds: [], override: "human" } });
        case "resubmit":
          if (c.dirty.length) return { run, effects: [{ t: "reject-submit", files: c.dirty }] };
          return startGate(c.sha, "人工从当前提交重新送审");
        case "retry": {
          const last = lastOf(run);
          const from = run.blockedFrom;
          if (from === "writing") {
            return go({ state: "writing", nudges: 0 }, [
              { t: "notify-writer", kind: "text", text: "人已经处理了异常，请继续完成任务。" },
            ]);
          }
          if (from === "ready") return go({ state: "ready" });
          if (!last) return none;
          if (from === "gating" && !last.finishedAt)
            return go({ state: "gating" }, [{ t: "run-gate" }]);
          return go({ state: "gating" }, [
            { t: "create-reviewers", round: run.round, sha: last.sha },
          ]);
        }
      }
    }
  }
}

export type AgentFact = { alive: boolean; idle: boolean; error: boolean };
export type Facts = {
  now: string;
  head: string | null;
  workspaceAlive: boolean;
  writer: AgentFact;
  /** keyed by reviewer agent id */
  reviewers: Record<string, AgentFact>;
  gateRunning: boolean;
  creatingReviewers: boolean;
};

/** Pure read of the five facts in Spec 6.4. Returns the events that bring the Run back in line. */
export function reconcile(run: Run, f: Facts): Event[] {
  if (run.state === "blocked" || run.state === "merged" || run.state === "abandoned") return [];
  const fail = (reason: BlockedReason, note: string): Event[] => [{ kind: "fail", reason, note }];
  if (!f.workspaceAlive) return fail("agent-failed", "写手的工作区已不存在");
  if (run.state !== "ready" && !f.writer.alive) return fail("agent-failed", "写手不存在或已归档");
  const last = lastOf(run);
  switch (run.state) {
    case "writing": {
      if (f.writer.error) return fail("agent-failed", "写手出错");
      const idleMs = Date.parse(f.now) - Date.parse(run.lastProgressAt);
      if (f.writer.idle && idleMs > run.limits.stallMinutes * 60_000) {
        return fail("stalled", `写手空闲超过 ${run.limits.stallMinutes} 分钟`);
      }
      return [];
    }
    case "gating": {
      const idle = !f.gateRunning && !f.creatingReviewers;
      return idle && last ? [{ kind: "resume-gating" }] : [];
    }
    case "reviewing": {
      const sha = inRound(run)[0]?.sha;
      if (f.head && sha && f.head !== sha) {
        return fail(
          "writer-worktree-changed-during-review",
          `写手 HEAD 已变为 ${f.head.slice(0, 8)}`,
        );
      }
      const dead = inRound(run).find((r) => {
        const a = f.reviewers[r.reviewer.agentId];
        return !r.verdict && (!a?.alive || a.error);
      });
      return dead ? fail("agent-failed", `审查者 ${dead.seat} 不存在、已归档或出错`) : [];
    }
    case "ready":
      return f.head && run.approved && f.head !== run.approved.sha
        ? [{ kind: "head-changed" }]
        : [];
  }
}

export type Waiting = {
  who: "writer" | "gate" | "reviewers" | "human" | "nobody";
  why: string;
  options: string[];
};

/** Who the Run is waiting for, why, and what the human may do (AC10). */
export function waiting(run: Run, pendingPermission = false): Waiting {
  if (pendingPermission) {
    return {
      who: "human",
      why: "有一个权限请求在等人批准",
      options: ["approve-permission", "abandon"],
    };
  }
  switch (run.state) {
    case "writing":
      return { who: "writer", why: "写手在工作，等它调用 team_submit", options: ["abandon"] };
    case "gating":
      return { who: "gate", why: "插件正在执行验收命令", options: ["abandon"] };
    case "reviewing": {
      const open = inRound(run)
        .filter((r) => !r.verdict)
        .map((r) => r.seat);
      return {
        who: "reviewers",
        why: `等审查者 ${open.join("、") || "全部"} 给出结论`,
        options: ["abandon"],
      };
    }
    case "ready":
      return {
        who: "human",
        why: "验收通过且审查批准，等人决定合并",
        options: ["merged", "abandoned"],
      };
    case "blocked":
      return {
        who: "human",
        why: `${run.blockedReason ?? "blocked"}${run.blockedNote ? `：${run.blockedNote}` : ""}`,
        options: [...(run.blockedReason ? CHOICES[run.blockedReason] : []), "abandon"],
      };
    default:
      return { who: "nobody", why: "已结束", options: [] };
  }
}
