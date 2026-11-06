import { describe, expect, test } from "vitest";
import { extractProtocolBlock } from "../../server/run-engine/protocol";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  RunReviewReportBlockSchema,
  RunSmokeReportBlockSchema,
  RunTaskReportBlockSchema,
} from "../../shared/schemas/run-engine/protocol";
import {
  type Dispatched,
  judgeDispatch,
  producerDispatch,
  reworkDispatch,
  section,
} from "./support/dispatch-fixtures";
import { recordReply } from "./support/judge-flow";

/**
 * Failure mode this file guards (DEV, 2026-11-06): a strict schema refuses a whole report for one
 * missing key, and nothing repairs it yet. A producer (haiku) left `ref` out of an evidence entry
 * because the version 1 text read as if `ref` were optional; the earlier round trips passed because
 * their reports were written by someone who already knew the schema.
 *
 * So the key lists here come from the schemas, not from this file:
 *  1. each current prompt must say, object by object, "缺一不可：<exactly the required keys>";
 *  2. a report built from exactly those keys (plus the keys the task data makes conditional) must
 *     pass the parser, the reducer and the gates;
 *  3. removing any one of those keys must make the parser refuse the report, so the sentence in the
 *     prompt is true.
 * A new required key in a schema fails 1 and 2 until the prompt and this writer both know it.
 */

type Field = { safeParse(value: unknown): { success: boolean } };
type ObjectSchema = { shape: Record<string, Field> };

const ENVELOPE = [
  "protocolVersion",
  "runId",
  "taskId",
  "attempt",
  "nonce",
  "assignmentId",
  "messageId",
  "status",
];
/** Keys a report object must carry, in schema order. `skip` drops the identity envelope by default. */
function required(schema: ObjectSchema, skip: readonly string[] = []): string[] {
  return Object.entries(schema.shape)
    .filter(([key, field]) => !skip.includes(key) && !field.safeParse(undefined).success)
    .map(([key]) => key);
}
const elementOf = (schema: ObjectSchema, key: string) =>
  (schema.shape[key] as unknown as { element: ObjectSchema }).element;

const [DONE, NOT_DONE] = (RunTaskReportBlockSchema as unknown as { options: ObjectSchema[] })
  .options as [ObjectSchema, ObjectSchema];
const EVIDENCE = elementOf(DONE, "evidence");
const WORKSPACE = DONE.shape.workspace as unknown as ObjectSchema;
const REVIEW = RunReviewReportBlockSchema as unknown as ObjectSchema;
const BLOCKER = elementOf(REVIEW, "blockers");
const PROBE = elementOf(REVIEW, "probes");
const SMOKE = RunSmokeReportBlockSchema as unknown as ObjectSchema;
const CHECK = elementOf(SMOKE, "checks");

/** "缺一不可：a、b、c" with nothing but a separator after the last key. */
function listsExactly(text: string, keys: string[]): boolean {
  return new RegExp(`缺一不可：${keys.join("、")}(?![、\\w])`, "u").test(text);
}

function textOf(dispatched: Dispatched): string {
  const text = compileDispatch(dispatched.intent, dispatched.record);
  if (text === null) throw new Error("the fixture's prompt cannot be rebuilt");
  return text;
}

describe("the prompts name every key the strict schema requires", () => {
  test("producer and rework: the three task-report shapes, evidence entries and workspace", () => {
    for (const dispatched of [producerDispatch(), reworkDispatch()]) {
      const text = textOf(dispatched);
      expect(listsExactly(text, required(DONE, ENVELOPE))).toBe(true);
      expect(listsExactly(text, required(NOT_DONE, ENVELOPE))).toBe(true);
      expect(listsExactly(text, required(EVIDENCE))).toBe(true);
      expect(listsExactly(text, required(WORKSPACE))).toBe(true);
    }
  });

  test("reviewer: the report, its blockers and its probes", () => {
    const text = textOf(judgeDispatch("reviewer"));
    expect(listsExactly(text, required(REVIEW, ENVELOPE))).toBe(true);
    expect(listsExactly(text, required(BLOCKER))).toBe(true);
    expect(listsExactly(text, required(PROBE))).toBe(true);
  });

  test("smoker: the report and its checks", () => {
    const text = textOf(judgeDispatch("smoker"));
    expect(listsExactly(text, required(SMOKE, ENVELOPE))).toBe(true);
    expect(listsExactly(text, required(CHECK))).toBe(true);
  });
});

// --- the writer the prompts describe: required keys only, values from the dispatch --------------

const fence = (kind: string, body: unknown) =>
  `Done.\n\`\`\`${kind}\n${JSON.stringify(body)}\n\`\`\`\n`;

function pick(keys: string[], values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((key) => {
      if (!(key in values))
        throw new Error(`this test's writer does not know the required key ${key}`);
      return [key, values[key]];
    }),
  );
}

type Requirement = {
  id: string;
  command: string | null;
  requiresIsolatedHome: boolean;
  minLines?: number;
  minFunctions?: number;
};

function evidenceEntry(requirement: Requirement, evidenceDir: string, ref: unknown) {
  const entry = pick(required(EVIDENCE), {
    id: requirement.id,
    command: requirement.command,
    exitCode: 0,
    summary: "passed",
    artifactPath: `${evidenceDir}/${requirement.id}.log`,
    ref,
  });
  // The two keys the prompt makes conditional on the task data.
  if (requirement.requiresIsolatedHome) {
    entry.isolation = { homePath: "C:/work/isolated-home", outsideRealHome: true };
  }
  if (requirement.minLines !== undefined || requirement.minFunctions !== undefined) {
    entry.coverage = { lines: 100, functions: 100 };
  }
  return entry;
}

function identityOf(text: string) {
  const { messageId: _unused, ...identity } = section(text, "【身份资料 JSON】");
  return identity;
}

const DELIVERED = { kind: "git-commit", value: "a".repeat(40) };

function doneReport(dispatched: Dispatched, changedFiles: string[]) {
  const text = textOf(dispatched);
  const facts = section(text, "【执行事实 JSON】") as { workspace: unknown; evidenceDir: string };
  const task = section(text, "【任务资料 JSON】") as { evidence: Requirement[] };
  return {
    ...identityOf(text),
    status: "done",
    ...pick(required(DONE, ENVELOPE), {
      changedFiles,
      ref: DELIVERED,
      workspace: facts.workspace,
      evidence: task.evidence.map((item) => evidenceEntry(item, facts.evidenceDir, DELIVERED)),
    }),
  };
}

function notDoneReport(dispatched: Dispatched, status: "blocked" | "failed") {
  return {
    ...identityOf(textOf(dispatched)),
    status,
    ...pick(required(NOT_DONE, ENVELOPE), {
      reasonCode: status === "blocked" ? "COMMIT_UNAVAILABLE" : "TEST_FAILED",
      summary: "ran the required command, exit code 0; git commit failed: no committer identity",
      evidence: [],
    }),
  };
}

function reviewReport(dispatched: Dispatched, verdict: string, withBlocker: boolean) {
  const text = textOf(dispatched);
  const facts = section(text, "【执行事实 JSON】") as {
    delivery: { deliveryRef: unknown };
    evidenceDir: string;
  };
  const ref = facts.delivery.deliveryRef;
  return {
    ...identityOf(text),
    ...pick(required(REVIEW, ENVELOPE), {
      reviewedRef: ref,
      verdict,
      blockers: withBlocker
        ? [pick(required(BLOCKER), { id: "b1", summary: "the parser is off by one", path: null })]
        : [],
      probes: [
        pick(required(PROBE), {
          id: "diff-check",
          command: "git diff --name-only --no-renames A B",
          exitCode: 0,
          summary: "the changed files equal the claim",
          artifactPath: `${facts.evidenceDir}/diff-check.log`,
          ref,
        }),
      ],
    }),
  };
}

function smokeReport(dispatched: Dispatched) {
  const text = textOf(dispatched);
  const facts = section(text, "【执行事实 JSON】") as {
    delivery: { deliveryRef: unknown };
    devTarget: Record<string, string>;
    evidenceDir: string;
  };
  const task = section(text, "【任务资料 JSON】") as { smokeChecklist: string[] };
  return {
    ...identityOf(text),
    ...pick(required(SMOKE, ENVELOPE), {
      testedRef: facts.delivery.deliveryRef,
      devHost: facts.devTarget.devHost,
      devServerId: facts.devTarget.devServerId,
      devHome: facts.devTarget.devHome,
      checks: task.smokeChecklist.map((id) =>
        pick(required(CHECK), {
          id,
          result: "pass",
          evidencePath: `${facts.evidenceDir}/${id}.log`,
        }),
      ),
    }),
  };
}

/** Parses the way the observer does, then lets the reducer and the gates judge it. */
function accept(
  dispatched: Dispatched,
  kind: "task-report" | "review-report" | "smoke-report",
  report: unknown,
): RunRecord {
  const parsed = extractProtocolBlock(fence(kind, report), { expected: kind });
  if (parsed.status !== "block") throw new Error(`parser refused: ${JSON.stringify(parsed)}`);
  return recordReply(
    dispatched.record,
    dispatched.assignmentId,
    kind,
    () => parsed.block as unknown as Record<string, unknown>,
  );
}
const stateOf = (record: RunRecord, taskId: string) =>
  record.tasks.find((task) => task.spec.id === taskId);

describe("a report made of the required keys alone passes the parser, the reducer and the gates", () => {
  test("producer, first attempt: done with an isolated-home evidence entry", () => {
    const dispatched = producerDispatch();
    const after = accept(dispatched, "task-report", doneReport(dispatched, ["src/t2.ts"]));
    expect(stateOf(after, "t2")).toMatchObject({ state: "review", evidenceReturns: 0 });
  });

  test("producer: coverage is required exactly when the task data asks for a minimum", () => {
    const dispatched = producerDispatch({
      mutate: (record) => {
        const t2 = record.tasks.find((task) => task.spec.id === "t2");
        const requirement = t2?.spec.evidence[0];
        if (requirement) {
          Object.assign(requirement, {
            requiresIsolatedHome: false,
            minLines: 80,
            minFunctions: 70,
          });
        }
      },
    });
    const after = accept(dispatched, "task-report", doneReport(dispatched, ["src/t2.ts"]));
    expect(stateOf(after, "t2")).toMatchObject({ state: "review", evidenceReturns: 0 });
  });

  test("rework: the new commit's report, with every entry carrying that commit's ref", () => {
    const dispatched = reworkDispatch();
    const after = accept(dispatched, "task-report", doneReport(dispatched, ["src/t1.ts"]));
    expect(stateOf(after, "t1")).toMatchObject({ state: "review", attempts: 2 });
  });

  test("producer: blocked and failed carry an empty evidence array, and an entry there has no ref to carry", () => {
    const dispatched = producerDispatch();
    for (const status of ["blocked", "failed"] as const) {
      const after = accept(dispatched, "task-report", notDoneReport(dispatched, status));
      expect(stateOf(after, "t2")?.state).toBe(status);
    }
    const entry = pick(required(EVIDENCE), {
      id: "five-gates",
      command: null,
      exitCode: 0,
      summary: "ran before the commit failed",
      artifactPath: `${dispatched.evidenceDir}/five-gates.log`,
      ref: DELIVERED,
    });
    const { ref: _ref, ...withoutRef } = entry;
    const refused = extractProtocolBlock(
      fence("task-report", { ...notDoneReport(dispatched, "blocked"), evidence: [withoutRef] }),
      { expected: "task-report" },
    );
    expect(refused).toMatchObject({ status: "rejected", reason: "schema-invalid" });
  });

  test("reviewer: a probe with its own ref, and a blocker whose path is null", () => {
    const pass = judgeDispatch("reviewer");
    expect(
      stateOf(accept(pass, "review-report", reviewReport(pass, "可合入", false)), "t1")?.state,
    ).toBe("done");
    const sendBack = judgeDispatch("reviewer");
    const after = accept(sendBack, "review-report", reviewReport(sendBack, "修改后合入", true));
    expect(stateOf(after, "t1")?.state).not.toBe("done");
  });

  test("smoker: one check per checklist id", () => {
    const dispatched = judgeDispatch("smoker");
    const after = accept(dispatched, "smoke-report", smokeReport(dispatched));
    expect(stateOf(after, "t1")?.state).toBe("done");
  });
});

describe("every key the prompts call 缺一不可 is one the strict parser really refuses to lose", () => {
  type Case = {
    name: string;
    kind: "task-report" | "review-report" | "smoke-report";
    report: Record<string, unknown>;
    /** Where the object sits inside the report. */
    at: (string | number)[];
    keys: string[];
  };

  function cases(): Case[] {
    const producer = producerDispatch();
    const reviewer = judgeDispatch("reviewer");
    const smoker = judgeDispatch("smoker");
    const done = doneReport(producer, ["src/t2.ts"]);
    const review = reviewReport(reviewer, "修改后合入", true);
    const smoke = smokeReport(smoker);
    return [
      { name: "done", kind: "task-report", report: done, at: [], keys: required(DONE, ENVELOPE) },
      {
        name: "evidence entry",
        kind: "task-report",
        report: done,
        at: ["evidence", 0],
        keys: required(EVIDENCE),
      },
      {
        name: "workspace",
        kind: "task-report",
        report: done,
        at: ["workspace"],
        keys: required(WORKSPACE),
      },
      {
        name: "blocked",
        kind: "task-report",
        report: notDoneReport(producer, "blocked"),
        at: [],
        keys: required(NOT_DONE, ENVELOPE),
      },
      {
        name: "review",
        kind: "review-report",
        report: review,
        at: [],
        keys: required(REVIEW, ENVELOPE),
      },
      {
        name: "blocker",
        kind: "review-report",
        report: review,
        at: ["blockers", 0],
        keys: required(BLOCKER),
      },
      {
        name: "probe",
        kind: "review-report",
        report: review,
        at: ["probes", 0],
        keys: required(PROBE),
      },
      {
        name: "smoke",
        kind: "smoke-report",
        report: smoke,
        at: [],
        keys: required(SMOKE, ENVELOPE),
      },
      {
        name: "check",
        kind: "smoke-report",
        report: smoke,
        at: ["checks", 0],
        keys: required(CHECK),
      },
    ];
  }

  test("dropping any one of them is a schema-invalid report", () => {
    for (const item of cases()) {
      for (const key of item.keys) {
        const copy = structuredClone(item.report);
        const holder = item.at.reduce<Record<string, unknown>>(
          (node, step) => (node as never)[step],
          copy,
        );
        delete holder[key];
        const result = extractProtocolBlock(fence(item.kind, copy), { expected: item.kind });
        expect(result.status, `${item.name} without ${key}`).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBe("schema-invalid");
          expect(result.issues?.[0]?.path, `${item.name} without ${key}`).toBe(
            [...item.at, key].join("."),
          );
        }
      }
    }
  });
});
