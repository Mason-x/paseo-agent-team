import { describe, expect, test } from "vitest";
import { extractProtocolBlock } from "../../server/run-engine/protocol";
import { checkDag } from "../../shared/domain/run-engine/dag-admission";
import {
  compilePlanRepair,
  compilePlanRequest,
  PLAN_REQUEST_VERSION,
} from "../../shared/domain/run-engine/engine-prompts";
import { RunTaskDagBlockSchema } from "../../shared/schemas/run-engine/protocol";
import { REPO_ID } from "../fixtures/run-engine/base";
import { COORDINATOR_AGENT } from "./support/bootstrap-run";
import { NONCE, prepared, repaired, section, sha256 } from "./support/plan-fixtures";

/**
 * Failure mode this file guards (DEV, claude haiku coordinator, 2026-11-07): the strict `task-dag`
 * schema refused a whole plan because no task had a `group`; the text had mentioned `group` only
 * inside the line "title；goal；group", the model read it as optional, and the Run stopped waiting
 * for a DAG with no way forward. The producer and reviewer templates had the same fault and got the
 * same fix: the key lists here come from the schema, not from this file.
 *  1. the plan request (current version) and its re-send each say, object by object,
 *     "缺一不可：<exactly the required keys>";
 *  2. a plan made of exactly those keys, with values taken from the request's own data sections,
 *     passes the parser and the admission checks, so the text is enough to write an admissible plan;
 *  3. removing any one of those keys makes the parser refuse the plan at that key, so the sentence
 *     in the text is true.
 * A new required key in the schema fails 1 and 2 until the text and this writer both know it.
 */

type Field = { safeParse(value: unknown): { success: boolean } };
type ObjectSchema = { shape: Record<string, Field> };

/** Keys an object must carry, in schema order: the ones that do not accept `undefined`. */
function required(schema: ObjectSchema): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);
}
const elementOf = (schema: ObjectSchema, key: string) =>
  (schema.shape[key] as unknown as { element: ObjectSchema }).element;

const DAG = RunTaskDagBlockSchema as unknown as ObjectSchema;
const TASK = elementOf(DAG, "tasks");
const SCOPE = elementOf(TASK, "scopes");
const EVIDENCE = elementOf(TASK, "evidence");
const DUTIES = TASK.shape.dispatchDuties as unknown as ObjectSchema;

/** "缺一不可：a、b、c" with nothing but a separator after the last key. */
function listsExactly(text: string, keys: string[]): boolean {
  return new RegExp(`缺一不可：${keys.join("、")}(?![、\\w])`, "u").test(text);
}

function planText(templateVersion = PLAN_REQUEST_VERSION): string {
  const { record, intent } = prepared({ templateVersion });
  const text = compilePlanRequest(intent, record);
  if (text === null) throw new Error("the fixture's plan request cannot be rebuilt");
  return text;
}

describe("the plan request names every key the strict schema requires", () => {
  test("the shape of the schema this file is written against", () => {
    // If one of these moves, the lists below were derived from something else than intended.
    expect(required(DAG)).toHaveLength(10);
    expect(required(TASK)).toHaveLength(18);
    expect(required(SCOPE)).toEqual(["repoId", "kind", "path", "access"]);
    expect(required(EVIDENCE)).toEqual(["id", "command", "artifactKind", "requiresIsolatedHome"]);
    expect(required(DUTIES)).toEqual(["produce", "review", "smoke"]);
  });

  test("the current version lists the keys of the block, a task, a scope, an evidence item and the duties", () => {
    const text = planText();
    expect(listsExactly(text, required(DAG))).toBe(true);
    expect(listsExactly(text, required(TASK))).toBe(true);
    expect(listsExactly(text, required(SCOPE))).toBe(true);
    expect(listsExactly(text, required(EVIDENCE))).toBe(true);
    expect(listsExactly(text, required(DUTIES))).toBe(true);
  });

  test("the re-send lists them again, because the plan that failed is the one it asks for", () => {
    const { record, wake } = repaired();
    const text = compilePlanRepair(wake, record) ?? "";
    expect(text).not.toBe("");
    expect(listsExactly(text, required(DAG))).toBe(true);
    expect(listsExactly(text, required(TASK))).toBe(true);
    expect(listsExactly(text, required(SCOPE))).toBe(true);
    expect(listsExactly(text, required(EVIDENCE))).toBe(true);
    expect(listsExactly(text, required(DUTIES))).toBe(true);
  });

  test("the frozen versions are left as they were: version 2 never made the claim", () => {
    expect(planText(2)).not.toContain("缺一不可");
    expect(planText(1)).not.toContain("缺一不可");
  });
});

// --- the writer the text describes: required keys only, values from the request's own data ----------

function pick(keys: string[], values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((key) => {
      if (!(key in values)) {
        throw new Error(`this test's writer does not know the required key ${key}`);
      }
      return [key, values[key]];
    }),
  );
}

type RosterSeat = { tier: string; enabled: boolean; agentKey: string | null; duties: string[] };

/** The plan the request asks for, read off its own sections; nothing but required keys. */
function planFrom(text: string): Record<string, unknown> {
  const identity = section(text, "【控制身份 JSON】") as Record<string, unknown>;
  const facts = section(text, "【规划事实 JSON】") as { repoAlias: string };
  const roster = section(text, "【花名册 JSON】") as RosterSeat[];
  const dutyOf = (tier: string) =>
    roster.find((seat) => seat.enabled && seat.agentKey !== null && seat.tier === tier)
      ?.duties[0] ?? "";
  const task = (id: string, deps: string[]) =>
    pick(required(TASK), {
      id,
      title: `Implement ${id}`,
      goal: `Deliver ${id} within the declared scope.`,
      group: "core",
      deps,
      level: "L2",
      tier: "B",
      execution: "write",
      scopes: [
        pick(required(SCOPE), {
          repoId: facts.repoAlias,
          kind: "file",
          path: `src/${id}.ts`,
          access: "write",
        }),
      ],
      acceptance: ["The change is observable."],
      evidence: [
        pick(required(EVIDENCE), {
          id: "check",
          command: "npm test",
          artifactKind: "command-output",
          requiresIsolatedHome: false,
        }),
      ],
      devSmoke: false,
      smokeChecklist: [],
      irreversible: null,
      reviewPolicy: "required",
      implementationPolicy: "default",
      architectureTaskId: null,
      dispatchDuties: pick(required(DUTIES), {
        produce: dutyOf("B"),
        review: dutyOf("A"),
        smoke: null,
      }),
    });
  return pick(required(DAG), {
    ...identity,
    tasks: [task("t1", []), task("t2", ["t1"])],
    cancelTaskIds: [],
    budgetRequests: [],
  });
}

const fence = (body: unknown) => `Plan.\n\`\`\`task-dag\n${JSON.stringify(body)}\n\`\`\`\n`;

function admit(reply: string) {
  const { record } = prepared();
  const parsed = extractProtocolBlock(reply, { expected: "task-dag" });
  if (parsed.status !== "block") return { parsed } as const;
  return {
    parsed,
    checked: checkDag(record, parsed.block as never, {
      agentId: COORDINATOR_AGENT,
      canonicalRepoId: REPO_ID,
      nonceDigest: sha256(NONCE),
      seatFamilies: new Map(),
    }),
  } as const;
}

describe("a plan made of the required keys alone", () => {
  test("is read by the parser and admitted by the checks", () => {
    const result = admit(fence(planFrom(planText())));
    expect(result.parsed.status).toBe("block");
    expect(result.checked).toMatchObject({ ok: true });
  });

  test("is also what the re-send asks for: the same identity, the same keys", () => {
    const { record, wake } = repaired();
    const text = compilePlanRepair(wake, record) ?? "";
    expect(section(text, "【控制身份 JSON】")).toEqual(section(planText(), "【控制身份 JSON】"));
    const result = admit(fence(planFrom(planText())));
    expect(result.checked).toMatchObject({ ok: true });
  });
});

describe("every key the text calls 缺一不可 is one the strict parser really refuses to lose", () => {
  type Case = { name: string; at: (string | number)[]; keys: string[] };
  const CASES: Case[] = [
    { name: "block", at: [], keys: required(DAG) },
    { name: "task", at: ["tasks", 0], keys: required(TASK) },
    { name: "scope", at: ["tasks", 0, "scopes", 0], keys: required(SCOPE) },
    { name: "evidence item", at: ["tasks", 0, "evidence", 0], keys: required(EVIDENCE) },
    { name: "dispatchDuties", at: ["tasks", 0, "dispatchDuties"], keys: required(DUTIES) },
  ];

  test("dropping any one of them is a schema-invalid plan, named at that key", () => {
    for (const item of CASES) {
      for (const key of item.keys) {
        const copy = structuredClone(planFrom(planText()));
        const holder = item.at.reduce<Record<string, unknown>>(
          (node, step) => (node as never)[step],
          copy,
        );
        delete holder[key];
        const result = extractProtocolBlock(fence(copy), { expected: "task-dag" });
        expect(result.status, `${item.name} without ${key}`).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBe("schema-invalid");
          expect(
            result.issues?.map((issue) => issue.path),
            `${item.name} without ${key}`,
          ).toContain([...item.at, key].join("."));
        }
      }
    }
  });

  test("the DEV failure: no task has a group", () => {
    const plan = planFrom(planText());
    for (const task of plan.tasks as Record<string, unknown>[]) delete task.group;
    const result = extractProtocolBlock(fence(plan), { expected: "task-dag" });
    expect(result).toMatchObject({ status: "rejected", reason: "schema-invalid" });
    expect(JSON.stringify(result)).toContain("tasks.0.group");
  });
});
