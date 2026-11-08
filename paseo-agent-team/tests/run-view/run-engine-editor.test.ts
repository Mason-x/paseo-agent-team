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

import { RunEngineEditor } from "../../client/teams/RunEngineEditor";
import {
  setEngineEnabled,
  setEngineSeat,
  startFreshEngineBlock,
} from "../../shared/domain/run-engine/team-config-edit";
import type { TeamMember } from "../../shared/schemas/team";
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

async function mount(value: unknown, extra: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  let view!: { root: Node; unmount(): void };
  await renderer.act(async () => {
    view = renderer.create(
      h(RunEngineEditor, { theme, members, value, revision: 0, onChange, ...extra } as never),
    );
  });
  return { view, onChange };
}

/** The first argument of the nth call, or a failure: a call that did not happen is not a quiet undefined. */
const written = <T>(fn: { mock: { calls: unknown[][] } }, call: number): T => {
  const args = fn.mock.calls[call];
  if (args === undefined) throw new Error(`call ${call} did not happen`);
  return args[0] as T;
};

const texts = (root: Node) =>
  root
    .findAll((node) => node.type === "Text")
    .map((node) =>
      Array.isArray(node.props.children)
        ? node.props.children.join("")
        : String(node.props.children ?? ""),
    );
const find = (root: Node, label: string, type = "Pressable") =>
  root.findAll((node) => node.type === type && node.props.accessibilityLabel === label)[0];
/** The node, or a failure that names it: a missing control is a test failure, not a silent no-op. */
const byLabel = (root: Node, label: string, type = "Pressable"): Node => {
  const node = find(root, label, type);
  if (node === undefined) throw new Error(`no ${type} labelled "${label}"`);
  return node;
};

function filled(): Record<string, unknown> {
  let block: unknown = setEngineEnabled(undefined, true, ["seat-d", "seat-a"]);
  for (const seatId of ["seat-d", "seat-a"]) {
    block = setEngineSeat(block, seatId, { channelId: "claude" });
  }
  return block as Record<string, unknown>;
}

describe("RunEngineEditor", () => {
  test("with no block it shows only the switch, and turning it on writes the defaults for the Team's seats", async () => {
    const { view, onChange } = await mount(undefined);
    expect(texts(view.root)).toContain(zh.statusLabel.absent);
    expect(find(view.root, zh.enable, "Switch")).toBeDefined();
    expect(texts(view.root)).not.toContain(zh.seats);
    await renderer.act(async () =>
      (byLabel(view.root, zh.enable, "Switch").props.onValueChange as (on: boolean) => void)(true),
    );
    const written = onChange.mock.calls[0]?.[0] as {
      enabled: boolean;
      seats: { seatId: string }[];
    };
    expect(written.enabled).toBe(true);
    expect(written.seats.map((seat) => seat.seatId)).toEqual(["seat-d", "seat-a"]);
    await renderer.act(async () => view.unmount());
  });

  test("an enabled block shows a card per seat, the numbers, and what launch would refuse", async () => {
    const { view } = await mount(setEngineSeat(filled(), "seat-d", { channelId: "" }));
    const text = texts(view.root);
    expect(text).toContain("seat-d");
    expect(text).toContain("seat-a");
    expect(text).toContain(zh.numbers.configuredConcurrency);
    // The shape problem of the empty channel is named by its path.
    expect(text.some((line) => line.includes("seats.0.channelId"))).toBe(true);
    await renderer.act(async () => view.unmount());
  });

  test("a good block says launch would take the Engine, once each producer has a reviewer", async () => {
    let block: unknown = filled();
    // seat-d produces at tier A, seat-a reviews at tier A: nothing left to warn about.
    block = setEngineSeat(block, "seat-d", { tier: "A" });
    block = setEngineSeat(block, "seat-a", { tier: "A" });
    block = setEngineSeat(block, "seat-a", { duty: { name: "review", on: true } });
    block = setEngineSeat(block, "seat-a", { duty: { name: "implement", on: false } });
    const { view } = await mount(block);
    expect(texts(view.root)).toContain(zh.ready);
    await renderer.act(async () => view.unmount());
  });

  test("a block that launch would accept with a warning shows the warning and not the all-clear", async () => {
    // seat-d produces at tier B and only seat-a (tier B) reviews: nothing reviews its L2 work at tier A.
    let block: unknown = filled();
    block = setEngineSeat(block, "seat-a", { duty: { name: "review", on: true } });
    block = setEngineSeat(block, "seat-a", { duty: { name: "implement", on: false } });
    const { view } = await mount(block);
    const text = texts(view.root);
    expect(text).toContain(zh.warnings);
    expect(text).not.toContain(zh.ready);
    await renderer.act(async () => view.unmount());
  });

  test("the planned Profiles of the seats let the editor warn about a Codex seat that is not full-access", async () => {
    const without = await mount(filled());
    expect(texts(without.view.root).join("\n")).not.toContain("full-access");
    await renderer.act(async () => without.view.unmount());
    const { view } = await mount(filled(), {
      seatProfiles: [{ seatId: "seat-d", provider: "codex", modeId: "auto" }],
    });
    expect(texts(view.root).join("\n")).toContain("full-access");
    await renderer.act(async () => view.unmount());
  });

  test("a tier, a duty, a channel and a number each write back through the edit functions", async () => {
    const { view, onChange } = await mount(filled());
    await renderer.act(async () => (byLabel(view.root, "A seat-d").props.onPress as () => void)());
    expect(written<{ seats: { tier: string }[] }>(onChange, 0).seats[0]?.tier).toBe("A");

    await renderer.act(async () =>
      (byLabel(view.root, `${zh.duty.review} seat-d`).props.onPress as () => void)(),
    );
    expect(written<{ seats: { duties: string[] }[] }>(onChange, 1).seats[0]?.duties).toEqual([
      "implement",
      "review",
    ]);

    await renderer.act(async () =>
      (
        byLabel(view.root, `${zh.channel} seat-d`, "TextInput").props.onChangeText as (
          text: string,
        ) => void
      )("codex"),
    );
    expect(written<{ seats: { channelId: string }[] }>(onChange, 2).seats[0]?.channelId).toBe(
      "codex",
    );

    await renderer.act(async () =>
      (
        byLabel(view.root, zh.numbers.configuredConcurrency, "TextInput").props.onChangeText as (
          text: string,
        ) => void
      )("5"),
    );
    expect(
      written<{ policy: { configuredConcurrency: number } }>(onChange, 3).policy
        .configuredConcurrency,
    ).toBe(5);
    await renderer.act(async () => view.unmount());
  });

  test("a Team seat with no engine seat, and an engine seat with no member, are offered a fix each", async () => {
    const block = setEngineEnabled(undefined, true, ["seat-d", "seat-gone"]);
    const { view, onChange } = await mount(block);
    const text = texts(view.root).join("\n");
    expect(text).toContain("seat-a");
    expect(text).toContain("seat-gone");
    await renderer.act(async () =>
      (byLabel(view.root, zh.addMissing).props.onPress as () => void)(),
    );
    expect(
      written<{ seats: { seatId: string }[] }>(onChange, 0).seats.map((seat) => seat.seatId),
    ).toEqual(["seat-d", "seat-gone", "seat-a"]);
    await renderer.act(async () =>
      (byLabel(view.root, zh.removeOrphans).props.onPress as () => void)(),
    );
    expect(
      written<{ seats: { seatId: string }[] }>(onChange, 1).seats.map((seat) => seat.seatId),
    ).toEqual(["seat-d"]);
    await renderer.act(async () => view.unmount());
  });

  test("a damaged block is explained, not edited: no switch, no seats, and only starting fresh replaces it", async () => {
    const { view, onChange } = await mount({ version: 7, enabled: true, mystery: 1 });
    expect(texts(view.root)).toContain(zh.invalidTitle);
    expect(find(view.root, zh.enable, "Switch")).toBeUndefined();
    expect(texts(view.root)).not.toContain(zh.seats);
    expect(onChange).not.toHaveBeenCalled();
    await renderer.act(async () =>
      (byLabel(view.root, zh.startFresh).props.onPress as () => void)(),
    );
    expect(onChange).toHaveBeenCalledWith(startFreshEngineBlock(["seat-d", "seat-a"]));
    await renderer.act(async () => view.unmount());
  });

  test("a disabled block keeps its settings visible and the switch off", async () => {
    const { view } = await mount(setEngineEnabled(filled(), false, ["seat-d", "seat-a"]));
    expect(texts(view.root)).toContain(zh.statusLabel.disabled);
    expect(byLabel(view.root, zh.enable, "Switch").props.value).toBe(false);
    expect(texts(view.root)).toContain("seat-d");
    await renderer.act(async () => view.unmount());
  });
});
