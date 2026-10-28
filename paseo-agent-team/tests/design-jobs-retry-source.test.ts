// C04 / Q2-B: the retry seed path through the real useDesignJobs hook. The hook's public
// retrySourceFor(job) is the external behavior: a v2 host must read the seed of THAT job from
// status({ jobId }), and a host switch must drop this session's cached requests. No renderer.
import { describe, expect, test, vi } from "vitest";

type Effect = {
  deps?: unknown[];
  cleanup?: () => void;
  setup: () => (() => void) | void;
  run: boolean;
};
const rt = vi.hoisted(() => ({
  cur: null as null | { slots: unknown[]; i: number; effects: unknown[] },
}));

vi.mock("react", () => {
  const f = () => rt.cur as NonNullable<typeof rt.cur>;
  const memo = <T>(factory: () => T, deps: unknown[]) => {
    const fiber = f();
    const i = fiber.i++;
    const prev = fiber.slots[i] as { deps: unknown[]; value: T } | undefined;
    if (
      prev &&
      prev.deps.length === deps.length &&
      prev.deps.every((d, k) => Object.is(d, deps[k]))
    ) {
      return prev.value;
    }
    const value = factory();
    fiber.slots[i] = { deps, value };
    return value;
  };
  return {
    useRef<T>(init: T) {
      const fiber = f();
      const i = fiber.i++;
      if (!(i in fiber.slots)) fiber.slots[i] = { current: init };
      return fiber.slots[i] as { current: T };
    },
    useMemo: memo,
    useCallback<T>(fn: T, deps: unknown[]) {
      return memo(() => fn, deps);
    },
    useEffect(setup: () => (() => void) | void, deps?: unknown[]) {
      const fiber = f();
      const i = fiber.i++;
      const prev = fiber.effects[i] as Effect | undefined;
      if (!prev) {
        fiber.effects[i] = { deps, setup, run: true };
      } else {
        const changed =
          !prev.deps ||
          !deps ||
          prev.deps.length !== deps.length ||
          prev.deps.some((d, k) => !Object.is(d, deps[k]));
        prev.setup = setup;
        if (changed) {
          prev.run = true;
          prev.deps = deps;
        }
      }
    },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    error: null,
    isPending: false,
    refetch: async () => ({ data: undefined }),
  }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async () => ({}) }));

import { useDesignJobs } from "../client/designer/use-design-jobs";
import { designJob } from "./design-fixtures";

function mount(props: unknown) {
  const fiber = { slots: [] as unknown[], i: 0, effects: [] as Effect[] };
  let latest!: ReturnType<typeof useDesignJobs>;
  let p = props;
  const render = () => {
    rt.cur = fiber;
    fiber.i = 0;
    latest = (useDesignJobs as (o: unknown) => ReturnType<typeof useDesignJobs>)(p);
    rt.cur = null;
    for (const e of fiber.effects.filter((x) => x && x.run)) {
      e.run = false;
      e.cleanup = (e.setup() as (() => void) | undefined) ?? undefined;
    }
  };
  render();
  return {
    get r() {
      return latest;
    },
    rerender(next: unknown) {
      p = next;
      render();
    },
  };
}

const gapJob = (over = {}) =>
  designJob({ state: "failed", mode: "sota", targetWorkspaceId: "ws-target", ...over });
const seed = { request: "服务端种子", profileId: "p-sonnet", useDefaultProfileHints: false };
const okStatus = (jobs: unknown[]) => ({
  ok: true,
  scopeId: "11111111-1111-4111-8111-111111111111",
  jobs,
  truncated: false,
  discoveryIssues: [],
});
const opts = (hostId: string, modeContract: string, status: unknown) =>
  ({
    hostId,
    active: false,
    modeContract,
    rpc: { start: vi.fn(), status, result: vi.fn(), cancel: vi.fn(), continueJob: vi.fn() },
  }) as never;

describe("gapRetry server seed through the real useDesignJobs", () => {
  test("v2: the seed of THE job comes from status({jobId}) with an empty session cache", async () => {
    const job = gapJob();
    const other = gapJob({
      jobId: "aaaaaaaa-0000-4000-8000-000000000009",
      gapRetry: { request: "别人的", profileId: null, useDefaultProfileHints: true },
    });
    const status = vi.fn(async () => okStatus([other, { ...job, gapRetry: seed }]));
    const h = mount(opts("A", "v2", status));
    await expect(h.r.retrySourceFor(job)).resolves.toEqual(seed);
    expect(status).toHaveBeenCalledWith({ jobId: job.jobId, contractVersion: 2 });
  });

  test("v2: after a host switch the server seed still works", async () => {
    const job = gapJob();
    const status = vi.fn(async () => okStatus([{ ...job, gapRetry: seed }]));
    const h = mount(opts("A", "v2", status));
    h.rerender(opts("B", "v2", status));
    await expect(h.r.retrySourceFor(job)).resolves.toEqual(seed);
  });

  test("v2: a failing status falls back to the (empty) session cache", async () => {
    const job = gapJob();
    const h = mount(
      opts(
        "A",
        "v2",
        vi.fn(async () => {
          throw new Error("down");
        }),
      ),
    );
    await expect(h.r.retrySourceFor(job)).resolves.toBeNull();
  });

  test("v2: a job without a seed falls back to the cache", async () => {
    const job = gapJob();
    const h = mount(
      opts(
        "A",
        "v2",
        vi.fn(async () => okStatus([job])),
      ),
    );
    await expect(h.r.retrySourceFor(job)).resolves.toBeNull();
  });

  test("v2: a host switch clears the session cache before the fallback", async () => {
    const job = gapJob();
    const started = { ok: true, job };
    const status = vi.fn(async () => okStatus([job]));
    const h = mount({
      hostId: "A",
      active: false,
      modeContract: "v2",
      rpc: {
        start: vi.fn(async () => started),
        status,
        result: vi.fn(),
        cancel: vi.fn(),
        continueJob: vi.fn(),
      },
    } as never);
    await h.r.start({ request: "旧 host 的需求", mode: "sota" } as never);
    h.rerender(opts("B", "v2", status));
    await expect(h.r.retrySourceFor(job)).resolves.toBeNull();
  });

  test("legacy: never asks the server", async () => {
    const job = gapJob();
    const status = vi.fn(async () => okStatus([{ ...job, gapRetry: seed }]));
    const h = mount(opts("A", "legacy", status));
    await expect(h.r.retrySourceFor(job)).resolves.toBeNull();
    expect(status).not.toHaveBeenCalled();
  });
});
