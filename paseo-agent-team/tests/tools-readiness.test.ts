import { describe, expect, test } from "vitest";
import { coordinatorToolsBlocker } from "../shared/domain/tools-readiness";

describe("coordinatorToolsBlocker", () => {
  test("allows delegation when nothing is switched off", () => {
    const config = {
      mcp: { enabled: true, injectIntoAgents: true },
      providers: {
        claude: { enabled: true, paseoTools: { enabled: true, disabledTools: ["speak"] } },
      },
    };
    expect(coordinatorToolsBlocker(config, "claude")).toBeNull();
  });

  test("blocks when Paseo MCP is off", () => {
    expect(coordinatorToolsBlocker({ mcp: { enabled: false } }, "claude")).toContain("MCP");
  });

  test("blocks when Paseo does not inject its tools into agents", () => {
    const blocker = coordinatorToolsBlocker({ mcp: { injectIntoAgents: false } }, "claude");
    expect(blocker).toContain("注入 Paseo tools");
  });

  test("blocks when the provider turns Paseo tools off, naming it", () => {
    const config = { providers: { claude: { paseoTools: { enabled: false } } } };
    expect(coordinatorToolsBlocker(config, "claude")).toContain("claude");
    expect(coordinatorToolsBlocker(config, "codex")).toBeNull();
  });

  test("blocks when the delegation tool itself is disabled", () => {
    const config = {
      providers: {
        claude: { paseoTools: { disabledTools: ["list_agents", "send_agent_prompt"] } },
      },
    };
    expect(coordinatorToolsBlocker(config, "claude")).toContain("send_agent_prompt");
  });

  test("ignores disabled tools the coordinator does not need", () => {
    const config = { providers: { claude: { paseoTools: { disabledTools: ["speak"] } } } };
    expect(coordinatorToolsBlocker(config, "claude")).toBeNull();
  });

  test("an absent setting is not a reason to block", () => {
    expect(coordinatorToolsBlocker({ mcp: {} }, "claude")).toBeNull();
    expect(coordinatorToolsBlocker({ providers: {} }, "claude")).toBeNull();
  });

  test("unfamiliar config shapes from other Paseo versions never block", () => {
    const shapes: unknown[] = [
      undefined,
      null,
      3,
      "text",
      [],
      { mcp: [] },
      { mcp: "later-format" },
      { providers: 3 },
      { providers: { claude: 4 } },
      { providers: { claude: { paseoTools: { disabledTools: "all" } } } },
    ];
    for (const config of shapes) expect(coordinatorToolsBlocker(config, "claude")).toBeNull();
  });
});
