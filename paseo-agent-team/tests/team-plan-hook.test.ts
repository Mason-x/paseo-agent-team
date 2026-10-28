// B03: the Team screen's first paint must send exactly one team.plan batch for the saved Teams,
// never an empty probe first. This runs the real useTeamPlans effect with a minimal hook runtime;
// the client core alone cannot see duplicate hook-level requests.
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
    useState<T>(init: T) {
      const fiber = f();
      const i = fiber.i++;
      if (!(i in fiber.slots)) {
        const value = typeof init === "function" ? (init as () => T)() : init;
        const slot = { value };
        fiber.slots[i] = slot;
        return [
          value,
          (next: T | ((prev: T) => T)) => {
            slot.value = typeof next === "function" ? (next as (prev: T) => T)(slot.value) : next;
          },
        ];
      }
      const slot = fiber.slots[i] as { value: T };
      return [
        slot.value,
        (next: T | ((prev: T) => T)) => {
          slot.value = typeof next === "function" ? (next as (prev: T) => T)(slot.value) : next;
        },
      ];
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
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined }),
  },
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async () => ({}) }));

import { useTeamPlans } from "../client/teams/use-team-plans";
import type { TeamPlanInput, TeamPlanOutput } from "../shared/schemas/team-plan";
import { claudeOpus, codexXhigh, codingTeam } from "./fixtures";

const teams = Array.from({ length: 10 }, (_, index) => ({
  ...codingTeam,
  id: `team-${index}`,
  name: `Team ${index}`,
}));
const output = (): TeamPlanOutput => ({
  schemaVersion: 1,
  capabilities: {
    modeContract: 2,
    designRolePolicy: 1,
    supportedModes: ["sota"],
    runtimeCapabilities: { onDemand: true, expansion: true, collaboration: true },
  },
  checkedAt: "2026-10-28T00:00:00.000Z",
  context: null,
  results: [],
});

describe("useTeamPlans first paint", () => {
  test("ten saved Teams send one batch and no empty probe", async () => {
    const send = vi.fn(async (_input: TeamPlanInput) => output());
    const fiber = { slots: [] as unknown[], i: 0, effects: [] as Effect[] };
    rt.cur = fiber;
    (useTeamPlans as (options: unknown) => unknown)({
      hostId: "host-a",
      profiles: [claudeOpus, codexXhigh],
      revisions: { roles: "r1", teams: "t1", preferences: "p1" },
      teams,
      active: true,
      send,
    });
    rt.cur = null;
    for (const e of fiber.effects.filter((x) => x && x.run)) {
      e.run = false;
      e.cleanup = (e.setup() as (() => void) | undefined) ?? undefined;
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]?.[0] as TeamPlanInput;
    expect(input.items).toHaveLength(10);
    expect(send.mock.calls.some(([call]) => call.items.length === 0)).toBe(false);
  });
});
