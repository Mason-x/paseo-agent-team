// Inputs for the three gates (evidence / independent review / DEV smoke). Each ledger stops its
// task one step before or at the gate; the expected verdict belongs to the R03/R05 cases.
import { AT_UPDATED, claim, review, T1, T2, T3, task, withLedger } from "./base";
import type { LedgerFixture } from "./types";

/** RE3.2 / Y1: a done report whose evidence failed a gate; must stay in_progress. */
export const EVIDENCE_INCOMPLETE_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-evd",
  revision: 19,
  tasks: [
    T1,
    {
      ...T2,
      status: "in_progress",
      phase: "evidence-returned",
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
            summary: "",
            artifactPath: "evidence/cov.log",
          },
        ],
      },
    },
    T3,
  ],
  resources: [claim({ id: "lock-t2", taskId: "T2", path: "src/t2.ts" })],
});

/** RE3.3 / Y2: the review verdict predates the current ref, so it cannot unlock done. */
export const STALE_REVIEW_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-stl",
  revision: 20,
  tasks: [
    {
      ...T1,
      ref: { kind: "git-commit", value: "c9f5e22" },
      reviews: [review({ reviewedRef: { kind: "git-commit", value: "9f3c1a7" } })],
    },
    T2,
    T3,
  ],
});

/** RE3.4 / Y4: devSmoke is pending, the smoke target is the real default daemon alias. */
export const DEV_SMOKE_MISSING_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-smk",
  revision: 21,
  tasks: [
    T1,
    task({
      id: "T6",
      title: "UI smoke",
      devSmoke: true,
      smokeChecklist: ["open runs tab", "start team", "observe one run"],
      tier: "A",
      level: "L3",
      status: "in_progress",
      phase: "smoke-pending",
      scopes: [{ repoId: "repo-re-verify", kind: "file", path: "ui/runs.tsx", access: "write" }],
      reviews: [review()],
      smokeReport: {
        testedRef: { kind: "git-commit", value: "9f3c1a7" },
        devHost: "127.0.0.1:6767",
        devServerId: "srv-real-default",
        devHome: "C:/Users/operator/.paseo",
        checks: [{ id: "open runs tab", result: "pass", evidencePath: "evidence/smoke-1.png" }],
      },
    }),
    T3,
  ],
});

/** RE3.4 legal edge: a pre-registered DEV target with the full checklist present. */
export const DEV_SMOKE_READY_LEDGER: LedgerFixture = withLedger({
  runId: "run-rec0re-smr",
  revision: 22,
  tasks: [
    T1,
    task({
      id: "T6",
      title: "UI smoke",
      devSmoke: true,
      smokeChecklist: ["open runs tab", "start team"],
      tier: "A",
      level: "L3",
      status: "in_progress",
      phase: "smoke-ready",
      scopes: [{ repoId: "repo-re-verify", kind: "file", path: "ui/runs.tsx", access: "write" }],
      smokeReport: {
        testedRef: { kind: "git-commit", value: "9f3c1a7" },
        devHost: "127.0.0.1:6799",
        devServerId: "dev-server-1",
        devHome: "C:/Users/operator/.paseo-dev",
        checks: [
          { id: "open runs tab", result: "pass", evidencePath: "evidence/smoke-1.png" },
          { id: "start team", result: "pass", evidencePath: "evidence/smoke-2.png" },
        ],
      },
    }),
    T3,
  ],
  alerts: [
    {
      id: "alert-smoke-ready",
      severity: "info",
      code: "smoke-report-received",
      message: "Smoke report on the pre-registered DEV target; gate evaluation pending.",
      taskId: "T6",
      at: AT_UPDATED,
      acked: false,
    },
  ],
});
