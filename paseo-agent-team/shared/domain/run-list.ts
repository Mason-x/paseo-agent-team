import type { RunSummary } from "../schemas/preferences";
import { zh } from "../zh";
import { type RunPhase, type RunProgress, runProgress, type TeamRun } from "./run-progress";

export type RunFilter = "all" | "active" | "attention" | "ended";

export const RUN_FILTERS: readonly RunFilter[] = ["all", "attention", "active", "ended"];

/** Runs shown before "show earlier", so a host with weeks of history opens on what matters. */
export const RUN_PAGE_SIZE = 8;

export type RunRow = { run: TeamRun; progress: RunProgress };

type Bucket = Exclude<RunFilter, "all">;

const BUCKET_BY_PHASE: Record<RunPhase, Bucket> = {
  "needs-you": "attention",
  failed: "attention",
  starting: "active",
  running: "active",
  done: "ended",
  idle: "ended",
};

const BUCKET_ORDER: Record<Bucket, number> = { attention: 0, active: 1, ended: 2 };

export function bucketOf(phase: RunPhase): Bucket {
  return BUCKET_BY_PHASE[phase];
}

/** A run still has something to watch or answer while it is active or needs attention. */
export function isLive(phase: RunPhase): boolean {
  return bucketOf(phase) !== "ended";
}

/** Runs that need a person first, then ones in flight, then finished ones; newest first within each. */
export function buildRunRows(runs: readonly TeamRun[]): RunRow[] {
  return runs
    .map((run) => ({ run, progress: runProgress(run) }))
    .sort((left, right) => {
      const byBucket =
        BUCKET_ORDER[bucketOf(left.progress.phase)] - BUCKET_ORDER[bucketOf(right.progress.phase)];
      return byBucket !== 0 ? byBucket : right.run.startedAt.localeCompare(left.run.startedAt);
    });
}

export function filterRows(rows: readonly RunRow[], filter: RunFilter): RunRow[] {
  return filter === "all"
    ? [...rows]
    : rows.filter((row) => bucketOf(row.progress.phase) === filter);
}

export function filterCounts(rows: readonly RunRow[]): Record<RunFilter, number> {
  const counts: Record<RunFilter, number> = { all: rows.length, attention: 0, active: 0, ended: 0 };
  for (const row of rows) counts[bucketOf(row.progress.phase)] += 1;
  return counts;
}

/**
 * What the run was asked to do. Runs from versions before the task label only saved it in the
 * plugin's preferences, so those are still described.
 */
export function runTask(run: TeamRun, legacyRuns: readonly RunSummary[]): string | undefined {
  return run.task ?? legacyRuns.find((entry) => entry.runId === run.runId)?.taskExcerpt;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function span(ms: number): string | null {
  if (ms < MINUTE) return null;
  if (ms < HOUR) return zh.spanMinutes(Math.floor(ms / MINUTE));
  if (ms < DAY) return zh.spanHours(Math.floor(ms / HOUR));
  return zh.spanDays(Math.floor(ms / DAY));
}

/**
 * "Running for 5 minutes" while a run is live; "Finished 2 days ago" once it is not. A finished
 * run's age is counted from its last activity, not from when it began.
 */
export function runTimeLabel(run: TeamRun, phase: RunPhase, now: number): string {
  const started = Date.parse(run.startedAt);
  const lastActive = Date.parse(run.lastActivityAt);
  if (isLive(phase)) {
    const elapsed = Number.isFinite(started) ? span(Math.max(0, now - started)) : null;
    return elapsed ? zh.runningFor(elapsed) : zh.justStarted;
  }
  const since = Number.isFinite(lastActive) ? lastActive : started;
  const ago = Number.isFinite(since) ? span(Math.max(0, now - since)) : null;
  const outcome = phase === "done" ? zh.outcomeDone : zh.outcomeEnded;
  return ago ? zh.agoOutcome(ago, outcome) : zh.justNowOutcome(outcome);
}
