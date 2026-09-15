import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  listOmpSettingsWithDependencies,
  type OmpSettingsDependencies,
  parseOmpSettingsList,
  updateOmpSettingsWithDependencies,
} from "../server/omp-settings";
import { categorizeOmpSetting, formatOmpSettingLabel } from "../shared/omp-settings";

describe("OMP settings inventory", () => {
  test("preserves typed values while withholding credential-shaped values", () => {
    const catalog = parseOmpSettingsList({
      "retry.enabled": {
        value: true,
        type: "boolean",
        description: "Retry failed requests",
      },
      "auth.broker.token": {
        value: "must-not-cross-the-rpc-boundary",
        type: "string",
        description: "",
      },
      "images.urls.credentials": {
        redacted: true,
        type: "record",
        description: "",
      },
      unsupported: { value: true, type: "mystery" },
    });

    expect(catalog).toEqual({
      droppedCount: 1,
      settings: [
        {
          path: "retry.enabled",
          value: true,
          type: "boolean",
          description: "Retry failed requests",
        },
        {
          path: "auth.broker.token",
          redacted: true,
          configured: true,
          type: "string",
          description: "",
        },
        {
          path: "images.urls.credentials",
          redacted: true,
          type: "record",
          description: "",
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("must-not-cross-the-rpc-boundary");
  });

  test("rejects a non-object document", () => {
    expect(() => parseOmpSettingsList([])).toThrow("invalid settings document");
  });

  test("groups representative settings into OMP navigation categories", () => {
    expect(categorizeOmpSetting("theme.dark")).toBe("appearance");
    expect(categorizeOmpSetting("retry.maxRetries")).toBe("model");
    expect(categorizeOmpSetting("compaction.enabled")).toBe("context");
    expect(categorizeOmpSetting("mcp.notifications")).toBe("tools");
    expect(categorizeOmpSetting("task.maxConcurrency")).toBe("tasks");
    expect(categorizeOmpSetting("providers.fetch")).toBe("providers");
    expect(categorizeOmpSetting("setupVersion")).toBe("general");
  });

  test("formats dotted camel-case paths as readable labels", () => {
    expect(formatOmpSettingLabel("providers.streamIdleTimeoutSeconds")).toBe(
      "Stream Idle Timeout Seconds",
    );
  });
});

describe("OMP scalar settings updates", () => {
  function harness() {
    const values: Record<string, { value: unknown; type: string; description: string }> = {
      "retry.enabled": { value: true, type: "boolean", description: "" },
      temperature: { value: 0.5, type: "number", description: "" },
      personality: { value: "default", type: "enum", description: "" },
    };
    const commands: string[][] = [];
    const dependencies: OmpSettingsDependencies = {
      async resolveExecutable() {
        return "/fake/omp";
      },
      async runConfig(_executable, args) {
        commands.push([...args]);
        const serializedValue = args.at(-1);
        if (args[0] === "set" && args[1] === "temperature" && serializedValue === "99") {
          return {
            outcome: "exited",
            stdout: "",
            truncated: false,
            exitCode: 1,
            signal: null,
            spawnErrorCode: null,
            cleanupFailed: false,
          };
        }
        if (args[0] === "set" && args[1] && serializedValue !== undefined) {
          const setting = values[args[1]];
          if (setting) {
            setting.value =
              setting.type === "boolean"
                ? serializedValue === "true"
                : setting.type === "number"
                  ? Number(serializedValue)
                  : serializedValue;
          }
        }
        if (args[0] === "reset" && args[1] === "retry.enabled") values[args[1]].value = false;
        return {
          outcome: "exited",
          stdout: args[0] === "list" ? JSON.stringify(values) : "",
          truncated: false,
          exitCode: 0,
          signal: null,
          spawnErrorCode: null,
          cleanupFailed: false,
        };
      },
      async validateProjectConfig() {
        return {
          outcome: "exited",
          stdout: "{}",
          truncated: false,
          exitCode: 0,
          signal: null,
          spawnErrorCode: null,
          cleanupFailed: false,
        };
      },
    };
    return { commands, dependencies };
  }
  test("applies validated scalar sets and resets against one revision", async () => {
    const { commands, dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [
          { operation: "set", path: "personality", value: "concise" },
          { operation: "reset", path: "retry.enabled" },
        ],
      },
      dependencies,
    );

    expect(result.conflict).toBe(false);
    expect(result.appliedPaths).toEqual(["personality", "retry.enabled"]);
    expect(commands).toContainEqual(["set", "personality", "--json", "--", "concise"]);
    expect(commands).toContainEqual(["reset", "retry.enabled"]);
  });

  test("rejects stale revisions before running mutations", async () => {
    const { commands, dependencies } = harness();
    const result = await updateOmpSettingsWithDependencies(
      { revision: "stale", changes: [{ operation: "set", path: "personality", value: "x" }] },
      dependencies,
    );

    expect(result.conflict).toBe(true);
    expect(commands.filter(([operation]) => operation !== "list" && operation !== "path")).toEqual(
      [],
    );
  });

  test("reports the first failed change after preserving applied paths", async () => {
    const { dependencies } = harness();
    const listed = await listOmpSettingsWithDependencies({}, dependencies);
    const result = await updateOmpSettingsWithDependencies(
      {
        revision: listed.revision ?? "",
        changes: [
          { operation: "set", path: "personality", value: "concise" },
          { operation: "set", path: "temperature", value: 99 },
        ],
      },
      dependencies,
    );

    expect(result.appliedPaths).toEqual(["personality"]);
    expect(result.failed).toEqual({
      path: "temperature",
      message: "OMP rejected this setting change.",
    });
  });

  test("creates and removes validated workspace overrides without global mutations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    await writeFile(join(cwd, ".omp", "config.yml"), "personality: concise\n");
    const { commands, dependencies } = harness();
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      expect(listed.path).toBe(join(cwd, ".omp", "config.yml"));
      expect(
        listed.settings.find((setting) => setting.path === "personality")?.workspaceOverride,
      ).toBe(true);
      const written = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "retry.enabled", value: false }],
        },
        dependencies,
      );

      expect(written.appliedPaths).toEqual(["retry.enabled"]);
      const writtenText = await readFile(join(cwd, ".omp", "config.yml"), "utf8");
      expect(writtenText).toContain("personality: concise");
      expect(writtenText).toContain("enabled: false");
      expect(
        written.catalog.settings.find((setting) => setting.path === "retry.enabled")
          ?.workspaceOverride,
      ).toBe(true);

      const reset = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: written.catalog.revision ?? "",
          changes: [{ operation: "reset", path: "personality" }],
        },
        dependencies,
      );
      expect(reset.appliedPaths).toEqual(["personality"]);
      expect(await readFile(join(cwd, ".omp", "config.yml"), "utf8")).not.toContain("personality");
      expect(
        commands.filter(([operation]) => operation === "set" || operation === "reset"),
      ).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the project file unchanged when OMP rejects an override", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    const path = join(cwd, ".omp", "config.yml");
    await writeFile(path, "personality: concise\n");
    const { dependencies } = harness();
    dependencies.validateProjectConfig = async () => ({
      outcome: "exited",
      stdout: "",
      truncated: false,
      exitCode: 1,
      signal: null,
      spawnErrorCode: null,
      cleanupFailed: false,
    });
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const result = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "personality", value: "invalid" }],
        },
        dependencies,
      );
      expect(result.failed?.message).toBe("OMP rejected the workspace configuration change.");
      expect(await readFile(path, "utf8")).toBe("personality: concise\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reports a conflict when the project file changes during validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
    await mkdir(join(cwd, ".omp"), { recursive: true });
    const path = join(cwd, ".omp", "config.yml");
    await writeFile(path, "personality: concise\n");
    const { dependencies } = harness();
    dependencies.validateProjectConfig = async () => {
      await writeFile(path, "personality: external\n");
      return {
        outcome: "exited",
        stdout: "{}",
        truncated: false,
        exitCode: 0,
        signal: null,
        spawnErrorCode: null,
        cleanupFailed: false,
      };
    };
    try {
      const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
      const result = await updateOmpSettingsWithDependencies(
        {
          cwd,
          revision: listed.revision ?? "",
          changes: [{ operation: "set", path: "personality", value: "ours" }],
        },
        dependencies,
      );
      expect(result.conflict).toBe(true);
      expect(await readFile(path, "utf8")).toBe("personality: external\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test.skipIf(process.platform === "win32")(
    "rejects symlinked workspace configuration without replacing it",

    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "paseo-omp-settings-"));
      await mkdir(join(cwd, ".omp"), { recursive: true });
      const target = join(cwd, "shared.yml");
      const path = join(cwd, ".omp", "config.yml");
      await writeFile(target, "personality: concise\n");
      await symlink(target, path);
      const { dependencies } = harness();
      try {
        const listed = await listOmpSettingsWithDependencies({ cwd }, dependencies);
        const result = await updateOmpSettingsWithDependencies(
          {
            cwd,
            revision: listed.revision ?? "",
            changes: [{ operation: "set", path: "personality", value: "other" }],
          },
          dependencies,
        );
        expect(result.failed?.message).toContain("Symlinked workspace OMP configuration");
        expect(await readFile(target, "utf8")).toBe("personality: concise\n");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
