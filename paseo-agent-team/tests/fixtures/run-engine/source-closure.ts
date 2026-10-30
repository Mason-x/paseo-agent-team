// Test-only migration of the fixture source checks. Call only with schema-valid records.
// This checks the finite declared source relationships, not core gates/I7/state advancement.
import { RunStoredTaskReportSchema } from "../../../shared/schemas/run-engine/ledger";
import type { LedgerFixture, RunAssignment } from "./types";

export type SourceIssue = { code: string; path: string; message: string };
export type SourceIssueKey = Pick<SourceIssue, "code" | "path">;
export type SourceScenario = {
  cacheSource: Readonly<Record<string, string | null>>;
  cancelObligations: Readonly<Record<string, readonly string[]>>;
};

/** JSON deep equality without depending on property insertion order or a test assertion API. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}

// Retain the existing fixture cache-source predicate; this is not a new evidence gate.
function validProducer(record: LedgerFixture, assignment: RunAssignment): boolean {
  if (!["member", "coordinator", "reopen"].includes(assignment.purpose)) return false;
  const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
  const parsed = RunStoredTaskReportSchema.safeParse(assignment.acceptedProof);
  if (!task || !parsed.success || parsed.data.status !== "done") return false;
  return task.spec.evidence.every((required) => {
    const evidence = parsed.data.evidence.find((entry) => entry.id === required.id);
    return evidence !== undefined && evidence.exitCode === 0;
  });
}

/** The existing finite LocalNeverSent source witness, with no state repair or inference. */
function isLocalNeverSent(record: LedgerFixture, assignment: RunAssignment): boolean {
  if (
    assignment.cancellation !== null ||
    assignment.endedEventKey !== null ||
    assignment.turnId !== null ||
    assignment.endedAt !== null ||
    assignment.acceptedProof !== null
  ) {
    return false;
  }
  const dispatches = record.outbox.filter(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
  );
  if (dispatches.length !== 1) return false;
  const intent = dispatches[0];
  if (
    intent?.state !== "failed" ||
    intent.confirmedAt !== null ||
    intent.recoverySendCount !== 0 ||
    intent.localCancellation === null ||
    intent.taskId !== assignment.taskId ||
    intent.recipient !== assignment.agentId ||
    intent.messageId !== assignment.messageId ||
    intent.localCancellation.reason !== "cancel-before-send"
  )
    return false;
  const nonce = record.nonceRegistry.find(
    (entry) => entry.assignmentId === assignment.assignmentId,
  );
  if (
    !nonce ||
    nonce.runId !== record.runId ||
    nonce.acceptedAt !== null ||
    nonce.revokedAt === null ||
    nonce.revokeReason === null
  )
    return false;
  if (intent.localCancellation.eventSeq > record.counters.eventsThroughSeq) return false;
  if (
    record.events.some(
      (event) =>
        event.payload.taskId === assignment.taskId &&
        (event.kind === "turn_started" || event.kind === "turn_ended"),
    )
  )
    return false;
  const event = record.events.find(
    (entry) =>
      entry.seq === intent.localCancellation?.eventSeq &&
      entry.kind === intent.localCancellation.cause &&
      entry.at === intent.localCancellation.at &&
      entry.payload.taskId === assignment.taskId,
  );
  const audit = event?.payload.audit as
    | { localIntentIds?: unknown; supersededDecisionIds?: unknown }
    | undefined;
  if (
    !Array.isArray(audit?.localIntentIds) ||
    !audit.localIntentIds.includes(intent.id) ||
    !Array.isArray(audit.supersededDecisionIds)
  )
    return false;
  return !record.outbox.some(
    (entry) => entry.kind === "archive" && entry.assignmentId === assignment.assignmentId,
  );
}

/** Pure, exhaustive across independent relationships; missing references skip only dependents. */
export function collectSourceIssues(
  record: LedgerFixture,
  scenario: SourceScenario,
): SourceIssue[] {
  const issues: SourceIssue[] = [];
  const check = (ok: boolean, code: string, path: string, message: string): boolean => {
    if (!ok) issues.push({ code, path, message });
    return ok;
  };
  for (const assignment of record.assignments) {
    const ap = `assignments.${assignment.assignmentId}`;
    const proof = assignment.acceptedProof;
    // Either frozen identifier locates a candidate, so a single broken link can be named.
    // Multiple candidates are ambiguous; never pick a first row or hide a duplicate.
    const nonceCandidates = record.nonceRegistry.filter(
      (entry) => entry.assignmentId === assignment.assignmentId || entry.nonce === assignment.nonce,
    );
    const business = assignment.purpose !== "probe";
    if (business || proof !== null)
      check(
        nonceCandidates.length === 1,
        "assignment-nonce",
        `${ap}.nonce`,
        "Business assignment must have exactly one own nonce registration",
      );
    const nonce = nonceCandidates.length === 1 ? nonceCandidates[0] : undefined;
    if (proof !== null) {
      const identity = {
        runId: record.runId,
        taskId: assignment.taskId,
        attempt: assignment.attempt,
        assignmentId: assignment.assignmentId,
        nonce: assignment.nonce,
        messageId: assignment.messageId,
      };
      for (const [key, value] of Object.entries(identity)) {
        check(
          equal(proof[key], value),
          "proof-identity",
          `${ap}.acceptedProof.${key}`,
          "Proof identity must match its assignment and Run",
        );
      }
      if ("workspace" in proof) {
        check(
          equal(assignment.workspace, proof.workspace),
          "proof-workspace",
          `${ap}.workspace`,
          "Proof workspace must match assignment",
        );
      }
    }
    if (nonce) {
      const np = `nonceRegistry.${nonce.nonce}`;
      if (business) {
        const identity = {
          nonce: assignment.nonce,
          taskId: assignment.taskId,
          assignmentId: assignment.assignmentId,
          attempt: assignment.attempt,
          agentId: assignment.agentId,
          seatId: assignment.seatId,
          phase:
            assignment.purpose === "reviewer"
              ? "review"
              : assignment.purpose === "smoker"
                ? "smoke"
                : "implementation",
        };
        for (const [field, value] of Object.entries(identity)) {
          check(
            equal(nonce[field], value),
            "nonce-binding",
            `${np}.${field}`,
            "Nonce registration must match frozen assignment identity",
          );
        }
        // runId is checked once for every registry row by the existing nonce-run loop below.
      }
      if (proof !== null) {
        check(
          nonce.acceptedAt !== null,
          "nonce-accepted-at",
          `${np}.acceptedAt`,
          "Accepted proof requires acceptance time",
        );
        check(
          nonce.acceptedEventKey === `proof:${assignment.assignmentId}`,
          "nonce-accepted-key",
          `${np}.acceptedEventKey`,
          "Acceptance key must identify its own proof",
        );
        if (nonce.acceptedAt !== null) {
          check(
            Date.parse(nonce.acceptedAt) >= Date.parse(nonce.issuedAt),
            "nonce-accept-time",
            `${np}.acceptedAt`,
            "Acceptance cannot precede issue",
          );
          if (nonce.revokedAt !== null) {
            check(
              Date.parse(nonce.revokedAt) >= Date.parse(nonce.acceptedAt),
              "nonce-revoke-time",
              `${np}.revokedAt`,
              "Revocation cannot precede acceptance",
            );
          }
        }
      } else {
        check(
          nonce.acceptedAt === null,
          "nonce-accepted-at",
          `${np}.acceptedAt`,
          "No acceptance time without proof",
        );
        check(
          nonce.acceptedEventKey === null,
          "nonce-accepted-key",
          `${np}.acceptedEventKey`,
          "No acceptance key without proof",
        );
      }
    }
    const dispatches = record.outbox.filter(
      (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
    );
    check(
      dispatches.length === 1,
      "assignment-dispatch",
      `${ap}.dispatch`,
      "Assignment must have exactly one dispatch",
    );
    // Ambiguous/missing dispatch is one relation failure, not a reason to stop other branches.
    const dispatch = dispatches.length === 1 ? dispatches[0] : undefined;
    if (dispatch) {
      for (const [key, value] of Object.entries({
        taskId: assignment.taskId,
        recipient: assignment.agentId,
        messageId: assignment.messageId,
      })) {
        check(
          equal(dispatch[key], value),
          "dispatch-binding",
          `outbox.${dispatch.id}.${key}`,
          "Dispatch must bind its own assignment identity",
        );
      }
    }
    if (proof !== null && assignment.purpose !== "reviewer" && assignment.purpose !== "smoker") {
      check(
        assignment.delivery === null,
        "producer-delivery",
        `${ap}.delivery`,
        "Producer delivery must be null",
      );
    }
    const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
    check(task !== undefined, "assignment-task", `${ap}.taskId`, "Assignment task must exist");
    const seat = record.roster.find((entry) => entry.seatId === assignment.seatId);
    check(seat !== undefined, "assignment-seat", `${ap}.seatId`, "Assignment seat must exist");
    if (seat) {
      check(
        seat.agentId === assignment.agentId,
        "seat-agent",
        `${ap}.agentId`,
        "Seat agent must match assignment",
      );
      check(
        seat.tier === assignment.tier,
        "seat-tier",
        `${ap}.tier`,
        "Seat tier must match assignment",
      );
      if (task) {
        const action =
          assignment.purpose === "reviewer"
            ? "review"
            : assignment.purpose === "smoker"
              ? "smoke"
              : "produce";
        const duty = task.spec.dispatchDuties[action];
        check(
          duty !== null,
          "assignment-duty",
          `tasks.${task.spec.id}.spec.dispatchDuties.${action}`,
          "Assignment duty must be declared",
        );
        if (duty !== null)
          check(
            seat.duties.includes(duty),
            "seat-duty",
            `roster.${seat.seatId}.duties`,
            "Seat must have the explicit duty",
          );
      }
    }
    if (assignment.purpose === "reviewer" || assignment.purpose === "smoker") {
      const dp = `${ap}.delivery`;
      check(assignment.delivery !== null, "delivery-missing", dp, "Review/smoke requires delivery");
      if (assignment.delivery !== null) {
        const producer = record.assignments.find(
          (entry) => entry.assignmentId === assignment.delivery?.producerAssignmentId,
        );
        check(
          producer !== undefined,
          "delivery-producer",
          `${dp}.producerAssignmentId`,
          "Delivery producer must exist",
        );
        if (producer) {
          check(
            producer.taskId === assignment.taskId,
            "delivery-task",
            `${dp}.producerAssignmentId`,
            "Delivery must belong to same task",
          );
          check(
            producer.attempt === assignment.attempt,
            "delivery-attempt",
            `${ap}.attempt`,
            "Delivery attempt must match",
          );
          const producerPurpose = check(
            ["member", "coordinator", "reopen"].includes(producer.purpose),
            "producer-purpose",
            `assignments.${producer.assignmentId}.purpose`,
            "Delivery must point to a producer",
          );
          if (producerPurpose) {
            check(
              producer.acceptedProof !== null,
              "producer-proof",
              `assignments.${producer.assignmentId}.acceptedProof`,
              "Delivery requires producer proof",
            );
            if (producer.acceptedProof !== null) {
              const pp = `assignments.${producer.assignmentId}.acceptedProof`;
              check(
                "status" in producer.acceptedProof,
                "producer-proof-kind",
                pp,
                "Producer must carry a task report",
              );
              if ("status" in producer.acceptedProof) {
                check(
                  producer.acceptedProof.status === "done",
                  "producer-status",
                  `${pp}.status`,
                  "Delivery producer must be done",
                );
              }
              check(
                validProducer(record, producer),
                "producer-evidence",
                pp,
                "Delivery producer must satisfy its declared fixture evidence",
              );
            }
          }
          check(
            producer.agentId !== assignment.agentId,
            "reviewer-independence",
            `${ap}.agentId`,
            "Reviewer/smoker must be a different actor",
          );
          check(
            producer.seatId !== assignment.seatId,
            "reviewer-independence",
            `${ap}.seatId`,
            "Reviewer/smoker must use a different seat",
          );
        }
      }
    }
    const cancellation = assignment.cancellation;
    if (cancellation) {
      const cp = `${ap}.cancellation`;
      const intent = record.outbox.find((entry) => entry.id === cancellation.cancelIntentId);
      check(
        intent !== undefined,
        "cancellation-intent",
        `${cp}.cancelIntentId`,
        "Cancellation archive intent must exist",
      );
      if (intent) {
        for (const [key, value] of Object.entries({
          kind: "archive",
          taskId: assignment.taskId,
          assignmentId: assignment.assignmentId,
          recipient: assignment.agentId,
        })) {
          check(
            equal(intent[key], value),
            "cancellation-intent-binding",
            `outbox.${intent.id}.${key}`,
            "Cancellation intent must bind its actor",
          );
        }
      }
      if (assignment.state === "cancelled") {
        check(
          cancellation.assignmentId === assignment.assignmentId,
          "cancellation-assignment",
          `${cp}.assignmentId`,
          "Cancellation must identify its own assignment",
        );
        check(
          assignment.turnId !== null,
          "cancellation-turn",
          `${ap}.turnId`,
          "Cancellation requires a turn",
        );
        check(
          assignment.endedAt !== null,
          "cancellation-ended-at",
          `${ap}.endedAt`,
          "Cancellation requires end time",
        );
        if (assignment.turnId !== null)
          check(
            cancellation.lastTurnId === assignment.turnId,
            "cancellation-turn",
            `${cp}.lastTurnId`,
            "Cancellation must identify own last turn",
          );
        check(
          cancellation.refresh.agentId === assignment.agentId,
          "refresh-actor",
          `${cp}.refresh.agentId`,
          "Refresh must observe own actor",
        );
        check(
          !cancellation.refresh.activeTurn,
          "refresh-active-turn",
          `${cp}.refresh.activeTurn`,
          "Cancellation refresh must have no active turn",
        );
        if (assignment.endedAt !== null)
          check(
            Date.parse(cancellation.refresh.observedAt) >= Date.parse(assignment.endedAt),
            "refresh-time",
            `${cp}.refresh.observedAt`,
            "Refresh cannot precede end",
          );
        check(
          cancellation.observationSeq <= record.counters.observationSeq,
          "cancellation-watermark",
          `${cp}.observationSeq`,
          "Cancellation watermark cannot exceed record",
        );
        check(
          cancellation.endedEventKey !== null,
          "cancellation-ended-key",
          `${cp}.endedEventKey`,
          "Cancellation requires ended key",
        );
        if (assignment.endedEventKey !== null && cancellation.endedEventKey !== null)
          check(
            assignment.endedEventKey === cancellation.endedEventKey,
            "ended-key-mismatch",
            `${ap}.endedEventKey`,
            "Own and cancellation ended keys must agree",
          );
        if (
          cancellation.endedEventKey !== null &&
          assignment.turnId !== null &&
          assignment.endedAt !== null
        )
          check(
            record.eventReceipts.some(
              (entry) =>
                entry.eventKey === cancellation.endedEventKey &&
                entry.kind === "turn_ended" &&
                entry.agentId === assignment.agentId &&
                entry.turnId === assignment.turnId &&
                entry.receivedAt === assignment.endedAt,
            ),
            "cancellation-ended-receipt",
            `${cp}.endedEventKey`,
            "Cancellation must reference matching ended receipt",
          );
        if (intent) {
          check(
            intent.state === "confirmed",
            "cancellation-intent-state",
            `outbox.${intent.id}.state`,
            "Completed cancellation intent must be confirmed",
          );
          check(
            intent.confirmedAt !== null,
            "cancellation-intent-confirmed",
            `outbox.${intent.id}.confirmedAt`,
            "Completed cancellation intent requires time",
          );
        }
        const archived = check(
          cancellation.receipt.kind === "archive",
          "cancellation-receipt",
          `${cp}.receipt.kind`,
          "Completed cancellation requires archive receipt",
        );
        if (archived) {
          check(
            cancellation.receipt.confirmedAt !== null,
            "cancellation-receipt-confirmed",
            `${cp}.receipt.confirmedAt`,
            "Archive receipt requires time",
          );
          check(
            cancellation.receipt.externalId !== null,
            "cancellation-receipt-external",
            `${cp}.receipt.externalId`,
            "Archive receipt requires external identity",
          );
        }
        if (task)
          check(
            task.state === "cancelled",
            "cancellation-task",
            `tasks.${assignment.taskId}.state`,
            "Completed cancellation task must be cancelled",
          );
      }
    } else if (assignment.state === "cancelled") {
      check(
        isLocalNeverSent(record, assignment),
        "local-never-sent",
        ap,
        "Cancelled actor without 167 requires LocalNeverSent source witness",
      );
    }
    if (assignment.state === "ended" || assignment.endedEventKey !== null) {
      check(
        assignment.turnId !== null,
        "ended-turn",
        `${ap}.turnId`,
        "Ended assignment requires own turn",
      );
      check(
        assignment.endedAt !== null,
        "ended-at",
        `${ap}.endedAt`,
        "Ended assignment requires time",
      );
      check(
        assignment.endedEventKey !== null,
        "ended-key",
        `${ap}.endedEventKey`,
        "Ended assignment requires key",
      );
      if (
        assignment.endedEventKey !== null &&
        assignment.turnId !== null &&
        assignment.endedAt !== null
      ) {
        check(
          record.eventReceipts.some(
            (entry) =>
              entry.eventKey === assignment.endedEventKey &&
              entry.kind === "turn_ended" &&
              entry.agentId === assignment.agentId &&
              entry.turnId === assignment.turnId &&
              entry.receivedAt === assignment.endedAt,
          ),
          "ended-receipt",
          `${ap}.endedEventKey`,
          "Ended key must reference own matching receipt",
        );
      }
    }
  }
  for (const nonce of record.nonceRegistry) {
    check(
      nonce.runId === record.runId,
      "nonce-run",
      `nonceRegistry.${nonce.nonce}.runId`,
      "Nonce must belong to this Run",
    );
  }
  for (const task of record.tasks) {
    const tp = `tasks.${task.spec.id}`;
    for (const dep of task.spec.deps) {
      check(
        record.tasks.some((entry) => entry.spec.id === dep),
        "task-dependency",
        `${tp}.spec.deps.${dep}`,
        "Declared dependency task must exist",
      );
    }
    const sourceId = scenario.cacheSource[task.spec.id] ?? null;
    const producer =
      sourceId === null
        ? undefined
        : record.assignments.find((entry) => entry.assignmentId === sourceId);
    const valid =
      producer !== undefined && producer.taskId === task.spec.id && validProducer(record, producer);
    if (sourceId !== null) {
      check(
        valid,
        "cache-source",
        `${tp}.cacheSource`,
        "Explicit cache source must name own valid producer",
      );
      if (
        valid &&
        producer?.acceptedProof &&
        "ref" in producer.acceptedProof &&
        "changedFiles" in producer.acceptedProof
      ) {
        check(
          equal(task.ref, producer.acceptedProof.ref),
          "cache-ref",
          `${tp}.ref`,
          "Cache ref must match explicit source",
        );
        check(
          equal(task.changedFiles, producer.acceptedProof.changedFiles),
          "cache-files",
          `${tp}.changedFiles`,
          "Cache files must match explicit source",
        );
      }
    } else {
      check(
        task.ref === null && task.changedFiles.length === 0,
        "cache-source",
        `${tp}.cacheSource`,
        "Task without declared source must have empty cache",
      );
    }
    if (task.state === "done") {
      const producerProof = producer?.acceptedProof;
      const hasProducer = check(
        producer !== undefined &&
          producer.taskId === task.spec.id &&
          ["member", "coordinator", "reopen"].includes(producer.purpose) &&
          producerProof !== null &&
          producerProof !== undefined &&
          "status" in producerProof &&
          producerProof.status === "done",
        "done-producer-chain",
        `${tp}.producer`,
        "Done task requires its explicitly declared producer and own done proof",
      );
      // Review/smoke refs depend on that producer; independent nonce/cache checks still run.
      if (hasProducer) {
        const reviewer = record.assignments.find(
          (entry) =>
            entry.taskId === task.spec.id &&
            entry.purpose === "reviewer" &&
            entry.acceptedProof !== null &&
            "verdict" in entry.acceptedProof &&
            entry.delivery?.producerAssignmentId === producer?.assignmentId,
        );
        check(
          reviewer !== undefined,
          "done-reviewer-chain",
          `${tp}.reviewer`,
          "Done task requires matching reviewer proof chain",
        );
        if (reviewer?.acceptedProof && producer?.acceptedProof) {
          check(
            "reviewedRef" in reviewer.acceptedProof,
            "done-reviewer-kind",
            `assignments.${reviewer.assignmentId}.acceptedProof`,
            "Done reviewer requires review report",
          );
          if ("reviewedRef" in reviewer.acceptedProof && "ref" in producer.acceptedProof) {
            check(
              equal(reviewer.acceptedProof.reviewedRef, producer.acceptedProof.ref),
              "done-reviewed-ref",
              `assignments.${reviewer.assignmentId}.acceptedProof.reviewedRef`,
              "Done review must reference producer ref",
            );
          }
        }
        if (task.spec.devSmoke) {
          const smoker = record.assignments.find(
            (entry) =>
              entry.taskId === task.spec.id &&
              entry.purpose === "smoker" &&
              entry.delivery?.producerAssignmentId === producer?.assignmentId &&
              entry.acceptedProof !== null &&
              "testedRef" in entry.acceptedProof,
          );
          check(
            smoker !== undefined,
            "done-smoker-chain",
            `${tp}.smoker`,
            "DEV done task requires its matching smoker proof chain",
          );
          if (
            smoker?.acceptedProof &&
            "testedRef" in smoker.acceptedProof &&
            producerProof &&
            "ref" in producerProof
          ) {
            check(
              equal(smoker.acceptedProof.testedRef, producerProof.ref),
              "done-tested-ref",
              `assignments.${smoker.assignmentId}.acceptedProof.testedRef`,
              "Done smoke must reference producer ref",
            );
          }
        }
      }
    }
    const completed = record.assignments.some(
      (entry) =>
        entry.taskId === task.spec.id && entry.state === "cancelled" && Boolean(entry.cancellation),
    );
    if (completed) {
      const decision = record.decisions.find(
        (entry) => entry.subjectId === task.spec.id && entry.state === "answered",
      );
      check(
        decision !== undefined,
        "cancellation-decision",
        `${tp}.cancellationDecision`,
        "Completed cancellation requires answered decision",
      );
      if (decision) {
        const dp = `decisions.${decision.decisionId}`;
        check(
          decision.dedupeKey === `cancel:${task.spec.id}`,
          "cancellation-dedupe",
          `${dp}.dedupeKey`,
          "Cancellation decision must name task",
        );
        check(
          ["cancel", "assign-seat"].includes(decision.answer?.action ?? ""),
          "cancellation-action",
          `${dp}.answer.action`,
          "Cancellation requires explicit authorization",
        );
        check(
          (decision.answer?.taskIds ?? []).includes(task.spec.id),
          "cancellation-answer-coverage",
          `${dp}.answer.taskIds`,
          "Cancellation answer must cover task",
        );
      }
    }
  }
  for (const claim of record.resources) {
    const cp = `resources.${claim.claimId}`;
    check(
      /^assignment-/.test(claim.originAssignmentId),
      "claim-origin-id",
      `${cp}.originAssignmentId`,
      "Claim origin must be an assignment identity",
    );
    const origin = record.assignments.find(
      (entry) => entry.assignmentId === claim.originAssignmentId,
    );
    check(
      origin !== undefined,
      "claim-origin",
      `${cp}.originAssignmentId`,
      "Claim origin must exist",
    );
    if (origin) {
      check(
        origin.taskId === claim.taskId,
        "claim-origin-task",
        `${cp}.originAssignmentId`,
        "Claim origin must belong to same task",
      );
      check(
        ["member", "coordinator", "reopen"].includes(origin.purpose),
        "claim-origin-purpose",
        `${cp}.originAssignmentId`,
        "Claim origin must be producer",
      );
    }
  }
  for (const decision of record.decisions) {
    const dp = `decisions.${decision.decisionId}`;
    const cancelSubject =
      decision.category === "D1" &&
      decision.subjectId !== null &&
      decision.dedupeKey === `cancel:${decision.subjectId}`
        ? decision.subjectId
        : null;
    if (cancelSubject !== null && decision.cancelIntents !== null) {
      if (Object.hasOwn(scenario.cancelObligations, cancelSubject)) {
        check(
          equal(
            decision.cancelIntents.map((entry) => entry.assignmentId),
            [...(scenario.cancelObligations[cancelSubject] ?? [])].sort(),
          ),
          "cancellation-pairs",
          `${dp}.cancelIntents`,
          "Pairs must equal explicit scenario obligations",
        );
      }
      for (const binding of decision.cancelIntents) {
        const actor = record.assignments.find(
          (entry) => entry.assignmentId === binding.assignmentId,
        );
        if (actor)
          check(
            actor.taskId === cancelSubject,
            "cancellation-pair-task",
            `${dp}.cancelIntents.${binding.assignmentId}.assignmentId`,
            "Pair must belong to cancellation decision subject",
          );
      }
    }
    if (decision.state === "superseded") {
      check(
        decision.answer === null,
        "superseded-answer",
        `${dp}.answer`,
        "Administrative close is not authorization",
      );
      check(
        decision.answeredAt === null,
        "superseded-answered-at",
        `${dp}.answeredAt`,
        "Administrative close has no human answer time",
      );
      const resolution = decision.resolution;
      check(
        resolution !== null,
        "superseded-resolution",
        `${dp}.resolution`,
        "Administrative close needs typed witness",
      );
      check(
        (decision.cancelIntents ?? []).length === 0,
        "superseded-pairs",
        `${dp}.cancelIntents`,
        "Administrative close cannot have actor obligations",
      );
      const task = record.tasks.find((entry) => entry.spec.id === decision.subjectId);
      check(
        task?.state === "cancelled",
        "superseded-task",
        `${dp}.subjectId`,
        "Administrative close needs cancelled task",
      );
      if (task)
        check(
          task.releaseDecisionId !== decision.decisionId,
          "superseded-release",
          `tasks.${task.spec.id}.releaseDecisionId`,
          "Administrative decision cannot authorize release",
        );
      if (resolution) {
        const rp = `${dp}.resolution`;
        check(
          resolution.witness.taskId === decision.subjectId,
          "superseded-witness-task",
          `${rp}.witness.taskId`,
          "Witness must name decision task",
        );
        const locals = resolution.witness.localIntentIds;
        check(
          equal(locals, [...locals].sort()),
          "superseded-local-order",
          `${rp}.witness.localIntentIds`,
          "Local identities must be sorted",
        );
        const expected = record.outbox
          .filter(
            (entry) =>
              entry.kind === "dispatch" &&
              entry.localCancellation !== null &&
              entry.taskId === decision.subjectId,
          )
          .map((entry) => entry.id)
          .sort();
        check(
          equal(locals, expected),
          "superseded-local-closure",
          `${rp}.witness.localIntentIds`,
          "Local witness must match scenario intents",
        );
        if (resolution.eventSeq > (record.checkpoint?.throughSeq ?? 0)) {
          const event = record.events.find(
            (entry) =>
              entry.seq === resolution.eventSeq &&
              entry.at === resolution.at &&
              entry.kind === resolution.cause &&
              entry.payload.taskId === decision.subjectId,
          );
          check(
            event !== undefined,
            "superseded-cancel-event",
            `${rp}.eventSeq`,
            "Uncompressed resolution requires its cancel event",
          );
          if (event) {
            const audit = event.payload.audit as
              | { localIntentIds?: unknown; supersededDecisionIds?: unknown }
              | undefined;
            check(
              equal(audit?.localIntentIds, locals),
              "superseded-audit-locals",
              `events.${event.seq}.payload.audit.localIntentIds`,
              "Cancel audit must match witness",
            );
            check(
              Array.isArray(audit?.supersededDecisionIds) &&
                audit.supersededDecisionIds.includes(decision.decisionId),
              "superseded-audit-decision",
              `events.${event.seq}.payload.audit.supersededDecisionIds`,
              "Cancel audit must include decision",
            );
          }
        }
      }
      continue;
    }
    if (decision.cancelIntents === null) continue;
    const ids = decision.cancelIntents.map((entry) => entry.assignmentId);
    check(
      equal(ids, [...ids].sort()),
      "cancellation-pairs-order",
      `${dp}.cancelIntents`,
      "Cancellation pairs must be sorted",
    );
    check(
      new Set(ids).size === ids.length,
      "cancellation-pairs-unique",
      `${dp}.cancelIntents`,
      "Cancellation pairs must be unique",
    );
    for (const binding of decision.cancelIntents) {
      const bp = `${dp}.cancelIntents.${binding.assignmentId}`;
      const assignment = record.assignments.find(
        (entry) => entry.assignmentId === binding.assignmentId,
      );
      const intent = record.outbox.find((entry) => entry.id === binding.intentId);
      check(
        assignment !== undefined,
        "cancellation-pair-assignment",
        `${bp}.assignmentId`,
        "Pair assignment must exist",
      );
      check(
        intent !== undefined,
        "cancellation-pair-intent",
        `${bp}.intentId`,
        "Pair intent must exist",
      );
      if (assignment && intent) {
        for (const [key, value] of Object.entries({
          kind: "archive",
          taskId: assignment.taskId,
          assignmentId: assignment.assignmentId,
          recipient: assignment.agentId,
        })) {
          check(
            equal(intent[key], value),
            "cancellation-pair-binding",
            `outbox.${intent.id}.${key}`,
            "Archive pair must bind its own actor",
          );
        }
      }
    }
  }
  // Code-unit lexical order is stable, independent of source array order or locale.
  return issues.sort((a, b) => {
    for (const key of ["code", "path", "message"] as const) {
      if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    return 0;
  });
}
