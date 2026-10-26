import { beforeEach, describe, expect, test, vi } from "vitest";
import { AGENT_TEAMS_SCREEN } from "../client/app/tabs";
import {
  buildDesignPrefillScreenParams,
  createDesignPrefillToken,
  DESIGN_PREFILL_CAPACITY,
  DESIGN_PREFILL_TTL_MS,
  type DesignPrefillEvent,
  type DesignSlashCommandInput,
  handleDesignSlashCommand,
  queueDesignPrefill,
  resetDesignPrefills,
  subscribeDesignPrefills,
  takeDesignPrefill,
} from "../client/designer/events";
import { designZh } from "../shared/zh/design";

function event(
  token: string,
  createdAt = 0,
  overrides: Partial<DesignPrefillEvent> = {},
): DesignPrefillEvent {
  return {
    token,
    scopeId: "scope-a",
    request: "给后台做一次改版",
    workspaceId: "ws-1",
    createdAt,
    ...overrides,
  };
}

beforeEach(() => {
  resetDesignPrefills();
});

describe("one-shot prefill queue", () => {
  test("the same text under a second nonce can be prefilled again", () => {
    queueDesignPrefill(event("a".repeat(32), 0));
    queueDesignPrefill(event("b".repeat(32), 0));
    expect(takeDesignPrefill({ token: "a".repeat(32), scopeId: "scope-a", now: 1 })).toMatchObject({
      request: "给后台做一次改版",
    });
    expect(takeDesignPrefill({ token: "b".repeat(32), scopeId: "scope-a", now: 1 })).toMatchObject({
      request: "给后台做一次改版",
    });
  });

  test("a token is consumed once", () => {
    const token = "c".repeat(32);
    queueDesignPrefill(event(token));
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 1 })).not.toBeNull();
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 2 })).toBeNull();
  });

  test("a different scope neither sees nor consumes the text", () => {
    const token = "d".repeat(32);
    queueDesignPrefill(event(token));
    expect(takeDesignPrefill({ token, scopeId: "scope-b", now: 1 })).toBeNull();
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 2 })).not.toBeNull();
  });

  test("two listeners race and only the first accepting listener consumes", () => {
    const token = "e".repeat(32);
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    subscribeDesignPrefills({ scopeId: "scope-a", token, now: 1 }, first);
    subscribeDesignPrefills({ scopeId: "scope-a", token, now: 1 }, second);
    queueDesignPrefill(event(token));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 1 })).toBeNull();
  });

  test("a listener that returns false leaves the event for the next listener", () => {
    const token = "f".repeat(32);
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    const offFirst = subscribeDesignPrefills({ scopeId: "scope-a", token, now: 1 }, first);
    const offSecond = subscribeDesignPrefills({ scopeId: "scope-a", token, now: 1 }, second);
    queueDesignPrefill(event(token));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    offFirst();
    offSecond();
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 1 })).toBeNull();
  });

  test("a listener subscribed for another scope never receives the body", () => {
    const token = "g".repeat(32);
    const wrongHost = vi.fn(() => true);
    subscribeDesignPrefills({ scopeId: "scope-b", token, now: 1 }, wrongHost);
    queueDesignPrefill(event(token));
    expect(wrongHost).not.toHaveBeenCalled();
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 1 })).not.toBeNull();
  });

  test("an event already waiting is handed to the first matching subscriber", () => {
    const token = "h".repeat(32);
    queueDesignPrefill(event(token));
    const listener = vi.fn(() => true);
    subscribeDesignPrefills({ scopeId: "scope-a", token, now: 1 }, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 1 })).toBeNull();
  });

  test("subscribing after the TTL never delivers or consumes an expired token", () => {
    const token = "m".repeat(32);
    queueDesignPrefill(event(token, 1_000));
    const listener = vi.fn(() => true);
    subscribeDesignPrefills(
      { scopeId: "scope-a", token, now: 1_000 + DESIGN_PREFILL_TTL_MS + 1 },
      listener,
    );
    expect(listener).not.toHaveBeenCalled();
    expect(
      takeDesignPrefill({ token, scopeId: "scope-a", now: 1_000 + DESIGN_PREFILL_TTL_MS + 2 }),
    ).toBeNull();
  });

  test("a null workspace is preserved for the screen to clear its target", () => {
    const token = "n".repeat(32);
    queueDesignPrefill(event(token, 1_000, { workspaceId: null }));
    expect(takeDesignPrefill({ token, scopeId: "scope-a", now: 1_001 })?.workspaceId).toBeNull();
  });

  test("expired tokens are dropped at the TTL boundary", () => {
    const token = "i".repeat(32);
    queueDesignPrefill(event(token, 1_000));
    expect(
      takeDesignPrefill({ token, scopeId: "scope-a", now: 1_000 + DESIGN_PREFILL_TTL_MS + 1 }),
    ).toBeNull();

    const fresh = "j".repeat(32);
    queueDesignPrefill(event(fresh, 1_000));
    expect(
      takeDesignPrefill({ token: fresh, scopeId: "scope-a", now: 1_000 + DESIGN_PREFILL_TTL_MS }),
    ).not.toBeNull();
  });

  test("the queue holds at most twenty events and evicts the oldest", () => {
    const tokens = Array.from({ length: DESIGN_PREFILL_CAPACITY + 1 }, (_, index) =>
      index.toString(16).padStart(2, "0").repeat(16),
    );
    tokens.forEach((token, index) => {
      queueDesignPrefill(event(token, index));
    });
    expect(takeDesignPrefill({ token: tokens[0] ?? "", scopeId: "scope-a", now: 100 })).toBeNull();
    expect(
      takeDesignPrefill({ token: tokens[1] ?? "", scopeId: "scope-a", now: 100 }),
    ).not.toBeNull();
    expect(
      takeDesignPrefill({ token: tokens[tokens.length - 1] ?? "", scopeId: "scope-a", now: 100 }),
    ).not.toBeNull();
  });

  test("a cold reload (fresh module state) drops queued tokens", async () => {
    const token = "k".repeat(32);
    queueDesignPrefill(event(token));
    vi.resetModules();
    // Static import cannot exercise a fresh module instance; the reload boundary is the point.
    const fresh = await import("../client/designer/events");
    expect(fresh.takeDesignPrefill({ token, scopeId: "scope-a", now: 1 })).toBeNull();
  });

  test("tokens are short hex values and screen params never carry the request", () => {
    const token = createDesignPrefillToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const params = buildDesignPrefillScreenParams(token);
    expect(params).toEqual({ tab: "teams", designToken: token });
    expect(JSON.stringify(params)).not.toContain("改版");
  });
});

describe("slash command", () => {
  function commandInput(overrides: Partial<DesignSlashCommandInput> = {}) {
    return {
      args: "  给后台做一次改版  ",
      workspaceId: "ws-1",
      mode: "economy",
      now: 1_000,
      readScopeId: vi.fn(async () => "scope-a"),
      openScreen: vi.fn(),
      createToken: () => "l".repeat(32),
      ...overrides,
    } satisfies DesignSlashCommandInput;
  }

  test("queues a prefill and opens the Teams screen with a short token only", async () => {
    const openScreen = vi.fn();
    const input = commandInput({ openScreen });
    const start = vi.fn();
    const withStart = { ...input, start } as unknown as DesignSlashCommandInput;

    const result = await handleDesignSlashCommand(withStart);
    expect(result).toEqual({
      kind: "queued",
      token: "l".repeat(32),
      request: "给后台做一次改版",
      message: designZh.prefillQueued,
    });
    expect(start).not.toHaveBeenCalled();
    expect(openScreen).toHaveBeenCalledTimes(1);
    const opened = openScreen.mock.calls[0]?.[0];
    expect(opened).toEqual({
      screenId: AGENT_TEAMS_SCREEN,
      params: { tab: "teams", designToken: "l".repeat(32) },
    });
    expect(Object.keys(opened?.params ?? {}).sort()).toEqual(["designToken", "tab"]);
    expect(JSON.stringify(opened?.params)).not.toContain("给后台做一次改版");
    expect(JSON.stringify(opened?.params)).not.toContain("ws-1");
  });

  test("the queued event keeps the workspace and mode for the screen to consume", async () => {
    const input = commandInput();
    await handleDesignSlashCommand(input);
    expect(
      takeDesignPrefill({ token: "l".repeat(32), scopeId: "scope-a", now: 1_001 }),
    ).toMatchObject({ workspaceId: "ws-1", mode: "economy", request: "给后台做一次改版" });
  });

  test("an empty argument opens an empty card instead of failing", async () => {
    const input = commandInput({ args: "   ", workspaceId: null });
    const result = await handleDesignSlashCommand(input);
    expect(result).toMatchObject({ kind: "queued", request: "" });
    expect(
      takeDesignPrefill({ token: "l".repeat(32), scopeId: "scope-a", now: 1_001 }),
    ).toMatchObject({ request: "", workspaceId: null });
  });

  test("an oversized argument never reads the scope or opens a screen", async () => {
    const readScopeId = vi.fn(async () => "scope-a");
    const openScreen = vi.fn();
    const input = commandInput({ args: "x".repeat(4001), readScopeId, openScreen });
    await expect(handleDesignSlashCommand(input)).resolves.toEqual({
      kind: "invalid",
      reason: "too-long",
      message: designZh.prefillTooLong,
    });
    expect(readScopeId).not.toHaveBeenCalled();
    expect(openScreen).not.toHaveBeenCalled();
  });

  test("a failed scope lookup opens the empty Teams page with no body in the URL", async () => {
    const readScopeId = vi.fn(async () => {
      throw new Error("offline");
    });
    const openScreen = vi.fn();
    const input = commandInput({ readScopeId, openScreen });
    await expect(handleDesignSlashCommand(input)).resolves.toEqual({
      kind: "scope-unavailable",
      message: designZh.prefillScopeUnavailable,
    });
    expect(openScreen).toHaveBeenCalledWith({
      screenId: AGENT_TEAMS_SCREEN,
      params: { tab: "teams" },
    });
  });

  test("an empty scope id is treated as unavailable", async () => {
    const input = commandInput({ readScopeId: vi.fn(async () => "") });
    await expect(handleDesignSlashCommand(input)).resolves.toEqual({
      kind: "scope-unavailable",
      message: designZh.prefillScopeUnavailable,
    });
  });
});
