import { describe, expect, test } from "vitest";
import { filterRoles } from "../client/shared/role-filter";
import { architect, developer, techLead } from "./fixtures";

describe("filterRoles", () => {
  const roles = [architect, developer, techLead];

  test("returns every role when the query is blank", () => {
    expect(filterRoles(roles, "")).toEqual(roles);
    expect(filterRoles(roles, "   ")).toEqual(roles);
  });

  test("matches name, id, and description case-insensitively", () => {
    expect(filterRoles(roles, "ARCHITECT").map((role) => role.id)).toEqual(["architect"]);
    expect(filterRoles(roles, "tech-lead").map((role) => role.id)).toEqual(["tech-lead"]);
    expect(filterRoles(roles, "structure").map((role) => role.id)).toEqual(["architect"]);
  });

  test("returns an empty list when nothing matches", () => {
    expect(filterRoles(roles, "no-such-role")).toEqual([]);
  });
});
