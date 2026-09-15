import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const OMP_MCP_AUTH_TIMELINE_KIND = "omp-mcp-authorization";
const OmpMcpAuthorizationUrlSchema = z
  .string()
  .max(16_384)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }, "Authorization URL must be an HTTP URL without embedded credentials");

export const ompMcpAuthorizationTimelineSchema = z.object({
  url: OmpMcpAuthorizationUrlSchema,
  instructions: z
    .string()
    .max(64 * 1024)
    .optional(),
  loopbackCallback: z.boolean(),
  browserAuthorizationToken: z.string().uuid().optional(),
});

export type OmpMcpAuthorizationTimeline = z.infer<typeof ompMcpAuthorizationTimelineSchema>;
export const openOmpMcpAuthorizationInPaseoBrowser = defineRpc({
  name: "paseo-omp.open-mcp-authorization-in-browser",
  input: z.object({ authorizationToken: z.string().uuid() }),
  output: z.object({ opened: z.literal(true) }),
});

const OMP_MCP_SERVER_NAME = /^[a-zA-Z0-9_.:-]{1,100}$/u;

export type OmpMcpServerAction = "test" | "reauth" | "enable" | "disable";

export function buildOmpMcpServerCommand(
  action: OmpMcpServerAction,
  serverName: string,
): string | undefined {
  const name = serverName.trim();
  if (!OMP_MCP_SERVER_NAME.test(name)) return;
  return `/mcp ${action} ${name}`;
}
