import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import { describe, expect, test } from "vitest";
import {
  formatOmpVersion,
  loadReadyProviderSnapshot,
  lspTone,
  mcpTone,
  processTone,
  refreshProviderDiagnostics,
  rpcUiTone,
  selectKnownOmpProviders,
  summarizeBinaryHealth,
  summarizeLspSupport,
  summarizeMcpDiagnostics,
  summarizeMemoryBackend,
  summarizePathState,
  summarizeProcessDiagnostics,
  summarizeProviderStatus,
  summarizeRpcUiSupport,
} from "../client/provider-diagnostics-state";
import type { OmpProviderHealth } from "../shared/provider-diagnostics";

function health(overrides: Partial<OmpProviderHealth> = {}): OmpProviderHealth {
  return {
    binary: {
      installed: true,
      resolvedPath: "/usr/local/bin/omp",
      version: { major: 18, minor: 1, patch: 15, prerelease: null },
      versionStatus: "ok",
      processCleanupFailed: false,
    },
    rpcUi: { checked: true, supported: true },
    lsp: { status: "supported" },
    mcp: { status: "unavailable", serverCount: null, reason: "No mcp.json." },
    process: { status: "ok", trackedCount: 2 },
    roots: {
      agentRoot: "/home/test/.omp/agent",
      agentRootState: "available",
      configPath: "/home/test/.omp/agent/config.yml",
      configState: "available",
      sessionRoot: "/home/test/.omp/agent/sessions",
      sessionRootState: "available",
    },
    databases: { agentDbState: "available", historyDbState: "available" },
    memoryBackend: "mnemopi",
    checkedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("version health summaries", () => {
  test("formats normalized versions and includes them on successful probes", () => {
    const version = { major: 18, minor: 1, patch: 15, prerelease: "beta.1" };

    expect(formatOmpVersion(version)).toBe("18.1.15-beta.1");
    expect(
      summarizeBinaryHealth({
        installed: true,
        resolvedPath: "/usr/local/bin/omp",
        version,
        versionStatus: "ok",
        processCleanupFailed: false,
      }),
    ).toEqual({ label: "Installed (18.1.15-beta.1)", tone: "ok" });
  });

  test("distinguishes not-found, unrunnable, timeout, failed, and malformed outcomes", () => {
    const base = health().binary;
    const cases = [
      ["not-found", "Not installed", "danger"],
      ["unrunnable", "Found but could not run", "danger"],
      ["timeout", "Version check timed out", "warning"],
      ["probe-failed", "Version check failed", "warning"],
      ["malformed", "Unrecognized version output", "warning"],
    ] as const;

    for (const [versionStatus, label, tone] of cases) {
      expect(summarizeBinaryHealth({ ...base, version: null, versionStatus })).toEqual({
        label,
        tone,
      });
    }
  });
});

describe("compatibility and process summaries", () => {
  test("never turns unknown rpc-ui/LSP probes into unsupported claims", () => {
    expect(summarizeRpcUiSupport({ checked: false, supported: null })).toBe(
      "Unknown (omp binary unavailable)",
    );
    expect(summarizeRpcUiSupport({ checked: true, supported: null })).toBe(
      "Unknown (probe failed, empty, or truncated)",
    );
    expect(rpcUiTone({ checked: true, supported: null })).toBe("muted");

    expect(summarizeLspSupport({ status: "unknown" })).toBe(
      "Unknown (probe failed, empty, or truncated)",
    );
    expect(lspTone({ status: "not-advertised" })).toBe("muted");
  });

  test("renders honest MCP and process availability states", () => {
    expect(
      summarizeMcpDiagnostics({
        status: "unavailable",
        serverCount: null,
        reason: "No signal.",
      }),
    ).toBe("Unavailable (No signal.)");
    expect(
      summarizeMcpDiagnostics({
        status: "configured",
        serverCount: 2,
        reason: null,
      }),
    ).toBe("2 configured");
    const configuredMcp = {
      status: "configured" as const,
      serverCount: 1,
      reason: null,
    };
    expect(mcpTone(configuredMcp)).toBe("ok");
    expect(summarizeProcessDiagnostics({ status: "ok", trackedCount: 3 })).toBe(
      "3 metadata records (states not reported); live processes not verified",
    );
    expect(processTone({ status: "ok", trackedCount: 3 })).toBe("muted");
    expect(summarizeProcessDiagnostics({ status: "unavailable", trackedCount: null })).toBe(
      "No hub run directory found",
    );
    expect(summarizeProcessDiagnostics({ status: "partial", trackedCount: 1 })).toBe(
      "1 metadata records (states not reported; partial access); live processes not verified",
    );
    expect(processTone({ status: "partial", trackedCount: 1 })).toBe("warning");
  });
});

describe("storage summaries", () => {
  test("keeps missing, unreadable, invalid, and wrong-type states distinct", () => {
    expect(summarizePathState("missing")).toEqual({ label: "Missing", tone: "danger" });
    expect(summarizePathState("unreadable")).toEqual({
      label: "Unreadable",
      tone: "warning",
    });
    expect(summarizePathState("invalid")).toEqual({ label: "Invalid", tone: "warning" });
    expect(summarizePathState("wrong-type")).toEqual({
      label: "Wrong type on disk",
      tone: "warning",
    });
  });

  test("does not call unavailable memory not configured", () => {
    expect(summarizeMemoryBackend(health({ memoryBackend: null }))).toBe("Not configured");
    expect(
      summarizeMemoryBackend(
        health({
          memoryBackend: null,
          roots: { ...health().roots, configState: "invalid" },
        }),
      ),
    ).toBe("Unknown (config invalid)");
  });
});

describe("selectKnownOmpProviders", () => {
  test("keeps native and plugin OMP ids, including prototype-like ids safely", () => {
    const entries: PaseoProviderSnapshotResult["entries"] = [
      { provider: "omp", status: "ready", enabled: true, label: "OMP" },
      { provider: "omp-plugin", status: "ready", enabled: true, label: "OMP Plugin" },
      { provider: "omp-plugin-team-beta", status: "ready", enabled: true, label: "OMP Team Beta" },
      { provider: "omp-plugin-invalid/name", status: "ready", enabled: true },
      { provider: "constructor", status: "ready", enabled: true },
      { provider: "toString", status: "ready", enabled: true },
      { provider: "claude", status: "ready", enabled: true, label: "Claude" },
    ];

    expect(selectKnownOmpProviders(entries)).toEqual([
      { id: "omp", label: "OMP", status: "ready", enabled: true },
      { id: "omp-plugin", label: "OMP Plugin", status: "ready", enabled: true },
      { id: "omp-plugin-team-beta", label: "OMP Team Beta", status: "ready", enabled: true },
    ]);
  });
});

describe("provider status summaries", () => {
  test("disabled is primary; enabled statuses use explicit labels and tones", () => {
    expect(summarizeProviderStatus({ enabled: false, status: "ready" })).toEqual({
      label: "Disabled",
      tone: "muted",
    });
    expect(summarizeProviderStatus({ enabled: true, status: "ready" })).toEqual({
      label: "Ready",
      tone: "ok",
    });
    expect(summarizeProviderStatus({ enabled: true, status: "loading" })).toEqual({
      label: "Loading",
      tone: "warning",
    });
    expect(summarizeProviderStatus({ enabled: true, status: "error" })).toEqual({
      label: "Error",
      tone: "danger",
    });
    expect(summarizeProviderStatus({ enabled: true, status: "unavailable" })).toEqual({
      label: "Unavailable",
      tone: "danger",
    });
  });
});

describe("provider snapshot convergence and forced refresh", () => {
  const snapshot: PaseoProviderSnapshotResult = {
    entries: [],
    generatedAt: "2026-09-10T00:00:00.000Z",
    requestId: "request-1",
  };

  test("initial discovery waits for ready rather than keeping a loading snapshot", async () => {
    let waitCalls = 0;
    const providers = {
      async waitForReady() {
        waitCalls += 1;
        return snapshot;
      },
      async snapshot() {
        throw new Error("snapshot fallback should not run");
      },
      async refresh() {
        return { requestId: "refresh", acknowledged: true };
      },
    };

    expect(await loadReadyProviderSnapshot(providers)).toBe(snapshot);
    expect(waitCalls).toBe(1);
  });

  test("caches successful forced health even when provider refresh partially fails", async () => {
    const forcedHealth = health();
    const cachedHealth: OmpProviderHealth[] = [];
    const cachedProviders: PaseoProviderSnapshotResult[] = [];
    const providers = {
      async waitForReady() {
        return snapshot;
      },
      async snapshot() {
        return snapshot;
      },
      async refresh() {
        throw new Error("provider refresh failed");
      },
    };

    const result = await refreshProviderDiagnostics({
      providers,
      async loadForcedHealth() {
        return forcedHealth;
      },
      cacheHealth(value) {
        cachedHealth.push(value);
      },
      cacheProviders(value) {
        cachedProviders.push(value);
      },
    });

    expect(result.failed).toBe(true);
    expect(cachedHealth).toEqual([forcedHealth]);
    expect(cachedProviders).toEqual([snapshot]);
  });

  test("suppresses only a recognized unsupported-host refresh error", async () => {
    const providers = {
      async waitForReady() {
        return snapshot;
      },
      async snapshot() {
        return snapshot;
      },
      async refresh() {
        throw Object.assign(new Error("update host"), { code: "UPDATE_HOST_REQUIRED" });
      },
    };

    const result = await refreshProviderDiagnostics({
      providers,
      async loadForcedHealth() {
        return health();
      },
      cacheHealth() {},
      cacheProviders() {},
    });

    expect(result.failed).toBe(false);
  });
});

test("Hub historical metadata is never presented as live process health", () => {
  const historical = {
    status: "ok" as const,
    trackedCount: 22,
    activeCount: 0,
    historicalCount: 22,
    unknownCount: 0,
  };
  expect(summarizeProcessDiagnostics(historical)).toBe(
    "22 metadata records (0 active-state, 22 historical, 0 unknown); live processes not verified",
  );
  expect(processTone(historical)).toBe("muted");
  expect(
    summarizeProcessDiagnostics({
      status: "partial",
      trackedCount: 3,
      activeCount: 1,
      historicalCount: 1,
      unknownCount: 1,
    }),
  ).toContain("1 unknown; partial access");
});

test("provider refresh includes registered profile aliases but excludes other runtimes", async () => {
  let requested: string[] | undefined;
  const snapshot: PaseoProviderSnapshotResult = {
    entries: [],
    generatedAt: "2026-09-16T00:00:00Z",
    requestId: "test",
  };
  await refreshProviderDiagnostics({
    providers: {
      async refresh(input) {
        requested = input?.providers;
        return { requestId: "refresh", acknowledged: true };
      },
      async snapshot() {
        return snapshot;
      },
      async waitForReady() {
        return snapshot;
      },
    },
    providerIds: ["omp-plugin-team-beta", "omp-plugin", "codex", "omp-plugin-../invalid"],
    async loadForcedHealth() {
      return health();
    },
    cacheHealth() {},
    cacheProviders() {},
  });
  expect(requested).toEqual(["omp", "omp-plugin", "omp-plugin-team-beta"]);
});
