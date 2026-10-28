// V01b D6/C2 (AC-0c.8, 04 §6.3 H3=B, 89 K5): "close the switch and retry" through the REAL
// AgentTeamsScreen, DesignJobsPanel, useDesignJobs and TeamDesignerCard.
//
// Only the host transport, the settings documents and the React Native primitives are fakes. The
// screen is mounted with react-test-renderer, which is a test tool and not a project dependency:
// when it is not installed the suite skips itself (the pure planner/applier rules are covered by
// design-gap-ui.test.ts and the C04 spec). Install it with `npm i --no-save react-test-renderer@19.2.3`
// to run this file.
import { createElement as h, StrictMode } from "react";
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

const calls = vi.hoisted(() => ({ rpc: [] as { name: string; input: unknown }[] }));
const gapState = vi.hoisted(() => ({ jobs: [] as unknown[], seed: null as unknown }));

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
    Modal: host("Modal"),
    Platform: { OS: "ios" },
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
    StyleSheet: { create: (styles: unknown) => styles },
    Dimensions: { get: () => ({ width: 1000, height: 800 }) },
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => {
  const host = (name: string) => (props: Record<string, unknown>) =>
    h(name, props, props.children as never);
  return {
    Icon: host("Icon"),
    ScrollView: host("ScrollView"),
    TextInput: host("TextInput"),
    Modal: new Proxy(host("Modal"), {
      get: (target, key) =>
        key in target || typeof key !== "string" || !/^[A-Z]/.test(key)
          ? (target as never)[key]
          : host(`Modal.${key}`),
    }),
    FlatList: host("FlatList"),
    copyText: () => undefined,
    useToast: () => ({ show: () => undefined }),
  };
});
vi.mock("../client/version/VersionEntry", () => ({ VersionEntry: () => null }));
vi.mock("../shared/paseo/adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/paseo/adapter")>();
  return {
    ...actual,
    createPaseoAdapter: () => ({
      readConfig: async () => ({}),
      listProfiles: async () => [
        { id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" },
      ],
      listWorkspaces: async () => [{ id: "ws-target", name: "目标", path: "/p" }],
    }),
  };
});
vi.mock("@getpaseo/plugin/client", () => {
  const paseoStub = {};
  const rpcCache: Record<string, (input: unknown) => Promise<unknown>> = {};
  const settings: Record<string, unknown> = {};
  return {
    usePaseo: () => paseoStub,
    useRpc: (definition: { name: string }) =>
      // The real hook is referentially stable; an unstable one would re-run every effect.
      (rpcCache[definition.name] ??= async (input: unknown) => {
        calls.rpc.push({ name: definition.name, input });
        if (definition.name.endsWith("team.plan")) {
          const items = (input as { items: { key: string }[] }).items;
          return {
            schemaVersion: 1,
            capabilities: {
              modeContract: 2,
              designRolePolicy: 1,
              supportedModes: ["sota", "economy", "economy-all", "collaborative"],
              runtimeCapabilities: { onDemand: false, expansion: false, collaboration: false },
            },
            checkedAt: "2026-10-01T10:00:00.000Z",
            context: null,
            results: items.map((item) => ({
              key: item.key,
              status: "unavailable",
              effectiveMode: null,
              selectionFingerprint: null,
              rows: [],
              issues: [],
            })),
          };
        }
        if (definition.name.endsWith("design.status")) {
          const jobId = (input as { jobId?: string }).jobId;
          return {
            ok: true,
            scopeId: "11111111-1111-4111-8111-111111111111",
            jobs: gapState.jobs.map((job) =>
              jobId && gapState.seed ? { ...(job as object), gapRetry: gapState.seed } : job,
            ),
            truncated: false,
            discoveryIssues: [],
          };
        }
        return {};
      }),
    useSettings: (definition: { id: string }) => {
      const id = definition.id;
      settings[id] ??= {
        status: "ready",
        values:
          id === "agent-team-roles"
            ? { roles: [] }
            : id === "agent-team-teams"
              ? { teams: [] }
              : {},
        revision: "r1",
        saving: false,
        reload: () => undefined,
      };
      return settings[id];
    },
  };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoleGapReportSchema } from "../shared/schemas/design";
import { designGapZh } from "../shared/zh/design-gap";
import { designJob } from "./design-fixtures";

const specifier = "react-test-renderer";
const renderer = (await import(/* @vite-ignore */ specifier).catch(
  () => null,
)) as TestRenderer | null;
if (renderer) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

const theme = new Proxy({ colors: new Proxy({}, { get: () => "#000" }) }, {}) as never;
const report = RoleGapReportSchema.parse({
  responsibility: "数据库迁移评审",
  reason: "现有 Role 不承担",
  use: "member",
  profiles: [{ id: "p-sonnet", name: "Sonnet", provider: "claude", model: "claude-sonnet-4-6" }],
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

const REQUEST_LABEL = "项目需求";
const ofType = (root: Node, type: string) => root.findAll((node) => node.type === type);
const byLabel = (root: Node, label: string) =>
  root.findAll((node) => node.props.accessibilityLabel === label && typeof node.type === "string");
const texts = (root: Node) => ofType(root, "Text").map((node) => node.children.join(""));
const requestInput = (root: Node) => byLabel(root, REQUEST_LABEL)[0];
const ruleSwitch = (root: Node) => byLabel(root, designGapZh.switchLabel)[0];

async function until(condition: () => boolean, what: string) {
  const { act } = renderer as TestRenderer;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mountScreen(strict: boolean) {
  const { act, create } = renderer as TestRenderer;
  // Loaded on demand: a skipped suite must not drag the whole client tree into coverage.
  const { AgentTeamsScreen } = await import("../client/app/AgentTeamsScreen");
  calls.rpc.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = h(
    AgentTeamsScreen as never,
    {
      theme,
      layout: { compact: false },
      host: { id: "A" },
      navigation: { navigate: () => undefined },
      params: { tab: "teams" },
    } as never,
  );
  const tree = h(QueryClientProvider, { client }, screen);
  let mounted!: ReturnType<TestRenderer["create"]>;
  await act(async () => {
    mounted = create(strict ? h(StrictMode, null, tree) : tree);
  });
  await until(() => byLabel(mounted.root, designGapZh.retry).length > 0, "the gap card");
  return mounted;
}

async function press(root: Node, label: string) {
  const { act } = renderer as TestRenderer;
  await act(async () => {
    (byLabel(root, label)[0].props.onPress as () => void)();
  });
}

describe.skipIf(!renderer)("gap retry through the real screen (D6/C2)", () => {
  for (const strict of [false, true]) {
    describe(strict ? "in StrictMode" : "plain", () => {
      test("an empty draft is filled from the server seed, the switch goes off, nothing starts", async () => {
        gapState.jobs = [gapJob];
        gapState.seed = seed;
        const { root, unmount } = await mountScreen(strict);
        expect(ruleSwitch(root).props.value).toBe(true);
        calls.rpc.length = 0;

        await press(root, designGapZh.retry);
        await until(() => requestInput(root).props.defaultValue === seed.request, "the prefill");

        expect(ruleSwitch(root).props.value).toBe(false);
        expect(calls.rpc.map((call) => call.name)).not.toContain("agent-team.design.start");
        expect(calls.rpc.find((call) => call.name.endsWith("design.status"))?.input).toEqual({
          jobId: gapJob.jobId,
          contractVersion: 2,
        });
        expect(texts(root)).not.toContain(designGapZh.retryConfirmTitle);
        unmount();
      });

      test("a typed draft is kept until the user agrees to replace it", async () => {
        gapState.jobs = [gapJob];
        gapState.seed = seed;
        const { act } = renderer as TestRenderer;
        const { root, unmount } = await mountScreen(strict);
        await act(async () => {
          (requestInput(root).props.onChangeText as (text: string) => void)("我自己的草稿");
        });

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
        expect(calls.rpc.map((call) => call.name)).not.toContain("agent-team.design.start");
        unmount();
      });
    });
  }

  test("a job whose server has no seed leaves the draft alone and says so", async () => {
    gapState.jobs = [gapJob];
    gapState.seed = null;
    const { act } = renderer as TestRenderer;
    const { root, unmount } = await mountScreen(false);
    await act(async () => {
      (requestInput(root).props.onChangeText as (text: string) => void)("我自己的草稿");
    });

    await press(root, designGapZh.retry);
    await until(() => texts(root).includes(designGapZh.retryUnavailable), "the notice");

    expect(requestInput(root).props.defaultValue).toBe("我自己的草稿");
    expect(ruleSwitch(root).props.value).toBe(true);
    expect(texts(root)).not.toContain(designGapZh.retryConfirmTitle);
    unmount();
  });
});
