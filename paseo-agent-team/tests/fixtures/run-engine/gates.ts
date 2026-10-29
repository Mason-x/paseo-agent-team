// Inputs for the three gates (evidence / independent review / DEV smoke). Each ledger stops its
// task one step before or at the gate; the expected verdict belongs to the R03/R05 cases.
import {
  ASSIGNMENT_T2,
  AT_UPDATED,
  assignmentsForRun,
  claim,
  MESSAGE_T2,
  NONCE_T2,
  NORMAL_RUN_LEDGER,
  noncesForRun,
  spec,
  t1,
  t2,
  t3,
  taskRecord,
  withLedger,
} from "./base";
import type { LedgerFixture, RunTaskRecord } from "./types";

/** RE3.2 / Y1: a done report whose evidence failed a gate; must stay in_progress. */
export const EVIDENCE_INCOMPLETE_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-evd",
  revision: 19,
  tasks: [
    t1,
    {
      ...t2,
      state: "in_progress",
      phase: "review",
      evidenceReturns: 1,
    } as RunTaskRecord,
    t3,
  ],
  resources: [claim({ frozen: false })],
  assignments: assignmentsForRun("run-rec0re-evd").map((entry) =>
    entry.assignmentId === ASSIGNMENT_T2
      ? {
          ...entry,
          acceptedProof: {
            protocolVersion: 1,
            runId: "run-rec0re-evd",
            taskId: "t2",
            attempt: 1,
            nonce: NONCE_T2,
            assignmentId: ASSIGNMENT_T2,
            messageId: MESSAGE_T2,
            status: "done" as const,
            changedFiles: ["src/t2.ts"],
            ref: { kind: "git-commit" as const, value: "b7e4d10" },
            workspace: {
              id: "ws-run-rec0re-a1-t2",
              branch: "re-rec0rea1-t2-a1-1",
              baseRef: "main",
            },
            evidence: [
              {
                id: "five-gates",
                command: "npm run check",
                exitCode: 1,
                summary: "biome failed",
                artifactPath: "evidence/check.log",
                ref: { kind: "git-commit" as const, value: "b7e4d10" },
              },
              {
                id: "coverage",
                command: "npm run test:coverage",
                exitCode: 0,
                summary: "coverage captured",
                artifactPath: "evidence/cov.log",
                ref: { kind: "git-commit" as const, value: "b7e4d10" },
              },
            ],
          },
        }
      : entry,
  ),
  nonceRegistry: NORMAL_RUN_LEDGER.nonceRegistry.map((entry) => ({
    ...entry,
    runId: "run-rec0re-evd",
    ...(entry.assignmentId === ASSIGNMENT_T2
      ? { acceptedAt: AT_UPDATED, acceptedEventKey: `proof:${ASSIGNMENT_T2}` }
      : {}),
  })),
});

/** RE3.3 / Y2: the review verdict predates the current ref, so it cannot unlock done. */
export const STALE_REVIEW_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-stl",
  nonceRegistry: noncesForRun("run-rec0re-stl"),
  assignments: assignmentsForRun("run-rec0re-stl"),
  revision: 20,
  tasks: [
    {
      ...t1,
      ref: { kind: "git-commit", value: "c9f5e22" },
      changedFiles: ["src/t1.ts"],
    } as RunTaskRecord,
    t2,
    t3,
  ],
});

const T6_SMOKE_CHECKS = {
  missing: [{ id: "open runs tab", result: "pass" as const, evidencePath: "evidence/smoke-1.png" }],
  ready: [
    { id: "open runs tab", result: "pass" as const, evidencePath: "evidence/smoke-1.png" },
    { id: "start team", result: "pass" as const, evidencePath: "evidence/smoke-2.png" },
  ],
};

function devSmokeLedger(
  runId: string,
  smoke: {
    checklist: string[];
    devHost: string;
    devServerId: string;
    devHome: string;
    checks: { id: string; result: "pass" | "fail"; evidencePath: string }[];
  },
): LedgerFixture {
  const producer = "assignment-t6-a1";
  const reviewer = "assignment-t6-r1";
  const smoker = "assignment-t6-s1";
  const producerNonce = "6f1c2a44-3b7e-4f0a-9a11-000000000011";
  const reviewerNonce = "6f1c2a44-3b7e-4f0a-9a11-000000000012";
  const smokerNonce = "6f1c2a44-3b7e-4f0a-9a11-000000000013";
  const producerMessage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const reviewerMessage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const smokerMessage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const ref = { kind: "git-commit" as const, value: "9f3c1a7" };
  const workspace = { id: "ws-t6-a1", branch: "re-t6-a1", baseRef: "main" };
  const t6 = taskRecord(
    spec("t6", "UI smoke", {
      devSmoke: true,
      smokeChecklist: smoke.checklist,
      tier: "A",
      level: "L3",
      scopes: [{ repoId: "repo-re-verify", kind: "file", path: "ui/runs.tsx", access: "write" }],
    }),
    { state: "in_progress", phase: "smoke", currentAssignmentId: smoker },
  );
  const evidence = [
    {
      id: "five-gates",
      command: "npm run check && npm run typecheck && npm test",
      exitCode: 0,
      summary: "all gates passed",
      artifactPath: "evidence/t6.log",
      ref,
    },
  ];
  const assignmentBase = {
    taskId: "t6",
    seatId: "seat-a-impl",
    agentId: "agent-a-impl",
    profileId: "profile-a-impl",
    profileName: "Profile A impl",
    provider: "test-provider",
    model: "test-model",
    family: "codex",
    channelId: "claude",
    tier: "A" as const,
    reason: "explicit DEV smoke fixture",
    workspace,
    attempt: 1,
    state: "ended" as const,
    createdAt: AT_UPDATED,
    startedAt: AT_UPDATED,
    endedAt: AT_UPDATED,
  };
  return withLedger({
    runId,
    revision: 22,
    lifecycle: "paused",
    tasks: [t1, t6, t3],
    roster: [
      ...NORMAL_RUN_LEDGER.roster,
      {
        seatId: "seat-a-impl",
        tier: "A",
        agentId: "agent-a-impl",
        channelId: "claude",
        duties: ["implement"],
        enabled: true,
      },
      {
        seatId: "seat-a-review",
        tier: "A",
        agentId: "agent-a-review",
        channelId: "claude",
        duties: ["review"],
        enabled: true,
      },
      {
        seatId: "seat-a-smoke",
        tier: "A",
        agentId: "agent-a-smoke",
        channelId: "claude",
        duties: ["smoke"],
        enabled: true,
      },
    ],
    assignments: [
      ...assignmentsForRun(runId),
      {
        ...assignmentBase,
        assignmentId: producer,
        purpose: "member",
        nonce: producerNonce,
        messageId: producerMessage,
        delivery: null,
        acceptedProof: {
          protocolVersion: 1,
          runId,
          taskId: "t6",
          attempt: 1,
          nonce: producerNonce,
          assignmentId: producer,
          messageId: producerMessage,
          status: "done",
          changedFiles: ["ui/runs.tsx"],
          ref,
          workspace,
          evidence,
        },
        turnId: "turn-t6-a",
        endedEventKey: "agent-a-impl|turn-t6-a|turn_ended",
      },
      {
        ...assignmentBase,
        assignmentId: reviewer,
        seatId: "seat-a-review",
        agentId: "agent-a-review",
        profileId: "profile-a-review",
        purpose: "reviewer",
        nonce: reviewerNonce,
        messageId: reviewerMessage,
        delivery: { producerAssignmentId: producer },
        acceptedProof: {
          protocolVersion: 1,
          runId,
          taskId: "t6",
          attempt: 1,
          nonce: reviewerNonce,
          assignmentId: reviewer,
          messageId: reviewerMessage,
          reviewedRef: ref,
          verdict: "可合入",
          blockers: [],
          probes: [],
        },
        turnId: "turn-t6-r",
        endedEventKey: "agent-a-review|turn-t6-r|turn_ended",
      },
      {
        ...assignmentBase,
        assignmentId: smoker,
        seatId: "seat-a-smoke",
        agentId: "agent-a-smoke",
        profileId: "profile-a-smoke",
        purpose: "smoker",
        nonce: smokerNonce,
        messageId: smokerMessage,
        delivery: { producerAssignmentId: producer },
        acceptedProof: {
          protocolVersion: 1,
          runId,
          taskId: "t6",
          attempt: 1,
          nonce: smokerNonce,
          assignmentId: smoker,
          messageId: smokerMessage,
          testedRef: ref,
          devHost: smoke.devHost,
          devServerId: smoke.devServerId,
          devHome: smoke.devHome,
          checks: smoke.checks,
        },
        turnId: "turn-t6-s",
        endedEventKey: "agent-a-smoke|turn-t6-s|turn_ended",
      },
    ],
    outbox: [
      ...NORMAL_RUN_LEDGER.outbox,
      {
        id: "intent-t6-a1",
        kind: "dispatch",
        recipient: "agent-a-impl",
        messageId: producerMessage,
        idempotencyKey: "dispatch-t6-a1",
        payloadHash: "a".repeat(64),
        templateVersion: 1,
        state: "confirmed",
        recoverySendCount: 0,
        createdAt: AT_UPDATED,
        confirmedAt: AT_UPDATED,
        localCancellation: null,
        taskId: "t6",
        assignmentId: producer,
        semanticArgs: { promptBytes: 1 },
      },
      {
        id: "intent-t6-r1",
        kind: "dispatch",
        recipient: "agent-a-review",
        messageId: reviewerMessage,
        idempotencyKey: "dispatch-t6-r1",
        payloadHash: "b".repeat(64),
        templateVersion: 1,
        state: "confirmed",
        recoverySendCount: 0,
        createdAt: AT_UPDATED,
        confirmedAt: AT_UPDATED,
        localCancellation: null,
        taskId: "t6",
        assignmentId: reviewer,
        semanticArgs: { promptBytes: 1 },
      },
      {
        id: "intent-t6-s1",
        kind: "dispatch",
        recipient: "agent-a-smoke",
        messageId: smokerMessage,
        idempotencyKey: "dispatch-t6-s1",
        payloadHash: "c".repeat(64),
        templateVersion: 1,
        state: "confirmed",
        recoverySendCount: 0,
        createdAt: AT_UPDATED,
        confirmedAt: AT_UPDATED,
        localCancellation: null,
        taskId: "t6",
        assignmentId: smoker,
        semanticArgs: { promptBytes: 1 },
      },
    ],
    nonceRegistry: [
      ...noncesForRun(runId),
      ...[
        {
          nonce: producerNonce,
          assignmentId: producer,
          phase: "implementation" as const,
          agentId: "agent-a-impl",
          seatId: "seat-a-impl",
          key: "agent-a-impl|turn-t6-a|turn_ended",
        },
        {
          nonce: reviewerNonce,
          assignmentId: reviewer,
          phase: "review" as const,
          agentId: "agent-a-review",
          seatId: "seat-a-review",
          key: "agent-a-review|turn-t6-r|turn_ended",
        },
        {
          nonce: smokerNonce,
          assignmentId: smoker,
          phase: "smoke" as const,
          agentId: "agent-a-smoke",
          seatId: "seat-a-smoke",
          key: "agent-a-smoke|turn-t6-s|turn_ended",
        },
      ].map((entry) => ({
        nonce: entry.nonce,
        runId,
        taskId: "t6",
        assignmentId: entry.assignmentId,
        attempt: 1,
        phase: entry.phase,
        agentId: entry.agentId,
        seatId: entry.seatId,
        issuedAt: AT_UPDATED,
        acceptedAt: AT_UPDATED,
        acceptedEventKey: `proof:${entry.assignmentId}`,
        revokedAt: null,
        revokeReason: null,
      })),
    ],
    eventReceipts: [
      ...NORMAL_RUN_LEDGER.eventReceipts,
      {
        eventKey: "agent-a-impl|turn-t6-a|turn_ended",
        kind: "turn_ended",
        agentId: "agent-a-impl",
        turnId: "turn-t6-a",
        seq: 9,
        receivedAt: AT_UPDATED,
        dedupeKey: "agent-a-impl|turn-t6-a|turn_ended",
        disposition: "accepted",
      },
      {
        eventKey: "agent-a-review|turn-t6-r|turn_ended",
        kind: "turn_ended",
        agentId: "agent-a-review",
        turnId: "turn-t6-r",
        seq: 10,
        receivedAt: AT_UPDATED,
        dedupeKey: "agent-a-review|turn-t6-r|turn_ended",
        disposition: "accepted",
      },
      {
        eventKey: "agent-a-smoke|turn-t6-s|turn_ended",
        kind: "turn_ended",
        agentId: "agent-a-smoke",
        turnId: "turn-t6-s",
        seq: 11,
        receivedAt: AT_UPDATED,
        dedupeKey: "agent-a-smoke|turn-t6-s|turn_ended",
        disposition: "accepted",
      },
    ],
    counters: { ...NORMAL_RUN_LEDGER.counters, observationSeq: 11, eventsThroughSeq: 7 },
    ...(smoke.devServerId === "dev-server-1"
      ? {
          alerts: [
            {
              alertId: "alert-smoke-ready",
              state: "open",
              severity: "info",
              summary: "Smoke report on the pre-registered DEV target; gate evaluation pending.",
              createdAt: AT_UPDATED,
              acknowledgedAt: null,
              resolvedAt: null,
            },
          ],
        }
      : {}),
  });
}

/** RE3.4 / Y4: devSmoke is pending, the smoke target is the real default daemon alias. */
export const DEV_SMOKE_MISSING_LEDGER: LedgerFixture = devSmokeLedger("run-rec0re-smk", {
  checklist: ["open runs tab", "start team", "observe one run"],
  devHost: "127.0.0.1:6767",
  devServerId: "srv-real-default",
  devHome: "C:/Users/operator/.paseo",
  checks: T6_SMOKE_CHECKS.missing,
});

/** RE3.4 legal edge: a pre-registered DEV target with the full checklist present. */
export const DEV_SMOKE_READY_LEDGER: LedgerFixture = devSmokeLedger("run-rec0re-smr", {
  checklist: ["open runs tab", "start team"],
  devHost: "127.0.0.1:6799",
  devServerId: "dev-server-1",
  devHome: "/tmp/dev-home",
  checks: T6_SMOKE_CHECKS.ready,
});
