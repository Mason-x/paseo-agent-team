import { z } from "zod";

/**
 * Low-level report shapes shared by the stored ledger and the strict wire protocol.
 * This module must remain a leaf: it never imports ledger or protocol.
 */

export const RUN_PROTOCOL_VERSION = 1;

export const RunIdSchema = z
  .string()
  .max(96)
  .regex(/^run-[a-z0-9]+-[a-z0-9]+$/);
export const RunDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RunTimeSchema = z.string().datetime();
export const RunIdRefSchema = z.string().min(1).max(128);
export const RunPathSchema = z.string().min(1).max(512);
export const RunSeqSchema = z.number().int().nonnegative();
export const RunNonceSchema = z.string().uuid();
/** Business task ids use the same lowercase grammar as wire report identities. */
export const RunTaskIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const GitCommitRefShape = {
  kind: z.literal("git-commit"),
  value: z.string().min(1).max(128),
};
export const DiffRefShape = {
  kind: z.literal("diff-sha256"),
  value: RunDigestSchema,
  baseCommit: z.string().min(1).max(128),
  patchPath: RunPathSchema,
};

export const ReportIdentityShape = {
  protocolVersion: z.literal(RUN_PROTOCOL_VERSION),
  runId: RunIdSchema,
  taskId: RunTaskIdSchema,
  attempt: z.number().int().min(1),
  nonce: RunNonceSchema,
  assignmentId: RunIdRefSchema,
  /** Filled by the engine from the real dispatch on the stored side; optional on the wire. */
  messageId: z.string().uuid().optional(),
};

export const ReportWorkspaceShape = {
  id: RunIdRefSchema,
  branch: z.string().min(1).max(256),
  baseRef: z.string().min(1).max(256),
};

export const ReportCoverageShape = {
  lines: z.number().min(0).max(100),
  functions: z.number().min(0).max(100),
};

export const ReportIsolationShape = {
  homePath: RunPathSchema,
  outsideRealHome: z.boolean(),
};

export const ReportEvidenceFields = {
  id: z.string().min(1).max(64),
  command: z.string().min(1).max(2000).nullable(),
  exitCode: z.number().int(),
  summary: z.string().min(1).max(600),
  artifactPath: RunPathSchema,
};

export const ReportBlockerShape = {
  id: z.string().min(1).max(64),
  summary: z.string().min(1).max(600),
  path: RunPathSchema.nullable(),
};

export const ReportCheckShape = {
  id: z.string().min(1).max(64),
  /** No skip value: an inapplicable check must be removed by a spec revision first. */
  result: z.enum(["pass", "fail"]),
  evidencePath: RunPathSchema,
};

export const RunDispatchDutiesShape = {
  produce: z.string().min(1).max(64),
  review: z.string().min(1).max(64),
  smoke: z.string().min(1).max(64).nullable(),
};
