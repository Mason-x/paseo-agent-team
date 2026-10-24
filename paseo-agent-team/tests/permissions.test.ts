import { describe, expect, test } from "vitest";
import { sessionAllowUpdates } from "../shared/domain/permissions";

const allowTool = {
  type: "addRules",
  rules: [{ toolName: "mcp__paseo__send_agent_prompt" }],
  behavior: "allow",
  destination: "localSettings",
};

describe("sessionAllowUpdates", () => {
  test("keeps a suggested allow rule but retargets it to the session", () => {
    expect(sessionAllowUpdates([allowTool])).toEqual([{ ...allowTool, destination: "session" }]);
  });

  test("never writes the rule to a settings file", () => {
    for (const destination of ["localSettings", "projectSettings", "userSettings", "cliArg"]) {
      const [update] = sessionAllowUpdates([{ ...allowTool, destination }]);
      expect(update?.destination).toBe("session");
    }
  });

  test("does not change the suggestion it was given", () => {
    const suggestion = { ...allowTool };
    sessionAllowUpdates([suggestion]);
    expect(suggestion.destination).toBe("localSettings");
  });

  test("only allow rules count: deny rules and other kinds of update are left out", () => {
    expect(
      sessionAllowUpdates([
        { ...allowTool, behavior: "deny" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        allowTool,
      ]),
    ).toEqual([{ ...allowTool, destination: "session" }]);
  });

  test("is empty when the provider suggests nothing usable", () => {
    expect(sessionAllowUpdates(undefined)).toEqual([]);
    expect(sessionAllowUpdates([])).toEqual([]);
    expect(sessionAllowUpdates([null, 7, "allow", [], { type: "addRules" }])).toEqual([]);
  });
});
