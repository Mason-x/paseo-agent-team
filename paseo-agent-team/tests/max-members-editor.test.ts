import { createElement as h } from "react";
// @ts-expect-error react-test-renderer ships no types in this project.
import * as reactTestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Node = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: Node) => boolean): Node[];
};
type TestRenderer = {
  act(callback: () => Promise<void> | void): Promise<void>;
  create(element: unknown): { root: Node; unmount(): void };
};

const transport = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  plan: vi.fn(),
}));

vi.mock("@getpaseo/plugin", () => ({
  settingsRpc: () => ({ read: "read", write: "write" }),
  defineRpc: (definition: { name: string }) => definition.name,
  defineSettings: (definition: { id: string }) => definition,
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: string) =>
    rpc === "read" ? transport.read : rpc === "write" ? transport.write : transport.plan,
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const Modal = Object.assign(
    (props: Record<string, unknown>) => h("Modal", props, props.children as React.ReactNode),
    {
      Content: (props: Record<string, unknown>) =>
        h("ModalContent", props, props.children as React.ReactNode),
    },
  );
  return { Modal };
});
vi.mock("../client/shared/Field", () => ({
  TextField: (props: Record<string, unknown>) => h("TextField", props),
}));
vi.mock("../client/shared/buttons", () => ({
  ModalActions: (props: Record<string, unknown>) => h("ModalActions", props),
}));

import { MaxMembersEditor } from "../client/settings/MaxMembersEditor";
import type { PluginTheme } from "../client/shared/theme";
import { zh } from "../shared/zh";

const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const theme = {
  colors: { foregroundMuted: "#000", statusDanger: "#000", statusWarning: "#000" },
} as PluginTheme;
const raw = {
  maxMembers: 8,
  archiveOnLaunchFailure: true,
  recentRuns: [],
  economy: { pool: [{ profileId: "old" }], extra: { keep: true } },
  quotaRecovery: { mode: "manual", future: { keep: [1, 2] } },
  defaultPresets: { catalogRevision: "r", seenRoleIds: ["r1"], extension: { keep: true } },
  extension: { nested: ["preserve", { value: 1 }] },
};

function capability(retiresLegacyFields?: boolean) {
  return { capabilities: { modeContract: 2, retiresLegacyFields } };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function mount() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  let instance: ReturnType<TestRenderer["create"]> | undefined;
  await renderer.act(async () => {
    instance = renderer.create(h(MaxMembersEditor, { theme, open: true, onClose, onSaved }));
    await flush();
  });
  if (!instance) throw new Error("editor failed to mount");
  const mounted = instance;
  return {
    root: mounted.root,
    onClose,
    onSaved,
    async unmount() {
      await renderer.act(() => mounted.unmount());
    },
  };
}

function field(root: Node) {
  const found = root.findAll((node) => node.type === "TextField")[0];
  if (!found) throw new Error("missing field");
  return found;
}
function actions(root: Node) {
  const found = root.findAll((node) => node.type === "ModalActions")[0];
  if (!found) throw new Error("missing actions");
  return found;
}
function text(root: Node) {
  return root
    .findAll((node) => node.type === "Text")
    .flatMap((node) => node.children)
    .join(" ");
}
async function change(root: Node, value: string) {
  await renderer.act(() => {
    const onChange = field(root).props.onChange;
    if (typeof onChange !== "function") throw new Error("missing change handler");
    onChange(value);
  });
}
async function save(root: Node) {
  await renderer.act(async () => {
    const onConfirm = actions(root).props.onConfirm;
    if (typeof onConfirm !== "function") throw new Error("missing save handler");
    onConfirm();
    await flush();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.read.mockResolvedValue({
    status: "ready",
    revision: "rev-1",
    values: structuredClone(raw),
  });
  transport.write.mockResolvedValue({ status: "saved", revision: "rev-2", values: {} });
  transport.plan.mockResolvedValue(capability(true));
});
afterEach(() => vi.useRealTimers());

describe("maxMembers editor writes", () => {
  test.each(["0", "65", "2.5", "", "1e1", "9007199254740992"])(
    "an invalid edited limit %s never writes",
    async (value) => {
      const editor = await mount();
      await change(editor.root, value);
      await save(editor.root);
      expect(field(editor.root).props.error).toBe(zh.maxMembersInvalid);
      expect(transport.write).not.toHaveBeenCalled();
      expect(editor.onClose).not.toHaveBeenCalled();
      await editor.unmount();
    },
  );

  test.each(["1", "64"])("accepts an edited boundary of %s", async (value) => {
    const editor = await mount();
    await change(editor.root, value);
    await save(editor.root);
    const { economy: _economy, ...retained } = raw;
    expect(transport.write).toHaveBeenCalledWith({
      revision: "rev-1",
      values: { ...retained, maxMembers: Number(value) },
    });
    await editor.unmount();
  });

  test("an untouched legacy limit above 64 closes without a write", async () => {
    transport.read.mockResolvedValue({
      status: "ready",
      revision: "rev-large",
      values: { ...raw, maxMembers: 100 },
    });
    const editor = await mount();
    expect(text(editor.root)).toContain(zh.maxMembersLegacy(100));
    await save(editor.root);
    expect(transport.write).not.toHaveBeenCalled();
    expect(editor.onClose).toHaveBeenCalledTimes(1);
    await editor.unmount();
  });

  test("an unchanged value closes without a write or another probe", async () => {
    const editor = await mount();
    expect(text(editor.root)).toContain(zh.retiredPreferences);
    const before = transport.plan.mock.calls.length;
    await save(editor.root);
    expect(transport.write).not.toHaveBeenCalled();
    expect(transport.plan).toHaveBeenCalledTimes(before);
    expect(editor.onClose).toHaveBeenCalledTimes(1);
    expect(editor.onSaved).not.toHaveBeenCalled();
    await editor.unmount();
  });

  test("an upgraded host removes only economy and writes with the read revision", async () => {
    const editor = await mount();
    await change(editor.root, "12");
    await save(editor.root);
    const { economy: _economy, ...retained } = raw;
    expect(transport.write).toHaveBeenCalledWith({
      revision: "rev-1",
      values: { ...retained, maxMembers: 12 },
    });
    expect(editor.onSaved).toHaveBeenCalledTimes(1);
    expect(editor.onClose).toHaveBeenCalledTimes(1);
    await editor.unmount();
  });

  test.each(["old", "failure"] as const)("%s host preserves economy", async (kind) => {
    if (kind === "old") transport.plan.mockResolvedValue(capability());
    else transport.plan.mockRejectedValue(new Error("unavailable"));
    const editor = await mount();
    expect(text(editor.root)).toContain(zh.retiredPreferencesKept);
    await change(editor.root, "12");
    await save(editor.root);
    expect(transport.write).toHaveBeenCalledWith({
      revision: "rev-1",
      values: { ...raw, maxMembers: 12 },
    });
    expect(editor.onSaved).toHaveBeenCalledTimes(1);
    await editor.unmount();
  });

  test("an unanswered capability probe times out and keeps economy", async () => {
    const editor = await mount();
    transport.plan.mockImplementation(() => new Promise(() => undefined));
    await change(editor.root, "12");
    vi.useFakeTimers();
    await save(editor.root);
    expect(transport.write).not.toHaveBeenCalled();
    await renderer.act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(transport.write).toHaveBeenCalledWith({
      revision: "rev-1",
      values: { ...raw, maxMembers: 12 },
    });
    expect(editor.onSaved).toHaveBeenCalledTimes(1);
    await editor.unmount();
  });

  test("a conflict keeps the editor open and reports the revision conflict", async () => {
    transport.write.mockResolvedValue({ status: "conflict", error: "revision" });
    const editor = await mount();
    await change(editor.root, "12");
    await save(editor.root);
    expect(field(editor.root).props.error).toBe(zh.maxMembersSaveConflict);
    expect(text(editor.root)).toContain(zh.maxMembersReloadHint);
    expect(editor.onClose).not.toHaveBeenCalled();
    expect(editor.onSaved).not.toHaveBeenCalled();
    await editor.unmount();
  });

  test("a clean preferences object saves without any capability probe", async () => {
    const { economy: _economy, ...clean } = raw;
    transport.read.mockResolvedValue({ status: "ready", revision: "rev-3", values: clean });
    const editor = await mount();
    await change(editor.root, "12");
    await save(editor.root);
    expect(transport.plan).not.toHaveBeenCalled();
    expect(transport.write).toHaveBeenCalledWith({
      revision: "rev-3",
      values: { ...clean, maxMembers: 12 },
    });
    await editor.unmount();
  });
});
