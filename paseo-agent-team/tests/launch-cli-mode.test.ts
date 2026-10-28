import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
// @ts-expect-error -- the launch CLI is plain JS; these exported helpers have no declarations.
import * as launchCli from "../scripts/launch-team.mjs";

const {
  buildLaunchRequest,
  buildStatusRequest,
  DEPRECATED_ECONOMY_NOTICE,
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
    for (const value of ["", "Standard", "standard ", "flagship", "all-seats", "sota,economy"]) {
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
    expect(usage).toContain("legacy spelling of standard");
    expect(usage).toContain("contractVersion 2");
    expect(usage).toContain("经济");
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
});
