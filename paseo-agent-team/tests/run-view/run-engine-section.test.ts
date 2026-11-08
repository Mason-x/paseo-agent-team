import { createElement as h } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return {
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Switch: host("Switch"),
    Platform: { OS: "web" },
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  TextInput: (props: Record<string, unknown>) => h("TextInput", props),
}));

import { RunEngineSection } from "../../client/teams/RunEngineSection";
import { setEngineEnabled, setEngineSeat } from "../../shared/domain/run-engine/team-config-edit";
import type { TeamMember } from "../../shared/schemas/team";
import type { TeamPlanRow } from "../../shared/schemas/team-plan";
import { runEngineZh } from "../../shared/zh/run-engine";

const zh = runEngineZh.teamEditor;

type Node = {
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Node) => boolean): Node[];
};
type TestRenderer = {
  act(callback: () => Promise<void> | void): Promise<void>;
  create(element: unknown): { root: Node; unmount(): void };
};
const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const members: TeamMember[] = [
  { roleId: "developer", enabled: true, seatId: "seat-d" },
  { roleId: "architect", enabled: true, seatId: "seat-a" },
];

/** A Team plan row as the server answers it: only what the wiring reads is spelled out. */
function planRow(rowKey: string, overrides: Record<string, unknown> = {}): TeamPlanRow {
  return {
    rowKey,
    kind: "member",
    roleId: "developer",
    roleName: "Developer",
    enabled: true,
    purpose: "member",
    profile: { id: "p1", name: "Codex", provider: "codex", modeId: "auto" },
    ...overrides,
  } as unknown as TeamPlanRow;
}

function filled(): Record<string, unknown> {
  let block: unknown = setEngineEnabled(undefined, true, ["seat-d", "seat-a"]);
  for (const seatId of ["seat-d", "seat-a"]) {
    block = setEngineSeat(block, seatId, { channelId: "claude" });
  }
  return block as Record<string, unknown>;
}

async function mount(planRows: readonly TeamPlanRow[] | undefined, value: unknown = filled()) {
  const onChange = vi.fn();
  let view!: { root: Node; unmount(): void };
  await renderer.act(async () => {
    view = renderer.create(
      h(RunEngineSection, {
        theme,
        members,
        planRows,
        value,
        revision: 0,
        onChange,
      } as never),
    );
  });
  return { view, onChange };
}

const texts = (root: Node) =>
  root
    .findAll((node) => node.type === "Text")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    )
    .join("\n");
/** The node, or a failure that names it: a missing control is a test failure, not a silent no-op. */
const byLabel = (root: Node, label: string, type: string): Node => {
  const node = root.findAll(
    (entry) => entry.type === type && entry.props.accessibilityLabel === label,
  )[0];
  if (node === undefined) throw new Error(`no ${type} labelled "${label}"`);
  return node;
};

const WARNING = "full-access";

describe("RunEngineSection hands the planned Profiles of the Team's seats to the Run Engine editor", () => {
  test("a Codex seat whose Profile is not full-access gets the warning, once the plan has answered", async () => {
    const before = await mount(undefined);
    expect(texts(before.view.root)).not.toContain(WARNING);
    await renderer.act(async () => before.view.unmount());

    const { view } = await mount([planRow("seat:seat-d")]);
    expect(texts(view.root)).toContain(WARNING);
    expect(texts(view.root)).toContain("seat-d");
    await renderer.act(async () => view.unmount());
  });

  test("a full-access Codex Profile, or another provider, gets no warning", async () => {
    const full = await mount([
      planRow("seat:seat-d", {
        profile: { id: "p1", name: "Codex", provider: "codex", modeId: "full-access" },
      }),
    ]);
    expect(texts(full.view.root)).not.toContain(WARNING);
    await renderer.act(async () => full.view.unmount());

    const claude = await mount([
      planRow("seat:seat-d", {
        profile: { id: "p2", name: "Claude", provider: "claude", modeId: "auto" },
      }),
    ]);
    expect(texts(claude.view.root)).not.toContain(WARNING);
    await renderer.act(async () => claude.view.unmount());
  });

  test("a row it cannot be sure of is not guessed: a key the editor did not send, a candidate, two rows, another seat id", async () => {
    const unsure: readonly (readonly TeamPlanRow[])[] = [
      [planRow("seat:someone-else")],
      [planRow("seat:seat-d", { purpose: "candidate" })],
      [planRow("seat:seat-d"), planRow("seat:seat-d")],
      [planRow("seat:seat-d", { logicalSeatId: "seat-x" })],
      [planRow("seat:seat-d", { profile: null })],
      [planRow("seat:seat-d", { enabled: false })],
    ];
    for (const rows of unsure) {
      const { view } = await mount(rows);
      expect(texts(view.root)).not.toContain(WARNING);
      await renderer.act(async () => view.unmount());
    }
  });

  test("editing a policy number writes the block back with every field it did not know", async () => {
    const stored = {
      ...filled(),
      futureField: { keep: "me" },
    } as Record<string, unknown>;
    stored.policy = { ...(stored.policy as Record<string, unknown>), futureLimit: 7 };
    const { view, onChange } = await mount(undefined, stored);
    await renderer.act(async () =>
      (
        byLabel(view.root, zh.numbers.configuredConcurrency, "TextInput").props.onChangeText as (
          text: string,
        ) => void
      )("5"),
    );
    const next = onChange.mock.calls[0]?.[0] as {
      futureField?: unknown;
      policy: { configuredConcurrency: number; futureLimit?: unknown };
    };
    if (next === undefined) throw new Error("onChange did not happen");
    expect(next.policy.configuredConcurrency).toBe(5);
    expect(next.policy.futureLimit).toBe(7);
    expect(next.futureField).toEqual({ keep: "me" });
    await renderer.act(async () => view.unmount());
  });
});
