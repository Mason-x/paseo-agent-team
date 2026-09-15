import { describe, expect, test } from "vitest";
import {
  buildOmpMcpServerCommand,
  ompMcpAuthorizationTimelineSchema,
  openOmpMcpAuthorizationInPaseoBrowser,
} from "../shared/mcp";

describe("OMP MCP UI contracts", () => {
  test("builds only command-safe server actions", () => {
    expect(buildOmpMcpServerCommand("reauth", " github:remote ")).toBe("/mcp reauth github:remote");
    expect(buildOmpMcpServerCommand("test", "server name")).toBeUndefined();
    expect(buildOmpMcpServerCommand("disable", "")).toBeUndefined();
  });

  test("accepts bounded browser authorization data", () => {
    expect(
      ompMcpAuthorizationTimelineSchema.parse({
        url: "https://auth.example.test/authorize?state=opaque",
        instructions: "Sign in",
        loopbackCallback: true,
        browserAuthorizationToken: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      url: "https://auth.example.test/authorize?state=opaque",
      instructions: "Sign in",
      loopbackCallback: true,
      browserAuthorizationToken: "11111111-1111-4111-8111-111111111111",
    });
    expect(() =>
      ompMcpAuthorizationTimelineSchema.parse({
        url: "javascript:alert(1)",
        loopbackCallback: false,
      }),
    ).toThrow();
    expect(
      openOmpMcpAuthorizationInPaseoBrowser.input.safeParse({
        authorizationToken: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    expect(
      openOmpMcpAuthorizationInPaseoBrowser.input.safeParse({
        agentId: "agent-1",
        url: "https://auth.example.test/authorize",
      }).success,
    ).toBe(false);
  });
});
