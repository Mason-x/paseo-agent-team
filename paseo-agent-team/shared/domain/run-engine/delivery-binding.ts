import type {
  RunAcceptedProof,
  RunAssignment,
  RunRecord,
  RunStoredTaskReport,
} from "../../schemas/run-engine/ledger";
import { RunStoredTaskReportSchema } from "../../schemas/run-engine/ledger";

export type ProducerHead =
  | { kind: "ok"; assignment: RunAssignment }
  | { kind: "none" }
  | { kind: "invalid"; reason: string };

type DoneReport = Extract<RunStoredTaskReport, { status: "done" }>;

export type DeliveryCandidate = {
  producer: RunAssignment;
  proof: DoneReport;
  ref: DoneReport["ref"];
  files: readonly string[];
};

export type DeliveryResolution =
  | { kind: "ok"; d: DeliveryCandidate }
  | { kind: "none" }
  | { kind: "invalid"; reason: string };

const producerPurposes = new Set(["member", "coordinator", "reopen"]);

/** The one current producer for a task: same-task attempt, not superseded by another producer. */
export function producerHead(record: RunRecord, taskId: string): ProducerHead {
  const task = record.tasks.find((entry) => entry.spec.id === taskId);
  if (task === undefined) return { kind: "none" };
  const producers = record.assignments.filter(
    (entry) =>
      entry.taskId === taskId &&
      producerPurposes.has(entry.purpose) &&
      entry.attempt === task.attempts,
  );
  if (producers.length === 0) return { kind: "none" };
  const superseded = new Set(
    producers
      .map((entry) => entry.supersededByAssignmentId)
      .filter((id): id is string => typeof id === "string"),
  );
  const heads = producers.filter((entry) => !superseded.has(entry.assignmentId));
  if (heads.length !== 1) return { kind: "invalid", reason: "ambiguous-producer-head" };
  return { kind: "ok", assignment: heads[0] as RunAssignment };
}

/** Historical F/I7 use; parses a producer's stored accepted done proof without live/current head. */
export function resolveProducerProof(
  record: RunRecord,
  producerAssignmentId: string,
): DoneReport | undefined {
  const assignment = record.assignments.find(
    (entry) => entry.assignmentId === producerAssignmentId,
  );
  if (assignment === undefined || !producerPurposes.has(assignment.purpose)) return undefined;
  const parsed = RunStoredTaskReportSchema.safeParse(assignment.acceptedProof);
  return parsed.success && parsed.data.status === "done" ? parsed.data : undefined;
}

/** Identity-only D resolution: evidence gates decide whether this candidate is a valid D. */
export function resolveD(record: RunRecord, taskId: string): DeliveryResolution {
  const head = producerHead(record, taskId);
  if (head.kind !== "ok") return head;
  const proof = resolveProducerProof(record, head.assignment.assignmentId);
  if (proof === undefined) return { kind: "none" };
  return {
    kind: "ok",
    d: {
      producer: head.assignment,
      proof,
      ref: proof.ref,
      files: proof.changedFiles,
    },
  };
}

function knownEvidence(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    id: value.id,
    command: value.command,
    exitCode: value.exitCode,
    summary: value.summary,
    artifactPath: value.artifactPath,
    ref: knownValue(value.ref),
    coverage: value.coverage === undefined ? undefined : knownValue(value.coverage),
    isolation: value.isolation === undefined ? undefined : knownValue(value.isolation),
  };
}

function knownValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => knownValue(entry));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = knownValue(entry);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Protocol-known fields only; stored nested extensions are retained by the ledger, not compared. */
export function canonicalKnown(proof: RunAcceptedProof): unknown {
  if (!isRecord(proof)) return proof;
  const base = {
    protocolVersion: proof.protocolVersion,
    runId: proof.runId,
    taskId: proof.taskId,
    attempt: proof.attempt,
    nonce: proof.nonce,
    assignmentId: proof.assignmentId,
    messageId: proof.messageId,
  };
  if ("status" in proof) {
    if (proof.status === "done") {
      return {
        ...base,
        status: proof.status,
        changedFiles: proof.changedFiles,
        ref: knownValue(proof.ref),
        workspace: knownValue(proof.workspace),
        evidence: Array.isArray(proof.evidence)
          ? proof.evidence.map(knownEvidence)
          : proof.evidence,
      };
    }
    return {
      ...base,
      status: proof.status,
      reasonCode: proof.reasonCode,
      summary: proof.summary,
      evidence: Array.isArray(proof.evidence) ? proof.evidence.map(knownEvidence) : proof.evidence,
    };
  }
  if ("reviewedRef" in proof) {
    return {
      ...base,
      reviewedRef: knownValue(proof.reviewedRef),
      verdict: proof.verdict,
      blockers: knownValue(proof.blockers),
      probes: Array.isArray(proof.probes) ? proof.probes.map(knownEvidence) : proof.probes,
    };
  }
  return {
    ...base,
    testedRef: knownValue(proof.testedRef),
    devHost: proof.devHost,
    devServerId: proof.devServerId,
    devHome: proof.devHome,
    checks: knownValue(proof.checks),
  };
}

export function proofEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => proofEqual(value, b[index]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && proofEqual(a[key], b[key]))
  );
}

export function bindingMatches(
  record: RunRecord,
  assignment: RunAssignment,
  d: DeliveryCandidate,
): boolean {
  return (
    assignment.taskId === d.producer.taskId &&
    assignment.delivery?.producerAssignmentId === d.producer.assignmentId &&
    assignment.attempt === d.producer.attempt &&
    (assignment.purpose === "reviewer" || assignment.purpose === "smoker") &&
    record.assignments.some((entry) => entry.assignmentId === d.producer.assignmentId)
  );
}
