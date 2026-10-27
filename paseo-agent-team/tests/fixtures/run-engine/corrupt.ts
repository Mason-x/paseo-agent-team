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

/** RE1.3 / Y15: structurally parseable but missing required top-level or task fields. */
export const CORRUPT_MISSING_FIELDS: readonly {
  id: string;
  value: unknown;
  missing: readonly string[];
}[] = [
  { id: "no-schema-version", value: { runId: "run-rec0re-m1" }, missing: ["schemaVersion"] },
  {
    id: "no-run-id",
    value: { schemaVersion: 1, lifecycle: "active", tasks: [] },
    missing: ["runId"],
  },
  {
    id: "no-tasks",
    value: { schemaVersion: 1, runId: "run-rec0re-m3" },
    missing: ["tasks"],
  },
  {
    id: "task-without-id",
    value: {
      schemaVersion: 1,
      runId: "run-rec0re-m4",
      tasks: [{ status: "pending", title: "orphan" }],
    },
    missing: ["tasks[0].id"],
  },
  {
    id: "task-with-unknown-status",
    value: { schemaVersion: 1, runId: "run-rec0re-m5", tasks: [{ id: "T1", status: "thinking" }] },
    missing: ["tasks[0].status"],
  },
];

/** RE7.1 / Y15: a record that parses but claims a state this version cannot interpret. */
export const UNKNOWN_TASK_STATUS_RECORD: unknown = {
  ...NORMAL_RUN_LEDGER,
  runId: "run-rec0re-sts",
  revision: 5,
  tasks: [{ ...T2, status: "awaiting-human" }],
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
