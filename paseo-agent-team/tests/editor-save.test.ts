import { describe, expect, test, vi } from "vitest";
import {
  decideEditorSave,
  type EditorDocumentSnapshot,
  type EditorParsed,
  loadEditorSnapshot,
  mergeEditorDocument,
  mergeEditorRow,
  sameEditorRow,
  saveEditorRow,
} from "../client/catalog/editor-save";

type Row = { id: string; name: string; future?: unknown };

const parseRoles = (values: unknown): EditorParsed<Row> => {
  if (!values || typeof values !== "object" || !("roles" in values)) {
    return { ok: false, error: "bad roles" };
  }
  const roles = values.roles;
  if (!Array.isArray(roles)) return { ok: false, error: "bad roles" };
  return { ok: true, rows: roles as Row[] };
};

function snapshot(rows: Row[], revision: string): EditorDocumentSnapshot<Row> {
  return { revision, rows };
}

const rowA: Row = { id: "a", name: "A" };
const rowB: Row = { id: "b", name: "B" };

/** Stateful CAS settings fake: exact revision compare, commit, then increment. */
class CasStore {
  private rows: Row[];
  private revision: number;

  constructor(rows: Row[], revision = 1) {
    this.rows = structuredClone(rows);
    this.revision = revision;
  }

  get currentRevision(): string {
    return `r${this.revision}`;
  }

  read() {
    return {
      status: "ready" as const,
      revision: this.currentRevision,
      values: { roles: structuredClone(this.rows), futureDoc: { keep: true } },
    };
  }

  async write(document: unknown, expected: string) {
    if (expected !== this.currentRevision) return { status: "conflict" as const };
    if (!document || typeof document !== "object" || !("roles" in document)) {
      return { status: "invalid" as const };
    }
    const roles = document.roles;
    if (!Array.isArray(roles)) return { status: "invalid" as const };
    this.rows = structuredClone(roles);
    this.revision += 1;
    return { status: "saved" as const };
  }

  /** Another client's committed write, simulated between a read and a CAS. */
  externalWrite(mutate: (rows: Row[]) => Row[]): void {
    this.rows = mutate(structuredClone(this.rows));
    this.revision += 1;
  }

  rowsSnapshot(): Row[] {
    return structuredClone(this.rows);
  }
}

describe("editor conflict decisions", () => {
  const opened = snapshot([rowA, rowB], "r1");

  test("compares rows canonically and ignores key order", () => {
    expect(sameEditorRow({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    expect(sameEditorRow({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameEditorRow(null, null)).toBe(true);
  });

  test("writes when the baseline still matches the latest row", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: rowA,
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r2"),
      }),
    ).toBe("write");
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: rowA,
        opened,
        latest: snapshot(
          [
            { id: "b", name: "B2" },
            { id: "a", name: "A" },
          ],
          "r2",
        ),
      }),
    ).toBe("write");
  });

  test("a changed or deleted row is the matching conflict kind", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: rowA,
        opened,
        latest: snapshot([{ id: "a", name: "changed" }], "r2"),
      }),
    ).toBe("modified");
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: rowA,
        opened,
        latest: snapshot([{ id: "b", name: "B" }], "r2"),
      }),
    ).toBe("deleted");
  });

  test("a baseline that disagrees with the opened snapshot is stale", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: rowA,
        opened: snapshot([{ id: "a", name: "already changed" }], "r1"),
        latest: snapshot([{ id: "a", name: "already changed" }], "r1"),
      }),
    ).toBe("modified");
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: null,
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r1"),
      }),
    ).toBe("modified");
  });

  test("create always rejects an occupied id, even with overwrite or the same revision", () => {
    expect(
      decideEditorSave({
        mode: "create",
        id: "a",
        baseline: null,
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r1"),
      }),
    ).toBe("id-taken");
    expect(
      decideEditorSave({
        mode: "create",
        id: "a",
        baseline: null,
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r2"),
        forceOverwrite: true,
      }),
    ).toBe("id-taken");
    expect(
      decideEditorSave({
        mode: "create",
        id: "c",
        baseline: null,
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r2"),
      }),
    ).toBe("write");
  });

  test("force overwrite replaces a modified row", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        baseline: rowA,
        opened,
        latest: snapshot([{ id: "a", name: "changed" }], "r2"),
        forceOverwrite: true,
      }),
    ).toBe("write");
  });
});

describe("editor merge", () => {
  test("replaces in place or appends, and keeps the raw document shape", () => {
    expect(mergeEditorRow([{ id: "a" }, { id: "b" }], { id: "b", name: "B2" })).toEqual([
      { id: "a" },
      { id: "b", name: "B2" },
    ]);
    expect(mergeEditorRow([{ id: "a" }], { id: "b", name: "B" })).toEqual([
      { id: "a" },
      { id: "b", name: "B" },
    ]);
    expect(
      mergeEditorDocument({ roles: [], futureDoc: 1, custom: { keep: true } }, "roles", [
        { id: "a" },
      ]),
    ).toEqual({ roles: [{ id: "a" }], futureDoc: 1, custom: { keep: true } });
  });
});

describe("loadEditorSnapshot", () => {
  test("returns the parsed rows with the same revision", async () => {
    expect(
      await loadEditorSnapshot(
        async () => ({ status: "ready", revision: "r1", values: { roles: [{ id: "a" }] } }),
        parseRoles,
      ),
    ).toEqual({ ok: true, snapshot: { revision: "r1", rows: [{ id: "a" }] } });
  });

  test("reports invalid reads, parse failures, and transport errors", async () => {
    expect(
      await loadEditorSnapshot(async () => ({ status: "invalid", error: "nope" }), parseRoles),
    ).toEqual({ ok: false, error: "nope" });
    expect(
      (
        await loadEditorSnapshot(
          async () => ({ status: "ready", revision: "r1", values: {} }),
          parseRoles,
        )
      ).ok,
    ).toBe(false);
    expect(
      await loadEditorSnapshot(async () => {
        throw new Error("offline");
      }, parseRoles),
    ).toEqual({ ok: false, error: "" });
  });
});

describe("saveEditorRow", () => {
  test("merges into the fresh document and keeps unrelated rows and unknown keys", async () => {
    const store = new CasStore([rowA, rowB]);
    const opened = store.read();
    const write = vi.fn((document: unknown, revision: string) => store.write(document, revision));

    const result = await saveEditorRow({
      mode: "edit",
      key: "roles",
      row: { id: "a", name: "A-edited" },
      baseline: rowA,
      opened: { revision: opened.revision, rows: [rowA, rowB] },
      read: async () => store.read(),
      write,
      parse: parseRoles,
    });

    expect(result).toBe("saved");
    expect(store.rowsSnapshot()).toEqual([
      { id: "a", name: "A-edited" },
      { id: "b", name: "B" },
    ]);
    expect(write).toHaveBeenCalledWith(
      { roles: [{ id: "a", name: "A-edited" }, rowB], futureDoc: { keep: true } },
      "r1",
    );
  });

  test("returns the matching conflict kind without writing", async () => {
    const write = vi.fn(async () => ({ status: "saved" as const }));
    const base = {
      mode: "edit" as const,
      key: "roles" as const,
      row: { id: "a", name: "A-edited" },
      baseline: rowA,
      opened: snapshot([rowA], "r1"),
      write,
      parse: parseRoles,
    };

    expect(
      await saveEditorRow({
        ...base,
        read: async () => ({
          status: "ready",
          revision: "r2",
          values: { roles: [{ id: "a", name: "changed" }] },
        }),
      }),
    ).toBe("modified");
    expect(
      await saveEditorRow({
        ...base,
        read: async () => ({ status: "ready", revision: "r2", values: { roles: [] } }),
      }),
    ).toBe("deleted");
    expect(write).not.toHaveBeenCalled();
  });

  test("create rejects an existing id even when the revision did not move", async () => {
    const write = vi.fn(async () => ({ status: "saved" as const }));
    const result = await saveEditorRow({
      mode: "create",
      key: "roles",
      row: { id: "a", name: "new" },
      baseline: null,
      opened: snapshot([rowA], "r1"),
      read: async () => ({ status: "ready", revision: "r1", values: { roles: [rowA] } }),
      write,
      parse: parseRoles,
    });
    expect(result).toBe("id-taken");
    expect(write).not.toHaveBeenCalled();
    expect(
      await saveEditorRow({
        mode: "create",
        key: "roles",
        row: { id: "a", name: "new" },
        baseline: null,
        opened: snapshot([rowA], "r1"),
        forceOverwrite: true,
        read: async () => ({ status: "ready", revision: "r1", values: { roles: [rowA] } }),
        write,
        parse: parseRoles,
      }),
    ).toBe("id-taken");
    expect(write).not.toHaveBeenCalled();
  });

  test("force overwrite replaces the modified row after a fresh read", async () => {
    const store = new CasStore([{ id: "a", name: "theirs" }]);
    const result = await saveEditorRow({
      mode: "edit",
      key: "roles",
      row: { id: "a", name: "mine" },
      baseline: rowA,
      opened: snapshot([rowA], "r1"),
      forceOverwrite: true,
      read: async () => store.read(),
      write: (document, revision) => store.write(document, revision),
      parse: parseRoles,
    });
    expect(result).toBe("saved");
    expect(store.rowsSnapshot()).toEqual([{ id: "a", name: "mine" }]);
  });

  test("re-reads after a CAS conflict and merges an unrelated change", async () => {
    const store = new CasStore([rowA, rowB]);
    const opened = store.read();
    let interfered = false;
    const result = await saveEditorRow({
      mode: "edit",
      key: "roles",
      row: { id: "a", name: "A-edited" },
      baseline: rowA,
      opened: { revision: opened.revision, rows: [rowA, rowB] },
      read: async () => {
        if (!interfered) {
          interfered = true;
          store.externalWrite((rows) => [...rows, { id: "c", name: "C" }]);
        }
        return store.read();
      },
      write: (document, revision) => store.write(document, revision),
      parse: parseRoles,
    });
    expect(result).toBe("saved");
    expect(store.rowsSnapshot()).toEqual([
      { id: "a", name: "A-edited" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ]);
  });

  test("re-reads after a CAS conflict and reports a changed row", async () => {
    const store = new CasStore([rowA, rowB]);
    const opened = store.read();
    let interfered = false;
    const result = await saveEditorRow({
      mode: "edit",
      key: "roles",
      row: { id: "a", name: "A-edited" },
      baseline: rowA,
      opened: { revision: opened.revision, rows: [rowA, rowB] },
      read: async () => {
        if (!interfered) {
          interfered = true;
          store.externalWrite((rows) =>
            rows.map((row) => (row.id === "a" ? { ...row, name: "theirs" } : row)),
          );
        }
        return store.read();
      },
      write: (document, revision) => store.write(document, revision),
      parse: parseRoles,
    });
    expect(result).toBe("modified");
    expect(store.rowsSnapshot().find((row) => row.id === "a")).toEqual({
      id: "a",
      name: "theirs",
    });
  });

  test("two consecutive CAS interruptions are busy, not a row conflict", async () => {
    const store = new CasStore([rowA]);
    const opened = store.read();
    const result = await saveEditorRow({
      mode: "edit",
      key: "roles",
      row: { id: "a", name: "A-edited" },
      baseline: rowA,
      opened: { revision: opened.revision, rows: [rowA] },
      read: async () => store.read(),
      write: async () => {
        store.externalWrite((rows) => [...rows]);
        return { status: "conflict" as const };
      },
      parse: parseRoles,
    });
    expect(result).toBe("busy");
  });

  test("reports invalid reads, invalid writes, and transport failures", async () => {
    const base = {
      mode: "edit" as const,
      key: "roles" as const,
      row: { id: "a", name: "A" },
      baseline: rowA,
      opened: snapshot([rowA], "r1"),
      parse: parseRoles,
    };
    expect(
      await saveEditorRow({
        ...base,
        read: async () => ({ status: "invalid", error: "nope" }),
        write: vi.fn(),
      }),
    ).toBe("invalid");
    expect(
      await saveEditorRow({
        ...base,
        read: async () => ({
          status: "ready",
          revision: "r2",
          values: { roles: [{ id: "a", name: "A" }] },
        }),
        write: vi.fn(async () => ({ status: "invalid" as const })),
      }),
    ).toBe("invalid");
    expect(
      await saveEditorRow({
        ...base,
        read: async () => ({
          status: "ready",
          revision: "r2",
          values: { roles: [{ id: "a", name: "A" }] },
        }),
        write: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    ).toBe("failed");
  });
});
