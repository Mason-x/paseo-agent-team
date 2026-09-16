import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OmpStoreSchema } from "./omp-store";

const CwdSchema = z.string().min(1).max(4_096);

export const OmpMemoryFactSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number().min(0).max(1),
  timestamp: z.string().nullable(),
});
export type OmpMemoryFact = z.infer<typeof OmpMemoryFactSchema>;

export const listOmpMemory = defineRpc({
  name: "paseo-omp.list-memory",
  input: z.object({ store: OmpStoreSchema.optional(), cwd: CwdSchema }),
  output: z.object({
    bank: z.string().nullable(),
    facts: z.array(OmpMemoryFactSchema),
  }),
});
