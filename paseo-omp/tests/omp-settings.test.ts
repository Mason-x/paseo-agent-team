import { describe, expect, test } from "vitest";
import { parseOmpSettingsList } from "../server/omp-settings";
import { categorizeOmpSetting, formatOmpSettingLabel } from "../shared/omp-settings";

describe("OMP settings inventory", () => {
  test("preserves typed values while withholding credential-shaped values", () => {
    const catalog = parseOmpSettingsList({
      "retry.enabled": {
        value: true,
        type: "boolean",
        description: "Retry failed requests",
      },
      "auth.broker.token": {
        value: "must-not-cross-the-rpc-boundary",
        type: "string",
        description: "",
      },
      "images.urls.credentials": {
        redacted: true,
        type: "record",
        description: "",
      },
      unsupported: { value: true, type: "mystery" },
    });

    expect(catalog).toEqual({
      droppedCount: 1,
      settings: [
        {
          path: "retry.enabled",
          value: true,
          type: "boolean",
          description: "Retry failed requests",
        },
        {
          path: "auth.broker.token",
          redacted: true,
          configured: true,
          type: "string",
          description: "",
        },
        {
          path: "images.urls.credentials",
          redacted: true,
          type: "record",
          description: "",
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("must-not-cross-the-rpc-boundary");
  });

  test("rejects a non-object document", () => {
    expect(() => parseOmpSettingsList([])).toThrow("invalid settings document");
  });

  test("groups representative settings into OMP navigation categories", () => {
    expect(categorizeOmpSetting("theme.dark")).toBe("appearance");
    expect(categorizeOmpSetting("retry.maxRetries")).toBe("model");
    expect(categorizeOmpSetting("compaction.enabled")).toBe("context");
    expect(categorizeOmpSetting("mcp.notifications")).toBe("tools");
    expect(categorizeOmpSetting("task.maxConcurrency")).toBe("tasks");
    expect(categorizeOmpSetting("providers.fetch")).toBe("providers");
    expect(categorizeOmpSetting("setupVersion")).toBe("general");
  });

  test("formats dotted camel-case paths as readable labels", () => {
    expect(formatOmpSettingLabel("providers.streamIdleTimeoutSeconds")).toBe(
      "Stream Idle Timeout Seconds",
    );
  });
});
