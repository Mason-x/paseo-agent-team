import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
// @ts-expect-error -- the launch CLI is plain JS; these exported helpers have no declarations.
import * as launchCli from "../scripts/launch-team.mjs";

const {
  buildLaunchRequest,
  buildStatusRequest,
  MODE_VALUES,
  RETIRED_MODE_NOTICE,
  resolveMode,
  usage,
} = launchCli;
const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join("scripts", "launch-team.mjs");
const base = {
  teamId: "coding-team",
  task: "Add Stripe billing",
  target: { kind: "workspace", workspaceId: "ws-1" },
} as const;

describe("launch CLI single path", () => {
  test("only omitted mode and sota are accepted", () => {
    expect(MODE_VALUES).toEqual(["sota"]);
    expect(resolveMode(undefined)).toEqual({ ok: true, mode: undefined });
    expect(resolveMode("sota")).toEqual({ ok: true, mode: "sota" });
    for (const value of [
      "",
      "standard",
      "economy",
      "economy-all",
      "collaborative",
      "turbo",
      "SOTA",
    ]) {
      expect(resolveMode(value)).toEqual({ ok: false });
    }
  });

  test("requests omit retired mode and contract fields", () => {
    expect(buildLaunchRequest({ ...base, mode: "sota" })).toEqual(base);
    expect(buildStatusRequest("run-1")).toEqual({ runId: "run-1" });
    expect(usage).toContain("--mode sota");
  });

  test("--help prints usage without connecting", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, "--help"], {
      cwd: PLUGIN_ROOT,
    });
    expect(stdout).toContain("Usage: node scripts/launch-team.mjs");
    expect(stdout).toContain("--mode sota");
    expect(stderr).toBe("");
  });

  test.each(["standard", "economy", "economy-all", "collaborative", "turbo"])(
    "rejects %s before connecting",
    async (mode) => {
      await expect(
        execFileAsync(
          process.execPath,
          [
            SCRIPT,
            "--host",
            "127.0.0.1:1",
            "--team",
            "coding-team",
            "--workspace",
            "ws-1",
            "--mode",
            mode,
            "task",
          ],
          { cwd: PLUGIN_ROOT },
        ),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(RETIRED_MODE_NOTICE) });
    },
  );

  test("a directory junction still runs the CLI", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "paseo-d03-junction-"));
    const linkDir = path.join(tempRoot, "scripts-link");
    try {
      await symlink(
        path.join(PLUGIN_ROOT, "scripts"),
        linkDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [path.join(linkDir, "launch-team.mjs"), "--help"],
        { cwd: tempRoot },
      );
      expect(stdout).toContain("Usage: node scripts/launch-team.mjs");
      expect(stderr).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
