import { describe, expect, test } from "vitest";
import {
  documentationForSettingCategory,
  documentationForSettingPath,
  OMP_SETTINGS_GUIDES,
  OMP_SETTINGS_REFERENCE,
} from "../client/omp-doc-links";

const OFFICIAL_DOCS_ROOT = "https://github.com/can1357/oh-my-pi/blob/main/docs/";

describe("OMP documentation links", () => {
  test("keeps the general settings guidance on stable official anchors", () => {
    expect(OMP_SETTINGS_REFERENCE.url).toBe(`${OFFICIAL_DOCS_ROOT}settings.md`);
    expect(OMP_SETTINGS_GUIDES.map(({ url }) => url)).toEqual([
      `${OFFICIAL_DOCS_ROOT}settings.md#reading-and-writing-settings`,
      `${OFFICIAL_DOCS_ROOT}settings.md#value-parsing`,
      `${OFFICIAL_DOCS_ROOT}settings.md#precedence`,
    ]);
  });

  test("provides specific category links only where the official reference has an anchor", () => {
    expect(documentationForSettingCategory("model")?.url).toBe(
      `${OFFICIAL_DOCS_ROOT}models.md#role-aliases-and-settings`,
    );
    expect(documentationForSettingCategory("providers")?.url).toBe(
      `${OFFICIAL_DOCS_ROOT}settings.md#providers-and-services`,
    );
    expect(documentationForSettingCategory("files")?.url).toBe(
      `${OFFICIAL_DOCS_ROOT}settings.md#files-editing-and-reading`,
    );
    expect(documentationForSettingCategory("tasks")).toBeUndefined();
    expect(documentationForSettingCategory("general")).toBeUndefined();
  });

  test("adds row-level links only for settings with narrower documentation", () => {
    expect(documentationForSettingPath("modelRoleStorage")?.url).toBe(
      `${OFFICIAL_DOCS_ROOT}settings.md#where-writes-go`,
    );
    expect(documentationForSettingPath("enabledModels")?.url).toBe(
      `${OFFICIAL_DOCS_ROOT}settings.md#path-scoped-arrays`,
    );
    expect(documentationForSettingPath("disabledProviders")?.url).toBe(
      `${OFFICIAL_DOCS_ROOT}settings.md#provider-and-source-disabling`,
    );
    expect(documentationForSettingPath("retry.enabled")).toBeUndefined();
    expect(documentationForSettingPath("modelRoles.default")).toBeUndefined();
  });
});
