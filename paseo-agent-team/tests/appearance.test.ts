import { describe, expect, test } from "vitest";
import {
  DEFAULT_ROLE_ICON,
  identityForeground,
  isDarkSurface,
  isDefaultRoleIcon,
  pickerIconNames,
  ROLE_ICON_NAMES,
  resolveIdentityColor,
  resolveRoleIcon,
  storedIdentityColor,
  storedRoleIcon,
} from "../client/shared/appearance";
import { exampleCatalog } from "../shared/templates";
import { claudeOpus, NOW } from "./fixtures";

describe("identity colors", () => {
  test("maps native names and legacy aliases", () => {
    expect(resolveIdentityColor("blue")).toBe("blue");
    expect(resolveIdentityColor("cyan")).toBe("sky");
    expect(resolveIdentityColor("rose")).toBe("pink");
    expect(resolveIdentityColor("purple")).toBe("violet");
    expect(resolveIdentityColor("green")).toBe("emerald");
    expect(resolveIdentityColor("")).toBe("none");
    expect(resolveIdentityColor("not-a-color")).toBe("none");
    expect(storedIdentityColor("none")).toBeUndefined();
    expect(storedIdentityColor("teal")).toBe("teal");
  });

  test("picks light vs dark foregrounds from the surface", () => {
    expect(isDarkSurface("#181B1A")).toBe(true);
    expect(isDarkSurface("#fafafa")).toBe(false);
    expect(identityForeground("none", "#181B1A")).toBeUndefined();
    expect(identityForeground("blue", "#181B1A")).toBe("#7ba1d5");
    expect(identityForeground("blue", "#fafafa")).toBe("#39649e");
  });
});

describe("role icons", () => {
  test("maps native keys and keeps Lucide names", () => {
    expect(resolveRoleIcon(undefined)).toBe(DEFAULT_ROLE_ICON);
    expect(resolveRoleIcon("")).toBe(DEFAULT_ROLE_ICON);
    expect(resolveRoleIcon("flask")).toBe("FlaskConical");
    expect(resolveRoleIcon("gitBranch")).toBe("GitBranch");
    expect(resolveRoleIcon("Crown")).toBe("Crown");
    expect(resolveRoleIcon("not-an-icon")).toBe(DEFAULT_ROLE_ICON);
    expect(storedRoleIcon("")).toBeUndefined();
    expect(storedRoleIcon("Star")).toBeUndefined();
    expect(storedRoleIcon("flask")).toBe("FlaskConical");
    expect(isDefaultRoleIcon("")).toBe(true);
    expect(isDefaultRoleIcon("Code")).toBe(false);
  });

  test("picker grid is the native 29 icons, plus a custom current icon", () => {
    expect(pickerIconNames("")).toEqual([...ROLE_ICON_NAMES]);
    expect(pickerIconNames("Code")).toEqual([...ROLE_ICON_NAMES]);
    expect(pickerIconNames("Crown")).toEqual([...ROLE_ICON_NAMES, "Crown"]);
  });
});

describe("example catalog appearance", () => {
  test("every example role uses a native identity color and Lucide icon", () => {
    const catalog = exampleCatalog([claudeOpus], NOW);
    for (const role of catalog.roles) {
      expect(resolveIdentityColor(role.color)).not.toBe("none");
      expect(isDefaultRoleIcon(role.icon)).toBe(false);
    }
  });
});
