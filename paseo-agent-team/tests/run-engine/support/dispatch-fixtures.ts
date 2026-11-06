import {
  applyDispatch,
  buildDispatch,
  buildReviewDispatch,
} from "../../../shared/domain/run-engine/dispatch-builder";
import {
  producerSemanticArgs,
  reviewerSemanticArgs,
  reworkSemanticArgs,
  smokerSemanticArgs,
  templateVersionFor,
} from "../../../shared/domain/run-engine/prompt-template";
import type { RunEffectIntent, RunRecord } from "../../../shared/schemas/run-engine/ledger";
import { PROFILE_HAIKU } from "../../fixtures/run-engine/base";
import { recordReview } from "./judge-flow";
import { readyRun } from "./ready-run";
import { HEAD_SHA, JUDGE_SEAT_REVIEW, JUDGE_SEAT_SMOKE, reviewRun } from "./review-run";

/**
 * Dispatched assignments for the prompt/report contract tests: a producer (t2, first attempt), a
 * reworked producer (t1, second attempt), a reviewer and a smoker (t1). Every evidence directory is
 * under the fixture's `policy.evidenceRoot` ("evidence"), so a report built from the prompt can also
 * pass the evidence gate. Pass `version` to compile an older registered version of the same intent.
 */
export type Dispatch = Extract<RunEffectIntent, { kind: "dispatch" }>;

export const NOW = "2026-11-05T12:00:00.000Z";
const FACTS = { now: NOW, newId: (kind: string) => `${kind}-new` };
export const REPO_ROOT = "C:/work/repo";
const LUNA = {
  id: "profile-dev-luna",
  name: "DEV Luna",
  provider: "codex",
  model: "gpt-6-luna",
  family: "luna",
};
const HAIKU = {
  id: PROFILE_HAIKU.id,
  name: PROFILE_HAIKU.name,
  provider: PROFILE_HAIKU.provider,
  model: PROFILE_HAIKU.model,
  family: PROFILE_HAIKU.family,
};

/** The JSON line that follows a section label of a rendered prompt. */
export function section(text: string, label: string): Record<string, unknown> {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label}`);
  return JSON.parse(lines[index + 1] ?? "") as Record<string, unknown>;
}

export type Dispatched = {
  record: RunRecord;
  intent: Dispatch;
  assignmentId: string;
  evidenceDir: string;
};

function intentOf(record: RunRecord, assignmentId: string): Dispatch {
  const intent = record.outbox.find((entry) => entry.id === `intent-${assignmentId}`);
  if (intent?.kind !== "dispatch") throw new Error("intent missing");
  return intent;
}

export function producerDispatch(
  options: { version?: number; mutate?: (record: RunRecord) => void } = {},
): Dispatched {
  const assignmentId = "assignment-t2-a1-abcd1234";
  const evidenceDir = `evidence/${assignmentId}`;
  const ready = readyRun();
  options.mutate?.(ready);
  const task = ready.tasks.find((entry) => entry.spec.id === "t2");
  if (!task) throw new Error("fixture lost t2");
  const built = buildDispatch(ready, {
    taskId: "t2",
    seatId: "seat-b1",
    profile: HAIKU,
    workspace: {
      id: "ws-start",
      branch: "main",
      baseRef: "9f3c1a7000000000000000000000000000000000",
    },
    scopes: task.spec.scopes.map((scope) => ({ ...scope, verified: true })),
    reason: "test",
    otherResources: { trusted: true, claims: [] },
    ids: {
      assignmentId,
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000a1",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      intentId: `intent-${assignmentId}`,
      claimId: (index) => `claim-${index}`,
    },
    now: NOW,
    payload: {
      hash: "0".repeat(64),
      templateVersion: options.version ?? templateVersionFor("member") ?? 0,
      semanticArgs: producerSemanticArgs(task.spec, { repoRoot: REPO_ROOT, evidenceDir }),
    },
  });
  if (!built.ok) throw new Error(`build refused: ${built.reason}`);
  const applied = applyDispatch(ready, built, FACTS);
  if (!applied.ok) throw new Error(`apply refused: ${JSON.stringify(applied.params)}`);
  return {
    record: applied.next,
    intent: intentOf(applied.next, assignmentId),
    assignmentId,
    evidenceDir,
  };
}

export function judgeDispatch(
  purpose: "reviewer" | "smoker",
  options: { version?: number } = {},
): Dispatched {
  const record = reviewRun({ devSmoke: purpose === "smoker", reviewed: purpose === "smoker" });
  if (purpose === "smoker") {
    // A smoker comes after the review: the fixture keeps the accepted reviewer.
    const t1 = record.tasks.find((task) => task.spec.id === "t1");
    if (t1) t1.phase = "smoke";
  }
  const task = record.tasks.find((entry) => entry.spec.id === "t1");
  if (!task) throw new Error("fixture lost t1");
  const assignmentId = purpose === "reviewer" ? "assignment-t1-r1-new" : "assignment-t1-s1-new";
  const evidenceDir = `evidence/${assignmentId}`;
  const facts = { repoRoot: REPO_ROOT, evidenceDir };
  const built = buildReviewDispatch(record, {
    taskId: "t1",
    seatId: purpose === "reviewer" ? JUDGE_SEAT_REVIEW : JUDGE_SEAT_SMOKE,
    purpose,
    profile: LUNA,
    workspace: { id: "ws-start", branch: "main", baseRef: HEAD_SHA },
    reason: purpose,
    devServerId: purpose === "smoker" ? "dev-server-1" : undefined,
    ids: {
      assignmentId,
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000c1",
      messageId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      intentId: `intent-${assignmentId}`,
    },
    now: NOW,
    payload: {
      hash: "0".repeat(64),
      templateVersion: options.version ?? templateVersionFor(purpose) ?? 0,
      semanticArgs:
        purpose === "reviewer"
          ? reviewerSemanticArgs(task.spec, facts)
          : smokerSemanticArgs(task.spec, { ...facts, devServerId: "dev-server-1" }),
    },
  });
  if (!built.ok) throw new Error(`build refused: ${built.reason}`);
  const applied = applyDispatch(record, built, FACTS);
  if (!applied.ok) throw new Error(`apply refused: ${JSON.stringify(applied.params)}`);
  return {
    record: applied.next,
    intent: intentOf(applied.next, assignmentId),
    assignmentId,
    evidenceDir,
  };
}

/** t1 was delivered, a reviewer asked for changes, and the task is back for rework (attempt 2). */
export function reworkDispatch(options: { version?: number } = {}): Dispatched {
  const reviewerId = "assignment-t1-r1-new";
  const assignmentId = "assignment-t1-a2-new";
  const evidenceDir = `evidence/${assignmentId}`;
  const record = reviewRun();
  const task = record.tasks.find((entry) => entry.spec.id === "t1");
  if (!task) throw new Error("fixture lost t1");
  const review = buildReviewDispatch(record, {
    taskId: "t1",
    seatId: JUDGE_SEAT_REVIEW,
    purpose: "reviewer",
    profile: LUNA,
    workspace: { id: "ws-start", branch: "main", baseRef: HEAD_SHA },
    reason: "reviewer",
    ids: {
      assignmentId: reviewerId,
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000d1",
      messageId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      intentId: `intent-${reviewerId}`,
    },
    now: NOW,
    payload: {
      hash: "0".repeat(64),
      templateVersion: templateVersionFor("reviewer") ?? 0,
      semanticArgs: reviewerSemanticArgs(task.spec, {
        repoRoot: REPO_ROOT,
        evidenceDir: `evidence/${reviewerId}`,
      }),
    },
  });
  if (!review.ok) throw new Error(`build refused: ${review.reason}`);
  const reviewed = applyDispatch(record, review, FACTS);
  if (!reviewed.ok) throw new Error(`apply refused: ${JSON.stringify(reviewed.params)}`);
  const sentBack = recordReview(reviewed.next, reviewerId, {
    verdict: "修改后合入",
    blockers: [{ id: "b1", summary: "off by one in parse()", path: "src/t1.ts" }],
  });
  const back = sentBack.tasks.find((entry) => entry.spec.id === "t1");
  if (!back) throw new Error("fixture lost t1");
  const built = buildDispatch(sentBack, {
    taskId: "t1",
    seatId: "seat-b1",
    profile: HAIKU,
    workspace: { id: "ws-start", branch: "main", baseRef: HEAD_SHA },
    scopes: back.spec.scopes.map((scope) => ({ ...scope, verified: true })),
    reason: "rework",
    otherResources: { trusted: true, claims: [] },
    ids: {
      assignmentId,
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000d2",
      messageId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      intentId: `intent-${assignmentId}`,
      claimId: (index) => `claim-rework-${index}`,
    },
    now: NOW,
    payload: {
      hash: "0".repeat(64),
      templateVersion: options.version ?? templateVersionFor("member", { rework: true }) ?? 0,
      semanticArgs: reworkSemanticArgs(back.spec, { repoRoot: REPO_ROOT, evidenceDir }),
    },
  });
  if (!built.ok) throw new Error(`build refused: ${built.reason}`);
  const applied = applyDispatch(sentBack, built, FACTS);
  if (!applied.ok) throw new Error(`apply refused: ${JSON.stringify(applied.params)}`);
  return {
    record: applied.next,
    intent: intentOf(applied.next, assignmentId),
    assignmentId,
    evidenceDir,
  };
}
