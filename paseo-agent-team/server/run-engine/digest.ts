import { createHash } from "node:crypto";

/** SHA-256 of a string as bare lowercase hex, the digest format the ledger uses everywhere. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable id of a Run alert: the same text always names the same alert. */
export function alertIdFor(summary: string): string {
  return `alert-${sha256Hex(summary.slice(0, 1000)).slice(0, 16)}`;
}
