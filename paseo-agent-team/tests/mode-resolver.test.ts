import { describe, expect, test } from "vitest";
import {
  type HostSnapshot,
  resolveCoordinatorProfile,
  resolveSeatProfile,
} from "../shared/domain/mode-resolver";
import { architect, claudeOpus, codexXhigh, role } from "./fixtures";

const host: HostSnapshot = {
  status: "ready",
  profiles: [claudeOpus, codexXhigh],
  availability: [
    { provider: "claude", available: true },
    { provider: "codex", available: true },
  ],
};

describe("single-path seat resolution", () => {
  test("uses a Role's preferred Profile before its fallback", () => {
    expect(resolveSeatProfile({ role: architect, host })).toMatchObject({
      ok: true,
      value: { profile: { id: claudeOpus.id }, source: "role-preferred", issues: [] },
    });
  });

  test("uses the fallback when the preferred provider is unavailable", () => {
    const unavailable: HostSnapshot = {
      ...host,
      availability: [
        { provider: "claude", available: false },
        { provider: "codex", available: true },
      ],
    };
    expect(resolveSeatProfile({ role: architect, host: unavailable })).toMatchObject({
      ok: true,
      value: { profile: { id: codexXhigh.id }, source: "role-fallback" },
    });
  });

  test("a missing availability row keeps the original Role binding", () => {
    const unverified: HostSnapshot = { ...host, availability: [], availabilityUnverified: true };
    expect(resolveSeatProfile({ role: architect, host: unverified })).toMatchObject({
      ok: true,
      value: { profile: { id: claudeOpus.id }, source: "role-preferred" },
    });
  });

  test("an unreadable host blocks a seat instead of selecting a Profile", () => {
    expect(
      resolveSeatProfile({
        role: architect,
        host: { status: "unavailable", reason: "query failed" },
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          code: "MODE_CONTEXT_UNAVAILABLE",
          severity: "blocker",
          params: { reason: "query failed" },
        },
      ],
    });
  });

  test("all unavailable bindings produce a Role-specific blocker", () => {
    const unavailable: HostSnapshot = {
      ...host,
      availability: [
        { provider: "claude", available: false },
        { provider: "codex", available: false },
      ],
    };
    expect(resolveSeatProfile({ role: architect, host: unavailable })).toEqual({
      ok: false,
      issues: [
        {
          code: "MODE_PROFILE_UNRESOLVED",
          severity: "blocker",
          roleId: architect.id,
          params: { reason: "provider-unavailable" },
        },
      ],
    });
  });

  test("a disabled Role is blocked at the seat resolver boundary", () => {
    expect(resolveSeatProfile({ role: { ...architect, enabled: false }, host })).toEqual({
      ok: false,
      issues: [
        { code: "MODE_ROLE_DISABLED", severity: "blocker", roleId: architect.id, params: {} },
      ],
    });
  });

  test("a malformed retired execution policy does not affect the Role binding", () => {
    const legacy = role({
      id: "legacy",
      name: "Legacy",
      executionPolicy: { tier: "future-tier", taskKind: { invalid: true } },
    });
    expect(resolveSeatProfile({ role: legacy, host })).toMatchObject({
      ok: true,
      value: { profile: { id: claudeOpus.id }, source: "role-preferred" },
    });
  });
});

describe("single-path coordinator resolution", () => {
  test("preserves preferred-to-fallback warnings and source", () => {
    const fallback = {
      ...architect,
      preferredProfiles: [{ profileId: "missing", nameSnapshot: "Missing" }],
    };
    const result = resolveCoordinatorProfile({ role: fallback, host });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.legacyReason);
    expect(result.selection).toMatchObject({
      profile: { id: codexXhigh.id },
      source: "role-fallback",
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("Missing");
    expect(result.warnings[1]).toContain(codexXhigh.name);
  });

  test("reports missing bindings without inventing a coordinator", () => {
    const missing = {
      ...architect,
      preferredProfiles: [{ profileId: "missing" }],
      fallbackProfiles: [],
    };
    expect(resolveCoordinatorProfile({ role: missing, host })).toEqual({
      ok: false,
      legacyReason: "all-missing",
    });
  });
});
