import { createHash } from "node:crypto";
import { toPaseoMcpServers } from "../../shared/paseo/adapter";

/** SHA-256 of a string as bare lowercase hex, the digest format the ledger uses everywhere. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable id of a Run alert: the same text always names the same alert. */
export function alertIdFor(summary: string): string {
  return `alert-${sha256Hex(summary.slice(0, 1000)).slice(0, 16)}`;
}

/**
 * JSON with the keys of every object sorted and no white space, so the same value always gives the same
 * text whatever order its keys were written in. Arrays keep their order. `undefined` members are left out,
 * as `JSON.stringify` does.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The digest of a Role's MCP configuration as the host is given it (`toPaseoMcpServers`: a stdio entry
 * without a `type` gets one), so the same configuration always has the same digest. The configuration may
 * hold secrets (`env`, `headers`); only this digest is ever stored, never the text. Both the launch and a
 * rebuild use this one function; a difference between them would make every seat with MCP "changed".
 */
export function mcpServersSha256(mcpServers: Parameters<typeof toPaseoMcpServers>[0]): string {
  return sha256Hex(stableStringify(toPaseoMcpServers(mcpServers) ?? {}));
}
