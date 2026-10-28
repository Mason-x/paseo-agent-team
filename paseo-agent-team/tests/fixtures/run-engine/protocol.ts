// Protocol-layer inputs for R02: bad fences/blocks, identity mismatches, and the observation edges
// (deprecated timeline, scan budget). Strings are payloads, not fixtures that need to parse.
import type { RunArtifactRef } from "./types";

const fence = (kind: string, body: string) => `\`\`\`${kind}\n${body}\n\`\`\``;

const artifact: RunArtifactRef = { kind: "git-commit", value: "b7e4d10" };

const reportEvidence = {
  id: "five-gates",
  command: "npm run check && npm test",
  exitCode: 0,
  summary: "check and tests passed",
  artifactPath: "evidence/five-gates.log",
  ref: artifact,
};

const validReport = JSON.stringify({
  protocolVersion: 1,
  runId: "run-rec0re-prt",
  taskId: "t2",
  assignmentId: "assignment-t2-a1",
  attempt: 1,
  nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000002",
  status: "done",
  changedFiles: ["src/t2.ts"],
  ref: artifact,
  workspace: { id: "ws-t2", branch: "re-t2-a1", baseRef: "main" },
  evidence: [reportEvidence],
});

/**
 * AC-RE2.3: a `done` report needs at least one evidence entry. This is schema-invalid (protocol
 * failure), not a gate decision, so the self-check counts it with the illegal samples.
 */
export const EMPTY_EVIDENCE_REPORT: Record<string, unknown> = {
  ...(JSON.parse(validReport) as Record<string, unknown>),
  evidence: [],
};

/** RE2.3 / RE2.8 / Y5: one defect per sample; each must reject or be treated as data only. */
export const PROTOCOL_BLOCK_CASES: readonly { id: string; raw: string; defect: string }[] = [
  { id: "missing-block", raw: "Implemented T2. All tests pass.", defect: "no-fenced-block" },
  {
    id: "two-task-reports",
    raw: `${fence("task-report", validReport)}\n${fence("task-report", validReport)}`,
    defect: "two-blocks",
  },
  {
    id: "mixed-kinds",
    raw: `${fence("task-report", validReport)}\n${fence("review-report", "{}")}`,
    defect: "mixed-kinds",
  },
  {
    id: "non-json-body",
    raw: fence("task-report", "status=done; evidence=all"),
    defect: "non-json",
  },
  {
    id: "unknown-version",
    raw: fence("task-report", validReport.replace('"protocolVersion":1', '"protocolVersion":2')),
    defect: "unknown-version",
  },
  {
    id: "escaped-fence-inside-string",
    raw: fence(
      "task-report",
      JSON.stringify({
        ...JSON.parse(validReport),
        evidence: [{ ...reportEvidence, summary: "```task-dag``` is data here" }],
      }),
    ),
    defect: "nested-fence-is-data",
  },
  {
    id: "oversized-block",
    raw: fence("task-report", "x".repeat(32 * 1024 + 1)),
    defect: "over-32kib",
  },
  {
    id: "missing-evidence",
    raw: fence("task-report", JSON.stringify(EMPTY_EVIDENCE_REPORT)),
    defect: "empty-evidence-is-invalid",
  },
];

/**
 * RE2.2 / RE2.5 / Y6: a report whose assignment/nonce do not belong to the dispatched assignment.
 * R01 `ReportIdentityShape` has no reporter field, so "who reported" is not expressible in the
 * schema at all: this sample is deliberately schema-valid and is rejected later by ownership
 * checks (R05/R06), exactly like the oversized ledger is accepted by schema and rejected by the
 * store (R05). Do not add extra keys just to force a schema rejection.
 */
export const NON_ASSIGNEE_REPORT: Record<string, unknown> = {
  ...(JSON.parse(validReport) as Record<string, unknown>),
  assignmentId: "assignment-t2-a2",
  nonce: "6f1c2a44-3b7e-4f0a-9a11-00000000b2b2",
};

export const PROTOCOL_IDENTITY_CASES: readonly {
  id: string;
  report: Record<string, unknown>;
  defect: string;
}[] = [
  {
    id: "wrong-task",
    report: { ...JSON.parse(validReport), taskId: "t1" },
    defect: "taskId-mismatch",
  },
  {
    id: "wrong-attempt",
    report: { ...JSON.parse(validReport), attempt: 2 },
    defect: "attempt-mismatch",
  },
  {
    id: "unknown-nonce",
    report: { ...JSON.parse(validReport), nonce: "6f1c2a44-3b7e-4f0a-9a11-00000000dead" },
    defect: "nonce-not-issued",
  },
  {
    id: "reused-nonce",
    report: {
      ...JSON.parse(validReport),
      nonce: "6f1c2a44-3b7e-4f0a-9a11-000000000001",
    },
    defect: "nonce-already-consumed",
  },
  {
    id: "non-assignee",
    report: NON_ASSIGNEE_REPORT,
    defect: "reporter-not-assignee",
  },
];

/** RE2.4 / Y16: `turn_ended.timeline` is deprecated and empty; the refetch window is the truth. */
export const DEPRECATED_TIMELINE_CASE = {
  turnEnded: {
    agentId: "agent-b1",
    turnId: "turn-7",
    timeline: [],
    timelineDeprecated: true,
  },
  refetch: {
    dispatchMessageId: "22222222-2222-4222-8222-222222222222",
    assistantMessageIds: ["asst-7-1", "asst-7-2"],
    turnId: "turn-7",
    epoch: 3,
    pages: [
      { index: 0, bytes: 48_000, complete: true },
      { index: 1, bytes: 12_000, complete: true },
    ],
  },
} as const;

/** RE2.9 / Y5: over the whole-reply scan budget; must be "unverifiable", never "empty output". */
export const SCAN_BUDGET_CASE = {
  totalReplyBytes: 256 * 1024 + 1,
  timeline: { pageBytes: 512 * 1024, pages: 21, maxPages: 20 },
  missingPage: { requested: 4, received: null },
} as const;

/** The same block replayed with a different message id: dedupe is by report identity, not by text. */
export const PROTOCOL_REPLAY_CASE = {
  report: JSON.parse(validReport) as Record<string, unknown>,
  deliveries: [
    { messageId: "msg-delivery-1", at: "2026-10-27T12:30:00.000Z" },
    { messageId: "msg-delivery-1", at: "2026-10-27T12:30:03.000Z" },
    { messageId: "msg-delivery-2", at: "2026-10-27T12:31:00.000Z" },
  ],
} as const;

/** A review verdict tied to the exact artifact the smoke/review gate compares against. */
export const REVIEWED_REF: RunArtifactRef = { kind: "git-commit", value: "b7e4d10" };
