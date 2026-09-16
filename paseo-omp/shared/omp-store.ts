import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_PROFILE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

export function isOmpProfileName(value: string): boolean {
  return (
    value !== "default" &&
    !value.endsWith(".") &&
    OMP_PROFILE_NAME.test(value) &&
    !WINDOWS_RESERVED_PROFILE.test(value)
  );
}

export const OmpProfileNameSchema = z.string().trim().refine(isOmpProfileName, {
  message: "Invalid named OMP profile",
});
export const OmpStoreSchema = z
  .object({
    profile: OmpProfileNameSchema.optional(),
    agentDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"))
      // Browser validation accepts absolute paths from any supported server OS;
      // withOmpStore additionally applies node:path.isAbsolute on the server.
      .refine(
        (value) => /^(?:\/|[A-Za-z]:[\\/]|\\)/u.test(value),
        "OMP agent directory must be absolute",
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => !(value.profile && value.agentDir),
    "Choose a profile or agent directory, not both",
  );
export type OmpStore = z.infer<typeof OmpStoreSchema>;
export const listOmpStores = defineRpc({
  name: "paseo-omp.list-stores",
  input: z.object({}).strict(),
  output: z.object({ profiles: z.array(OmpProfileNameSchema).max(128) }),
});

export function storeForProvider(provider: string | undefined): OmpStore | undefined {
  if (!provider?.startsWith("omp-plugin-")) return;
  const profile = provider.slice("omp-plugin-".length);
  return isOmpProfileName(profile) ? { profile } : undefined;
}
export function storeLabel(store?: OmpStore): string {
  return store?.profile
    ? `Profile: ${store.profile}`
    : store?.agentDir
      ? "Custom agent directory"
      : "Daemon default store";
}
