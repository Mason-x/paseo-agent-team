import { asRecord } from "../paseo/adapter";
import { zh } from "../zh";

/** Paseo tools the coordinator needs to hand out work and follow up on it. */
export const DELEGATION_TOOLS = ["send_agent_prompt"] as const;

/**
 * Whether the coordinator's provider will receive Paseo's agent tools.
 *
 * Mirrors the daemon's gates (MCP enabled, "Inject Paseo tools", the provider's
 * "Enable Paseo tools", and its disabled-tool list). Only explicit `false` values block:
 * an unrecognised config shape from another Paseo version must not stop a launch.
 */
export function coordinatorToolsBlocker(config: unknown, provider: string): string | null {
  const root = asRecord(config);
  if (!root) return null;
  const mcp = asRecord(root.mcp);
  if (mcp?.enabled === false) return zh.paseoMcpDisabled;
  if (mcp?.injectIntoAgents === false) return zh.paseoToolsNotInjected;
  const tools = asRecord(asRecord(asRecord(root.providers)?.[provider])?.paseoTools);
  if (tools?.enabled === false) return zh.providerToolsDisabled(provider);
  const disabled = Array.isArray(tools?.disabledTools) ? tools.disabledTools : [];
  const missing = DELEGATION_TOOLS.filter((tool) => disabled.includes(tool));
  if (missing.length > 0) return zh.delegationToolsDisabled(provider, missing.join(", "));
  return null;
}
