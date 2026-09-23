import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toJsonValue } from "../shared/json";
import { RoleSchema } from "../shared/schemas/role";
import { RolesDocumentSchema } from "../shared/settings";
import { exampleCatalog } from "../shared/templates";
import { claudeOpus, NOW } from "./fixtures";

describe("settings write payload", () => {
  test("strips undefined optionals so Paseo useSettings z.json() accepts the document", () => {
    const catalog = exampleCatalog([claudeOpus], NOW);
    const role = catalog.roles[0];
    expect(role).toBeDefined();
    const parsed = RoleSchema.parse({
      ...role,
      mcpServers: undefined,
      updatedAt: NOW,
    });
    const next = catalog.roles.map((entry) => (entry.id === parsed.id ? parsed : entry));
    const doc = RolesDocumentSchema.parse({ roles: next });
    expect(() => z.json().parse(doc)).toThrow();
    expect(() => z.json().parse(toJsonValue(doc))).not.toThrow();
  });
});
