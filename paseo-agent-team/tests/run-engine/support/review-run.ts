import { REPO_EXCLUSIVE_RESOURCE } from "../../../shared/domain/run-engine/dispatch-builder";
import type { RunRecord } from "../../../shared/schemas/run-engine/ledger";
import { claim, REPO_ID } from "../../fixtures/run-engine/base";
import { readyRun } from "./ready-run";

export const JUDGE_SEAT_REVIEW = "seat-b2";
export const JUDGE_SEAT_SMOKE = "seat-m1";
export const BASE_SHA = "1".repeat(40);
export const HEAD_SHA = "2".repeat(40);

export type ReviewRunOptions = {
  runId?: string;
  repoId?: string;
  evidenceRoot?: string;
  baseSha?: string;
  headSha?: string;
  branch?: string;
  /** Claimed changed files of the delivery (default: the task's own file). */
  changedFiles?: string[];
  /** Keep the accepted reviewer of the normal ledger, so the task is ready for its smoke. */
  reviewed?: boolean;
  /** Give t1 a DEV smoke with one check and a seat that can run it. */
  devSmoke?: boolean;
};

/**
 * `readyRun` with t1 turned into a delivered task: its producer proof says it committed `headSha`
 * on `branch` starting from `baseSha`, and the task waits for review (or, with `reviewed`, for
 * smoke). Judges are seat-b2 (reviewer) and seat-m1 (smoker, added only with `devSmoke`), both with
 * a budget; t2 stays ready and t3 pending, so tests choose what else is runnable.
 */
export function reviewRun(options: ReviewRunOptions = {}): RunRecord {
  const baseSha = options.baseSha ?? BASE_SHA;
  const headSha = options.headSha ?? HEAD_SHA;
  const branch = options.branch ?? "main";
  const record = readyRun({
    runId: options.runId,
    repoId: options.repoId,
    evidenceRoot: options.evidenceRoot,
  });
  const t1 = record.tasks.find((task) => task.spec.id === "t1");
  const producer = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1");
  const reviewer = record.assignments.find((entry) => entry.assignmentId === "assignment-t1-r1");
  if (!t1 || !producer || !reviewer) throw new Error("fixture lost t1");

  const ref = { kind: "git-commit", value: headSha };
  const workspace = { id: "ws-start", branch, baseRef: baseSha };
  const files = options.changedFiles ?? ["src/t1.ts"];
  producer.workspace = workspace;
  const proof = producer.acceptedProof as unknown as {
    ref: unknown;
    workspace: unknown;
    changedFiles: string[];
    evidence: { ref: unknown }[];
  };
  proof.ref = ref;
  proof.workspace = workspace;
  proof.changedFiles = files;
  for (const item of proof.evidence) item.ref = ref;
  Object.assign(t1, {
    state: "review",
    phase: "review",
    ref,
    changedFiles: files,
  });
  // A delivered task keeps the claims it was granted until it is done, the repository-wide one
  // included: that is what keeps the next task from starting while it is being judged.
  const repoId = options.repoId ?? REPO_ID;
  record.resources = [
    claim({
      claimId: "claim-t1-file",
      taskId: "t1",
      originAssignmentId: producer.assignmentId,
      repoId,
      path: "src/t1.ts",
    }),
    claim({
      claimId: "claim-t1-repo",
      taskId: "t1",
      originAssignmentId: producer.assignmentId,
      repoId,
      kind: "hot",
      path: REPO_EXCLUSIVE_RESOURCE,
    }),
  ];

  if (options.devSmoke) {
    Object.assign(t1.spec, {
      devSmoke: true,
      smokeChecklist: ["health"],
      dispatchDuties: { produce: "implement", review: "review", smoke: "smoke" },
    });
    record.roster.push({
      seatId: JUDGE_SEAT_SMOKE,
      tier: "B",
      agentId: "agent-m1",
      channelId: "claude",
      duties: ["smoke"],
      enabled: true,
    });
    record.budgets.entries.push({
      scope: "seat",
      subjectId: JUDGE_SEAT_SMOKE,
      limit: 6,
      reserved: 0,
      confirmed: 0,
      observedTurns: 0,
    });
  }
  record.budgets.entries.push({
    scope: "seat",
    subjectId: JUDGE_SEAT_REVIEW,
    limit: 6,
    reserved: 0,
    confirmed: 0,
    observedTurns: 0,
  });

  if (options.reviewed) {
    const proofOfReview = reviewer.acceptedProof as unknown as { reviewedRef: unknown };
    proofOfReview.reviewedRef = ref;
    t1.phase = options.devSmoke ? "smoke" : "review";
  } else {
    record.assignments = record.assignments.filter(
      (entry) => entry.assignmentId !== reviewer.assignmentId,
    );
    record.outbox = record.outbox.filter((entry) => entry.assignmentId !== reviewer.assignmentId);
    record.nonceRegistry = record.nonceRegistry.filter(
      (entry) => entry.assignmentId !== reviewer.assignmentId,
    );
  }
  return record;
}
