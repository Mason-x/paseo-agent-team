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
  DEPRECATED_ECONOMY_NOTICE,
  formatRequestedMode,
  MODE_VALUES,
  modeNotice,
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

describe("launch CLI modes", () => {
  test("maps the five accepted spellings to the wire values", () => {
    expect(resolveMode(undefined)).toEqual({ ok: true, mode: undefined, deprecated: false });
    expect(resolveMode("")).toEqual({ ok: true, mode: undefined, deprecated: false });
    expect(resolveMode("sota")).toEqual({ ok: true, mode: "sota", deprecated: false });
    expect(resolveMode("collaborative")).toEqual({
      ok: true,
      mode: "collaborative",
      deprecated: false,
    });
    expect(resolveMode("standard")).toEqual({ ok: true, mode: "economy", deprecated: false });
    // The old spelling stays the standard mode; it must never be interpreted as economy-all.
    expect(resolveMode("economy")).toEqual({ ok: true, mode: "economy", deprecated: true });
    expect(resolveMode("economy-all")).toEqual({
      ok: true,
      mode: "economy-all",
      deprecated: false,
    });
    expect(MODE_VALUES).toEqual(["sota", "standard", "economy", "economy-all", "collaborative"]);
  });

  test("rejects unknown values, including near-misses and case variants", () => {
    for (const value of ["Standard", "standard ", "flagship", "all-seats", "sota,economy"]) {
      expect(resolveMode(value)).toEqual({ ok: false });
    }
  });

  test("the legacy spelling prints a notice, the others do not", () => {
    expect(modeNotice(resolveMode("economy"))).toBe(DEPRECATED_ECONOMY_NOTICE);
    expect(DEPRECATED_ECONOMY_NOTICE).toContain("--mode standard");
    expect(DEPRECATED_ECONOMY_NOTICE).toContain("economy-all");
    expect(modeNotice(resolveMode("standard"))).toBeUndefined();
    expect(modeNotice(resolveMode("economy-all"))).toBeUndefined();
    expect(modeNotice(resolveMode(undefined))).toBeUndefined();
    expect(modeNotice(resolveMode("turbo"))).toBeUndefined();
  });

  test("requests declare contractVersion 2 exactly once", () => {
    const request = buildLaunchRequest({ ...base, mode: "economy-all" });
    expect(request).toEqual({ ...base, mode: "economy-all", contractVersion: 2 });
    expect(Object.keys(request).filter((key) => key === "contractVersion")).toHaveLength(1);
    expect(request.contractVersion).toBe(2);

    const withoutMode = buildLaunchRequest({ ...base, mode: undefined });
    expect(withoutMode).not.toHaveProperty("mode");
    expect(Object.keys(withoutMode).filter((key) => key === "contractVersion")).toHaveLength(1);
    expect(withoutMode.contractVersion).toBe(2);

    expect(buildStatusRequest("run-1")).toEqual({ runId: "run-1", contractVersion: 2 });
  });

  test("usage lists every spelling and marks --mode as a script-only override", () => {
    for (const value of MODE_VALUES) expect(usage).toContain(value);
    expect(usage).toContain("advanced override for");
    expect(usage).toContain("scripts and tests only");
    expect(usage).toContain("legacy spelling of 标准");
    expect(usage).toContain("contractVersion 2");
    expect(usage).toContain("旗舰（SOTA）");
    expect(usage).toContain("标准");
    expect(usage).toContain("经济");
    expect(usage).toContain("协作");
    expect(usage).toContain("全席位");
  });

  test("preview names match the --mode / UI labels", () => {
    expect(formatRequestedMode("sota")).toBe("旗舰（SOTA）（sota）");
    expect(formatRequestedMode("economy")).toBe("标准（economy）");
    expect(formatRequestedMode("economy-all")).toBe("经济（economy-all）");
    expect(formatRequestedMode("collaborative")).toBe("协作（collaborative）");
  });

  test("--help prints the usage without connecting anywhere", async () => {
    // No --host is passed; a help request must exit before any client is created.
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, "--help"], {
      cwd: PLUGIN_ROOT,
    });
    expect(stdout).toContain("Usage: node scripts/launch-team.mjs");
    expect(stdout).toContain("economy-all");
    expect(stdout).toContain("advanced override");
    expect(stderr).toBe("");
  });

  test("an unknown --mode exits non-zero before any connection", async () => {
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
          "turbo",
          "task",
        ],
        { cwd: PLUGIN_ROOT },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--mode must be one of sota, standard, economy, economy-all"),
    });
  });

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
