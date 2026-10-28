// V01b D6/C2 (AC-0c.8, 04 §6.3 H3=B, 89 K5): "close the switch and retry" through the REAL
// DesignJobsPanel, useDesignJobs and TeamDesignerCard, mounted with react-test-renderer (a
// devDependency pinned to the project React version).
//
// The screen glue between them (`designPrefill` state, `onGapRetry`, the card's `prefill` prop) is
// three lines in AgentTeamsScreen; the harness below repeats them and the last test pins the screen
// source to the same text. Mounting the whole screen was verified by hand (clean draft, typed draft,
// StrictMode, eight data variants) but it loads ~1,200 uncovered lines of unrelated screen code into
// the coverage denominator, so the committed suite keeps to the designer path.
import { createElement as h, StrictMode, useState } from "react";
// @ts-expect-error react-test-renderer ships no types here; TestRenderer below is the subset used.
import * as reactTestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";

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

vi.mock("react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return {
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Switch: host("Switch"),
    TextInput: host("TextInput"),
    ScrollView: host("ScrollView"),
    Platform: { OS: "ios" },
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return {
    Icon: host("Icon"),
    ScrollView: host("ScrollView"),
    TextInput: host("TextInput"),
    useToast: () => ({ show: () => undefined }),
  };
});
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => async () => ({}),
  useSettings: () => ({ status: "loading", saving: false, reload: () => undefined }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DesignJobsPanel } from "../client/designer/DesignJobsPanel";
import type { DesignerPrefill } from "../client/designer/design-screen-state";
import { TeamDesignerCard } from "../client/designer/TeamDesignerCard";
import { useDesignJobs } from "../client/designer/use-design-jobs";
import { RoleGapReportSchema } from "../shared/schemas/design";
import { designGapZh } from "../shared/zh/design-gap";
import { designJob } from "./design-fixtures";

const renderer = reactTestRenderer as unknown as TestRenderer;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const profile = { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" };
const adapter = {
  listWorkspaces: async () => [{ id: "ws-target", name: "目标", path: "/p" }],
} as never;
const report = RoleGapReportSchema.parse({
  responsibility: "数据库迁移评审",
  reason: "现有 Role 不承担",
  use: "member",
  profiles: [profile],
  suggestedRole: {
    id: "qa-migration",
    name: "【质量】迁移评审",
    responsibilities: ["评审"],
    executionPolicy: { tier: "decision", taskKind: "general" },
  },
});
const gapJob = designJob({
  state: "failed",
  mode: "sota",
  existingRolesOnly: true,
  outputContractVersion: 2,
  roleGap: [report],
  resultId: null,
  carrierWorkspaceId: "ws-carrier",
  targetWorkspaceId: "ws-target",
  allowed: { cancel: false, save: false, launch: false, continueAction: null },
});
const seed = {
  request: "为现有的后台改版需求设计一个 Team。",
  profileId: "p-sonnet",
  useDefaultProfileHints: false,
};
const SCOPE_ID = "11111111-1111-4111-8111-111111111111";

type Transport = {
  status: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
};
function transport(withSeed: boolean): Transport {
  const status = vi.fn(async (input: { jobId?: string }) => ({
    ok: true,
    scopeId: SCOPE_ID,
    jobs: [input.jobId && withSeed ? { ...gapJob, gapRetry: seed } : gapJob],
    truncated: false,
    discoveryIssues: [],
  }));
  return { status, start: vi.fn() };
}

/** The AgentTeamsScreen glue: `designPrefill` state, `onGapRetry`, and the card's `prefill` prop. */
function Harness({ api }: { api: Transport }) {
  const [designPrefill, setDesignPrefill] = useState<{
    hostId: string;
    value: DesignerPrefill;
  } | null>(null);
  const jobs = useDesignJobs({
    hostId: "A",
    active: true,
    modeContract: "v2",
    rpc: {
      start: api.start as never,
      status: api.status as never,
      result: vi.fn() as never,
      cancel: vi.fn() as never,
      continueJob: vi.fn() as never,
    },
  });
  return h(
    TeamDesignerCard,
    {
      theme,
      layout: { compact: false } as never,
      adapter,
      hostId: "A",
      profiles: [profile],
      modeContract: "v2",
      prefill: designPrefill?.hostId === "A" ? designPrefill.value : undefined,
      onStart: (input: Parameters<typeof jobs.start>[0]) => jobs.start(input),
      collapseByDefault: true,
    },
    h(DesignJobsPanel, {
      theme,
      hostId: "A",
      jobs,
      teams: [],
      active: true,
      clientId: "11111111-1111-4111-8111-1111111111aa",
      navigation: {} as never,
      onPreviewLaunch: () => undefined,
      modeContract: "v2",
      onGapRetry: (prefill: DesignerPrefill) => setDesignPrefill({ hostId: "A", value: prefill }),
    }),
  );
}

const REQUEST_LABEL = "项目需求";
const ofType = (root: Node, type: string) => root.findAll((node) => node.type === type);
const byLabel = (root: Node, label: string) =>
  root.findAll((node) => node.props.accessibilityLabel === label && typeof node.type === "string");
const texts = (root: Node) => ofType(root, "Text").map((node) => node.children.join(""));
const requestInput = (root: Node) => byLabel(root, REQUEST_LABEL)[0];
const ruleSwitch = (root: Node) => byLabel(root, designGapZh.switchLabel)[0];

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await renderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mount(api: Transport, strict: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = h(QueryClientProvider, { client }, h(Harness, { api }));
  let mounted!: ReturnType<TestRenderer["create"]>;
  await renderer.act(async () => {
    mounted = renderer.create(strict ? h(StrictMode, null, tree) : tree);
  });
  await until(() => byLabel(mounted.root, designGapZh.retry).length > 0, "the gap card");
  return mounted;
}

async function press(root: Node, label: string) {
  await renderer.act(async () => {
    (byLabel(root, label)[0].props.onPress as () => void)();
  });
}

async function type(root: Node, text: string) {
  await renderer.act(async () => {
    (requestInput(root).props.onChangeText as (value: string) => void)(text);
  });
}

describe("gap retry through the designer card and panel (D6/C2)", () => {
  for (const strict of [false, true]) {
    describe(strict ? "in StrictMode" : "plain", () => {
      test("an empty draft is filled from the server seed, the switch goes off, nothing starts", async () => {
        const api = transport(true);
        const { root, unmount } = await mount(api, strict);
        expect(ruleSwitch(root).props.value).toBe(true);
        api.status.mockClear();

        await press(root, designGapZh.retry);
        await until(() => requestInput(root).props.defaultValue === seed.request, "the prefill");

        expect(ruleSwitch(root).props.value).toBe(false);
        expect(api.start).not.toHaveBeenCalled();
        expect(api.status).toHaveBeenCalledWith({ jobId: gapJob.jobId, contractVersion: 2 });
        expect(texts(root)).not.toContain(designGapZh.retryConfirmTitle);
        unmount();
      });

      test("a typed draft is kept until the user agrees to replace it", async () => {
        const api = transport(true);
        const { root, unmount } = await mount(api, strict);
        await type(root, "我自己的草稿");

        await press(root, designGapZh.retry);
        await until(() => texts(root).includes(designGapZh.retryConfirmTitle), "the replace bar");
        expect(requestInput(root).props.defaultValue).toBe("我自己的草稿");
        expect(ruleSwitch(root).props.value).toBe(true);

        await press(root, designGapZh.retryConfirmCancel);
        await until(() => !texts(root).includes(designGapZh.retryConfirmTitle), "the bar to close");
        expect(requestInput(root).props.defaultValue).toBe("我自己的草稿");
        expect(ruleSwitch(root).props.value).toBe(true);

        await press(root, designGapZh.retry);
        await until(() => texts(root).includes(designGapZh.retryConfirmTitle), "the replace bar");
        await press(root, designGapZh.retryConfirmReplace);
        await until(
          () => requestInput(root).props.defaultValue === seed.request,
          "the replacement",
        );
        expect(ruleSwitch(root).props.value).toBe(false);
        expect(api.start).not.toHaveBeenCalled();
        unmount();
      });
    });
  }

  test("a job whose server has no seed leaves the draft alone and says so", async () => {
    const api = transport(false);
    const { root, unmount } = await mount(api, false);
    await type(root, "我自己的草稿");

    await press(root, designGapZh.retry);
    await until(() => texts(root).includes(designGapZh.retryUnavailable), "the notice");

    expect(requestInput(root).props.defaultValue).toBe("我自己的草稿");
    expect(ruleSwitch(root).props.value).toBe(true);
    expect(texts(root)).not.toContain(designGapZh.retryConfirmTitle);
    unmount();
  });

  test("the screen wires the panel and the card exactly as the harness does", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "..", "client", "app", "AgentTeamsScreen.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "prefill: designPrefill?.hostId === host.id ? designPrefill.value : undefined",
    );
    expect(source).toMatch(
      /onGapRetry=\{\(prefill\) => \{\s*setTab\("teams"\);\s*setDesignPrefill\(\{ hostId: host\.id, value: prefill \}\);\s*\}\}/,
    );
  });
});
