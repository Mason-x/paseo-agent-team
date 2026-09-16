import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  quotaProviderFromSession,
  quotaProviderGroups,
  quotaProviderIconName,
  quotaResetLabel,
  quotaSeverityForProvider,
  quotaSummaryForProvider,
  quotasForProvider,
} from "../client/quota-state";
import { listOmpQuotasFrom, resolveListOmpQuotas } from "../server/quota";
import type { OmpQuota } from "../shared/quota";

const quotaRoots: string[] = [];

afterEach(async () => {
  await Promise.all(quotaRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const quotas: OmpQuota[] = [
  {
    provider: "anthropic",
    label: "Claude 5 Hour",
    windowLabel: "5 Hour",
    usedFraction: 0.25,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  },
  {
    provider: "cursor",
    label: "Cursor Pro",
    windowLabel: null,
    usedFraction: 0.9,
    status: "ok",
    resetsAt: null,
    recordedAt: 1,
  },
];

describe("session-specific quota selection", () => {
  test("derives the omp model provider from Paseo's provider string", () => {
    expect(quotaProviderFromSession("omp/anthropic/claude-opus-5")).toBe("anthropic");
    expect(quotaProviderFromSession("omp", "azure/gpt-5.6-terra")).toBe("azure");
    expect(quotaProviderFromSession("codex/gpt-5.4")).toBeNull();
  });
  test("shows only the current session provider quota", () => {
    expect(quotasForProvider(quotas, "anthropic")).toEqual([quotas[0]]);
    expect(quotaSummaryForProvider(quotas, "anthropic")).toEqual({
      visible: true,
      label: "Anthropic · 25%",
    });
    expect(quotaSummaryForProvider(quotas, "azure")).toEqual({
      visible: true,
      label: "Azure · —",
    });
  });

  test("maps each provider to a distinct icon and severity bucket", () => {
    expect(quotaProviderIconName("anthropic")).toBe("Asterisk");
    expect(quotaProviderIconName("cursor")).toBe("MousePointer2");
    expect(quotaProviderIconName("azure")).toBe("Cloud");
    expect(quotaProviderIconName("unknown-vendor")).toBe("Gauge");
    expect(quotaSeverityForProvider(quotas, "anthropic")).toBe("ok");
    expect(quotaSeverityForProvider(quotas, "cursor")).toBe("danger");
    expect(quotaSeverityForProvider(quotas, "azure")).toBe("unknown");
  });

  test("sorts the active session's provider first, then worst quota first", () => {
    const groups = quotaProviderGroups(quotas, "azure");
    expect(groups.map((group) => group.provider)).toEqual(["cursor", "anthropic"]);
    expect(groups[0]).toMatchObject({ provider: "cursor", peakFraction: 0.9, severity: "danger" });

    const currentFirst = quotaProviderGroups(quotas, "anthropic");
    expect(currentFirst.map((group) => group.provider)).toEqual(["anthropic", "cursor"]);
  });
});

describe("quota reset countdown", () => {
  test("treats resets_at as epoch milliseconds, not seconds", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const resetsInTwoHours = now + 2 * 3_600_000 + 30 * 60_000;
    expect(quotaResetLabel(resetsInTwoHours, now)).toBe("resets 2h 30m");
    expect(quotaResetLabel(now - 1_000, now)).toBe("resets 0m");
    expect(quotaResetLabel(null, now)).toBe("");
  });
});

describe("OMP quota reader", () => {
  test("keeps the newest valid quota row per provider account and limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quotas-"));
    quotaRoots.push(root);
    const path = join(root, "agent.db");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    database
      .prepare("INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(1, "anthropic", "account", "five-hour", "Five hour", "5h", 0.1, "ok", null, 1);
    database
      .prepare("INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(2, "anthropic", "account", "five-hour", "Five hour", "5h", 0.9, "warning", 2, 2);
    database
      .prepare("INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(3, "openai", "account", "daily", "Daily", null, 0.2, "ok", null, 3);
    database.close();

    expect(listOmpQuotasFrom(path)).toEqual([
      expect.objectContaining({ provider: "anthropic", usedFraction: 0.9, recordedAt: 2 }),
      expect.objectContaining({ provider: "openai", usedFraction: 0.2, recordedAt: 3 }),
    ]);
    expect(listOmpQuotasFrom(join(root, "missing.db"))).toEqual([]);
  });

  test("resolves quotas from the configured OMP agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-quota-resolver-"));
    quotaRoots.push(root);
    const database = new DatabaseSync(join(root, "agent.db"));
    database.exec(`CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT,
      window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER, recorded_at INTEGER
    )`);
    database
      .prepare("INSERT INTO usage_history VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(1, "anthropic", "account", "daily", "Daily", null, 0.5, "ok", null, 10);
    database.close();
    const previous = process.env.PASEO_OMP_AGENT_DIR;
    process.env.PASEO_OMP_AGENT_DIR = root;
    try {
      expect(resolveListOmpQuotas({})).toEqual({
        quotas: [expect.objectContaining({ provider: "anthropic", usedFraction: 0.5 })],
      });
    } finally {
      if (previous === undefined) delete process.env.PASEO_OMP_AGENT_DIR;
      else process.env.PASEO_OMP_AGENT_DIR = previous;
    }
  });
});

describe("profile alias and opaque-model quotas", () => {
  test("recognizes native and profile plugin model providers without guessing opaque ids", () => {
    expect(quotaProviderFromSession("omp-plugin", "anthropic/claude-fable-5")).toBe("anthropic");
    expect(quotaProviderFromSession("omp-plugin-team-beta", "openai-codex/gpt-5.6-sol")).toBe(
      "openai-codex",
    );
    expect(quotaProviderFromSession("omp-plugin-team-beta", "omp:model:opaque-hash")).toBeNull();
  });
  test("opaque OMP models retain an explicitly aggregate quota pill", () => {
    expect(quotaSummaryForProvider(quotas, null, true)).toEqual({
      visible: true,
      label: "Quotas · 90%",
    });
    expect(quotaSeverityForProvider(quotas, null, true)).toBe("danger");
    expect(quotaSummaryForProvider([], null, true)).toEqual({ visible: true, label: "Quotas · —" });
    expect(quotaSummaryForProvider(quotas, null).visible).toBe(false);
  });
});
