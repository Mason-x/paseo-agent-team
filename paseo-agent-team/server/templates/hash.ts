import { createHash } from "node:crypto";
import { canonicalize } from "../../shared/domain/catalog-content";

export function hashCatalogContent(content: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(content), "utf8").digest("hex");
}
