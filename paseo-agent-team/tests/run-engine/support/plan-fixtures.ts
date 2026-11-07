import { createHash } from "node:crypto";
import { transitionIntent } from "../../../shared/domain/run-engine/effect-state";
import {
  buildPlanSeats,
  PLAN_REPAIR_VERSION,
  PLAN_REQUEST_VERSION,
  planRequestFacts,
} from "../../../shared/domain/run-engine/engine-prompts";
import {
  type PlanRepairRequest,
  requestPlanRepair,
} from "../../../shared/domain/run-engine/plan-repair";
import { addPlanRequest } from "../../../shared/domain/run-engine/run-record";
import type { RunEffectIntent, RunRecord } from "../../../shared/schemas/run-engine/ledger";
import { bootstrapRun, COORDINATOR_AGENT } from "./bootstrap-run";

export type Wake = Extract<RunEffectIntent, { kind: "wake" }>;

export const NOW = "2026-11-05T12:00:00.000Z";
export const NONCE = "6f1c2a44-3b7e-4f0a-9a11-0000000000f1";
export const PLAN_MESSAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const REPAIR_MESSAGE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
export const ROLE = {
  name: "Developer",
  mission: "Implement the assigned files.",
  responsibilities: ["Write code", "Run the checks"],
  restrictions: ["Do not touch unrelated modules"],
};

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A Run that has agents on every seat and whose plan request has just been prepared. */
export function prepared(
  options: {
    task?: string;
    role?: typeof ROLE;
    sameAgent?: boolean;
    templateVersion?: number;
  } = {},
): {
  record: RunRecord;
  intent: Wake;
} {
  const task = options.task ?? "Add a login page.";
  const base = bootstrapRun({ runId: "run-plan01-a1" });
  base.outbox = [];
  delete (base.launch as Record<string, unknown>).dagControl;
  base.launch.modelPlan.task = task;
  (base.launch as Record<string, unknown>).seatProfiles = {
    "seat-b1": {
      profileId: "p1",
      name: "Haiku",
      provider: "claude",
      model: "claude-haiku-5-5",
      family: "haiku",
    },
    "seat-b2": {
      profileId: "p2",
      name: "Luna",
      provider: "codex",
      model: "gpt-6-luna",
      family: "luna",
    },
  };
  if (options.sameAgent) {
    const reviewer = base.roster.find((seat) => seat.seatId === "seat-b2");
    if (reviewer) reviewer.agentId = "agent-b1";
  }
  const role = options.role ?? ROLE;
  const members = new Map([
    ["seat-b1", { memberName: "Backend dev", role }],
    ["seat-b2", { memberName: "Reviewer", role: { ...role, name: "Reviewer" } }],
  ]);
  const record = addPlanRequest(base, {
    intentId: "intent-plan-1",
    messageId: PLAN_MESSAGE,
    payloadHash: "0".repeat(64),
    templateVersion: options.templateVersion ?? PLAN_REQUEST_VERSION,
    task,
    controlNonce: NONCE,
    controlNonceDigest: sha256(NONCE),
    facts: planRequestFacts({ seats: buildPlanSeats(base, members), devTargetUsable: true }),
    now: NOW,
  });
  const intent = record.outbox.find((entry) => entry.kind === "wake");
  if (intent?.kind !== "wake") throw new Error("intent missing");
  return { record, intent };
}

/** Moves an intent through `sending` to `confirmed`, as the outbox executor does. */
export function confirm(record: RunRecord, intentId: string): RunRecord {
  const sending = transitionIntent(record, intentId, "sending", { now: NOW });
  if (!sending.ok) throw new Error("cannot start sending");
  const done = transitionIntent(sending.next, intentId, "confirmed", { now: NOW });
  if (!done.ok) throw new Error("cannot confirm");
  return done.next;
}

/** The plan re-send's request, as `dag.ts` makes it, for the plan request of `record`. */
export function askAgain(
  record: RunRecord,
  over: Partial<PlanRepairRequest> = {},
  suffix = "1",
): ReturnType<typeof requestPlanRepair> {
  const plan = record.outbox.findLast((intent) => intent.semanticArgs?.purpose === "plan");
  return requestPlanRepair(record, {
    agentId: COORDINATOR_AGENT,
    anchor: plan?.messageId ?? "",
    reason: "plan-rejected:schema-invalid",
    issues: [{ path: "tasks.0.group", message: "invalid_type" }],
    intentId: `intent-plan-repair-${suffix}`,
    messageId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${suffix}`,
    payloadHash: "0".repeat(64),
    templateVersion: PLAN_REPAIR_VERSION,
    now: NOW,
    ...over,
  });
}

/** A Run whose plan request went out and was answered with a plan the parser refused, then re-sent. */
export function repaired(options: Parameters<typeof prepared>[0] = {}) {
  const { record, intent } = prepared(options);
  const out = confirm(record, intent.id);
  const asked = askAgain(out);
  if (!asked.ok) throw new Error(`cannot ask again: ${asked.code}`);
  const wake = asked.next.outbox.at(-1) as Wake;
  return { record: asked.next, plan: intent, wake };
}

/** The single JSON line after a section label of a prompt. */
export function section(text: string, label: string): unknown {
  const lines = text.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) throw new Error(`no section ${label}`);
  return JSON.parse(lines[index + 1] ?? "");
}
