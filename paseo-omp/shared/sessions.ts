import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

const CwdSchema = z.string().min(1).max(4_096);

// omp's history.db stores created_at as epoch seconds (confirmed against live rows: 10-digit
// values), unlike agent.db's usage_history which stores milliseconds. Diff against
// Date.now() / 1_000, never Date.now() directly.
export const OmpSessionEntrySchema = z.object({
  id: z.number().int(),
  sessionId: z.string().nullable(),
  title: z.string().nullable(),
  prompt: z.string(),
  truncated: z.boolean(),
  createdAt: z.number().int(),
});
export type OmpSessionEntry = z.infer<typeof OmpSessionEntrySchema>;

export const listOmpSessions = defineRpc({
  name: "paseo-omp.list-sessions",
  input: z.object({ store: OmpStoreSchema.optional(), cwd: CwdSchema }),
  output: z.object({ sessions: z.array(OmpSessionEntrySchema) }),
});
