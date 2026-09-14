import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  normalizeOmpCatalogOptions,
  normalizeOmpSessionConfig,
  withCommittedOmpSelection,
} from "../server/provider/config-normalization";
import { buildOmpSpawnRequest } from "../server/provider/omp-rpc";
import { parseOmpProviderOptions } from "../server/provider/provider-options";
import { createOmpProvider } from "../server/provider/registration";
import {
  configuredOutputRedactionValues,
  OmpPublicDataSerializer,
} from "../server/provider/security";

const TEST_ENV: NodeJS.ProcessEnv = {
  HOME: "/home/tester",
  PATH: "/usr/bin",
  PI_CODING_AGENT_DIR: "/home/tester/.omp/agent",
};

function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    cwd: "/repo",
    env: {},
    mcpServers: {},
    settings: {},
    persist: true,
    ...overrides,
  };
}

describe("OMP provider option normalization", () => {
  test("maps command, environment, params, and ephemeral sessions to argv", () => {
    const normalized = normalizeOmpSessionConfig(
      sessionConfig({
        env: { SESSION_VALUE: "session-wins" },
        mode: "full",
        providerOptions: {
          command: ["/usr/bin/env", "omp-custom", "--mode=rpc-ui"],
          env: { PROFILE_VALUE: "profile", SESSION_VALUE: "profile-loses" },
          params: {
            sessionDir: "/var/lib/omp/sessions",
            rpcTimeoutMs: 12_345,
            smolModel: "openai/gpt-5-mini",
            slowModel: "anthropic/claude-opus-5",
            planModel: "openai/gpt-5.4",
          },
        },
        persist: false,
      }),
    );
    const request = buildOmpSpawnRequest({ ...normalized, environment: TEST_ENV });

    expect(request.command).toBe("/usr/bin/env");
    expect(request.args).toEqual([
      "omp-custom",
      "--mode=rpc-ui",
      "--approval-mode",
      "yolo",
      "--smol",
      "openai/gpt-5-mini",
      "--slow",
      "anthropic/claude-opus-5",
      "--plan",
      "openai/gpt-5.4",
      "--session-dir",
      "/var/lib/omp/sessions",
      "--no-session",
    ]);
    expect(request.env).toEqual({
      ...TEST_ENV,
      PROFILE_VALUE: "profile",
      SESSION_VALUE: "session-wins",
    });
    expect(normalized.readyTimeoutMs).toBe(12_345);
    expect(normalized.requestTimeoutMs).toBe(12_345);
  });

  test("forwards selected daemon environment names across catalog and session launches", () => {
    const providerOptions = {
      inheritEnv: ["CUSTOM_API_KEY", "CUSTOM_SETTING", "OVERRIDE_ME"],
      env: { OVERRIDE_ME: "profile-value" },
    };
    const catalog = normalizeOmpCatalogOptions(
      { scope: "workspace", cwd: "/repo", providerOptions },
      "/repo",
    );
    const session = normalizeOmpSessionConfig(
      sessionConfig({
        providerOptions,
        env: { OVERRIDE_ME: "session-value" },
      }),
    );

    expect(catalog.inheritEnv).toEqual(providerOptions.inheritEnv);
    expect(session.inheritEnv).toEqual(providerOptions.inheritEnv);

    const daemonEnvironment = {
      ...TEST_ENV,
      CUSTOM_API_KEY: "daemon-credential",
      CUSTOM_SETTING: "daemon-setting",
      OVERRIDE_ME: "daemon-value",
      UNSELECTED_VALUE: "must-not-pass",
    };
    const catalogRequest = buildOmpSpawnRequest({ ...catalog, environment: daemonEnvironment });
    const sessionRequest = buildOmpSpawnRequest({ ...session, environment: daemonEnvironment });

    expect(catalogRequest.env.CUSTOM_API_KEY).toBe("daemon-credential");
    expect(catalogRequest.env.CUSTOM_SETTING).toBe("daemon-setting");
    expect(catalogRequest.env.OVERRIDE_ME).toBe("profile-value");
    expect(sessionRequest.env.OVERRIDE_ME).toBe("session-value");
    expect(catalogRequest.env.UNSELECTED_VALUE).toBeUndefined();
    expect(sessionRequest.env.UNSELECTED_VALUE).toBeUndefined();
  });

  test("keys catalog caches by inherited names without resolving daemon values", async () => {
    const catalogOptions = {
      scope: "global" as const,
      providerOptions: { inheritEnv: ["CUSTOM_API_KEY"] },
    };
    const firstValueKey = await createOmpProvider({
      environment: { ...TEST_ENV, CUSTOM_API_KEY: "first-secret" },
    }).getCatalogCacheKey?.(catalogOptions);
    const secondValueKey = await createOmpProvider({
      environment: { ...TEST_ENV, CUSTOM_API_KEY: "second-secret" },
    }).getCatalogCacheKey?.(catalogOptions);
    const differentNameKey = await createOmpProvider({
      environment: { ...TEST_ENV, OTHER_API_KEY: "first-secret" },
    }).getCatalogCacheKey?.({
      scope: "global",
      providerOptions: { inheritEnv: ["OTHER_API_KEY"] },
    });

    expect(firstValueKey).toBeDefined();
    expect(firstValueKey).toBe(secondValueKey);
    expect(firstValueKey).not.toBe(differentNameKey);
  });

  test("maps every interactive launch mode after permission bridging", () => {
    for (const [mode, approvalMode] of [
      ["write", "write"],
      ["ask", "always-ask"],
    ] as const) {
      const nativeLaunch = buildOmpSpawnRequest({ cwd: "/repo", mode }, TEST_ENV);
      expect(nativeLaunch.args.slice(-2)).toEqual(["--approval-mode", approvalMode]);
      expect(normalizeOmpSessionConfig(sessionConfig({ mode }), true).mode).toBe(mode);
      const template = {
        cwd: "/repo",
        command: ["/opt/omp", "--mode=rpc-ui"],
        env: { PROFILE: mode },
        mode,
        roleModels: { smol: "fast", slow: "slow", plan: "planner" },
        sessionDir: `/sessions/${mode}`,
        readyTimeoutMs: 12_000,
        requestTimeoutMs: 34_000,
        noSession: true,
        systemPrompt: `system-${mode}`,
      } as const;
      const refreshed = withCommittedOmpSelection(template, {
        model: "provider/first",
        thinkingOption: "medium",
      });
      const recoveredAgain = withCommittedOmpSelection(refreshed, {
        model: "provider/second",
        thinkingOption: "high",
      });
      expect(recoveredAgain).toEqual({
        ...template,
        model: "provider/second",
        thinkingOption: "high",
      });
    }
  });

  test("defaults output redaction to none and accepts only configured-values", () => {
    expect(parseOmpProviderOptions({}).outputRedaction).toBe("none");
    expect(
      normalizeOmpSessionConfig(
        sessionConfig({ providerOptions: { outputRedaction: "configured-values" } }),
      ).outputRedaction,
    ).toBe("configured-values");
    for (const outputRedaction of ["configured", "all", true, null]) {
      expect(() => parseOmpProviderOptions({ outputRedaction })).toThrow(
        "providerOptions.outputRedaction",
      );
    }
  });
  test("collects only explicit credential values and excludes short values", () => {
    const config = sessionConfig({
      env: {
        SESSION_SECRET: "session-secret",
        SHARED_TOKEN: "session-override",
        SHORT_TOKEN: "xyz",
      },
      mcpServers: {
        local: {
          type: "stdio",
          command: "server-secret-is-not-collected",
          args: ["argument-secret-is-not-collected"],
          env: { MCP_VALUE: "mcp-env-secret", SHORT: "abc" },
        },
        remote: {
          type: "http",
          url: "https://url-secret-is-not-collected.example.test",
          headers: { Authorization: "mcp-header-secret", "X-Short": "xyz" },
        },
      },
      providerOptions: {
        outputRedaction: "configured-values",
        env: {
          PROFILE_API_KEY: "profile-secret",
          PROFILE_LABEL: "profile-visible",
          SHARED_TOKEN: "profile-loses",
        },
      },
    });
    const normalized = normalizeOmpSessionConfig(config);

    expect(
      configuredOutputRedactionValues(
        normalized.outputRedaction ?? "none",
        normalized.env,
        config.mcpServers,
      ),
    ).toEqual([
      "profile-secret",
      "session-override",
      "session-secret",
      "mcp-env-secret",
      "mcp-header-secret",
    ]);
    expect(configuredOutputRedactionValues("none", normalized.env, config.mcpServers)).toEqual([]);
  });

  test("does not hold fragmented output for cross-frame redaction", () => {
    const serializer = new OmpPublicDataSerializer(["configured-secret"]);
    expect(serializer.text("configured-")).toBe("configured-");
    expect(serializer.text("secret")).toBe("secret");
    expect(serializer.text("configured-secret")).toBe("<redacted>");
  });
  test("enforces the generic denied tool list in OMP launch arguments", () => {
    const normalized = normalizeOmpSessionConfig({
      ...sessionConfig({ mode: "full" }),
      deniedTools: ["bash", "write", "bash"],
    } as ProviderSessionConfig & { deniedTools: readonly string[] });
    const request = buildOmpSpawnRequest({ ...normalized, environment: TEST_ENV });
    const toolsIndex = request.args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    const enabledTools = request.args[toolsIndex + 1]?.split(",") ?? [];
    expect(enabledTools).toContain("read");
    expect(enabledTools).not.toContain("bash");
    expect(enabledTools).not.toContain("write");
    expect(() =>
      normalizeOmpSessionConfig({
        ...sessionConfig(),
        deniedTools: ["unknown-extension-tool"],
      } as ProviderSessionConfig & { deniedTools: readonly string[] }),
    ).toThrow("cannot enforce unknown denied tools");
  });

  test("keeps host model overrides outside strict provider options", () => {
    for (const field of ["models", "additionalModels", "disallowedTools"] as const) {
      expect(() => parseOmpProviderOptions({ [field]: [] })).toThrow("Unrecognized key");
    }
  });

  test("rejects unknown or malformed options instead of stripping them", () => {
    expect(() => parseOmpProviderOptions({ typo: true })).toThrow(
      "providerOptions: Unrecognized key",
    );
    expect(() => parseOmpProviderOptions({ command: [] })).toThrow("providerOptions.command");
    expect(() => parseOmpProviderOptions({ params: { rpcTimeoutMs: 0 } })).toThrow(
      "providerOptions.params.rpcTimeoutMs",
    );
    expect(() => parseOmpProviderOptions({ inheritEnv: "CUSTOM_TOKEN" })).toThrow(
      "providerOptions.inheritEnv",
    );
    expect(() => parseOmpProviderOptions({ inheritEnv: ["9INVALID"] })).toThrow(
      "providerOptions.inheritEnv.0",
    );
    expect(() =>
      parseOmpProviderOptions({
        inheritEnv: Array.from({ length: 257 }, (_, index) => `CUSTOM_${index}`),
      }),
    ).toThrow("providerOptions.inheritEnv");
    expect(() =>
      normalizeOmpSessionConfig(sessionConfig({ settings: { unsupported: true } })),
    ).toThrow("does not expose live provider settings");
  });
});
