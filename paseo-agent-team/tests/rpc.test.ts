import { describe, expect, test } from "vitest";
import {
  defaultCatalogPreviewRpc,
  exampleCatalogRpc,
  LaunchStartInputSchema,
  launchStartRpc,
  launchStatusRpc,
} from "../shared/rpc";

describe("plugin RPC contracts", () => {
  test("method names are part of the client/server protocol, so they stay fixed", () => {
    expect(launchStartRpc.name).toBe("agent-team.launch.start");
    expect(launchStatusRpc.name).toBe("agent-team.launch.status");
    expect(exampleCatalogRpc.name).toBe("agent-team.templates.examples");
    expect(defaultCatalogPreviewRpc.name).toBe("agent-team.templates.defaults.preview");
  });

  test("a launch needs a Team, a task, and a target", () => {
    const valid = {
      teamId: "coding-team",
      task: "  Add Stripe  ",
      target: { kind: "workspace", workspaceId: "ws-1" },
    };
    expect(LaunchStartInputSchema.parse(valid).task).toBe("Add Stripe");
    expect(() => LaunchStartInputSchema.parse({ ...valid, task: "   " })).toThrow();
    expect(() => LaunchStartInputSchema.parse({ ...valid, teamId: "" })).toThrow();
    expect(() => LaunchStartInputSchema.parse({ ...valid, target: undefined })).toThrow();
    expect(() =>
      LaunchStartInputSchema.parse({ ...valid, target: { kind: "elsewhere" } }),
    ).toThrow();
    expect(() =>
      LaunchStartInputSchema.parse({ ...valid, target: { kind: "workspace", workspaceId: "" } }),
    ).toThrow();
  });

  test("a new workspace takes a bounded, trimmed title", () => {
    const input = (title: string) => ({
      teamId: "t",
      task: "x",
      target: { kind: "new-workspace", projectId: "p1", title },
    });
    expect(LaunchStartInputSchema.parse(input("  Billing ")).target).toMatchObject({
      title: "Billing",
    });
    expect(() => LaunchStartInputSchema.parse(input("x".repeat(81)))).toThrow();
  });

  test("start answers with either a job or the reasons it cannot start", () => {
    expect(
      launchStartRpc.output.parse({ ok: false, blockers: ["Team 不存在。"], warnings: [] }),
    ).toMatchObject({ ok: false });
    expect(() => launchStartRpc.output.parse({ ok: true })).toThrow();
    expect(() => launchStartRpc.output.parse({ ok: false, warnings: [] })).toThrow();
  });

  test("status may report that the run is no longer known", () => {
    expect(launchStatusRpc.output.parse({ job: null })).toEqual({ job: null });
    expect(() => launchStatusRpc.input.parse({ runId: "" })).toThrow();
  });

  test("preset preview is strict, defaults to blocking Profile errors, and requires a discriminated response", () => {
    expect(defaultCatalogPreviewRpc.input.parse({})).toEqual({ allowUnboundOnProfileError: false });
    expect(defaultCatalogPreviewRpc.input.parse({ allowUnboundOnProfileError: true })).toEqual({
      allowUnboundOnProfileError: true,
    });
    expect(() => defaultCatalogPreviewRpc.input.parse({ autoImport: true })).toThrow();
    expect(
      defaultCatalogPreviewRpc.output.parse({
        ok: false,
        blockers: [{ code: "profiles-unavailable", message: "读取失败" }],
      }),
    ).toMatchObject({ ok: false });
    expect(() => defaultCatalogPreviewRpc.output.parse({ ok: false, blockers: [] })).toThrow();
    expect(() => defaultCatalogPreviewRpc.output.parse({ ok: true, roles: [] })).toThrow();
    expect(exampleCatalogRpc.input.parse({})).toEqual({});
    expect(exampleCatalogRpc.output.parse({ roles: [], teams: [] })).toEqual({
      roles: [],
      teams: [],
    });
  });
});
