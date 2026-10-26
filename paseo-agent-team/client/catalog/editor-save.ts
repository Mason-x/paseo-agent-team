/**
 * Conflict-safe row saving shared by the Role and Team editors.
 *
 * The editor captures the document revision and rows when it opens. A save re-reads the document,
 * compares the edited row (not unrelated rows) with that snapshot, merges into the fresh document,
 * and writes with the fresh revision. A concurrent change to the same row is a conflict; changes
 * to other rows are preserved instead of being overwritten.
 */

export type EditorDocumentSnapshot<Row> = {
  revision: string;
  rows: readonly Row[];
};

export type EditorSaveDecision = "write" | "conflict";

export type EditorReadReply =
  | { status: "ready"; revision: string; values: unknown }
  | { status: "invalid"; revision?: string; error: string };

export type EditorParsed<Row> = { ok: true; rows: Row[] } | { ok: false; error: string };

export type EditorWriteReply =
  | { status: "saved" }
  | { status: "conflict" }
  | { status: "invalid"; error?: string };

export type EditorSaveResult = "saved" | "conflict" | "invalid" | "failed";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry) ?? null);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** Key order is irrelevant; array order and explicit null are significant. */
export function sameEditorRow(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
}

/**
 * A save may proceed when the document still holds the row exactly as it was opened. Any change
 * to that row (or its deletion) is a conflict; unrelated row changes are merged.
 */
export function decideEditorSave<Row extends { id: string }>(input: {
  mode: "create" | "edit";
  id: string;
  opened: EditorDocumentSnapshot<Row>;
  latest: EditorDocumentSnapshot<Row>;
  forceOverwrite?: boolean;
}): EditorSaveDecision {
  if (input.forceOverwrite) return "write";
  if (input.opened.revision === input.latest.revision) return "write";
  const latestRow = input.latest.rows.find((row) => row.id === input.id);
  if (input.mode === "create") return latestRow ? "conflict" : "write";
  const openedRow = input.opened.rows.find((row) => row.id === input.id);
  if (!openedRow || !latestRow) return "conflict";
  return sameEditorRow(openedRow, latestRow) ? "write" : "conflict";
}

/** Replace the row in place, or append it when absent. Array order is otherwise untouched. */
export function mergeEditorRow<Row extends { id: string }>(rows: readonly Row[], row: Row): Row[] {
  const index = rows.findIndex((entry) => entry.id === row.id);
  if (index < 0) return [...rows, row];
  const next = [...rows];
  next[index] = row;
  return next;
}

/** Keep the raw document (including unknown top-level keys) and replace only its row list. */
export function mergeEditorDocument(
  raw: unknown,
  key: "roles" | "teams",
  rows: readonly unknown[],
): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  return { ...base, [key]: rows };
}

function rawRows(raw: unknown, key: "roles" | "teams"): unknown[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const rows = (raw as Record<string, unknown>)[key];
  return Array.isArray(rows) ? rows : [];
}

/** Read one version of the document and remember its revision plus parsed rows. */
export async function loadEditorSnapshot<Row extends { id: string }>(
  read: () => Promise<EditorReadReply>,
  parse: (values: unknown) => EditorParsed<Row>,
): Promise<{ ok: true; snapshot: EditorDocumentSnapshot<Row> } | { ok: false; error: string }> {
  try {
    const reply = await read();
    if (reply.status !== "ready") return { ok: false, error: reply.error };
    const parsed = parse(reply.values);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, snapshot: { revision: reply.revision, rows: parsed.rows } };
  } catch {
    return { ok: false, error: "" };
  }
}

/**
 * Fresh read -> conflict decision -> merge -> CAS write. Only an explicit write conflict retries
 * (twice); the next decision catches a racing change to the same row.
 */
export async function saveEditorRow<Row extends { id: string }>(input: {
  mode: "create" | "edit";
  key: "roles" | "teams";
  row: Row;
  opened: EditorDocumentSnapshot<Row>;
  forceOverwrite?: boolean;
  read: () => Promise<EditorReadReply>;
  write: (document: Record<string, unknown>, revision: string) => Promise<EditorWriteReply>;
  parse: (values: unknown) => EditorParsed<Row>;
}): Promise<EditorSaveResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply: EditorReadReply;
    try {
      reply = await input.read();
    } catch {
      return "failed";
    }
    if (reply.status !== "ready") return "invalid";
    const parsed = input.parse(reply.values);
    if (!parsed.ok) return "invalid";

    const latest = { revision: reply.revision, rows: parsed.rows };
    if (
      decideEditorSave({
        mode: input.mode,
        id: input.row.id,
        opened: input.opened,
        latest,
        forceOverwrite: input.forceOverwrite,
      }) === "conflict"
    ) {
      return "conflict";
    }

    const merged = mergeEditorRow(rawRows(reply.values, input.key) as Row[], input.row);
    let write: EditorWriteReply;
    try {
      write = await input.write(
        mergeEditorDocument(reply.values, input.key, merged),
        reply.revision,
      );
    } catch {
      return "failed";
    }
    if (write.status === "saved") return "saved";
    if (write.status === "invalid") return "invalid";
  }
  return "conflict";
}
