import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type { listOmpSessions, OmpSessionEntry } from "../shared/sessions";
import { ompDataDir } from "./paths";

const PROMPT_LIMIT = 400;
const ROW_LIMIT = 100;

const SessionRowSchema = z.object({
  id: z.number().int(),
  sessionId: z.string().nullable(),
  title: z.string().nullable(),
  prompt: z.string(),
  createdAt: z.number().int(),
});

export function listOmpSessionsFrom(path: string, cwd: string): OmpSessionEntry[] {
  try {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 500 });
    try {
      const rows = database
        .prepare(
          `SELECT h.id AS id, h.session_id AS sessionId, t.title AS title,
                  h.prompt AS prompt, h.created_at AS createdAt
           FROM history h
           LEFT JOIN session_titles t ON t.session_id = h.session_id
           WHERE h.cwd = ?
           ORDER BY h.created_at DESC, h.id DESC
           LIMIT ?`,
        )
        .all(cwd, ROW_LIMIT);
      return rows.flatMap((row) => {
        const parsed = SessionRowSchema.safeParse(row);
        if (!parsed.success) return [];
        const truncated = parsed.data.prompt.length > PROMPT_LIMIT;
        return [
          {
            ...parsed.data,
            prompt: truncated ? parsed.data.prompt.slice(0, PROMPT_LIMIT) : parsed.data.prompt,
            truncated,
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

export function resolveListOmpSessions({ cwd }: RpcInput<typeof listOmpSessions>): {
  sessions: OmpSessionEntry[];
} {
  return { sessions: listOmpSessionsFrom(join(ompDataDir(), "history.db"), cwd) };
}
