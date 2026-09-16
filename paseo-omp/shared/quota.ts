import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

// omp's usage_history stores recorded_at/resets_at as epoch milliseconds (confirmed against
// live rows: 13-digit values), not seconds. Any "time remaining" math must diff against
// Date.now() directly, never Date.now() / 1000.
export const OmpQuotaSchema = z.object({
  provider: z.string(),
  label: z.string(),
  windowLabel: z.string().nullable(),
  usedFraction: z.number().min(0).nullable(),
  status: z.string().nullable(),
  resetsAt: z.number().int().nullable(),
  recordedAt: z.number().int(),
});
export type OmpQuota = z.infer<typeof OmpQuotaSchema>;

export const listOmpQuotas = defineRpc({
  name: "paseo-omp.list-quotas",
  input: z.object({ store: OmpStoreSchema.optional() }),
  output: z.object({ quotas: z.array(OmpQuotaSchema) }),
});
