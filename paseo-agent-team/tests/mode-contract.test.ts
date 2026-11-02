import { describe, expect, test } from "vitest";
import {
  checkModeAccess,
  isTeamMode,
  legacyFieldRetirement,
  MODE_CONTRACT_VERSION,
  modeContractSupport,
  normalizeContractVersion,
  requestContractVersion,
  retiredModeLabel,
  SUPPORTED_TEAM_MODES,
} from "../shared/domain/mode-contract";
import { DesignStartInputSchema } from "../shared/schemas/design";
import { TeamSchema } from "../shared/schemas/team";
import { TeamModeSchema } from "../shared/schemas/team-mode";
import { codingTeam } from "./fixtures";

describe("retired mode compatibility", () => {
  test("stored legacy and unknown modes decode while only sota is supported", () => {
    expect(SUPPORTED_TEAM_MODES).toEqual(["sota"]);
    expect(TeamModeSchema.options).toEqual(["sota", "economy", "economy-all", "collaborative"]);
    expect(isTeamMode("economy-all")).toBe(true);
    expect(isTeamMode("toString")).toBe(false);
    expect(TeamSchema.parse({ ...codingTeam, mode: "future-mode" }).mode).toBe("future-mode");
    expect(retiredModeLabel("economy")).toBe("标准");
    expect(retiredModeLabel("future-mode")).toBe("future-mode");
    expect(retiredModeLabel("sota")).toBeNull();
  });

  test("missing or sota request succeeds; retired and unknown requests block", () => {
    expect(checkModeAccess({})).toEqual({ ok: true });
    expect(checkModeAccess({ requestedMode: "sota" })).toEqual({ ok: true });
    for (const requestedMode of ["economy", "economy-all", "collaborative", "future-mode"]) {
      expect(checkModeAccess({ requestedMode })).toMatchObject({
        ok: false,
        issue: {
          code: "MODE_UNKNOWN",
          severity: "blocker",
          params: { value: requestedMode, reason: "retired" },
        },
      });
    }
  });

  test("only contract version 2 opts in; legacy, unknown and failure remain distinct", () => {
    expect(MODE_CONTRACT_VERSION).toBe(2);
    for (const [raw, expected] of [
      [undefined, 1],
      [null, 1],
      [0, 1],
      [1, 1],
      [2, 2],
      [3, 1],
      [-1, 1],
      [2.5, 1],
      ["2", 1],
      [Number.NaN, 1],
    ] as const) {
      expect(normalizeContractVersion(raw)).toBe(expected);
      expect(modeContractSupport({ kind: "capabilities", modeContract: raw })).toBe(
        expected === 2 ? "v2" : "legacy",
      );
    }
    expect(requestContractVersion({})).toBe(1);
    expect(requestContractVersion({ contractVersion: 2 })).toBe(2);
    expect(modeContractSupport({ kind: "method-not-found" })).toBe("legacy");
    expect(modeContractSupport({ kind: "failed" })).toBe("unknown");
  });

  test("only the explicit retirement capability authorizes removal", () => {
    expect(legacyFieldRetirement({ kind: "capabilities", retiresLegacyFields: true })).toBe(true);
    expect(legacyFieldRetirement({ kind: "capabilities" })).toBe(false);
    expect(legacyFieldRetirement({ kind: "capabilities", retiresLegacyFields: false })).toBe(false);
    expect(legacyFieldRetirement({ kind: "method-not-found" })).toBe(false);
    expect(legacyFieldRetirement({ kind: "failed" })).toBe(false);
  });

  test("design start still accepts integer contract versions and rejects non-integers", () => {
    const base = {
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      request: "补一个 Role",
    };
    for (const contractVersion of [0, 1, 2, 3, -1])
      expect(DesignStartInputSchema.safeParse({ ...base, contractVersion }).success).toBe(true);
    for (const contractVersion of [2.5, "2", Number.NaN])
      expect(DesignStartInputSchema.safeParse({ ...base, contractVersion }).success).toBe(false);
  });
});
