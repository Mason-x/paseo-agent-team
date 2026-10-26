import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, expect, test } from "vitest";

const pluginRoot = join(import.meta.dirname, "..");
const SOURCE = /\.(?:ts|tsx)$/;
const RELATIVE_IMPORT =
  /\bfrom\s+["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

async function buildArchive(): Promise<Record<string, Uint8Array>> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-agent-team-release-"));
  const archivePath = join(temporaryDirectory, "release.zip");
  try {
    execFileSync(process.execPath, ["scripts/package-release.ts", archivePath], {
      cwd: pluginRoot,
    });
    return unzipSync(await readFile(archivePath));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

let archive: Record<string, Uint8Array>;

beforeAll(async () => {
  archive = await buildArchive();
}, 30_000);

test("release archive includes the npm lockfile and every runtime directory", () => {
  const files = Object.keys(archive);
  expect(files).toContain("paseo-agent-team/package-lock.json");
  expect(files).toContain("paseo-agent-team/paseo-plugin.json");
  expect(files).toContain("paseo-agent-team/index.client.tsx");
  expect(files).toContain("paseo-agent-team/index.server.ts");
  for (const directory of ["client", "server", "shared"]) {
    expect(files.some((file) => file.startsWith(`paseo-agent-team/${directory}/`))).toBe(true);
  }
});

test("every relative import in the archive resolves to a shipped file", () => {
  const names = new Set(Object.keys(archive));
  const unresolved: string[] = [];
  for (const [name, bytes] of Object.entries(archive)) {
    if (!SOURCE.test(name)) continue;
    for (const match of strFromU8(bytes).matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(name), match[1] ?? match[2] ?? ""));
      const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`];
      if (!candidates.some((candidate) => names.has(candidate))) {
        unresolved.push(`${name} -> ${match[1] ?? match[2]}`);
      }
    }
  }
  expect(unresolved).toEqual([]);
});

test("release runtime files contain no host Profile IDs or test fixtures", () => {
  for (const [name, bytes] of Object.entries(archive)) {
    expect(name).not.toMatch(/\/tests\/|\/scripts\/|ruflo-catalog/);
    if (SOURCE.test(name)) expect(strFromU8(bytes), name).not.toContain("agent_profile_");
  }
  expect(Object.keys(archive)).toContain("paseo-agent-team/server/templates/default-catalog.ts");
});
