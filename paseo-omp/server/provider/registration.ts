import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import type { OmpBrowserAuthorizationRegistry } from "../mcp-browser";
import { probeOmpAvailability } from "../provider-diagnostics";
import { createOmpConnection, OmpNativeSessionReservations } from "./connection";
import type { OmpMcpConnector } from "./host-tools";
import { OmpRpcRuntime, type OmpRuntime } from "./omp-rpc";
import { parseOmpProviderOptions } from "./provider-options";
import { boundedJsonBytes } from "./security";
import { OmpProviderOptionsSchema } from "./settings";
import type { OmpTimelineScheduler } from "./timeline-projector";

type ProviderCatalogOptionsCompat = {
  scope: "global" | "workspace";
  cwd?: string;
  force?: boolean;
  providerOptions?: Readonly<Record<string, unknown>>;
  settings?: Readonly<Record<string, unknown>>;
};
type ProviderAvailabilityCompat = {
  status: "missing" | "unrunnable" | "incompatible" | "available";
  diagnostic?: string;
};
type ProviderRegistrationCompat = Omit<
  ProviderRegistration,
  "getCatalogCacheKey" | "checkAvailability"
> & {
  providerOptionsSchema?: typeof OmpProviderOptionsSchema;
  getCatalogCacheKey?(
    options: ProviderCatalogOptionsCompat,
    context?: { timeoutMs?: number },
  ): Promise<string | undefined>;
  checkAvailability?(
    options: ProviderCatalogOptionsCompat,
    context?: { timeoutMs?: number },
  ): Promise<ProviderAvailabilityCompat>;
};

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.subsession",
  "session.revert.conversation",
  "permission",
  "timeline.plugin",
] as const;
const ConnectRequestSchema = z.object({
  versions: z.array(z.number().int().positive().max(16)).min(1).max(8),
  capabilities: z.array(z.string().min(1).max(64)).max(32),
});

export interface OmpProviderOptions {
  runtime?: OmpRuntime;
  timelineScheduler?: OmpTimelineScheduler;
  replayTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  mcpInitializationTimeoutMs?: number;
  mcpConnector?: OmpMcpConnector;
  browserAuthorizationRegistry?: OmpBrowserAuthorizationRegistry;
  availabilityProbe?: (
    options: ProviderCatalogOptionsCompat,
    timeoutMs: number | undefined,
  ) => Promise<ProviderAvailabilityCompat>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createOmpProvider(options: OmpProviderOptions = {}): ProviderRegistrationCompat {
  const runtime = options.runtime ?? new OmpRpcRuntime({ environment: options.environment });
  const nativeReservations = new OmpNativeSessionReservations();
  return {
    id: "omp-plugin",
    label: "OMP Plugin",
    description: "Direct plugin provider for OMP's rpc-ui protocol",
    icon: "server/provider/omp.svg",
    providerOptionsSchema: OmpProviderOptionsSchema,
    async getCatalogCacheKey(catalogOptions) {
      const providerOptions = parseOmpProviderOptions(catalogOptions.providerOptions);
      const identity = {
        scope: catalogOptions.scope,
        ...(catalogOptions.scope === "workspace" ? { cwd: catalogOptions.cwd } : {}),
        providerOptions,
        settings: catalogOptions.settings ?? {},
        defaultCommand: (options.environment ?? process.env).OMP_COMMAND ?? "omp",
      };
      if (
        boundedJsonBytes(identity, 2 * 1024 * 1024, 4_096, 256 * 1024, 16_384) ===
        Number.POSITIVE_INFINITY
      ) {
        throw new Error("OMP catalog identity is too large");
      }
      return createHash("sha256").update(stableJson(identity)).digest("base64url");
    },
    async checkAvailability(catalogOptions, context) {
      if (options.availabilityProbe) {
        return await options.availabilityProbe(catalogOptions, context?.timeoutMs);
      }
      const providerOptions = parseOmpProviderOptions(catalogOptions.providerOptions);
      const environment = { ...(options.environment ?? process.env), ...providerOptions.env };
      const configuredCommand: readonly [string, ...string[]] = providerOptions.command?.[0]
        ? [providerOptions.command[0], ...providerOptions.command.slice(1)]
        : [environment.OMP_COMMAND || "omp"];
      return await probeOmpAvailability({
        command: configuredCommand,
        cwd:
          catalogOptions.scope === "workspace" && catalogOptions.cwd
            ? catalogOptions.cwd
            : homedir(),
        environment,
        timeoutMs: context?.timeoutMs,
      });
    },
    async connect(request) {
      if (boundedJsonBytes(request, 8 * 1024, 32, 256, 64) === Number.POSITIVE_INFINITY) {
        throw new Error("OMP provider received an oversized connection request");
      }
      const parsed = ConnectRequestSchema.safeParse(request);
      if (!parsed.success || !parsed.data.versions.includes(1)) {
        throw new Error("OMP provider requires a valid provider protocol version 1 request");
      }
      const requestedCapabilities = new Set(parsed.data.capabilities);
      const capabilities = CAPABILITIES.filter((capability) =>
        requestedCapabilities.has(capability),
      );
      return createOmpConnection(
        runtime,
        capabilities,
        options.timelineScheduler,
        options.environment,
        nativeReservations,
        options.mcpConnector,
        options.mcpInitializationTimeoutMs,
        options.replayTimeoutMs,
        options.browserAuthorizationRegistry,
      );
    },
  };
}
