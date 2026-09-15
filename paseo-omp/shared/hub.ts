import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Mirrors the on-disk shape omp's hub writes under
// ~/.omp/run/daemons/<projectHash>/daemons/<name>/meta.json. That layout is an internal,
// unversioned implementation detail of the omp harness, not a published API, so every field
// here is optional-safe on the server side and this schema is intentionally permissive
// (state is a free-form string, not a fixed enum) to avoid rejecting shapes we have not seen.
export const HubProcessSchema = z.object({
  name: z.string(),
  application: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  state: z.string(),
  owner: z.string().nullable(),
  restartCount: z.number().int().nonnegative(),
  persist: z.boolean(),
  detached: z.boolean(),
  createdAt: z.number().nullable(),
  startedAt: z.number().nullable(),
  readyAt: z.number().nullable(),
  exitedAt: z.number().nullable(),
  exitCode: z.number().nullable(),
});
export type HubProcess = z.infer<typeof HubProcessSchema>;
export const OmpWorkspaceCwdSchema = z.string().min(1).max(4_096);
const ProcessNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const listHubProcesses = defineRpc({
  name: "paseo-omp.list-processes",
  input: z.object({ cwd: OmpWorkspaceCwdSchema }),
  output: z.object({ processes: z.array(HubProcessSchema) }),
});

export const tailHubLog = defineRpc({
  name: "paseo-omp.tail-log",
  input: z.object({ cwd: OmpWorkspaceCwdSchema, name: ProcessNameSchema }),
  output: z.object({ content: z.string(), truncated: z.boolean() }),
});
