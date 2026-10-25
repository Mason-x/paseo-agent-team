import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AGENT_TEAM_TABS,
  DEFAULT_AGENT_TEAM_TAB,
  parseTab,
  resolveInitialTab,
} from "../client/app/tabs";

describe("tabs", () => {
  test("lists Team first, then Role, then runs", () => {
    expect([...AGENT_TEAM_TABS]).toEqual(["teams", "roles", "runs"]);
  });

  test("opens the Team page when nothing asks for another", () => {
    expect(DEFAULT_AGENT_TEAM_TAB).toBe("teams");
    expect(resolveInitialTab(undefined)).toBe("teams");
    expect(resolveInitialTab("")).toBe("teams");
    expect(resolveInitialTab("unknown")).toBe("teams");
  });

  test("an explicit params.tab still wins (the 'view runs' command opens runs)", () => {
    expect(resolveInitialTab("runs")).toBe("runs");
    expect(resolveInitialTab("roles")).toBe("roles");
    expect(resolveInitialTab("teams")).toBe("teams");
    expect(parseTab("runs")).toBe("runs");
    expect(parseTab("nope")).toBeUndefined();
  });
});

describe("Team page copy", () => {
  const files = [
    "client/designer/TeamDesignerCard.tsx",
    "client/designer/card-state.ts",
    "client/designer/use-designer-workspaces.ts",
    "client/teams/TeamsTab.tsx",
    "shared/domain/design-request.ts",
  ];

  test.each(files)("%s keeps visible text in shared/zh.ts", (file) => {
    const source = readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    expect(source).not.toMatch(/[　-〿㐀-鿿＀-￯]/u);
  });
});
