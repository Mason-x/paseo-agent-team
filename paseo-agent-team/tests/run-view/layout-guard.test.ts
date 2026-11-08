import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(ROOT, "client/runs/engine");
const files = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

/**
 * A narrow screen cannot be looked at here (that is the DEV phase's real-browser check), but the
 * ways a card overflows or a button cannot be pressed are visible in the code: a fixed width, a
 * button without a minimum height, a row that cannot wrap. These are the guards for those.
 */
describe("the Engine views stay inside a narrow screen", () => {
  test("no fixed pixel width in any Engine view; the DAG column width is passed in, not styled", () => {
    const widths: string[] = [];
    for (const name of files) {
      for (const match of read(name).matchAll(/\bwidth: (\d+)/gu))
        widths.push(`${name}:${match[1]}`);
    }
    expect(widths).toEqual([]);
  });

  test("the DAG columns live in a horizontal ScrollView, and list mode is the compact one", () => {
    const view = read("EngineView.tsx");
    expect(view).toContain("<ScrollView horizontal>");
    expect(view).toContain("column(layer, 180)");
    // The model picks list mode when the layout is compact, so the columns never reach a small screen.
    expect(readFileSync(path.join(ROOT, "shared/domain/run-engine/view.ts"), "utf8")).toContain(
      'compact ? "list" : "columns"',
    );
    expect(view).toContain("layout.compact");
  });

  test("every pressable control has a touch-sized minimum height", () => {
    const heights = [...read("EngineControls.tsx").matchAll(/minHeight: (\d+)/gu)].map((match) =>
      Number(match[1]),
    );
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);
  });

  test("rows of badges and actions can wrap, and the long texts can shrink", () => {
    expect(read("EngineView.tsx").match(/flexWrap: "wrap"/gu)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
    expect(read("EngineControls.tsx")).toContain("flexShrink: 1");
  });

  test("the page that holds the view scrolls once: the detail is embedded, not a second scroller", () => {
    expect(read("EngineRunsSection.tsx")).toMatch(/\bembedded\b/u);
  });

  test("both polls (detail and list) go through the poller and stop while the page is hidden", () => {
    const hook = read("use-engine-run.ts");
    expect(hook).toContain("createPoller(");
    expect(hook).toContain("usePageVisible()");
    expect(hook).toContain("if (!active || !visible) return;");
    expect(hook).toContain("if (!visible) return;");
    expect(hook).not.toContain("setInterval");
  });
});
