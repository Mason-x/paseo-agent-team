import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpQuotas, OmpQuota } from "../shared/quota";
import { ompDataDir } from "./paths";

const QuotaRowSchema = z.object({
  provider: z.string(),
  label: z.string(),
  windowLabel: z.string().nullable(),
  usedFraction: z.number().min(0).nullable(),
  status: z.string().nullable(),
  resetsAt: z.number().int().nullable(),
  recordedAt: z.number().int(),
});

export function listOmpQuotasFrom(path: string): OmpQuota[] {
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const rows = database
        .prepare(
          `SELECT provider, label, window_label AS windowLabel, used_fraction AS usedFraction,
                  status, resets_at AS resetsAt, recorded_at AS recordedAt
           FROM (
             SELECT provider, account_key, limit_id, label, window_label, used_fraction, status,
                    resets_at, recorded_at, id,
                    ROW_NUMBER() OVER (
                      PARTITION BY provider, account_key, limit_id
                      ORDER BY recorded_at DESC, id DESC
                    ) AS position
             FROM usage_history
           )
           WHERE position = 1
           ORDER BY COALESCE(usedFraction, -1) DESC, provider, label`,
        )
        .all();
      return rows.flatMap((row) => {
        const parsed = QuotaRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

export function resolveListOmpQuotas(_input: RpcInput<typeof listOmpQuotas>): {
  quotas: OmpQuota[];
} {
  return { quotas: listOmpQuotasFrom(join(ompDataDir(), "agent.db")) };
}
