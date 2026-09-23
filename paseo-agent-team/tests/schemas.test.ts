import { describe, expect, test } from "vitest";
import { createAutoSlug, isSlug, slugify } from "../shared/ids";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { RoleSchema } from "../shared/schemas/role";
import { TeamSchema } from "../shared/schemas/team";
import { RolesDocumentSchema, TeamsDocumentSchema } from "../shared/settings";
import { architect, NOW } from "./fixtures";

describe("slug", () => {
  test("accepts lowercase ids that start with a letter", () => {
    expect(isSlug("architect")).toBe(true);
    expect(isSlug("backend-developer")).toBe(true);
    expect(isSlug("a")).toBe(false);
    expect(isSlug("Architect")).toBe(false);
    expect(isSlug("1lead")).toBe(false);
    expect(isSlug("tech_lead")).toBe(false);
  });

  test("slugify lowercases and strips junk", () => {
    expect(slugify("Tech Lead")).toBe("tech-lead");
    expect(slugify("  2 Backend  ")).toBe("i-2-backend");
    expect(slugify("  2 Backend  ", "role")).toBe("r-2-backend");
    expect(slugify("")).toBe("item");
    expect(slugify("你好策划", "role")).toBe("role");
  });

  test("auto slug follows the name until the id is edited by hand", () => {
    const auto = createAutoSlug("role");
    auto.reset(false, "role", "");
    expect(auto.nextFromName(false, "你好")).toBe("role");
    expect(auto.nextFromName(false, "Tech Lead")).toBe("tech-lead");
    expect(auto.resolve(false, "Tech Lead", "role")).toBe("tech-lead");
    auto.markManual();
    expect(auto.nextFromName(false, "Other")).toBeNull();
    expect(auto.resolve(false, "Other", "custom-id")).toBe("custom-id");
  });

  test("locked auto slug never rewrites the id", () => {
    const auto = createAutoSlug("role");
    auto.reset(true, "architect", "Architect");
    expect(auto.nextFromName(true, "New Name")).toBeNull();
    expect(auto.resolve(true, "New Name", "architect")).toBe("architect");
  });
});

describe("RoleSchema", () => {
  test("parses a complete role and fills defaults", () => {
    const parsed = RoleSchema.parse({
      ...architect,
      restrictions: undefined,
      outputContract: undefined,
      fallbackProfiles: undefined,
      enabled: undefined,
    });
    expect(parsed.restrictions).toEqual([]);
    expect(parsed.outputContract).toEqual([]);
    expect(parsed.fallbackProfiles).toEqual([]);
    expect(parsed.enabled).toBe(true);
  });

  test("rejects empty name, mission, system prompt, and preferred profiles", () => {
    expect(RoleSchema.safeParse({ ...architect, name: "" }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...architect, mission: "  " }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...architect, systemPrompt: "" }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...architect, preferredProfiles: [] }).success).toBe(false);
    expect(RoleSchema.safeParse({ ...architect, responsibilities: [] }).success).toBe(false);
  });

  test("rejects an illegal id", () => {
    expect(RoleSchema.safeParse({ ...architect, id: "Architect" }).success).toBe(false);
  });

  test("passthrough keeps unknown fields", () => {
    const parsed = RoleSchema.parse({ ...architect, extra: "ok" });
    expect(parsed.extra).toBe("ok");
  });

  test("accepts bounded stdio and remote MCP servers", () => {
    const parsed = RoleSchema.parse({
      ...architect,
      mcpServers: {
        repo: { command: "repo-mcp", args: ["--stdio"] },
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    });
    expect(parsed.mcpServers?.repo).toEqual({ command: "repo-mcp", args: ["--stdio"] });
    expect(parsed.mcpServers?.remote).toEqual({
      type: "http",
      url: "https://example.com/mcp",
    });
  });

  test("rejects shell flags, unknown fields, and unsafe MCP server names", () => {
    expect(
      RoleSchema.safeParse({
        ...architect,
        mcpServers: { repo: { command: "repo-mcp", shell: true } },
      }).success,
    ).toBe(false);
    const hidden = JSON.parse('{"__proto__":{"command":"node","shell":true}}') as unknown;
    expect(RoleSchema.parse({ ...architect, mcpServers: hidden }).mcpServers).toEqual({});
    const own = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(own, "__proto__", {
      value: { command: "node" },
      enumerable: true,
    });
    expect(RoleSchema.parse({ ...architect, mcpServers: own }).mcpServers).toEqual({});
    expect(
      RoleSchema.safeParse({
        ...architect,
        mcpServers: { "bad name": { command: "node" } },
      }).success,
    ).toBe(false);
    expect(
      RoleSchema.safeParse({
        ...architect,
        mcpServers: { repo: { command: "repo\n-mcp" } },
      }).success,
    ).toBe(false);
  });
});

describe("TeamSchema", () => {
  const base = {
    id: "coding-team",
    name: "Coding Team",
    coordinatorRoleId: "tech-lead",
    members: [{ roleId: "architect", enabled: true }],
    createdAt: NOW,
    updatedAt: NOW,
  };

  test("rejects coordinator listed as a member", () => {
    const result = TeamSchema.safeParse({
      ...base,
      members: [{ roleId: "tech-lead", enabled: true }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("协调者"))).toBe(true);
    }
  });

  test("rejects duplicate roles without instanceLabel", () => {
    const result = TeamSchema.safeParse({
      ...base,
      members: [
        { roleId: "developer", enabled: true },
        { roleId: "developer", enabled: true },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("allows duplicate roles with instanceLabel", () => {
    expect(
      TeamSchema.parse({
        ...base,
        members: [
          { roleId: "developer", instanceLabel: "Backend", enabled: true },
          { roleId: "developer", instanceLabel: "Frontend", enabled: true },
        ],
      }).members,
    ).toHaveLength(2);
  });

  test("requires at least one member", () => {
    expect(TeamSchema.safeParse({ ...base, members: [] }).success).toBe(false);
  });

  test("strips a leftover member profileOverride", () => {
    const parsed = TeamSchema.parse({
      ...base,
      members: [
        {
          roleId: "architect",
          enabled: true,
          profileOverride: { profileId: "claude-opus-high", nameSnapshot: "Claude" },
        },
      ],
    });
    expect(parsed.members[0]).toEqual({ roleId: "architect", enabled: true });
  });
});

describe("settings documents", () => {
  test("reject duplicate ids", () => {
    expect(
      RolesDocumentSchema.safeParse({ roles: [architect, { ...architect, name: "Copy" }] }).success,
    ).toBe(false);
    expect(
      TeamsDocumentSchema.safeParse({
        teams: [
          {
            id: "coding-team",
            name: "A",
            coordinatorRoleId: "tech-lead",
            members: [{ roleId: "architect" }],
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: "coding-team",
            name: "B",
            coordinatorRoleId: "tech-lead",
            members: [{ roleId: "developer" }],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("preferences fill defaults", () => {
    const parsed = PreferencesSchema.parse({});
    expect(parsed.maxMembers).toBe(8);
    expect(parsed.archiveOnLaunchFailure).toBe(true);
    expect(parsed.recentRuns).toEqual([]);
  });
});
