import { describe, expect, test } from "vitest";
import { resolveProfile } from "../client/domain/profile-resolver";
import { allAvailable, architect, claudeOpus, codexXhigh } from "./fixtures";

describe("resolveProfile", () => {
  test("uses preferred then fallback", () => {
    const preferred = resolveProfile(architect, [claudeOpus, codexXhigh], allAvailable);
    expect(preferred).toMatchObject({ ok: true, profile: claudeOpus, source: "role-preferred" });

    const fallback = resolveProfile(architect, [codexXhigh], allAvailable);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.profile).toEqual(codexXhigh);
      expect(fallback.source).toBe("role-fallback");
      expect(fallback.warnings.some((warning) => warning.includes("备选"))).toBe(true);
    }
  });

  test("skips an unavailable provider and continues", () => {
    const result = resolveProfile(
      architect,
      [claudeOpus, codexXhigh],
      [
        { provider: "claude", available: false, reason: "not logged in" },
        { provider: "codex", available: true },
      ],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toEqual(codexXhigh);
      expect(result.warnings.some((warning) => warning.includes("不可用"))).toBe(true);
    }
  });

  test("reports all-missing when every candidate is gone", () => {
    const result = resolveProfile(architect, [], allAvailable);
    expect(result).toMatchObject({ ok: false, reason: "all-missing" });
  });

  test("reports provider-unavailable when candidates exist but providers are down", () => {
    const result = resolveProfile(
      architect,
      [claudeOpus, codexXhigh],
      [
        { provider: "claude", available: false, reason: "offline" },
        { provider: "codex", available: false, reason: "offline" },
      ],
    );
    expect(result).toMatchObject({ ok: false, reason: "provider-unavailable" });
  });

  test("reports no-candidates when the role has none", () => {
    const result = resolveProfile(
      { ...architect, preferredProfiles: [], fallbackProfiles: [] },
      [claudeOpus],
      allAvailable,
    );
    expect(result).toMatchObject({ ok: false, reason: "no-candidates" });
  });
});
