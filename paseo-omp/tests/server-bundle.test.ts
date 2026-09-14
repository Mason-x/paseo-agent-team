import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { build } from "esbuild";
import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { extractArchiveFiles } from "../scripts/release-archive";

const pluginRoot = join(import.meta.dirname, "..");
const nodeRequire = createRequire(join(pluginRoot, "index.server.ts"));
const executeFile = promisify(execFile);
const sdkStub = {
  defineRpc: (definition: unknown) => definition,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
};

function runtimeRequire(name: string): unknown {
  return name.startsWith("@getpaseo/plugin") ? sdkStub : nodeRequire(name);
}

async function compileServerBundle(entryPath: string) {
  const result = await build({
    stdin: {
      contents: await readFile(entryPath, "utf8"),
      loader: "tsx",
      resolveDir: dirname(entryPath),
      sourcefile: entryPath,
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    external: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/server",
      "@getpaseo/client",
      "@modelcontextprotocol/sdk/*",
      "yaml",
      "zod",
    ],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  return { code: result.outputFiles[0]?.text ?? "", warnings: result.warnings };
}

async function compileClientBundle(entryPath: string) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["@getpaseo/*", "@tanstack/react-query", "react", "react-native", "zod"],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  return result.warnings;
}

describe("plugin server bundle", () => {
  test("requires the published Paseo 0.8 provider contract", async () => {
    const manifest = JSON.parse(await readFile(join(pluginRoot, "paseo-plugin.json"), "utf8"));
    expect(manifest).toEqual(expect.objectContaining({ requirements: { paseo: "^0.8.0" } }));
    expect(await readFile(join(pluginRoot, "README.md"), "utf8")).toContain("Paseo `^0.8.0`");
  });

  test("loads and registers the plugin provider in the daemon CJS sandbox", async () => {
    const { code, warnings } = await compileServerBundle(join(pluginRoot, "index.server.ts"));
    expect(warnings.map((warning) => warning.text)).toEqual([]);
    // biome-ignore lint/security/noGlobalEval: mirrors the daemon's plugin loader
    const factory = globalThis.eval(
      `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`,
    ) as (require: (name: string) => unknown) => { default?: unknown };
    const originalCwd = process.cwd();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-bundle-"));
    process.chdir(temporaryDirectory);
    try {
      const module = factory(runtimeRequire);
      if (typeof module.default !== "function") throw new Error("Missing server contribution");
      const providers: ProviderRegistration[] = [];
      const handlers: unknown[] = [];
      const beforeHooks: unknown[] = [];
      const cleanup = module.default({
        before: (...args: unknown[]) => {
          beforeHooks.push(args);
          return () => {};
        },
        handle: (...args: unknown[]) => handlers.push(args),
        registerProvider: (provider: ProviderRegistration) => providers.push(provider),
      });
      expect(handlers).toHaveLength(13);
      expect(beforeHooks).toHaveLength(1);
      const [hookName, hook] = beforeHooks[0] as [
        string,
        (event: {
          request: {
            agentId: string;
            workspaceId: string | null;
            provider: string;
            cwd: string;
            env: Record<string, string>;
          };
        }) => unknown,
      ];
      expect(hookName).toBe("agent.session_open");
      expect(
        hook({
          request: {
            agentId: "plugin-agent",
            workspaceId: "plugin-workspace",
            provider: "omp-plugin",
            cwd: "/workspace",
            env: { PASEO_AGENT_ID: "spoofed" },
          },
        }),
      ).toEqual(
        expect.objectContaining({
          env: {
            PASEO_AGENT_ID: "plugin-agent",
            PASEO_WORKSPACE_ID: "plugin-workspace",
          },
        }),
      );
      expect(
        hook({
          request: {
            agentId: "builtin-agent",
            workspaceId: "builtin-workspace",
            provider: "omp",
            cwd: "/workspace",
            env: {},
          },
        }),
      ).toBeUndefined();
      expect(providers).toEqual([
        expect.objectContaining({ id: "omp-plugin", label: "OMP Plugin" }),
      ]);
      const provider = providers[0];
      if (!provider) throw new Error("Registered provider is missing");
      const connection = await provider.connect({
        versions: [1],
        capabilities: ["prompt.message", "prompt.steer", "session.configure"],
      });
      expect(connection.capabilities).toEqual([
        "prompt.message",
        "prompt.steer",
        "session.configure",
      ]);
      await connection.close();
      expect(typeof cleanup).toBe("function");
    } finally {
      process.chdir(originalCwd);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("loads the server entrypoint from the extracted release archive", async () => {
    await mkdir(join(pluginRoot, "dist"), { recursive: true });
    const temporaryDirectory = await mkdtemp(join(pluginRoot, "dist", "release-load-"));
    const archivePath = join(temporaryDirectory, "paseo-omp.zip");
    const extractionRoot = join(temporaryDirectory, "extracted");
    try {
      await executeFile(
        process.execPath,
        ["--import", "tsx", "scripts/package-release.ts", archivePath],
        {
          cwd: pluginRoot,
        },
      );

      const files = unzipSync(await readFile(archivePath));
      expect(files["paseo-omp/server/provider/security.ts"]).toBeDefined();
      expect(new TextDecoder().decode(files["paseo-omp/paseo-plugin.json"])).toContain(
        '"paseo": "^0.8.0"',
      );
      expect(new TextDecoder().decode(files["paseo-omp/README.md"])).toContain(
        "coexists with Paseo's bundled `omp` provider",
      );
      await extractArchiveFiles(files, extractionRoot);

      // Dynamic import intentionally exercises the extracted plugin's runtime module boundary.
      const entrypoint = await import(
        pathToFileURL(join(extractionRoot, "paseo-omp", "index.server.ts")).href
      );
      expect(typeof entrypoint.default).toBe("function");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  test("packages import-complete client and server entries", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-omp-package-"));
    const archivePath = join(temporaryDirectory, "paseo-omp.zip");
    try {
      await executeFile(
        process.execPath,
        ["--import", "tsx", "scripts/package-release.ts", archivePath],
        {
          cwd: pluginRoot,
        },
      );
      const archive = unzipSync(await readFile(archivePath));
      await extractArchiveFiles(archive, temporaryDirectory);
      for (const path of [
        "paseo-omp/client/provider-image.tsx",
        "paseo-omp/shared/provider-image.ts",
        "paseo-omp/server/provider/image.ts",
      ]) {
        expect(archive[path]).toBeDefined();
      }
      const extractedRoot = join(temporaryDirectory, "paseo-omp");
      const clientWarnings = await compileClientBundle(join(extractedRoot, "index.client.tsx"));
      const serverBundle = await compileServerBundle(join(extractedRoot, "index.server.ts"));
      expect(clientWarnings.map((warning) => warning.text)).toEqual([]);
      expect(serverBundle.warnings.map((warning) => warning.text)).toEqual([]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});
