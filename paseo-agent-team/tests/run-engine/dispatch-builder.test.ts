import { describe, expect, test } from "vitest";
import {
  applyDispatch,
  buildDispatch,
  type DispatchBuildInput,
  REPO_EXCLUSIVE_RESOURCE,
} from "../../shared/domain/run-engine/dispatch-builder";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { claim, PROFILE_HAIKU, REPO_ID } from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";

/**
 * Failure modes this file guards:
 *  - a dispatch that reserves no budget, or reserves it although the reducer then refuses;
 *  - a second Run's task `t2` being waved through because it shares an id with ours;
 *  - a lock grant made on a view of other Runs that could not be read;
 *  - a write granted for a scope the host adapter did not verify;
 *  - two tasks of one repository in flight at once (M2 serializes them with one named resource).
 */

const NOW = "2026-11-05T12:00:00.000Z";
const FACTS = { now: NOW, newId: (kind: string) => `${kind}-new` };

function input(overrides: Partial<DispatchBuildInput> = {}): DispatchBuildInput {
  return {
    taskId: "t2",
    seatId: "seat-b1",
    profile: {
      id: PROFILE_HAIKU.id,
      name: PROFILE_HAIKU.name,
      provider: PROFILE_HAIKU.provider,
      model: PROFILE_HAIKU.model,
      family: PROFILE_HAIKU.family,
    },
    workspace: { id: "ws-start", branch: "main", baseRef: "main" },
    scopes: [{ repoId: REPO_ID, kind: "file", path: "src/t2.ts", access: "write", verified: true }],
    reason: "L2/B: lowest load",
    otherResources: { trusted: true, claims: [] },
    ids: {
      assignmentId: "assignment-t2-new",
      nonce: "6f1c2a44-3b7e-4f0a-9a11-0000000000a1",
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      intentId: "intent-t2-new",
      claimId: (index) => `claim-t2-new-${index}`,
    },
    now: NOW,
    payload: { hash: "9".repeat(64), templateVersion: 1 },
    ...overrides,
  };
}

type Claim = RunRecord["resources"][number];

function foreignRepoClaim(overrides: Partial<Claim> = {}): Claim {
  return claim({
    claimId: "claim-other-run",
    // The same task id as ours: every Run has a t2.
    taskId: "t2",
    originAssignmentId: "assignment-other",
    kind: "hot",
    path: REPO_EXCLUSIVE_RESOURCE,
    ...overrides,
  });
}

describe("buildDispatch", () => {
  test("builds an event the reducer accepts, and the reservation lands in the same record", () => {
    const record = readyRun();
    const built = buildDispatch(record, input());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const applied = applyDispatch(record, built, FACTS);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const next = applied.next;

    const t2 = next.tasks.find((task) => task.spec.id === "t2");
    expect(t2?.state).toBe("assigned");
    expect(t2?.attempts).toBe(1);
    expect(
      next.assignments.find((entry) => entry.assignmentId === "assignment-t2-new"),
    ).toMatchObject({
      attempt: 1,
      state: "assigned",
      agentId: "agent-b1",
      workspace: { id: "ws-start", branch: "main", baseRef: "main" },
    });
    expect(next.outbox.find((entry) => entry.id === "intent-t2-new")).toMatchObject({
      kind: "dispatch",
      state: "prepared",
      recipient: "agent-b1",
      payloadHash: "9".repeat(64),
    });
    expect(next.nonceRegistry.some((entry) => entry.nonce === built.event.nonce.nonce)).toBe(true);

    // One file claim for the declared scope plus the repo-wide exclusive resource.
    expect(next.resources.map((entry) => `${entry.kind}:${entry.path}`).sort()).toEqual([
      `file:src/t2.ts`,
      `hot:${REPO_EXCLUSIVE_RESOURCE}`,
    ]);

    // seat-b1 started at reserved 1 (limit 6).
    expect(next.budgets.entries.find((entry) => entry.subjectId === "seat-b1")?.reserved).toBe(2);
    // The input record was not touched.
    expect(record.budgets.entries.find((entry) => entry.subjectId === "seat-b1")?.reserved).toBe(1);
  });

  test("a second Run's claim on the repository blocks the grant even when its task id is also t2", () => {
    const record = readyRun();
    const built = buildDispatch(
      record,
      input({ otherResources: { trusted: true, claims: [foreignRepoClaim()] } }),
    );
    expect(built).toMatchObject({ ok: false, reason: "lock-conflict" });
    if (!built.ok) {
      expect(built.conflicts?.map((entry) => entry.claimId)).toContain("claim-other-run");
    }
  });

  test("a different repository in another Run does not block", () => {
    const record = readyRun();
    const built = buildDispatch(
      record,
      input({
        otherResources: {
          trusted: true,
          claims: [foreignRepoClaim({ repoId: "repo-elsewhere" })],
        },
      }),
    );
    expect(built.ok).toBe(true);
  });

  test("an unreadable view of other Runs refuses the grant instead of guessing", () => {
    const record = readyRun();
    const built = buildDispatch(record, input({ otherResources: { trusted: false, claims: [] } }));
    expect(built).toEqual({ ok: false, reason: "other-runs-untrusted" });
  });

  test("a declared scope the host adapter did not verify is refused", () => {
    const record = readyRun();
    const unverified = buildDispatch(
      record,
      input({
        scopes: [
          { repoId: REPO_ID, kind: "file", path: "src/t2.ts", access: "write", verified: false },
        ],
      }),
    );
    expect(unverified).toEqual({ ok: false, reason: "scope-unverified" });
    const missing = buildDispatch(record, input({ scopes: [] }));
    expect(missing).toEqual({ ok: false, reason: "scope-unverified" });
  });

  test("another task of this Run holding the repository blocks the grant", () => {
    const record = readyRun();
    record.resources = [
      claim({
        claimId: "claim-t1-hot",
        taskId: "t1",
        originAssignmentId: "assignment-t1-a1",
        kind: "hot",
        path: REPO_EXCLUSIVE_RESOURCE,
      }),
    ];
    const built = buildDispatch(record, input());
    expect(built).toMatchObject({ ok: false, reason: "lock-conflict" });
  });

  test("refuses when the seat budget is exhausted or missing", () => {
    const exhausted = readyRun();
    const entry = exhausted.budgets.entries.find((item) => item.subjectId === "seat-b1");
    if (!entry) throw new Error("fixture lost the seat-b1 budget");
    entry.reserved = entry.limit;
    expect(buildDispatch(exhausted, input())).toEqual({ ok: false, reason: "budget-exhausted" });

    const missing = readyRun();
    missing.budgets.entries = [];
    missing.policy.seatBudgets = [];
    expect(buildDispatch(missing, input())).toEqual({ ok: false, reason: "budget-missing" });
  });

  test("refuses a task that is not ready and a seat that cannot take work", () => {
    const record = readyRun();
    expect(buildDispatch(record, input({ taskId: "t3" }))).toEqual({
      ok: false,
      reason: "task-not-dispatchable",
    });
    expect(buildDispatch(record, input({ taskId: "nope" }))).toEqual({
      ok: false,
      reason: "task-missing",
    });
    const disabled = readyRun();
    const seat = disabled.roster.find((item) => item.seatId === "seat-b1");
    if (!seat) throw new Error("fixture lost seat-b1");
    seat.enabled = false;
    expect(buildDispatch(disabled, input())).toEqual({ ok: false, reason: "seat-unavailable" });
    expect(buildDispatch(record, input({ seatId: "seat-unknown" }))).toEqual({
      ok: false,
      reason: "seat-unavailable",
    });
  });

  test("a dispatched task is not dispatched again, and a reused message id is refused", () => {
    const record = readyRun();
    const built = buildDispatch(record, input());
    if (!built.ok) throw new Error("expected a build");
    const applied = applyDispatch(record, built, FACTS);
    if (!applied.ok) throw new Error("expected an apply");
    expect(buildDispatch(applied.next, input())).toEqual({
      ok: false,
      reason: "task-not-dispatchable",
    });

    // A ready task whose new message id already belongs to some intent: the host would deduplicate
    // it as the same message, so the ledger must not mint a second assignment for it.
    const reused = readyRun();
    const existing = reused.outbox[0];
    if (!existing) throw new Error("fixture lost its outbox");
    const duplicate = buildDispatch(
      reused,
      input({ ids: { ...input().ids, messageId: existing.messageId } }),
    );
    expect(duplicate).toEqual({ ok: false, reason: "duplicate-dispatch" });
  });

  test("a reducer refusal reserves nothing", () => {
    const record = readyRun();
    // No free execution slot: the reducer refuses after the builder has already priced the dispatch.
    record.policy.configuredConcurrency = 0;
    const built = buildDispatch(record, input());
    if (!built.ok) throw new Error("expected a build");
    const applied = applyDispatch(record, built, FACTS);
    expect(applied.ok).toBe(false);
    expect(record.budgets.entries.find((entry) => entry.subjectId === "seat-b1")?.reserved).toBe(1);
  });
});
