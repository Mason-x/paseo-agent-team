// V01b D6/C2 (AC-0c.8, 04 §6.3 H3=B, 89 K5): "close the switch and retry" through the REAL
// DesignJobsPanel, useDesignJobs and TeamDesignerCard, mounted with react-test-renderer (a
// devDependency pinned to the project React version).
//
// The screen state transitions between them (retry -> Teams tab + prefill slot, slot -> card prop)
// are the pure functions `applyGapRetry` / `designPrefillForHost` in design-screen-state.ts; the
// screen calls them and so does the harness below, so a change in them fails these tests. Mounting
// the whole screen loads ~1,200 uncovered lines of unrelated screen code into the coverage
// denominator, so the committed suite keeps to the designer path (the screen was mounted by hand:
// clean draft, typed draft, StrictMode, eight data variants).
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
import {
  applyGapRetry,
  type DesignerPrefill,
  type DesignPrefillSlot,
  designPrefillForHost,
} from "../client/designer/design-screen-state";
import { TeamDesignerCard } from "../client/designer/TeamDesignerCard";
import { useDesignJobs } from "../client/designer/use-design-jobs";
import { RoleGapReportSchema } from "../shared/schemas/design";
import { designZh } from "../shared/zh/design";
import { designGapZh } from "../shared/zh/design-gap";
import { designJob, designResult } from "./design-fixtures";

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
  result: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  continueJob: ReturnType<typeof vi.fn>;
  onOpenRole: ReturnType<typeof vi.fn>;
  onConfigureEconomy: ReturnType<typeof vi.fn>;
  onCreateRole: ReturnType<typeof vi.fn>;
};
function transport(withSeed: boolean, jobs: unknown[] = [gapJob]): Transport {
  const status = vi.fn(async (input: { jobId?: string }) => ({
    ok: true,
    scopeId: SCOPE_ID,
    jobs: jobs.map((job) =>
      input.jobId && withSeed ? { ...(job as object), gapRetry: seed } : job,
    ),
    truncated: false,
    discoveryIssues: [],
  }));
  const result = vi.fn(async () => ({ ok: true, result: designResult() }));
  return {
    status,
    start: vi.fn(),
    result,
    cancel: vi.fn(async () => ({ ok: true })),
    continueJob: vi.fn(async () => ({ ok: true })),
    onOpenRole: vi.fn(),
    onConfigureEconomy: vi.fn(),
    onCreateRole: vi.fn(),
  };
}

/** The AgentTeamsScreen glue, through the same pure functions the screen calls. */
function Harness({ api }: { api: Transport }) {
  const [tab, setTab] = useState<string>("runs");
  const [designPrefill, setDesignPrefill] = useState<DesignPrefillSlot>(null);
  const jobs = useDesignJobs({
    hostId: "A",
    active: true,
    modeContract: "v2",
    rpc: {
      start: api.start as never,
      status: api.status as never,
      result: api.result as never,
      cancel: api.cancel as never,
      continueJob: api.continueJob as never,
    },
  });
  return h(
    "Screen",
    { tab },
    h(
      TeamDesignerCard,
      {
        theme,
        layout: { compact: false } as never,
        adapter,
        hostId: "A",
        profiles: [profile],
        modeContract: "v2",
        prefill: designPrefillForHost(designPrefill, "A"),
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
        onOpenRole: api.onOpenRole as never,
        onConfigureEconomy: api.onConfigureEconomy as never,
        onCreateRole: api.onCreateRole as never,
        onGapRetry: (prefill: DesignerPrefill) => {
          const next = applyGapRetry("A", prefill);
          setTab(next.tab);
          setDesignPrefill(next.designPrefill);
        },
      }),
    ),
  );
}

const REQUEST_LABEL = "项目需求";
const ofType = (root: Node, type: string) => root.findAll((node) => node.type === type);
const byLabel = (root: Node, label: string) =>
  root.findAll((node) => node.props.accessibilityLabel === label && typeof node.type === "string");
const currentTab = (root: Node) => ofType(root, "Screen")[0].props.tab;
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

async function mountPanel(api: Transport, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = h(QueryClientProvider, { client }, h(Harness, { api }));
  let mounted!: ReturnType<TestRenderer["create"]>;
  await renderer.act(async () => {
    mounted = renderer.create(strict ? h(StrictMode, null, tree) : tree);
  });
  return mounted;
}

async function mount(api: Transport, strict: boolean) {
  const mounted = await mountPanel(api, strict);
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
        expect(currentTab(root)).toBe("runs");
        api.status.mockClear();

        await press(root, designGapZh.retry);
        await until(() => requestInput(root).props.defaultValue === seed.request, "the prefill");

        expect(ruleSwitch(root).props.value).toBe(false);
        expect(currentTab(root)).toBe("teams");
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

  test("the screen applies the retry through the same functions the harness uses", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "..", "client", "app", "AgentTeamsScreen.tsx"),
      "utf8",
    );
    // Only that the functions are imported and called; formatting and naming around them are free.
    expect(source).toMatch(/\bapplyGapRetry\s*\(/);
    expect(source).toMatch(/\bdesignPrefillForHost\s*\(/);
  });
});

describe("a finished design through the panel", () => {
  test("shows the result card: summary, reused Role reasons and the new Role", async () => {
    const saved = designJob({
      state: "saved",
      resultId: "a".repeat(64),
      savedTeamId: "coding-team",
      saveState: "committed",
      allowed: { cancel: false, save: false, launch: true, continueAction: null },
    });
    const api = transport(false, [saved]);
    const { root, unmount } = await mountPanel(api);
    const result = designResult();
    await until(() => texts(root).includes(result.summary), "the result card");
    expect(api.result).toHaveBeenCalledWith({ jobId: saved.jobId, contractVersion: 2 });
    const shown = texts(root);
    expect(shown).toContain(result.reuse[0]?.reason);
    expect(shown.some((line) => line.includes(result.newRoles[0]?.name ?? "?"))).toBe(true);
    unmount();
  });
});

describe("gap exits and job actions through the panel", () => {
  const unlaunchable = RoleGapReportSchema.parse({
    responsibility: "数据库迁移执行",
    reason: "绑定的 Profile 在本 host 不可用",
    use: "member",
    profiles: [profile],
    unlaunchableRole: {
      roleId: "qa-migration",
      roleName: "【质量】迁移评审",
      unavailableProfileIds: [profile.id],
      profileNames: [profile.name],
    },
  });

  test("a missing Role offers creating it, an unlaunchable one opens its binding", async () => {
    const api = transport(false, [{ ...gapJob, roleGap: [report, unlaunchable] }]);
    const { root, unmount } = await mount(api, false);

    await press(root, designGapZh.actionCreateRole);
    expect(api.onCreateRole).toHaveBeenCalledTimes(1);

    await press(root, designGapZh.actionOpenRole);
    expect(api.onOpenRole).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: "qa-migration", profileId: profile.id }),
    );
    unmount();
  });

  test("an economy-all gap sends the user to the all-seats route, not to the Role", async () => {
    const api = transport(false, [{ ...gapJob, mode: "economy-all" }]);
    const { root, unmount } = await mount(api, false);

    await press(root, designGapZh.actionConfigureEconomy);
    expect(api.onConfigureEconomy).toHaveBeenCalledWith(
      expect.objectContaining({ layer: "allSeats" }),
    );
    expect(api.onOpenRole).not.toHaveBeenCalled();
    unmount();
  });

  test("a running design can be cancelled and a stopped one rechecked", async () => {
    const running = designJob({
      state: "designing",
      attempt: 1,
      allowed: { cancel: true, save: false, launch: false, continueAction: null },
    });
    const cancelApi = transport(false, [running]);
    const first = await mountPanel(cancelApi);
    await until(() => byLabel(first.root, designZh.jobCancel).length > 0, "the cancel button");
    await press(first.root, designZh.jobCancel);
    expect(cancelApi.cancel).toHaveBeenCalledWith({ jobId: running.jobId, contractVersion: 2 });
    first.unmount();

    const stopped = designJob({
      state: "needs_continue",
      attempt: 1,
      allowed: { cancel: false, save: false, launch: false, continueAction: "recheck" },
    });
    const continueApi = transport(false, [stopped]);
    const second = await mountPanel(continueApi);
    await until(
      () => byLabel(second.root, designZh.jobContinueRecheck).length > 0,
      "the recheck button",
    );
    await press(second.root, designZh.jobContinueRecheck);
    expect(continueApi.continueJob).toHaveBeenCalledWith({
      jobId: stopped.jobId,
      expectedRevision: stopped.stateRevision,
      action: "recheck",
      contractVersion: 2,
    });
    second.unmount();
  });
});
