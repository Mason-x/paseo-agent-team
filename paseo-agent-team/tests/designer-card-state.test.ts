import { describe, expect, test } from "vitest";
import {
  resolveCollapseDefault,
  resolveCollapsed,
  resolveDesignerProfile,
  resolveFoldOnInput,
  resolveSelection,
  resolveStartBlock,
} from "../client/designer/card-state";
import { checkDesignRequest } from "../shared/domain/design-request";

describe("resolveCollapseDefault", () => {
  test("folds a compact page only when there are Teams to show", () => {
    expect(resolveCollapseDefault(true, 1)).toBe(true);
    expect(resolveCollapseDefault(true, 0)).toBe(false);
  });

  test("never folds the designer on a wide page", () => {
    expect(resolveCollapseDefault(false, 0)).toBe(false);
    expect(resolveCollapseDefault(false, 3)).toBe(false);
  });
});

describe("resolveCollapsed", () => {
  test("follows the default until the user has chosen", () => {
    expect(resolveCollapsed(false, null)).toBe(false);
    expect(resolveCollapsed(true, null)).toBe(true);
  });

  test("a card the user opened stays open when the Team list grows", () => {
    // Compact layout, empty list: expanded by default. The user opens it; the list then fills up.
    expect(resolveCollapsed(false, "expanded")).toBe(false);
    expect(resolveCollapsed(true, "expanded")).toBe(false);
  });

  test("a card the user folded stays folded", () => {
    expect(resolveCollapsed(false, "collapsed")).toBe(true);
    expect(resolveCollapsed(true, "collapsed")).toBe(true);
  });
});

describe("resolveFoldOnInput", () => {
  test("typing pins an untouched card open before the Team list grows", () => {
    expect(resolveFoldOnInput(null)).toBe("expanded");
    expect(resolveCollapsed(true, resolveFoldOnInput(null))).toBe(false);
  });

  test("typing leaves an explicit fold choice alone", () => {
    expect(resolveFoldOnInput("expanded")).toBe("expanded");
    expect(resolveFoldOnInput("collapsed")).toBe("collapsed");
  });
});

describe("resolveSelection", () => {
  const items = [{ id: "ws-1" }, { id: "ws-2" }];

  test("an empty choice is never missing", () => {
    expect(resolveSelection("", items, false)).toEqual({ id: "", missing: false });
    expect(resolveSelection("", [], false)).toEqual({ id: "", missing: false });
  });

  test("a listed choice is kept", () => {
    expect(resolveSelection("ws-2", items, false)).toEqual({ id: "ws-2", missing: false });
  });

  test("a choice the loaded list no longer has is missing", () => {
    expect(resolveSelection("ws-9", items, false)).toEqual({ id: "ws-9", missing: true });
  });

  test("an unverifiable list (loading or failed) never reports a choice missing", () => {
    expect(resolveSelection("ws-9", [], true)).toEqual({ id: "ws-9", missing: false });
  });
});

describe("resolveDesignerProfile", () => {
  const profiles = [{ id: "opus" }, { id: "gpt" }];

  test("starts on the default when the host still lists it", () => {
    expect(resolveDesignerProfile(null, "opus", profiles, false)).toEqual({
      id: "opus",
      missing: false,
    });
  });

  test("drops a stale default quietly", () => {
    expect(resolveDesignerProfile(null, "gone", profiles, false)).toEqual({
      id: "",
      missing: false,
    });
    expect(resolveDesignerProfile(null, undefined, profiles, false).id).toBe("");
  });

  test("an explicit choice beats the default, including 'pick for me'", () => {
    expect(resolveDesignerProfile("gpt", "opus", profiles, false).id).toBe("gpt");
    expect(resolveDesignerProfile("", "opus", profiles, false)).toEqual({
      id: "",
      missing: false,
    });
  });

  test("never swaps an explicit choice the host no longer lists", () => {
    expect(resolveDesignerProfile("gone", "opus", profiles, false)).toEqual({
      id: "gone",
      missing: true,
    });
    expect(resolveDesignerProfile("gone", "opus", [], true).missing).toBe(false);
  });
});

describe("resolveStartBlock", () => {
  const valid = checkDesignRequest("设计一个团队");
  const base = {
    hasStartHandler: true,
    disabledReason: undefined,
    submitting: false,
    request: valid,
    workspaceMissing: false,
    profileMissing: false,
    profilesLoading: false,
  };

  test("allows a valid request", () => {
    expect(resolveStartBlock(base)).toBeNull();
  });

  test("blocks a blank or over-long request, with the matching reason", () => {
    expect(resolveStartBlock({ ...base, request: checkDesignRequest("  \n ") })).toBe(
      "request-empty",
    );
    expect(resolveStartBlock({ ...base, request: checkDesignRequest("字".repeat(4001)) })).toBe(
      "request-too-long",
    );
  });

  test("blocks until the designer is wired up, whatever else is true", () => {
    expect(resolveStartBlock({ ...base, hasStartHandler: false })).toBe("unavailable");
    expect(
      resolveStartBlock({ ...base, hasStartHandler: false, request: checkDesignRequest("") }),
    ).toBe("unavailable");
  });

  test("blocks on an external reason, an in-flight start, or a stale selection", () => {
    expect(resolveStartBlock({ ...base, disabledReason: "目录未就绪" })).toBe("disabled");
    expect(resolveStartBlock({ ...base, submitting: true })).toBe("submitting");
    expect(resolveStartBlock({ ...base, workspaceMissing: true })).toBe("workspace-missing");
    expect(resolveStartBlock({ ...base, profileMissing: true })).toBe("profile-missing");
    expect(resolveStartBlock({ ...base, profilesLoading: true })).toBe("profiles-loading");
  });

  test("reports the request problem before a selection problem", () => {
    expect(
      resolveStartBlock({ ...base, request: checkDesignRequest(""), workspaceMissing: true }),
    ).toBe("request-empty");
  });
});
