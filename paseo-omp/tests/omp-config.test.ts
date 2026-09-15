import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseOmpConfig, readOmpConfigFrom } from "../server/omp-config";

const temporaryDirectories: string[] = [];

async function tempConfigDir(filename: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-omp-config-"));
  temporaryDirectories.push(dir);
  await writeFile(join(dir, filename), contents);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("omp config reader", () => {
  test("maps every safe field from a realistic config.yml", async () => {
    const dir = await tempConfigDir(
      "config.yml",
      `
setupVersion: 2
symbolPreset: nerd
theme:
  dark: dark-dracula
memory:
  backend: mnemopi
github:
  enabled: true
defaultThinkingLevel: auto
disabledProviders:
  - omniroute
  - openai-codex
modelRoles:
  default: azure/gpt-5.6-sol
  plan: anthropic/claude-opus-5:max
enabledModels:
  - azure/gpt-5.6-sol
  - anthropic/claude-opus-5
modelProviderOrder:
  - azure
  - anthropic
retry:
  modelFallback: true
  usageAwareFallback: true
  usageReservePct: 10
  usageReservePolicy: auto
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    default:
      - azure/gpt-5.6-sol
      - anthropic/claude-opus-5:max
dev:
  autoqaConsent: granted
`,
    );

    const result = await readOmpConfigFrom(dir);
    expect(result.available).toBe(true);
    expect(result.path).toBe(join(dir, "config.yml"));
    expect(result.config).toEqual({
      setupVersion: 2,
      symbolPreset: "nerd",
      theme: { dark: "dark-dracula" },
      memory: { backend: "mnemopi" },
      github: { enabled: true },
      defaultThinkingLevel: "auto",
      disabledProviders: ["omniroute", "openai-codex"],
      modelRoles: { default: "azure/gpt-5.6-sol", plan: "anthropic/claude-opus-5:max" },
      enabledModels: ["azure/gpt-5.6-sol", "anthropic/claude-opus-5"],
      modelProviderOrder: ["azure", "anthropic"],
      retry: {
        modelFallback: true,
        usageAwareFallback: true,
        usageReservePct: 10,
        usageReservePolicy: "auto",
        fallbackRevertPolicy: "cooldown-expiry",
        fallbackChains: { default: ["azure/gpt-5.6-sol", "anthropic/claude-opus-5:max"] },
      },
      dev: { autoqaConsent: "granted" },
    });
  });

  test("falls back to config.yaml when config.yml is absent", async () => {
    const dir = await tempConfigDir("config.yaml", "symbolPreset: ascii\n");
    const result = await readOmpConfigFrom(dir);
    expect(result.available).toBe(true);
    expect(result.path).toBe(join(dir, "config.yaml"));
    expect(result.config).toEqual({ symbolPreset: "ascii" });
  });

  test("can restrict project discovery to canonical config.yml", async () => {
    const dir = await tempConfigDir("config.yaml", "symbolPreset: ascii\n");
    const result = await readOmpConfigFrom(dir, ["config.yml"]);
    expect(result).toEqual({ path: join(dir, "config.yml"), available: false, config: null });
  });

  test("reports unavailable with the canonical path when no config file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-omp-config-"));
    temporaryDirectories.push(dir);
    const result = await readOmpConfigFrom(dir);
    expect(result).toEqual({ path: join(dir, "config.yml"), available: false, config: null });
  });

  test("reports unavailable for unparsable YAML instead of throwing", async () => {
    const dir = await tempConfigDir("config.yml", "modelRoles: [unterminated\n");
    const result = await readOmpConfigFrom(dir);
    expect(result.available).toBe(false);
    expect(result.config).toBeNull();
  });

  test("omits unrecognized top-level and nested keys", () => {
    const config = parseOmpConfig({
      symbolPreset: "nerd",
      // Unrecognized top-level key: never part of the allowlist.
      experimentalFeatureFlag: true,
      theme: {
        dark: "dark-dracula",
        // Unrecognized nested key inside an allowed section.
        accentOverride: "#ff00ff",
      },
      memory: {
        backend: "mnemopi",
        // Not part of the memory allowlist; must never surface even though it looks harmless.
        embeddingModel: "text-embedding-3",
      },
    });
    expect(config).toEqual({
      symbolPreset: "nerd",
      theme: { dark: "dark-dracula" },
      memory: { backend: "mnemopi" },
    });
  });

  test("never surfaces credential-shaped keys, even when present on disk", async () => {
    const dir = await tempConfigDir(
      "config.yml",
      `
symbolPreset: nerd
auth:
  broker:
    token: sk-super-secret-token
mnemopi:
  embeddingApiKey: mnemopi-secret-key
  llmApiKey: mnemopi-llm-secret
hindsight:
  apiToken: hindsight-secret-token
searxng:
  basicPassword: searxng-secret
memory:
  backend: mnemopi
  apiKey: leaked-memory-key
`,
    );

    const result = await readOmpConfigFrom(dir);
    expect(result.available).toBe(true);
    const serialized = JSON.stringify(result.config);
    for (const secret of [
      "sk-super-secret-token",
      "mnemopi-secret-key",
      "mnemopi-llm-secret",
      "hindsight-secret-token",
      "searxng-secret",
      "leaked-memory-key",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Entire credential-bearing top-level sections are absent, not merely their secret fields.
    expect(result.config).not.toHaveProperty("auth");
    expect(result.config).not.toHaveProperty("mnemopi");
    expect(result.config).not.toHaveProperty("hindsight");
    expect(result.config).not.toHaveProperty("searxng");
    expect(result.config?.memory).toEqual({ backend: "mnemopi" });
  });

  test("drops one malformed section without losing the rest of the document", () => {
    const config = parseOmpConfig({
      symbolPreset: "nerd",
      // Wrong shape: retry.fallbackChains must be a record of string arrays.
      retry: { modelFallback: "yes" },
      modelRoles: { default: "azure/gpt-5.6-sol" },
    });
    expect(config).toEqual({
      symbolPreset: "nerd",
      modelRoles: { default: "azure/gpt-5.6-sol" },
    });
  });

  test("treats a non-mapping document as an empty, safe result", () => {
    expect(parseOmpConfig(["not", "a", "mapping"])).toEqual({});
    expect(parseOmpConfig("a bare scalar")).toEqual({});
    expect(parseOmpConfig(null)).toEqual({});
  });
});
