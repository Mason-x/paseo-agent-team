import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildOmpPluginConfigMutationArgs,
  buildOmpPluginMutationArgs,
  inspectOmpPluginConfigWithDependencies,
  listOmpPluginsWithDependencies,
  mutateOmpPluginConfigWithDependencies,
  mutateOmpPluginWithDependencies,
  type OmpPluginDependencies,
  parseOmpPluginConfig,
  parseOmpPluginList,
} from "../server/omp-plugins";
import type { BoundedRun } from "../server/provider-diagnostics";
import {
  OmpPluginConfigMutationSchema,
  OmpPluginInstallSourceSchema,
  OmpPluginMutationSchema,
  OmpPluginTargetSchema,
} from "../shared/omp-plugins";

function completed(stdout: string, exitCode = 0): BoundedRun {
  return {
    outcome: "exited",
    stdout,
    truncated: false,
    exitCode,
    signal: null,
    spawnErrorCode: null,
    cleanupFailed: false,
  };
}

function dependenciesFor(runPlugin: OmpPluginDependencies["runPlugin"]): OmpPluginDependencies {
  return {
    async resolveExecutable() {
      return "/trusted/omp";
    },
    runPlugin,
  };
}

describe("OMP plugin RPC validation", () => {
  test.each([
    "",
    " ",
    "--force",
    "-evil",
    "package\n--force",
    "package\0other",
    "package\t--force",
    `x${"a".repeat(512)}`,
    "🙂".repeat(200),
  ])("rejects unsafe install source %j", (source) => {
    expect(OmpPluginInstallSourceSchema.safeParse(source).success).toBe(false);
    expect(OmpPluginMutationSchema.safeParse({ action: "install", source }).success).toBe(false);
  });

  test.each(["", "--force", "plugin\nother", "plugin\0other", "BadPlugin", "a".repeat(215)])(
    "rejects unsafe plugin target %j",
    (plugin) => {
      expect(OmpPluginTargetSchema.safeParse(plugin).success).toBe(false);
    },
  );

  test("accepts documented package, marketplace, Git, and local install sources", () => {
    for (const source of [
      "@oh-my-pi/exa",
      "code-review@claude-plugins-official",
      "github:user/repo#v1.0",
      "https://github.com/user/repo#v1.0",
      "./plugins/local plugin",
    ]) {
      expect(OmpPluginInstallSourceSchema.safeParse(source).success).toBe(true);
    }
  });

  test.each(["", "--key", "line\nbreak", "nul\0byte"])("rejects unsafe config key %j", (key) => {
    expect(
      OmpPluginConfigMutationSchema.safeParse({
        action: "delete",
        plugin: "safe-plugin",
        key,
      }).success,
    ).toBe(false);
  });

  test.each(["", "--value", "line\nbreak", "nul\0byte", "🙂".repeat(1_025)])(
    "rejects unsafe config string value %j",
    (value) => {
      expect(
        OmpPluginConfigMutationSchema.safeParse({
          action: "set",
          plugin: "safe-plugin",
          key: "endpoint",
          value,
        }).success,
      ).toBe(false);
    },
  );

  test("accepts finite config numbers and rejects non-finite values", () => {
    expect(
      OmpPluginConfigMutationSchema.safeParse({
        action: "set",
        plugin: "safe-plugin",
        key: "offset",
        value: -1,
      }).success,
    ).toBe(true);
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        OmpPluginConfigMutationSchema.safeParse({
          action: "set",
          plugin: "safe-plugin",
          key: "retryCount",
          value,
        }).success,
      ).toBe(false);
    }
  });

  test("requires workspace context and rejects project-scoped installs", () => {
    const mutation = {
      action: "install" as const,
      source: "plugin@catalog",
      scope: "project" as const,
    };
    expect(OmpPluginMutationSchema.safeParse(mutation).success).toBe(false);
    expect(
      OmpPluginMutationSchema.safeParse({
        action: "install",
        source: "@scope/package",
        scope: "project",
        cwd: "/workspace/project",
      }).success,
    ).toBe(false);
    expect(
      OmpPluginMutationSchema.safeParse({ ...mutation, cwd: "/workspace/project" }).success,
    ).toBe(false);
    expect(
      OmpPluginMutationSchema.safeParse({
        action: "enable",
        plugin: "plugin@catalog",
        scope: "project",
        cwd: "/workspace/project",
      }).success,
    ).toBe(true);
  });
});

describe("OMP plugin command construction", () => {
  test("builds only documented argv for lifecycle mutations", () => {
    expect(
      buildOmpPluginMutationArgs({ action: "install", source: "plugin@catalog", scope: "user" }),
    ).toEqual(["plugin", "install", "plugin@catalog", "--scope", "user", "--json"]);
    expect(
      buildOmpPluginMutationArgs({
        action: "enable",
        plugin: "plugin@catalog",
        scope: "project",
        cwd: "/workspace/project",
      }),
    ).toEqual(["plugin", "enable", "plugin@catalog", "--scope", "project", "--json"]);
    expect(
      buildOmpPluginMutationArgs({ action: "enable", plugin: "plugin@catalog", scope: "user" }),
    ).toEqual(["plugin", "enable", "plugin@catalog", "--scope", "user", "--json"]);
    expect(buildOmpPluginMutationArgs({ action: "disable", plugin: "@scope/plugin" })).toEqual([
      "plugin",
      "disable",
      "@scope/plugin",
      "--scope",
      "user",
      "--json",
    ]);
    expect(buildOmpPluginMutationArgs({ action: "uninstall", plugin: "plain-plugin" })).toEqual([
      "plugin",
      "uninstall",
      "plain-plugin",
      "--scope",
      "user",
      "--json",
    ]);
    expect(buildOmpPluginMutationArgs({ action: "upgrade", plugin: "plugin@catalog" })).toEqual([
      "plugin",
      "upgrade",
      "plugin@catalog",
      "--scope",
      "user",
      "--json",
    ]);
  });

  test("builds documented typed config argv without a shell", () => {
    expect(
      buildOmpPluginConfigMutationArgs({
        action: "set",
        plugin: "safe-plugin",
        key: "retryCount",
        value: 3,
      }),
    ).toEqual(["plugin", "config", "set", "safe-plugin", "retryCount", "--json", "--", "3"]);
    expect(
      buildOmpPluginConfigMutationArgs({
        action: "delete",
        plugin: "safe-plugin",
        key: "retryCount",
      }),
    ).toEqual(["plugin", "config", "delete", "safe-plugin", "retryCount", "--json"]);
  });
});

describe("OMP plugin state", () => {
  test("accepts the documented no-plugin JSON state", async () => {
    const calls: string[][] = [];
    const result = await listOmpPluginsWithDependencies(
      {},
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        return completed('{"npm":[],"marketplace":[]}');
      }),
    );

    expect(calls).toEqual([["plugin", "list", "--json"]]);
    expect(result).toEqual({ available: true, plugins: [], droppedCount: 0 });
  });

  test("runs plugin discovery from the selected workspace", async () => {
    const workingDirectories: Array<string | undefined> = [];
    await listOmpPluginsWithDependencies(
      { cwd: "/workspace/project" },
      dependenciesFor(async (_executable, _args, _limit, _timeout, cwd) => {
        workingDirectories.push(cwd);
        return completed('{"npm":[],"marketplace":[]}');
      }),
    );

    expect(workingDirectories).toEqual(["/workspace/project"]);
  });
  test("maps bounded npm and marketplace identity, source, version, scope, and status", () => {
    expect(
      parseOmpPluginList({
        npm: [
          {
            name: "@scope/tool",
            version: "1.2.3",
            path: "/home/user/.omp/plugins/node_modules/@scope/tool",
            manifest: {
              description: "Useful tool",
              features: { search: { default: true }, web: {} },
              settings: { apiKey: { type: "string", secret: true } },
            },
            enabledFeatures: ["search"],
            enabled: false,
          },
        ],
        marketplace: [
          {
            id: "review@official",
            scope: "project",
            entries: [
              {
                scope: "project",
                installPath: "/repo/.omp/plugins/cache/review",
                version: "2.0.0",
                enabled: false,
              },
            ],
            shadowedBy: "project",
          },
        ],
      }),
    ).toEqual({
      droppedCount: 0,
      plugins: [
        {
          id: "@scope/tool",
          packageName: "@scope/tool",
          version: "1.2.3",
          source: "npm",
          scope: null,
          enabled: false,
          shadowed: false,
          path: "/home/user/.omp/plugins/node_modules/@scope/tool",
          description: "Useful tool",
          enabledFeatures: ["search"],
          availableFeatures: ["search", "web"],
          configurable: true,
          ambiguous: false,
          configAmbiguous: false,
          usesDefaultFeatures: false,
        },
        {
          id: "review@official",
          version: "2.0.0",
          source: "marketplace",
          scope: "project",
          enabled: false,
          shadowed: true,
          path: "/repo/.omp/plugins/cache/review",
          description: null,
          enabledFeatures: [],
          availableFeatures: [],
          configurable: false,
          ambiguous: false,
          configAmbiguous: false,
          usesDefaultFeatures: true,
        },
      ],
    });
  });

  test("marks duplicate actionable package identities as ambiguous", () => {
    const parsed = parseOmpPluginList({
      npm: [
        {
          name: "duplicate-plugin",
          version: "1.0.0",
          path: "/plugins/one",
          manifest: {},
          enabledFeatures: null,
          enabled: true,
        },
        {
          name: "duplicate-plugin",
          version: "2.0.0",
          path: "/plugins/two",
          manifest: {},
          enabledFeatures: null,
          enabled: true,
        },
      ],
      marketplace: [],
    });

    expect(parsed.plugins.map(({ configAmbiguous }) => configAmbiguous)).toEqual([true, true]);
    expect(parsed.plugins.map(({ ambiguous }) => ambiguous)).toEqual([true, true]);
    expect(parsed.plugins.every(({ usesDefaultFeatures }) => usesDefaultFeatures)).toBe(true);
  });

  test("marks user and project marketplace packages as config-ambiguous", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-omp-plugin-collision-"));
    const userPath = join(root, "user");
    const projectPath = join(root, "project");
    try {
      await Promise.all(
        [userPath, projectPath].map(async (path) => {
          await mkdir(path, { recursive: true });
          await writeFile(join(path, "package.json"), '{"name":"shared-plugin"}');
        }),
      );
      const state = await listOmpPluginsWithDependencies(
        { cwd: root },
        dependenciesFor(async () =>
          completed(
            JSON.stringify({
              npm: [],
              marketplace: [
                {
                  id: "shared@catalog",
                  scope: "user",
                  entries: [{ installPath: userPath, version: "1.0.0" }],
                },
                {
                  id: "shared@catalog",
                  scope: "project",
                  entries: [{ installPath: projectPath, version: "2.0.0" }],
                },
              ],
            }),
          ),
        ),
      );

      expect(state.plugins.map(({ ambiguous }) => ambiguous)).toEqual([false, false]);
      expect(state.plugins.map(({ configAmbiguous }) => configAmbiguous)).toEqual([true, true]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns a sanitized failure without forwarding command output", async () => {
    const result = await listOmpPluginsWithDependencies(
      {},
      dependenciesFor(async () => completed("credential=must-not-leak", 1)),
    );

    expect(result.available).toBe(false);
    expect(result.plugins).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
});

describe("OMP plugin configuration inspection", () => {
  test("returns schema metadata while withholding values and credential-shaped defaults", () => {
    const parsed = parseOmpPluginConfig({
      settings: { endpoint: "https://example.test", apiKey: "must-not-leak" },
      schema: {
        endpoint: {
          type: "string",
          description: "Service endpoint",
          default: "https://secret.invalid",
        },
        apiKey: { type: "string", description: "API key", secret: true, default: "default-secret" },
        accessToken: { type: "string", description: "Token" },
      },
    });

    expect(parsed).toEqual({
      droppedCount: 0,
      settings: [
        {
          key: "endpoint",
          type: "string",
          description: "Service endpoint",
          configured: true,
          secret: false,
          enumValues: [],
        },
        {
          key: "apiKey",
          type: "string",
          description: "API key",
          configured: true,
          secret: true,
          enumValues: [],
        },
        {
          key: "accessToken",
          type: "string",
          description: "Token",
          configured: false,
          secret: true,
          enumValues: [],
        },
      ],
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("default-secret");
    expect(serialized).not.toContain("secret.invalid");
  });

  test("uses the documented config-list argv", async () => {
    const calls: string[][] = [];
    const result = await inspectOmpPluginConfigWithDependencies(
      { plugin: "safe-plugin" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        return completed('{"settings":{},"schema":{}}');
      }),
    );

    expect(calls).toEqual([["plugin", "config", "list", "safe-plugin", "--json"]]);
    expect(result).toEqual({
      available: true,
      plugin: "safe-plugin",
      settings: [],
      droppedCount: 0,
    });
  });
});

describe("OMP plugin configuration mutations", () => {
  function configHarness() {
    const settings: Record<string, unknown> = { endpoint: "old", mode: "safe", retryCount: 2 };
    const schema = {
      endpoint: { type: "string", description: "Endpoint" },
      apiKey: { type: "string", description: "Secret", secret: true },
      mode: { type: "enum", description: "Mode", values: ["safe", "fast"] },
      retryCount: { type: "number", description: "Retries", min: 0, max: 5, step: 1 },
      enabled: { type: "boolean", description: "Enabled" },
    };
    const calls: string[][] = [];
    const dependencies = dependenciesFor(async (_executable, args) => {
      calls.push([...args]);
      if (args[2] === "set") settings[args[4] ?? ""] = args[5];
      if (args[2] === "delete") delete settings[args[4] ?? ""];
      return args[2] === "list"
        ? completed(JSON.stringify({ settings, schema }))
        : completed("mutation output is intentionally ignored");
    });
    return { calls, dependencies };
  }

  test("validates metadata type and bounds before executing config set", async () => {
    const { calls, dependencies } = configHarness();
    const wrongType = await mutateOmpPluginConfigWithDependencies(
      { action: "set", plugin: "safe-plugin", key: "retryCount", value: "3" },
      dependencies,
    );
    expect(wrongType.ok).toBe(false);
    expect(wrongType.message).toBe("This setting requires a finite number.");
    expect(calls).toEqual([["plugin", "config", "list", "safe-plugin", "--json"]]);

    calls.length = 0;
    const tooLarge = await mutateOmpPluginConfigWithDependencies(
      { action: "set", plugin: "safe-plugin", key: "retryCount", value: 6 },
      dependencies,
    );
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.message).toBe("This setting is above its documented maximum.");
    expect(calls).toEqual([["plugin", "config", "list", "safe-plugin", "--json"]]);

    calls.length = 0;
    const invalidEnum = await mutateOmpPluginConfigWithDependencies(
      { action: "set", plugin: "safe-plugin", key: "mode", value: "unsafe" },
      dependencies,
    );
    expect(invalidEnum.ok).toBe(false);
    expect(invalidEnum.message).toBe("This setting requires one of its documented choices.");
    expect(calls).toEqual([["plugin", "config", "list", "safe-plugin", "--json"]]);
  });

  test("rejects secret writes before placing values in argv", async () => {
    const { calls, dependencies } = configHarness();
    const result = await mutateOmpPluginConfigWithDependencies(
      { action: "set", plugin: "safe-plugin", key: "apiKey", value: "must-not-return" },
      dependencies,
    );

    expect(calls).toEqual([["plugin", "config", "list", "safe-plugin", "--json"]]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "Secret plugin settings cannot be written through process arguments.",
    );
    expect(JSON.stringify(result)).not.toContain("must-not-return");
  });

  test("deletes a setting and refreshes configured state", async () => {
    const { calls, dependencies } = configHarness();
    const result = await mutateOmpPluginConfigWithDependencies(
      { action: "delete", plugin: "safe-plugin", key: "endpoint" },
      dependencies,
    );

    expect(calls).toEqual([
      ["plugin", "config", "list", "safe-plugin", "--json"],
      ["plugin", "config", "delete", "safe-plugin", "endpoint", "--json"],
      ["plugin", "config", "list", "safe-plugin", "--json"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.config.settings.find(({ key }) => key === "endpoint")?.configured).toBe(false);
  });

  test("sanitizes config mutation failures and still refreshes metadata", async () => {
    const calls: string[][] = [];
    const metadata = JSON.stringify({
      settings: { endpoint: "old" },
      schema: { endpoint: { type: "string", description: "Endpoint" } },
    });
    const result = await mutateOmpPluginConfigWithDependencies(
      { action: "set", plugin: "safe-plugin", key: "endpoint", value: "new" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        return args[2] === "set" ? completed("credential=must-not-leak", 1) : completed(metadata);
      }),
    );

    expect(calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("OMP rejected the plugin operation.");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
});

describe("OMP plugin mutations", () => {
  test("refreshes authoritative state after a successful mutation", async () => {
    const calls: string[][] = [];
    const result = await mutateOmpPluginWithDependencies(
      { action: "disable", plugin: "safe-plugin" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        if (args[1] === "disable") return completed('{"disabled":"safe-plugin"}');
        return completed(
          JSON.stringify({
            npm: [
              {
                name: "safe-plugin",
                version: "1.0.0",
                path: "/plugins/safe-plugin",
                manifest: {},
                enabledFeatures: null,
                enabled: false,
              },
            ],
            marketplace: [],
          }),
        );
      }),
    );

    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "disable", "safe-plugin", "--scope", "user", "--json"],
      ["plugin", "list", "--json"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.state.plugins[0]?.enabled).toBe(false);
  });

  test("refreshes state after failure and never exposes raw command errors", async () => {
    const calls: string[][] = [];
    const result = await mutateOmpPluginWithDependencies(
      { action: "uninstall", plugin: "safe-plugin" },
      dependenciesFor(async (_executable, args) => {
        calls.push([...args]);
        if (args[1] === "uninstall") return completed("token=must-not-leak", 1);
        return completed(
          JSON.stringify({
            npm: [
              {
                name: "safe-plugin",
                version: "1.0.0",
                path: "/plugins/safe-plugin",
                manifest: {},
                enabledFeatures: null,
                enabled: true,
              },
            ],
            marketplace: [],
          }),
        );
      }),
    );

    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "uninstall", "safe-plugin", "--scope", "user", "--json"],
      ["plugin", "list", "--json"],
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("OMP rejected the plugin operation.");
    expect(result.state.plugins[0]?.id).toBe("safe-plugin");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
});
