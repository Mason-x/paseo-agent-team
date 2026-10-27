import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  CLI_MODE_SPELLINGS,
  checkModeAccess,
  isLegacyTeamMode,
  isTeamMode,
  LEGACY_TEAM_MODES,
  MODE_CONTRACT_VERSION,
  type ModeContractVersion,
  modeContractSupport,
  modeMinContract,
  modeToStore,
  modeUsable,
  projectLegacyMode,
  readCliMode,
  readStoredMode,
  requestContractVersion,
  storedModeValue,
  TEAM_MODE_DISPLAY,
  TEAM_MODES,
  type TeamModeDisplay,
  teamModeDisplay,
} from "../shared/domain/mode-contract";
import { normalizeMode } from "../shared/domain/mode-resolver";
import { TeamSchema } from "../shared/schemas/team";
import { type TeamMode, TeamModeSchema } from "../shared/schemas/team-mode";
import { NOW } from "./fixtures";

// The enum a baseline (contract-v1) App, daemon, or script was built with. Anything projected to a
// legacy peer must parse with it.
const BaselineTeamModeSchema = z.enum(["sota", "economy", "collaborative"]);

type MatrixRow = {
  stored: string | undefined;
  read: { mode: TeamMode; display: TeamModeDisplay; defaulted: boolean } | "unknown";
  legacy: string | null;
  wireV1: boolean;
  wireV2: boolean;
};

// Storage/wire/display mapping matrix (H4=A). `stored` is Team.mode as written; the wire columns
// say whether a launch/design request of that contract may carry the mode.
const MATRIX: readonly MatrixRow[] = [
  {
    stored: undefined,
    read: { mode: "sota", display: "flagship", defaulted: true },
    legacy: "sota",
    wireV1: true,
    wireV2: true,
  },
  {
    stored: "  ",
    read: { mode: "sota", display: "flagship", defaulted: true },
    legacy: "sota",
    wireV1: true,
    wireV2: true,
  },
  {
    stored: "sota",
    read: { mode: "sota", display: "flagship", defaulted: false },
    legacy: "sota",
    wireV1: true,
    wireV2: true,
  },
  {
    stored: "economy",
    read: { mode: "economy", display: "standard", defaulted: false },
    legacy: "economy",
    wireV1: true,
    wireV2: true,
  },
  {
    stored: "economy-all",
    read: { mode: "economy-all", display: "economy", defaulted: false },
    legacy: null,
    wireV1: false,
    wireV2: true,
  },
  {
    stored: "collaborative",
    read: { mode: "collaborative", display: "collaborative", defaulted: false },
    legacy: "collaborative",
    wireV1: true,
    wireV2: true,
  },
  { stored: "standard", read: "unknown", legacy: null, wireV1: false, wireV2: false },
  { stored: "quantum", read: "unknown", legacy: null, wireV1: false, wireV2: false },
];

function wireAccepted(mode: string, contract: ModeContractVersion): boolean {
  const parsed = TeamModeSchema.safeParse(mode);
  if (!parsed.success) return false;
  return checkModeAccess({
    storedMode: "sota",
    requestedMode: parsed.data,
    contractVersion: contract,
  }).ok;
}

describe("mode contract tables", () => {
  test("the local lists are pinned to the strict enum", () => {
    expect([...TEAM_MODES]).toEqual(TeamModeSchema.options);
    expect(LEGACY_TEAM_MODES.every((mode) => BaselineTeamModeSchema.safeParse(mode).success)).toBe(
      true,
    );
    expect([...LEGACY_TEAM_MODES]).toEqual(BaselineTeamModeSchema.options);
    expect(TEAM_MODES.filter(isLegacyTeamMode)).toEqual([...LEGACY_TEAM_MODES]);
    expect(MODE_CONTRACT_VERSION).toBe(2);
  });

  test("the label table is one-to-one and covers every mode", () => {
    expect(Object.keys(TEAM_MODE_DISPLAY)).toEqual([...TEAM_MODES]);
    const displays = TEAM_MODES.map(teamModeDisplay);
    expect(new Set(displays).size).toBe(TEAM_MODES.length);
    expect(TEAM_MODE_DISPLAY).toEqual({
      sota: "flagship",
      economy: "standard",
      "economy-all": "economy",
      collaborative: "collaborative",
    });
  });

  test("stored values are the modes themselves and pairwise distinct", () => {
    const stored = TEAM_MODES.map(storedModeValue);
    expect(stored).toEqual([...TEAM_MODES]);
    expect(new Set(stored).size).toBe(TEAM_MODES.length);
    expect(isTeamMode("standard")).toBe(false);
    expect(isTeamMode("toString")).toBe(false);
    expect(TEAM_MODES.map(modeMinContract)).toEqual([1, 1, 2, 1]);
  });
});

describe("storage / wire / display / legacy mapping matrix", () => {
  test.each(MATRIX)("stored $stored", (row) => {
    const read = readStoredMode(row.stored);
    if (row.read === "unknown") {
      expect(read).toEqual({ status: "unknown", raw: row.stored });
      // Planning reads the same value the same way: an unknown stored mode blocks.
      expect(normalizeMode(row.stored).ok).toBe(false);
    } else {
      expect(read).toEqual({ status: "known", ...row.read });
      expect(normalizeMode(row.stored)).toEqual({ ok: true, value: row.read.mode, issues: [] });
      expect(projectLegacyMode(row.read.mode)).toBe(row.legacy);
      if (row.legacy !== null) {
        expect(BaselineTeamModeSchema.safeParse(row.legacy).success).toBe(true);
      }
    }
    const wireValue = row.stored?.trim() || "sota";
    expect(wireAccepted(wireValue, 1)).toBe(row.wireV1);
    expect(wireAccepted(wireValue, 2)).toBe(row.wireV2);
  });

  test("legacy economy stays the standard mode everywhere and never becomes economy-all", () => {
    const read = readStoredMode("economy");
    expect(read).toMatchObject({ status: "known", mode: "economy", display: "standard" });
    expect(projectLegacyMode("economy")).toBe("economy");
    expect(readCliMode("economy")).toEqual({ ok: true, mode: "economy", legacySpelling: true });
    expect(checkModeAccess({ storedMode: "economy", contractVersion: 1 })).toEqual({ ok: true });
    expect(
      checkModeAccess({ storedMode: "economy", requestedMode: "economy", contractVersion: 1 }),
    ).toEqual({ ok: true });
    for (const mode of TEAM_MODES) {
      if (mode !== "economy") expect(teamModeDisplay(mode)).not.toBe("standard");
    }
  });

  test("an unknown stored value keeps its exact raw text", () => {
    expect(readStoredMode(" Quantum ")).toEqual({ status: "unknown", raw: " Quantum " });
    expect(readStoredMode("economy-ALL")).toEqual({ status: "unknown", raw: "economy-ALL" });
  });
});

describe("save mapping (AC-0d.11)", () => {
  function savedTeam(mode: string | undefined) {
    return TeamSchema.parse({
      id: "team",
      name: "Team",
      coordinatorRoleId: "lead-tech",
      members: [{ roleId: "eng-fullstack", enabled: true }],
      createdAt: NOW,
      updatedAt: NOW,
      ...(mode === undefined ? {} : { mode }),
      future: { kept: true },
    });
  }

  test("each explicit choice round-trips to its own mode through the stored Team", () => {
    const reopened = TEAM_MODES.map((selected) => {
      const stored = modeToStore({ original: "economy", selected, touched: true });
      const team = savedTeam(stored);
      expect(team).toMatchObject({ future: { kept: true } });
      return readStoredMode(team.mode);
    });
    expect(reopened).toEqual(
      TEAM_MODES.map((mode) => ({
        status: "known",
        mode,
        display: TEAM_MODE_DISPLAY[mode],
        defaulted: false,
      })),
    );
  });

  test("an untouched mode keeps the stored value: absent, legacy, new, or unknown", () => {
    for (const original of [undefined, "", "economy", "economy-all", "quantum", " sota "]) {
      for (const selected of TEAM_MODES) {
        const stored = modeToStore({ original, selected, touched: false });
        expect(stored).toBe(original);
        expect(savedTeam(stored).mode).toBe(original);
      }
    }
  });
});

describe("contract-v2 negotiation and access gate (04 §3.2)", () => {
  test("only an explicit contractVersion 2 opts in", () => {
    expect(requestContractVersion({})).toBe(1);
    expect(requestContractVersion({ contractVersion: 2 })).toBe(2);
    expect(requestContractVersion({ contractVersion: 1 })).toBe(1);
    expect(requestContractVersion({ contractVersion: 3 })).toBe(1);
  });

  test("a legacy caller cannot launch a Team saved with a mode it cannot represent", () => {
    // A stale page shows such a Team as SOTA and would send mode:sota; the override must not help.
    for (const requestedMode of [undefined, ...LEGACY_TEAM_MODES]) {
      expect(
        checkModeAccess({ storedMode: "economy-all", requestedMode, contractVersion: 1 }),
      ).toEqual({
        ok: false,
        denial: { subject: "team", value: "economy-all" },
        issue: {
          code: "MODE_UNKNOWN",
          severity: "blocker",
          params: {
            field: "mode",
            value: "economy-all",
            reason: "contract-required",
            contractVersion: 2,
          },
        },
      });
      expect(
        checkModeAccess({ storedMode: "future-mode", requestedMode, contractVersion: 1 }),
      ).toMatchObject({ ok: false, denial: { subject: "team", value: "future-mode" } });
    }
  });

  test("a legacy caller cannot request a new mode, but keeps every legacy mode", () => {
    for (const storedMode of [undefined, "sota", "economy", "collaborative"]) {
      expect(
        checkModeAccess({ storedMode, requestedMode: "economy-all", contractVersion: 1 }),
      ).toMatchObject({ ok: false, denial: { subject: "request", value: "economy-all" } });
      for (const requestedMode of [undefined, ...LEGACY_TEAM_MODES]) {
        expect(checkModeAccess({ storedMode, requestedMode, contractVersion: 1 })).toEqual({
          ok: true,
        });
      }
    }
  });

  test("a v2 caller always passes; planning still blocks an unknown saved mode", () => {
    for (const storedMode of [undefined, "economy", "economy-all", "future-mode"]) {
      for (const requestedMode of [undefined, ...TEAM_MODES]) {
        expect(checkModeAccess({ storedMode, requestedMode, contractVersion: 2 })).toEqual({
          ok: true,
        });
      }
    }
    expect(normalizeMode("future-mode")).toMatchObject({
      ok: false,
      issues: [{ code: "MODE_UNKNOWN", severity: "blocker" }],
    });
  });

  test("the probe only reports a legacy daemon on an explicit method-not-found", () => {
    expect(modeContractSupport({ kind: "capabilities", modeContract: 2 })).toBe("v2");
    expect(modeContractSupport({ kind: "capabilities", modeContract: 3 })).toBe("v2");
    expect(modeContractSupport({ kind: "capabilities", modeContract: 1 })).toBe("legacy");
    expect(modeContractSupport({ kind: "capabilities" })).toBe("legacy");
    expect(modeContractSupport({ kind: "capabilities", modeContract: "2" })).toBe("legacy");
    expect(modeContractSupport({ kind: "method-not-found" })).toBe("legacy");
    expect(modeContractSupport({ kind: "failed" })).toBe("unknown");
  });

  test("a new mode is usable only against a confirmed v2 daemon", () => {
    for (const support of ["v2", "legacy", "unknown"] as const) {
      for (const mode of LEGACY_TEAM_MODES) expect(modeUsable(mode, support)).toBe(true);
      expect(modeUsable("economy-all", support)).toBe(support === "v2");
    }
  });
});

describe("script spelling (AC-0d.14)", () => {
  test("standard and the legacy economy spelling both mean the standard mode", () => {
    expect(CLI_MODE_SPELLINGS).toEqual([
      "sota",
      "standard",
      "economy",
      "economy-all",
      "collaborative",
    ]);
    expect(CLI_MODE_SPELLINGS.map(readCliMode)).toEqual([
      { ok: true, mode: "sota", legacySpelling: false },
      { ok: true, mode: "economy", legacySpelling: false },
      { ok: true, mode: "economy", legacySpelling: true },
      { ok: true, mode: "economy-all", legacySpelling: false },
      { ok: true, mode: "collaborative", legacySpelling: false },
    ]);
    expect(readCliMode(" standard ")).toEqual({ ok: true, mode: "economy", legacySpelling: false });
  });

  test("anything else is rejected with the original text", () => {
    for (const value of ["", "cheap", "Economy", "economy_all", "sota "]) {
      const read = readCliMode(value);
      if (value === "sota ")
        expect(read).toEqual({ ok: true, mode: "sota", legacySpelling: false });
      else expect(read).toEqual({ ok: false, value });
    }
  });
});
