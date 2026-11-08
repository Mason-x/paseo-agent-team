import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "../..");
const doc = readFileSync(path.resolve(PLUGIN, "../docs/run-engine-acceptance.md"), "utf8");

const AC_IDS = Array.from({ length: 22 }, (_, index) => `AC${String(index + 1).padStart(2, "0")}`);
const STATUSES = ["已覆盖", "部分", "未覆盖", "需 DEV"];

type Reference = { ac: string; file: string; title: string; template: boolean };

function references(): Reference[] {
  const out: Reference[] = [];
  let ac = "";
  for (const line of doc.split("\n")) {
    const heading = /^### (AC\d{2}) /u.exec(line);
    if (heading) ac = heading[1] as string;
    const match = /^- (tests\/\S+\.ts) :: (.+)$/u.exec(line);
    if (!match) continue;
    const rest = match[2] as string;
    const cut = rest.indexOf(" — ");
    const title = (cut === -1 ? rest : rest.slice(0, cut)).trim();
    const note = cut === -1 ? "" : rest.slice(cut + 3);
    out.push({
      ac,
      file: match[1] as string,
      title,
      template: note.includes("模板") || /%[sij]|\$\w+/u.test(title),
    });
  }
  return out;
}

/**
 * `docs/run-engine-acceptance.md` says which tests show each acceptance item. A reference that no
 * longer points at a real test is worse than none, so every one is looked up in the file it names.
 */
describe("the acceptance table points at tests that exist", () => {
  const refs = references();

  test("every AC has a row in the summary table with a status from the legend", () => {
    for (const id of AC_IDS) {
      const row = doc.split("\n").find((line) => line.startsWith(`| ${id} | `));
      expect(row, `${id} has no row`).toBeDefined();
      const cells = (row as string).split(" | ");
      const status = cells[2] as string;
      expect(
        STATUSES.some((name) => status.startsWith(name)),
        `${id}: status "${status}"`,
      ).toBe(true);
    }
  });

  test("every AC has an evidence section", () => {
    for (const id of AC_IDS) {
      expect(doc, `${id} has no evidence section`).toMatch(new RegExp(`^### ${id} `, "mu"));
    }
  });

  test("the references are many, and every AC with a status of covered or partial cites a test", () => {
    expect(refs.length).toBeGreaterThan(80);
    for (const id of AC_IDS) {
      expect(refs.filter((ref) => ref.ac === id).length, `${id} cites no test`).toBeGreaterThan(0);
    }
  });

  test("each cited file exists", () => {
    const missing = [...new Set(refs.map((ref) => ref.file))].filter(
      (file) => !existsSync(path.resolve(PLUGIN, file)),
    );
    expect(missing).toEqual([]);
  });

  test("each cited title is in the file it is cited for (templates are not checked)", () => {
    const wrong: string[] = [];
    for (const ref of refs) {
      if (ref.template || !existsSync(path.resolve(PLUGIN, ref.file))) continue;
      const source = readFileSync(path.resolve(PLUGIN, ref.file), "utf8");
      const variants = [
        ref.title,
        ref.title.replaceAll("'", "\\'"),
        ref.title.replaceAll('"', '\\"'),
      ];
      if (!variants.some((variant) => source.includes(variant))) {
        wrong.push(`${ref.ac} ${ref.file} :: ${ref.title}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
