// Corrupt and boundary inputs for the ledger reader. Nothing here is meant to parse as a record:
// the point is that a reader must preserve the original bytes, project an error, and never treat
// a damaged file as an empty or migrated ledger.
import { NORMAL_RUN_LEDGER, T2 } from "./base";

const TRUNCATED_TEXT =
  '{"schemaVersion":1,"runId":"run-rec0re-tr1","revision":3,"tasks":[{"id":"T1","status":"do';

/** I1 / Y15: byte-level damage. Readers must not surface half a record as valid. */
export const CORRUPT_JSON_TEXTS: readonly { id: string; text: string; damage: string }[] = [
  {
    id: "truncated-mid-object",
    text: TRUNCATED_TEXT,
    damage: "truncated",
  },
  {
    id: "empty-file",
    text: "",
    damage: "empty",
  },
  {
    id: "two-writes-concatenated",
    text: '{"schemaVersion":1,"runId":"run-rec0re-tr2","revision":3}{"schemaVersion":1,"runId":"run-rec0re-tr2","revision":4}',
    damage: "duplicate-root",
  },
  {
    id: "non-utf8-bytes",
    text: '{"schemaVersion":1,"runId":"run-rec0re-tr3","note":"\u0000\u0001\u0002"}',
    damage: "control-bytes",
  },
  {
    id: "trailing-comma",
    text: '{"schemaVersion":1,"runId":"run-rec0re-tr4","tasks":[],}',
    damage: "syntax",
  },
];

/**
 * RE1.3 / Y15: each sample is the valid baseline with exactly one field removed or corrupted, so
 * the rejection has one cause. `missing` is the expected zod issue path (dot notation); the
 * self-check asserts exactly that path and no other.
 */
function without(value: object, key: string): Record<string, unknown> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

const BASELINE_TASKS = NORMAL_RUN_LEDGER.tasks as unknown as Record<string, unknown>[];
const [FIRST_TASK, ...OTHER_TASKS] = BASELINE_TASKS;
const FIRST_SPEC = FIRST_TASK.spec as Record<string, unknown>;

export const CORRUPT_MISSING_FIELDS: readonly {
  id: string;
  value: unknown;
  missing: readonly string[];
}[] = [
  {
    id: "no-schema-version",
    value: without(NORMAL_RUN_LEDGER, "schemaVersion"),
    missing: ["schemaVersion"],
  },
  {
    id: "no-run-id",
    value: without(NORMAL_RUN_LEDGER, "runId"),
    missing: ["runId"],
  },
  {
    id: "no-tasks",
    value: without(NORMAL_RUN_LEDGER, "tasks"),
    missing: ["tasks"],
  },
  {
    id: "task-without-id",
    value: {
      ...NORMAL_RUN_LEDGER,
      tasks: [{ ...FIRST_TASK, spec: without(FIRST_SPEC, "id") }, ...OTHER_TASKS],
    },
    missing: ["tasks.0.spec.id"],
  },
  {
    id: "task-with-unknown-status",
    value: {
      ...NORMAL_RUN_LEDGER,
      tasks: [{ ...FIRST_TASK, state: "thinking" }, ...OTHER_TASKS],
    },
    missing: ["tasks.0.state"],
  },
];

/** RE7.1 / Y15: a record that parses but claims a state this version cannot interpret. */
export const UNKNOWN_TASK_STATUS_RECORD: unknown = {
  ...NORMAL_RUN_LEDGER,
  runId: "run-rec0re-sts",
  revision: 5,
  tasks: [{ ...T2, state: "awaiting-human" }],
};

/** Diagnosis sidecar inputs: a corrupt record and the digest that names its issues file. */
export const CORRUPT_RECORD_WITH_DIGEST = {
  runId: "run-rec0re-dmg",
  digest: `sha256:${"d".repeat(64)}`,
  bytes: TRUNCATED_TEXT,
  expectedIssuesPath: `issues/${"d".repeat(64)}.json`,
  diagnosis: {
    status: "corrupt",
    readable: false,
    preserveOriginalBytes: true,
    autoRepair: false,
  },
} as const;
