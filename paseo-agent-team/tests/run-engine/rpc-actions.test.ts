import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runDecideRpc, runKickRpc, runReplanRpc } from "../../shared/rpc/run-engine";
import {
  RUN_ACTION_CODES,
  RUN_ACTION_CONTROLS,
  RunDecideInputSchema,
  RunDecideOutputSchema,
  RunKickInputSchema,
  RunKickOutputSchema,
  RunReplanInputSchema,
  RunReplanOutputSchema,
} from "../../shared/schemas/run-engine/rpc-actions";

/**
 * The contract of the three writing RPCs (P06). Failure modes this file guards:
 *  - an input that carries more than the contract names (a nonce, a prompt, a state to write) being
 *    accepted, or one that lacks the request id / revision that make a write idempotent and safe;
 *  - a refusal code the handlers emit that the contract does not list, so a client cannot recognise it;
 *  - the existing shape-only controls (`run.control`, `run.approve`, `run.reconcile`) being widened
 *    or registered by this change.
 */

const RUN = "run-ctl001-a1";
const DECISION = "11111111-1111-4111-8111-111111111111";
const base = {
  runContractVersion: 1,
  runId: RUN,
  requestId: "req-1",
  expectedRevision: 3,
  reason: "r",
};

describe("inputs", () => {
  test("replan: strict, with the request id, the revision and a reason", () => {
    expect(RunReplanInputSchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, extra: 1 },
      { ...base, nonce: "x" },
      { ...base, requestId: "" },
      { ...base, requestId: "x".repeat(129) },
      { ...base, reason: "" },
      { ...base, reason: "x".repeat(601) },
      { ...base, expectedRevision: -1 },
      { ...base, runContractVersion: 2 },
      { ...base, runId: "not-a-run" },
    ]) {
      expect(RunReplanInputSchema.safeParse(bad).success).toBe(false);
    }
    const { expectedRevision: _a, ...noRevision } = base;
    const { requestId: _b, ...noRequest } = base;
    expect(RunReplanInputSchema.safeParse(noRevision).success).toBe(false);
    expect(RunReplanInputSchema.safeParse(noRequest).success).toBe(false);
  });

  test("decide: the decision id is a uuid and the only answer is retry", () => {
    const ok = { ...base, decisionId: DECISION, answer: { action: "retry" } };
    expect(RunDecideInputSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, decisionId: "not-a-uuid" },
      { ...ok, answer: { action: "reject" } },
      { ...ok, answer: { action: "cancel", taskIds: ["t1"] } },
      { ...ok, answer: { action: "retry", taskId: "t1" } },
      { ...ok, answer: undefined },
      { ...ok, state: "answered" },
    ]) {
      expect(RunDecideInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("kick: a Run id and nothing else", () => {
    expect(RunKickInputSchema.safeParse({ runContractVersion: 1, runId: RUN }).success).toBe(true);
    for (const bad of [
      { runContractVersion: 1 },
      { runContractVersion: 1, runId: RUN, requestId: "x" },
      { runContractVersion: 1, runId: RUN, force: true },
    ]) {
      expect(RunKickInputSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("outputs", () => {
  const issue = {
    code: "revision-conflict",
    severity: "error",
    path: [],
    params: { current: 4 },
    action: "refresh",
  };

  test("every answer is a status with the revision and its issues", () => {
    expect(
      RunReplanOutputSchema.safeParse({
        runContractVersion: 1,
        status: "applied",
        revision: 5,
        epoch: 2,
        issues: [],
      }).success,
    ).toBe(true);
    expect(
      RunReplanOutputSchema.safeParse({
        runContractVersion: 1,
        status: "rejected",
        revision: 4,
        epoch: null,
        issues: [issue],
      }).success,
    ).toBe(true);
    expect(
      RunDecideOutputSchema.safeParse({
        runContractVersion: 1,
        status: "replayed",
        revision: 6,
        decisionId: DECISION,
        taskId: "t1",
        issues: [],
      }).success,
    ).toBe(true);
    expect(
      RunKickOutputSchema.safeParse({
        runContractVersion: 1,
        status: "ok",
        outcome: "blocked",
        dispatched: 0,
        revision: 6,
        reason: "dispatch-blocked:workspace-dirty",
        issues: [],
      }).success,
    ).toBe(true);
    expect(
      RunReplanOutputSchema.safeParse({
        runContractVersion: 1,
        status: "maybe",
        revision: 1,
        epoch: 2,
        issues: [],
      }).success,
    ).toBe(false);
    // A replan is never epoch 1 (that is the launch's own request).
    expect(
      RunReplanOutputSchema.safeParse({
        runContractVersion: 1,
        status: "applied",
        revision: 1,
        epoch: 1,
        issues: [],
      }).success,
    ).toBe(false);
  });

  test("the names the capabilities may carry are the three that exist", () => {
    expect([...RUN_ACTION_CONTROLS]).toEqual(["replan", "decide", "kick"]);
    expect(runReplanRpc.name).toBe("agent-team.run.replan");
    expect(runDecideRpc.name).toBe("agent-team.run.decide");
    expect(runKickRpc.name).toBe("agent-team.run.kick");
  });
});

describe("the refusal codes", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  test("every code the handlers and the pure functions can refuse with is in the contract's list", () => {
    const sources = [
      "server/run-engine/control.ts",
      "shared/domain/run-engine/replan.ts",
      "shared/domain/run-engine/decision-answer.ts",
    ].map(read);
    const found = new Set<string>();
    for (const text of sources) {
      for (const match of text.matchAll(
        /\b(?:code|issue|refused)(?::|\()\s*"([a-z]+(?:-[a-z]+)+)"/gu,
      )) {
        if (match[1]) found.add(match[1]);
      }
    }
    // Reasons that are not codes of the contract (they travel in `params.reason`) are not matched above.
    expect(found.size).toBeGreaterThan(8);
    for (const code of found) expect(RUN_ACTION_CODES as readonly string[]).toContain(code);
  });

  test("the shape-only controls are as they were: nothing here registered or widened them", () => {
    const entry = read("index.server.ts");
    expect(entry).not.toContain("runControlRpc");
    expect(entry).not.toContain("RunControlInputSchema");
    expect(entry).not.toContain("RunApproveInputSchema");
    expect(read("shared/rpc/run-engine.ts")).not.toContain("agent-team.run.control");
  });
});
