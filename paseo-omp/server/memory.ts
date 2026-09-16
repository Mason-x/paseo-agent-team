import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpMemory, OmpMemoryFact } from "../shared/memory";
import { ompStateDir } from "./paths";

const FactRowSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  timestamp: z.string().nullable(),
});

type CandidateBank = { name: string; modifiedAt: number };

async function newestBank(root: string, cwd: string): Promise<string | undefined> {
  const prefix = `${basename(cwd)}-`;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map(async (entry): Promise<CandidateBank | undefined> => {
          try {
            return { name: entry.name, modifiedAt: (await stat(join(root, entry.name))).mtimeMs };
          } catch {
            return undefined;
          }
        }),
    );
    return candidates
      .flatMap((candidate) => (candidate ? [candidate] : []))
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.name;
  } catch {
    return undefined;
  }
}

export function listOmpFactsFrom(path: string): OmpMemoryFact[] {
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const rows = database
        .prepare(
          `SELECT fact_id AS id, subject, predicate, object, confidence, timestamp
           FROM facts
           ORDER BY COALESCE(timestamp, created_at) DESC
           LIMIT 100`,
        )
        .all();
      return rows.flatMap((row) => {
        const parsed = FactRowSchema.safeParse(row);
        if (!parsed.success) return [];
        return [
          {
            ...parsed.data,
            confidence: parsed.data.confidence ?? 1,
          },
        ];
      });
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

export async function listOmpMemoryFrom(
  root: string,
  cwd: string,
): Promise<{ bank: string | null; facts: OmpMemoryFact[] }> {
  const bank = await newestBank(root, cwd);
  if (!bank) return { bank: null, facts: [] };
  return { bank, facts: listOmpFactsFrom(join(root, bank, "mnemopi.db")) };
}

export async function resolveListOmpMemory({
  cwd,
}: RpcInput<typeof listOmpMemory>): Promise<{ bank: string | null; facts: OmpMemoryFact[] }> {
  return listOmpMemoryFrom(join(ompStateDir(), "memories", "mnemopi", "banks"), cwd);
}
