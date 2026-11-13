import {
  DEFAULT_LIMITS,
  type GateAttempt,
  type Review,
  type Run,
  RunSchema,
} from "../../v2/shared/run";

export const NOW = "2026-11-12T10:00:00.000Z";
export const SHA = "a".repeat(40);
export const BASE = "b".repeat(40);

export function makeRun(patch: Partial<Run> = {}): Run {
  return RunSchema.parse({
    schemaVersion: 1,
    revision: 1,
    id: "r-20261112-0001",
    title: "demo",
    state: "writing",
    repo: { sourceCheckout: "/repo", baseRef: "main", baseSha: BASE },
    workspace: { id: "ws-w", path: "/wt/writer", branch: "team/r-20261112-0001/writer" },
    task: {
      file: ".team/task.md",
      gateCommands: [{ name: "test", command: "npm test", timeoutSec: 60 }],
      protectedPaths: ["tests/**"],
    },
    specs: {
      writer: { profile: "w", provider: "claude/sonnet" },
      reviewers: [{ profile: "r", provider: "codex/gpt-5.4" }],
    },
    writer: { agentId: "agent-w", profile: "w", family: "claude" },
    limits: { ...DEFAULT_LIMITS },
    attempts: [],
    reviews: [],
    lastProgressAt: NOW,
    createdAt: NOW,
    ...patch,
  });
}

export const attempt = (n: number, result?: GateAttempt["result"], sha = SHA): GateAttempt => ({
  n,
  sha,
  startedAt: NOW,
  ...(result ? { result, finishedAt: NOW } : {}),
  checks: [],
  policyViolations: [],
});

export function review(seat: Review["seat"], patch: Partial<Review> = {}): Review {
  return {
    id: `rv-1-${seat}-1`,
    round: 1,
    sha: SHA,
    seat,
    reviewer: { agentId: `agent-${seat}`, profile: "r", family: "openai" },
    workspace: {
      id: `ws-${seat}`,
      path: `/wt/${seat}`,
      branch: `team/r-20261112-0001/review-1-${seat}`,
    },
    blocking: 0,
    nudges: 0,
    reportFile: `.team/reviews/1-${seat}.md`,
    ...patch,
  };
}

/** A Run in `reviewing` with the given seats, round 1, candidate SHA. */
export function reviewing(seats: Review["seat"][] = ["r1"], patch: Partial<Run> = {}): Run {
  return makeRun({
    state: "reviewing",
    round: 1,
    attempts: [attempt(1, "pass")],
    reviews: seats.map((s) => review(s)),
    ...patch,
  });
}
