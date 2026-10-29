// Inputs for the three gates (evidence / independent review / DEV smoke). Each ledger stops its
// task one step before or at the gate; the expected verdict belongs to the R03/R05 cases.
import { AT_UPDATED, claim, PROFILE_HAIKU, spec, t1, t2, t3, taskRecord, withLedger } from "./base";
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
      report: {
        status: "done",
        changedFiles: ["src/t2.ts"],
        ref: { kind: "git-commit", value: "b7e4d10" },
        evidence: [
          {
            id: "five-gates",
            command: "npm run check",
            exitCode: 1,
            summary: "biome failed",
            artifactPath: "evidence/check.log",
          },
          {
            id: "coverage",
            command: "npm run test:coverage",
            exitCode: 0,
            summary: "coverage captured",
            artifactPath: "evidence/cov.log",
          },
        ],
      },
    } as RunTaskRecord,
    t3,
  ],
  resources: [claim({ frozen: false })],
});

/** RE3.3 / Y2: the review verdict predates the current ref, so it cannot unlock done. */
export const STALE_REVIEW_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-stl",
  revision: 20,
  tasks: [
    {
      ...t1,
      ref: { kind: "git-commit", value: "c9f5e22" },
      changedFiles: ["src/t1.ts"],
      reviews: [
        {
          reviewerAgentId: "agent-b2",
          reviewerSeatId: "seat-b2",
          verdict: "可合入",
          reviewedRef: { kind: "git-commit", value: "9f3c1a7" },
          blockers: [],
        },
      ],
    } as RunTaskRecord,
    t2,
    t3,
  ],
});

/** RE3.4 / Y4: devSmoke is pending, the smoke target is the real default daemon alias. */
export const DEV_SMOKE_MISSING_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-smk",
  revision: 21,
  tasks: [
    t1,
    taskRecord(
      spec("t6", "UI smoke", {
        devSmoke: true,
        smokeChecklist: ["open runs tab", "start team", "observe one run"],
        tier: "A",
        level: "L3",
        scopes: [{ repoId: "repo-re-verify", kind: "file", path: "ui/runs.tsx", access: "write" }],
      }),
      {
        state: "in_progress",
        phase: "smoke",
        smokeReport: {
          testedRef: { kind: "git-commit", value: "9f3c1a7" },
          devHost: "127.0.0.1:6767",
          devServerId: "srv-real-default",
          devHome: "C:/Users/operator/.paseo",
          checks: [{ id: "open runs tab", result: "pass", evidencePath: "evidence/smoke-1.png" }],
        },
      },
    ),
    t3,
  ],
});

/** RE3.4 legal edge: a pre-registered DEV target with the full checklist present. */
export const DEV_SMOKE_READY_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-smr",
  revision: 22,
  tasks: [
    t1,
    taskRecord(
      spec("t6", "UI smoke", {
        devSmoke: true,
        smokeChecklist: ["open runs tab", "start team"],
        tier: "A",
        level: "L3",
        scopes: [{ repoId: "repo-re-verify", kind: "file", path: "ui/runs.tsx", access: "write" }],
      }),
      {
        state: "in_progress",
        phase: "smoke",
        smokeReport: {
          testedRef: { kind: "git-commit", value: "9f3c1a7" },
          devHost: "127.0.0.1:6799",
          devServerId: "dev-server-1",
          devHome: "/tmp/dev-home",
          checks: [
            { id: "open runs tab", result: "pass", evidencePath: "evidence/smoke-1.png" },
            { id: "start team", result: "pass", evidencePath: "evidence/smoke-2.png" },
          ],
        },
      },
    ),
    t3,
  ],
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
});

export { PROFILE_HAIKU };
