import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { expect, test } from "vitest";

const pluginRoot = join(import.meta.dirname, "..");

test("release archive includes the npm lockfile", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-agent-team-release-"));
  const archivePath = join(temporaryDirectory, "release.zip");

  try {
    execFileSync(process.execPath, ["scripts/package-release.ts", archivePath], {
      cwd: pluginRoot,
    });
    const files = Object.keys(unzipSync(await readFile(archivePath)));
    expect(files).toContain("paseo-agent-team/package-lock.json");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
