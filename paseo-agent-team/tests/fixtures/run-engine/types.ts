// Fixture aliases for the implemented Run Engine ledger contract. Deriving every type from the
// real schema makes drift a compile error instead of a runtime surprise.
import type { z } from "zod";
import type {
  RunAlertSchema,
  RunApprovalSchema,
  RunArtifactRefSchema,
  RunAssignmentSchema,
  RunBudgetEntrySchema,
  RunCancellationEvidenceSchema,
  RunChannelAvailabilitySchema,
  RunDecisionPointSchema,
  RunEffectIntentSchema,
  RunEventReceiptSchema,
  RunEventSchema,
  RunModelPlanBasisSchema,
  RunNonceEntrySchema,
  RunPolicySnapshotSchema,
  RunRecordSchema,
  RunReopenGrantSchema,
  RunResourceClaimSchema,
  RunSeatSnapshotSchema,
  RunTaskRecordSchema,
  RunTaskSpecSchema,
} from "../../../shared/schemas/run-engine/ledger";

export type RunAlert = z.infer<typeof RunAlertSchema>;
export type RunApproval = z.infer<typeof RunApprovalSchema>;
export type RunAssignment = z.infer<typeof RunAssignmentSchema>;
export type RunBudgetEntry = z.infer<typeof RunBudgetEntrySchema>;
export type RunChannelAvailability = z.infer<typeof RunChannelAvailabilitySchema>;
export type RunDecisionPoint = z.infer<typeof RunDecisionPointSchema>;
export type RunEffectIntent = z.infer<typeof RunEffectIntentSchema>;
export type RunEventReceipt = z.infer<typeof RunEventReceiptSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunModelPlanBasis = z.infer<typeof RunModelPlanBasisSchema>;
export type RunNonceEntry = z.infer<typeof RunNonceEntrySchema>;
export type RunPolicySnapshot = z.infer<typeof RunPolicySnapshotSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunReopenGrant = z.infer<typeof RunReopenGrantSchema>;
export type RunResourceClaim = z.infer<typeof RunResourceClaimSchema>;
export type RunSeatSnapshot = z.infer<typeof RunSeatSnapshotSchema>;
export type RunTaskRecord = z.infer<typeof RunTaskRecordSchema>;
export type RunTaskSpec = z.infer<typeof RunTaskSpecSchema>;
export type RunArtifactRef = z.infer<typeof RunArtifactRefSchema>;
export type RunCancellationEvidence = z.infer<typeof RunCancellationEvidenceSchema>;

/** Aliases kept for the fixture files' call sites. */
export type LedgerFixture = RunRecord;
export type TaskFixture = RunTaskRecord;
export type AssignmentFixture = RunAssignment;
export type IntentFixture = RunEffectIntent;
export type ResourceClaimFixture = RunResourceClaim;
export type NonceFixture = RunNonceEntry;
export type EventReceiptFixture = RunEventReceipt;
export type RunEventFixture = RunEvent;
export type DecisionFixture = RunDecisionPoint;
export type ChannelFixture = RunChannelAvailability;

export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

export type InvariantCase = {
  id: string;
  invariant: InvariantId;
  kind: "legal" | "violation" | "boundary";
  ledger: unknown;
  note: string;
};
