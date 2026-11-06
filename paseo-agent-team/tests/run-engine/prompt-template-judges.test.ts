import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { extractProtocolBlock } from "../../server/run-engine/protocol";
import {
  applyDispatch,
  buildReviewDispatch,
} from "../../shared/domain/run-engine/dispatch-builder";
import {
  compileDispatch,
  REVIEWER_TEMPLATE_VERSION,
  reviewerSemanticArgs,
  SMOKER_TEMPLATE_VERSION,
  smokerSemanticArgs,
  templateVersionFor,
} from "../../shared/domain/run-engine/prompt-template";
import { type ReduceResult, reduceRun } from "../../shared/domain/run-engine/reducer";
import type { RunEffectIntent, RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  BASE_SHA,
  HEAD_SHA,
  JUDGE_SEAT_REVIEW,
  JUDGE_SEAT_SMOKE,
  type ReviewRunOptions,
  reviewRun,
} from "./support/review-run";

/**
 * Failure modes this file guards:
 *  - a judge being told to review or test something other than the commit the producer delivered
 *    (the base it must diff against is the producer's, not its own workspace's);
 *  - a reviewer or smoker prompt that cannot be rebuilt from the ledger, or that is rebuilt from
 *    whatever the ledger says "now" instead of what the producer's accepted proof says;
 *  - a report the prompt describes that the strict parser, the reducer or the gates then refuse;
 *  - a template changing its bytes without a version bump.
 */

type Dispatch = Extract<RunEffectIntent, { kind: "dispatch" }>;

const NOW = "2026-11-05T12:00:00.000Z";
const FACTS = { now: NOW, newId: (kind: string) => `${kind}-new` };
const LUNA = {
  id: "profile-dev-luna",
  name: "DEV Luna",
  provider: "codex",
  model: "gpt-6-luna",
  family: "luna",
};
const REPO_ROOT = "C:/work/repo";

function judged(
  purpose: "reviewer" | "smoker",
  options: ReviewRunOptions = {},
  mutate?: (record: RunRecord) => void,
  version?: number,
): { record: RunRecord; intent: Dispatch; evidenceDir: string } {
  const record = reviewRun({ ...options, devSmoke: purpose === "smoker" || options.devSmoke });
  if (purpose === "smoker") {
    // A smoker comes after the review: the fixture keeps the accepted reviewer.
    const t1 = record.tasks.find((task) => task.spec.id === "t1");
    if (t1) t1.phase = "smoke";
  }
  mutate?.(record);
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
      templateVersion: version ?? templateVersionFor(purpose) ?? 0,
      semanticArgs:
        purpose === "reviewer"
          ? reviewerSemanticArgs(task.spec, facts)
          : smokerSemanticArgs(task.spec, { ...facts, devServerId: "dev-server-1" }),
    },
  });
  if (!built.ok) throw new Error(`build refused: ${built.reason}`);
  const applied = applyDispatch(record, built, FACTS);
  if (!applied.ok) throw new Error(`apply refused: ${JSON.stringify(applied.params)}`);
  const intent = applied.next.outbox.find((entry) => entry.id === `intent-${assignmentId}`);
  if (intent?.kind !== "dispatch") throw new Error("intent missing");
  return { record: applied.next, intent, evidenceDir };
}

function section(text: string, label: string): Record<string, unknown> {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label}`);
  return JSON.parse(lines[index + 1] ?? "") as Record<string, unknown>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("reviewer prompt", () => {
  test("names the producer's base and the delivered commit, taken from the producer's proof", () => {
    const { record, intent } = judged("reviewer");
    const text = compileDispatch(intent, record) ?? "";
    expect(section(text, "【执行事实 JSON】")).toEqual({
      purpose: "reviewer",
      // This is the reviewer's own workspace: HEAD at dispatch, NOT the base of the work.
      workspace: { id: "ws-start", branch: "main", baseRef: HEAD_SHA },
      repoRoot: REPO_ROOT,
      evidenceDir: "evidence/assignment-t1-r1-new",
      delivery: {
        producerAssignmentId: "assignment-t1-a1",
        producerBranch: "main",
        producerBaseRef: BASE_SHA,
        deliveryRef: { kind: "git-commit", value: HEAD_SHA },
        changedFiles: ["src/t1.ts"],
      },
    });
    expect(section(text, "【身份资料 JSON】")).toMatchObject({
      taskId: "t1",
      assignmentId: "assignment-t1-r1-new",
      attempt: 1,
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000c1",
    });
  });

  test("is rebuilt byte for byte, also from a reloaded record, and ignores the stored hash", () => {
    const { record, intent } = judged("reviewer");
    const first = compileDispatch(intent, record);
    expect(first).not.toBeNull();
    expect(compileDispatch(intent, record)).toBe(first);
    const reloaded = JSON.parse(JSON.stringify(record)) as RunRecord;
    const again = reloaded.outbox.find((entry) => entry.id === intent.id) as Dispatch;
    again.payloadHash = "f".repeat(64);
    expect(compileDispatch(again, reloaded)).toBe(first);
  });

  test("holds no code fence and no protocol block, and stays small", () => {
    const { record, intent } = judged("reviewer");
    const text = compileDispatch(intent, record) ?? "";
    expect(text).not.toMatch(/^ {0,3}`{3}/mu);
    expect(extractProtocolBlock(text)).toEqual({ status: "none" });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(16 * 1024);
    expect(text.endsWith("\n") && !text.endsWith("\n\n")).toBe(true);
  });

  test("cannot be rebuilt without a usable delivery", () => {
    const { record, intent } = judged("reviewer");
    const producer = (copy: RunRecord) =>
      copy.assignments.find((entry) => entry.assignmentId === "assignment-t1-a1");

    const noProof = structuredClone(record);
    const stripped = producer(noProof);
    if (stripped) stripped.acceptedProof = null;
    expect(compileDispatch(intent, noProof)).toBeNull();

    const diffRef = structuredClone(record);
    const target = producer(diffRef);
    if (target?.acceptedProof && "ref" in target.acceptedProof) {
      target.acceptedProof.ref = {
        kind: "diff-sha256",
        value: "a".repeat(64),
        baseCommit: BASE_SHA,
        patchPath: "evidence/x.patch",
      };
    }
    expect(compileDispatch(intent, diffRef)).toBeNull();

    const noWorkspace = structuredClone(record);
    const bare = producer(noWorkspace);
    if (bare) bare.workspace = null;
    expect(compileDispatch(intent, noWorkspace)).toBeNull();

    const unbound = structuredClone(record);
    const judge = unbound.assignments.find((entry) => entry.assignmentId === intent.assignmentId);
    if (judge) judge.delivery = null;
    expect(compileDispatch(intent, unbound)).toBeNull();

    // A producer template's arguments are not a reviewer's, and the version must be registered.
    expect(
      compileDispatch(
        { ...intent, semanticArgs: { ...intent.semanticArgs, template: "producer" } },
        record,
      ),
    ).toBeNull();
    expect(
      compileDispatch({ ...intent, templateVersion: REVIEWER_TEMPLATE_VERSION + 1 }, record),
    ).toBeNull();
  });
});

describe("smoker prompt", () => {
  test("adds the registered DEV target and the delivery, resolved from the ledger", () => {
    const { record, intent } = judged("smoker", { reviewed: true });
    const text = compileDispatch(intent, record) ?? "";
    const facts = section(text, "【执行事实 JSON】");
    expect(facts.devTarget).toEqual({
      devServerId: "dev-server-1",
      devHost: "127.0.0.1:6799",
      devHome: "/tmp/dev-home",
    });
    expect(facts.delivery).toMatchObject({
      producerBaseRef: BASE_SHA,
      deliveryRef: { kind: "git-commit", value: HEAD_SHA },
    });
    expect(
      (section(text, "【任务资料 JSON】") as { smokeChecklist: string[] }).smokeChecklist,
    ).toEqual(["health"]);
    expect(text).not.toMatch(/^ {0,3}`{3}/mu);
  });

  test("cannot be rebuilt when the DEV target or the checklist is no longer usable", () => {
    const { record, intent } = judged("smoker", { reviewed: true });

    const gone = structuredClone(record);
    gone.policy.devTargets = [];
    expect(compileDispatch(intent, gone)).toBeNull();

    const twice = structuredClone(record);
    const target = twice.policy.devTargets[0];
    if (target) twice.policy.devTargets.push({ ...target });
    expect(compileDispatch(intent, twice)).toBeNull();

    const defaultPort = structuredClone(record);
    const first = defaultPort.policy.devTargets[0];
    if (first) first.host = "127.0.0.1:6767";
    expect(compileDispatch(intent, defaultPort)).toBeNull();

    const emptyChecklist = { ...intent, semanticArgs: structuredClone(intent.semanticArgs) };
    (emptyChecklist.semanticArgs.taskSnapshot as { smokeChecklist: string[] }).smokeChecklist = [];
    expect(compileDispatch(emptyChecklist, record)).toBeNull();

    const noServer = {
      ...intent,
      semanticArgs: { ...intent.semanticArgs, devServerId: undefined },
    };
    expect(compileDispatch(noServer, record)).toBeNull();
  });
});

describe("the reports the judge prompts describe", () => {
  function fence(kind: string, body: unknown): string {
    return `Done.\n\`\`\`${kind}\n${JSON.stringify(body)}\n\`\`\`\n`;
  }

  function accept(
    record: RunRecord,
    intent: Dispatch,
    kind: "review-report" | "smoke-report",
    reply: string,
  ): ReduceResult {
    const delivered = structuredClone(record);
    const sent = delivered.outbox.find((entry) => entry.id === intent.id);
    if (sent) Object.assign(sent, { state: "confirmed", confirmedAt: NOW });
    const started = reduceRun(
      delivered,
      {
        kind: "turn-started",
        assignmentId: intent.assignmentId,
        agentId: intent.recipient,
        turnId: "turn-9",
      },
      FACTS,
    );
    if (!started.ok) throw new Error(`turn-started refused: ${JSON.stringify(started.params)}`);
    const parsed = extractProtocolBlock(reply, { expected: kind });
    if (parsed.status !== "block") throw new Error(`parser refused: ${JSON.stringify(parsed)}`);
    const reported = reduceRun(started.next, { kind, block: parsed.block } as never, FACTS);
    if (!reported.ok) return reported;
    // The judge counts as settled, and the task can complete, only once its turn has ended: the
    // host's turn_ended receipt first, then the reducer's own turn-ended.
    const endedEventKey = `${intent.recipient}|turn-9|turn_ended`;
    const observed = reduceRun(
      reported.next,
      {
        kind: "observation-recorded",
        receipt: {
          eventKey: endedEventKey,
          kind: "turn_ended",
          agentId: intent.recipient,
          turnId: "turn-9",
          seq: 0,
          receivedAt: NOW,
          dedupeKey: endedEventKey,
          disposition: "accepted",
        },
      },
      FACTS,
    );
    if (!observed.ok) return observed;
    return reduceRun(
      observed.next,
      { kind: "turn-ended", assignmentId: intent.assignmentId, endedEventKey },
      FACTS,
    );
  }

  function reviewReply(text: string, overrides: Record<string, unknown> = {}): string {
    const { messageId: _unused, ...identity } = section(text, "【身份资料 JSON】");
    const delivery = (section(text, "【执行事实 JSON】") as { delivery: { deliveryRef: unknown } })
      .delivery;
    return fence("review-report", {
      ...identity,
      reviewedRef: delivery.deliveryRef,
      verdict: "可合入",
      blockers: [],
      probes: [],
      ...overrides,
    });
  }

  test("a review report written from the prompt is accepted by the parser, reducer and gates", () => {
    const { record, intent } = judged("reviewer");
    const text = compileDispatch(intent, record) ?? "";
    const result = accept(record, intent, "review-report", reviewReply(text));
    if (!result.ok) throw new Error(`reducer refused: ${JSON.stringify(result.params)}`);
    // L2, no smoke: a passing review completes the task.
    expect(result.next.tasks.find((task) => task.spec.id === "t1")?.state).toBe("done");
  });

  test("a verdict that is not a pass sends the delivery back instead of completing it", () => {
    const { record, intent } = judged("reviewer");
    const text = compileDispatch(intent, record) ?? "";
    const result = accept(
      record,
      intent,
      "review-report",
      reviewReply(text, {
        verdict: "修改后合入",
        blockers: [{ id: "b1", summary: "off by one", path: "src/t1.ts" }],
      }),
    );
    if (!result.ok) throw new Error(`reducer refused: ${JSON.stringify(result.params)}`);
    expect(result.next.tasks.find((task) => task.spec.id === "t1")?.state).not.toBe("done");
  });

  test("a review of some other commit is not accepted as a review of the delivery", () => {
    const { record, intent } = judged("reviewer");
    const text = compileDispatch(intent, record) ?? "";
    const other = { kind: "git-commit", value: "3".repeat(40) };
    const result = accept(
      record,
      intent,
      "review-report",
      reviewReply(text, { reviewedRef: other }),
    );
    expect(result.ok).toBe(false);
  });

  test("a smoke report written from the prompt completes the task", () => {
    const { record, intent, evidenceDir } = judged("smoker", { reviewed: true });
    const text = compileDispatch(intent, record) ?? "";
    const { messageId: _unused, ...identity } = section(text, "【身份资料 JSON】");
    const facts = section(text, "【执行事实 JSON】") as {
      delivery: { deliveryRef: unknown };
      devTarget: { devHost: string; devServerId: string; devHome: string };
    };
    const reply = fence("smoke-report", {
      ...identity,
      testedRef: facts.delivery.deliveryRef,
      ...facts.devTarget,
      checks: [{ id: "health", result: "pass", evidencePath: `${evidenceDir}/health.log` }],
    });
    const result = accept(record, intent, "smoke-report", reply);
    if (!result.ok) throw new Error(`reducer refused: ${JSON.stringify(result.params)}`);
    expect(result.next.tasks.find((task) => task.spec.id === "t1")?.state).toBe("done");
  });

  test("a smoke that skips the checklist is not accepted", () => {
    const { record, intent, evidenceDir } = judged("smoker", { reviewed: true });
    const text = compileDispatch(intent, record) ?? "";
    const { messageId: _unused, ...identity } = section(text, "【身份资料 JSON】");
    const facts = section(text, "【执行事实 JSON】") as {
      delivery: { deliveryRef: unknown };
      devTarget: Record<string, string>;
    };
    const reply = fence("smoke-report", {
      ...identity,
      testedRef: facts.delivery.deliveryRef,
      ...facts.devTarget,
      checks: [{ id: "something-else", result: "pass", evidencePath: `${evidenceDir}/x.log` }],
    });
    expect(accept(record, intent, "smoke-report", reply).ok).toBe(false);
  });
});

describe("template versions are frozen", () => {
  // Any change to a rendered byte must be a new version. These hashes pin every registered version
  // of the judges' prompts for a fixed ledger; a failure here means "add a version", not "update
  // the hash". Older versions stay registered for intents that were committed with them.
  test("reviewer v1, v2, v3 and smoker v1, v2 render exactly these bytes", () => {
    const render = (purpose: "reviewer" | "smoker", version: number) => {
      const { record, intent } = judged(
        purpose,
        { reviewed: purpose === "smoker" },
        undefined,
        version,
      );
      return sha256(compileDispatch(intent, record) ?? "");
    };
    expect(REVIEWER_TEMPLATE_VERSION).toBe(3);
    expect(SMOKER_TEMPLATE_VERSION).toBe(2);
    expect(render("reviewer", 1)).toBe(
      "6a44d5f3700d3761605ae928a86c9ea8789145e4f7f0d68c99c8098410d16fa5",
    );
    expect(render("reviewer", 2)).toBe(
      "b7441ee543d1e00ac2a7073589ca50f4f99ff0829564e75e07fdb9a5cbea0b27",
    );
    expect(render("reviewer", 3)).toBe(
      "f0ce40250a4d4cf72f139fd411028cbc345c86aa82ad21be9ce211b41203262b",
    );
    expect(render("smoker", 1)).toBe(
      "8818d5bb22b565bbed86c5dbc88944c80ce6f110f71ad3c589e08658612e7425",
    );
    expect(render("smoker", 2)).toBe(
      "a78ce1560f255ef02195fa2b67f6cba0cbf0debb116c603de4eef2112a46c761",
    );
  });
});
