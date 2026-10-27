import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const pluginRoot = path.join(import.meta.dirname, "..");
const sentinels: string[] = [];

afterEach(async () => {
  await Promise.all(
    sentinels
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

function isInsideTemp(candidate: string): boolean {
  const parent = path.resolve(tmpdir());
  const resolved = path.resolve(candidate);
  const relative = path.relative(parent, resolved);
  return relative !== "" && !path.isAbsolute(relative) && !relative.split(/[/\\]/u).includes("..");
}

async function emptySentinel(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-isolation-sentinel-"));
  sentinels.push(directory);
  return directory;
}

test("vitest setupFiles redirects PASEO_HOME away from the inherited home", () => {
  const home = process.env.PASEO_HOME;
  const mark = process.env.PASEO_VITEST_HOME_MARK;
  const inherited = process.env.PASEO_VITEST_INHERITED_HOME ?? "";
  expect(mark, "setupFiles must set PASEO_VITEST_HOME_MARK").toBeTruthy();
  expect(home).toBe(mark);
  expect(home).not.toBe(inherited);
  expect(path.isAbsolute(home ?? "")).toBe(true);
  expect(isInsideTemp(home ?? "")).toBe(true);
  expect(existsSync(home ?? "")).toBe(true);
});

test("verify:package ignores an inherited sentinel PASEO_HOME", async () => {
  const sentinel = await emptySentinel();
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join("scripts", "verify-host-compile.mjs")],
    {
      cwd: pluginRoot,
      env: { ...process.env, PASEO_HOME: sentinel },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const output = `${stdout}\n${stderr}`;
  expect(await readdir(sentinel)).toEqual([]);
  expect(output).not.toContain(sentinel);
  expect(output).not.toMatch(/design ledger initialization failed/u);
}, 90_000);
