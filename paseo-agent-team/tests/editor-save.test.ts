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
  const document = values as { roles?: Row[] } | null;
  return Array.isArray(document?.roles)
    ? { ok: true, rows: document.roles }
    : { ok: false, error: "bad roles" };
};

function snapshot(rows: Row[], revision: string): EditorDocumentSnapshot<Row> {
  return { revision, rows };
}

describe("editor conflict decisions", () => {
  const opened = snapshot(
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    "r1",
  );

  test("compares rows canonically and ignores key order", () => {
    expect(sameEditorRow({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
    expect(sameEditorRow({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameEditorRow(null, null)).toBe(true);
  });

  test("same revision or unrelated row changes may write", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        opened,
        latest: snapshot([{ id: "a", name: "changed" }], "r1"),
      }),
    ).toBe("write");
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
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

  test("a changed or deleted edited row is a conflict", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        opened,
        latest: snapshot([{ id: "a", name: "changed" }], "r2"),
      }),
    ).toBe("conflict");
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
        opened,
        latest: snapshot([{ id: "b", name: "B" }], "r2"),
      }),
    ).toBe("conflict");
  });

  test("create conflicts only when the id was taken", () => {
    expect(
      decideEditorSave({
        mode: "create",
        id: "c",
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r2"),
      }),
    ).toBe("write");
    expect(
      decideEditorSave({
        mode: "create",
        id: "a",
        opened,
        latest: snapshot([{ id: "a", name: "A" }], "r2"),
      }),
    ).toBe("conflict");
  });

  test("force overwrite always writes", () => {
    expect(
      decideEditorSave({
        mode: "edit",
        id: "a",
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
    const opened = snapshot(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      "r1",
    );
    const write = vi.fn(async () => ({ status: "saved" as const }));

    const result = await saveEditorRow({
      mode: "edit",
      key: "roles",
      row: { id: "a", name: "A-edited" },
      opened,
      read: async () => ({
        status: "ready",
        revision: "r2",
        values: {
          roles: [
            { id: "b", name: "B2", future: "keep" },
            { id: "a", name: "A" },
          ],
          futureDoc: { keep: true },
        },
      }),
      write,
      parse: parseRoles,
    });

    expect(result).toBe("saved");
    expect(write).toHaveBeenCalledWith(
      {
        roles: [
          { id: "b", name: "B2", future: "keep" },
          { id: "a", name: "A-edited" },
        ],
        futureDoc: { keep: true },
      },
      "r2",
    );
  });

  test("does not write when the edited row changed or was deleted", async () => {
    const opened = snapshot([{ id: "a", name: "A" }], "r1");
    const write = vi.fn(async () => ({ status: "saved" as const }));

    expect(
      await saveEditorRow({
        mode: "edit",
        key: "roles",
        row: { id: "a", name: "A-edited" },
        opened,
        read: async () => ({
          status: "ready",
          revision: "r2",
          values: { roles: [{ id: "a", name: "changed" }] },
        }),
        write,
        parse: parseRoles,
      }),
    ).toBe("conflict");
    expect(write).not.toHaveBeenCalled();
  });

  test("force overwrite replaces the concurrent row", async () => {
    const opened = snapshot([{ id: "a", name: "A" }], "r1");
    const write = vi.fn(async () => ({ status: "saved" as const }));

    expect(
      await saveEditorRow({
        mode: "edit",
        key: "roles",
        row: { id: "a", name: "A-mine" },
        opened,
        forceOverwrite: true,
        read: async () => ({
          status: "ready",
          revision: "r2",
          values: { roles: [{ id: "a", name: "theirs" }] },
        }),
        write,
        parse: parseRoles,
      }),
    ).toBe("saved");
    expect(write).toHaveBeenCalledWith({ roles: [{ id: "a", name: "A-mine" }] }, "r2");
  });

  test("create conflicts when another client took the id", async () => {
    const write = vi.fn(async () => ({ status: "saved" as const }));
    expect(
      await saveEditorRow({
        mode: "create",
        key: "roles",
        row: { id: "a", name: "A" },
        opened: snapshot([], "r1"),
        read: async () => ({
          status: "ready",
          revision: "r2",
          values: { roles: [{ id: "a", name: "theirs" }] },
        }),
        write,
        parse: parseRoles,
      }),
    ).toBe("conflict");
    expect(write).not.toHaveBeenCalled();
  });

  test("retries once after a write conflict and reports exhaustion", async () => {
    const opened = snapshot([{ id: "a", name: "A" }], "r1");
    const values = { roles: [{ id: "a", name: "A" }] };
    const read = async () => ({ status: "ready" as const, revision: "r2", values });
    const succeeding = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict" })
      .mockResolvedValueOnce({ status: "saved" });
    expect(
      await saveEditorRow({
        mode: "edit",
        key: "roles",
        row: { id: "a", name: "A" },
        opened,
        read,
        write: succeeding,
        parse: parseRoles,
      }),
    ).toBe("saved");
    expect(succeeding).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => ({ status: "conflict" as const }));
    expect(
      await saveEditorRow({
        mode: "edit",
        key: "roles",
        row: { id: "a", name: "A" },
        opened,
        read,
        write: failing,
        parse: parseRoles,
      }),
    ).toBe("conflict");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  test("reports invalid reads, invalid writes, and transport failures", async () => {
    const opened = snapshot([{ id: "a", name: "A" }], "r1");
    const base = {
      mode: "edit" as const,
      key: "roles" as const,
      row: { id: "a", name: "A" },
      opened,
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
