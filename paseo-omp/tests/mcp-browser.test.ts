import { describe, expect, test } from "vitest";
import {
  OmpBrowserAuthorizationRegistry,
  resolveOpenOmpMcpAuthorizationInPaseoBrowser,
} from "../server/mcp-browser";

describe("OMP browser authorization registry", () => {
  test("routes only to the current active agent session", async () => {
    const registry = new OmpBrowserAuthorizationRegistry();
    const opened: string[] = [];
    const registration = registry.register("agent-1", async (url) => {
      opened.push(url);
    });
    const authorizationToken = registration.issue("https://auth.example.test/authorize");
    expect(authorizationToken).toBeDefined();

    await registry.open(authorizationToken ?? "");
    expect(opened).toEqual(["https://auth.example.test/authorize"]);

    registration.remove();
    await expect(registry.open(authorizationToken ?? "")).rejects.toThrow("no longer available");
  });

  test("does not let a stale cleanup remove a replacement session", async () => {
    const registry = new OmpBrowserAuthorizationRegistry();
    const firstRegistration = registry.register("agent-1", async () => {});
    const staleToken = firstRegistration.issue("https://auth.example.test/stale");
    firstRegistration.remove();

    let opened = false;
    const replacement = registry.register("agent-1", async () => {
      opened = true;
    });
    const replacementToken = replacement.issue("https://auth.example.test/current");
    firstRegistration.remove();

    await expect(registry.open(staleToken ?? "")).rejects.toThrow("no longer available");
    await registry.open(replacementToken ?? "");
    expect(opened).toBe(true);
  });

  test("bounds grants and invalidates the oldest authorization", async () => {
    const registry = new OmpBrowserAuthorizationRegistry();
    const opened: string[] = [];
    const registration = registry.register("agent-1", async (url) => {
      opened.push(url);
    });
    const tokens = Array.from({ length: 17 }, (_, index) =>
      registration.issue(`https://auth.example.test/authorize/${index}`),
    );

    await expect(registry.open(tokens[0] ?? "")).rejects.toThrow("no longer available");
    await registry.open(tokens[16] ?? "");
    expect(opened).toEqual(["https://auth.example.test/authorize/16"]);
  });

  test("rejects duplicate and excessive session registrations", () => {
    const registry = new OmpBrowserAuthorizationRegistry();
    const first = registry.register("agent-0", async () => {});
    expect(() => registry.register("agent-0", async () => {})).toThrow("already registered");
    for (let index = 1; index < 32; index += 1) {
      registry.register(`agent-${index}`, async () => {});
    }
    expect(() => registry.register("agent-32", async () => {})).toThrow("session limit");
    first.remove();
    expect(first.issue("https://auth.example.test/stale")).toBeUndefined();
  });

  test("resolves an opaque browser authorization RPC and clears all grants", async () => {
    const registry = new OmpBrowserAuthorizationRegistry();
    let opened = false;
    const registration = registry.register("agent-1", async () => {
      opened = true;
    });
    const authorizationToken = registration.issue("https://auth.example.test/authorize");

    await expect(
      resolveOpenOmpMcpAuthorizationInPaseoBrowser(
        { authorizationToken: authorizationToken ?? "" },
        registry,
      ),
    ).resolves.toEqual({ opened: true });
    expect(opened).toBe(true);

    registry.clear();
    await expect(registry.open(authorizationToken ?? "")).rejects.toThrow("no longer available");
  });
});
