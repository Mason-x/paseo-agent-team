import {
  type RunAssignment,
  type RunEvidenceRepair,
  RunEvidenceRepairSchema,
  type RunRecord,
  type RunStoredTaskReport,
  RunStoredTaskReportSchema,
} from "../../schemas/run-engine/ledger";
import { artifactRefEqual, producerHead } from "./delivery-binding";
import { hasUnsettledEffects, isNormalEnded } from "./transitions";

export const EVIDENCE_TEMPLATE_VERSION = 1;
export const EVIDENCE_TEMPLATE = "evidence";

/**
 * Evidence reissues are a v2-only contract. A v1 assignment may already contain an unrelated
 * passthrough field called `evidenceRepair`; reading it never grants v2 execution semantics.
 */
export function evidenceRepairOf(
  record: Pick<RunRecord, "schemaVersion">,
  assignment: Pick<RunAssignment, "evidenceRepair">,
): RunEvidenceRepair | null {
  if (record.schemaVersion !== 2 || assignment.evidenceRepair === undefined) return null;
  const parsed = RunEvidenceRepairSchema.safeParse(assignment.evidenceRepair);
  return parsed.success ? parsed.data : null;
}

type DoneProof = Extract<RunStoredTaskReport, { status: "done" }>;

/** Only missing or incorrectly described evidence may be requested again automatically. */
export function evidenceIssueCanBeRepaired(reason: unknown): boolean {
  return (
    typeof reason === "string" &&
    ["missing", "duplicate-id", "command", "ref-mismatch", "artifact-root", "isolation"].includes(
      reason,
    )
  );
}

function doneProof(assignment: RunAssignment): DoneProof | null {
  const parsed = RunStoredTaskReportSchema.safeParse(assignment.acceptedProof);
  return parsed.success && parsed.data.status === "done" ? parsed.data : null;
}

function sameWorkspace(left: DoneProof["workspace"], right: DoneProof["workspace"]): boolean {
  return left.id === right.id && left.branch === right.branch && left.baseRef === right.baseRef;
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (files: readonly string[]) =>
    [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((file, index) => file === b[index]);
}

function sameActor(left: RunAssignment, right: RunAssignment): boolean {
  return (
    left.taskId === right.taskId &&
    left.attempt === right.attempt &&
    left.agentId === right.agentId &&
    left.seatId === right.seatId &&
    left.channelId === right.channelId &&
    left.profileId === right.profileId &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.family === right.family &&
    left.tier === right.tier &&
    left.purpose === right.purpose &&
    left.workspace !== null &&
    right.workspace !== null &&
    sameWorkspace(left.workspace, right.workspace)
  );
}

/** Validate a persisted supplement's chain without trusting its optional marker as authority. */
export function validStoredEvidenceRepair(record: RunRecord, assignment: RunAssignment): boolean {
  if (record.schemaVersion !== 2 || assignment.evidenceRepair === undefined) return true;
  const repair = evidenceRepairOf(record, assignment);
  if (!repair || assignment.assignmentId === repair.predecessorAssignmentId) return false;
  const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
  const predecessor = record.assignments.find(
    (entry) => entry.assignmentId === repair.predecessorAssignmentId,
  );
  const root = record.assignments.find((entry) => entry.assignmentId === repair.rootAssignmentId);
  const intents = record.outbox.filter(
    (entry) => entry.kind === "dispatch" && entry.assignmentId === assignment.assignmentId,
  );
  const intent = intents.length === 1 ? intents[0] : undefined;
  if (
    !task ||
    !predecessor ||
    !root ||
    !intent ||
    intent.semanticArgs.template !== EVIDENCE_TEMPLATE ||
    intent.templateVersion !== EVIDENCE_TEMPLATE_VERSION ||
    predecessor.supersededByAssignmentId !== assignment.assignmentId ||
    !sameActor(assignment, predecessor) ||
    !sameActor(assignment, root) ||
    !isNormalEnded(record, predecessor) ||
    !doneProof(predecessor) ||
    !doneProof(root) ||
    repair.ordinal > task.evidenceReturns ||
    repair.ordinal > record.policy.perTask.evidenceReturns ||
    evidenceRepairOf(record, root) !== null
  ) {
    return false;
  }
  const previous = evidenceRepairOf(record, predecessor);
  return previous === null
    ? predecessor.assignmentId === root.assignmentId
    : previous.rootAssignmentId === root.assignmentId && previous.ordinal + 1 === repair.ordinal;
}

/** A supplement may add evidence, but it cannot replace the original delivered work. */
export function matchesEvidenceRoot(
  record: RunRecord,
  assignment: RunAssignment,
  proof: DoneProof,
): boolean {
  const repair = evidenceRepairOf(record, assignment);
  if (!repair) return record.schemaVersion !== 2 || assignment.evidenceRepair === undefined;
  const root = record.assignments.find((entry) => entry.assignmentId === repair.rootAssignmentId);
  const original = root ? doneProof(root) : null;
  return (
    original !== null &&
    root?.taskId === assignment.taskId &&
    root.attempt === assignment.attempt &&
    artifactRefEqual(original.ref, proof.ref) &&
    sameWorkspace(original.workspace, proof.workspace) &&
    sameFiles(original.changedFiles, proof.changedFiles)
  );
}

/**
 * Validate a proposed v2 supplement against the current ledger, before the reducer supersedes its
 * predecessor. No clock, host, or filesystem facts are inferred here; the service must separately
 * verify the live agent and repository before proposing the event.
 */
export function validEvidenceReissue(
  record: RunRecord,
  assignment: RunAssignment,
  predecessorId: string,
): boolean {
  if (record.schemaVersion !== 2 || record.lifecycle !== "active") return false;
  const repair = evidenceRepairOf(record, assignment);
  if (!repair || repair.predecessorAssignmentId !== predecessorId) return false;
  const task = record.tasks.find((entry) => entry.spec.id === assignment.taskId);
  const predecessor = record.assignments.find((entry) => entry.assignmentId === predecessorId);
  const root = record.assignments.find((entry) => entry.assignmentId === repair.rootAssignmentId);
  const head = producerHead(record, assignment.taskId);
  if (
    !task ||
    !predecessor ||
    !root ||
    head.kind !== "ok" ||
    head.assignment.assignmentId !== predecessorId ||
    (task.state !== "assigned" && task.state !== "in_progress") ||
    task.evidenceReturns !== repair.ordinal ||
    repair.ordinal > record.policy.perTask.evidenceReturns ||
    predecessor.supersededByAssignmentId != null ||
    assignment.supersededByAssignmentId != null ||
    !isNormalEnded(record, predecessor) ||
    record.assignments.some(
      (entry) => entry.taskId === task.spec.id && !isNormalEnded(record, entry),
    ) ||
    record.decisions.some(
      (entry) =>
        entry.subjectId === task.spec.id &&
        (entry.state === "open" || entry.state === "waiting-human"),
    ) ||
    record.resources.some((entry) => entry.taskId === task.spec.id && entry.frozen) ||
    hasUnsettledEffects(record, task.spec.id) ||
    !doneProof(predecessor) ||
    !doneProof(root)
  ) {
    return false;
  }
  if (
    predecessor.taskId !== task.spec.id ||
    root.taskId !== task.spec.id ||
    predecessor.attempt !== task.attempts ||
    root.attempt !== task.attempts ||
    assignment.attempt !== task.attempts ||
    !sameActor(assignment, predecessor) ||
    !sameActor(assignment, root)
  ) {
    return false;
  }
  const previous = evidenceRepairOf(record, predecessor);
  if (previous === null) {
    // The counter is task-wide, so the first reissue of a later business attempt need not be 1.
    return predecessorId === repair.rootAssignmentId;
  }
  return (
    previous.rootAssignmentId === repair.rootAssignmentId && previous.ordinal + 1 === repair.ordinal
  );
}
