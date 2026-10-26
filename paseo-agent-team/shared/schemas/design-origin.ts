import { z } from "zod";

// Persisted inside Roles and Teams. Deliberately tolerant: a newer or damaged designer origin
// must never invalidate the whole catalog document. Unknown keys are preserved so a newer
// writer's metadata survives a round-trip through this version; the integration site adds
// `.optional().catch(undefined)` so a malformed block drops only the origin.
export const StoredDesignerOriginSchema = z
  .object({
    jobId: z.string().optional(),
    createdAt: z.string().optional(),
    requestExcerpt: z.string().optional(),
  })
  .passthrough();

export type StoredDesignerOrigin = z.infer<typeof StoredDesignerOriginSchema>;
