import { describe, expect, test } from "vitest";
import {
  defaultCatalogPreviewRpc,
  exampleCatalogRpc,
  LaunchPreviewInputSchema,
  LaunchStartInputSchema,
  launchPreviewRpc,
  launchStartRpc,
  launchStatusRpc,
} from "../shared/rpc";

describe("plugin RPC contracts", () => {
  test("method names are part of the client/server protocol, so they stay fixed", () => {
    expect(launchStartRpc.name).toBe("agent-team.launch.start");
    expect(launchPreviewRpc.name).toBe("agent-team.launch.preview");
    expect(launchStatusRpc.name).toBe("agent-team.launch.status");
    for (const name of [
      launchStartRpc.name,
      launchPreviewRpc.name,
      launchStatusRpc.name,
      exampleCatalogRpc.name,
      defaultCatalogPreviewRpc.name,
    ]) {
      expect(name).toMatch(/^[a-z][a-z0-9._-]*$/);
    }
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

  test("launch mode and preview hash are optional but validated", () => {
    const valid = {
      teamId: "coding-team",
      task: "Add Stripe",
      target: { kind: "workspace", workspaceId: "ws-1" },
    };
    expect(LaunchStartInputSchema.parse(valid)).toEqual(valid);
    expect(LaunchStartInputSchema.parse({ ...valid, mode: "economy" }).mode).toBe("economy");
    expect(
      LaunchStartInputSchema.parse({ ...valid, expectedPlanHash: "a".repeat(64) }).expectedPlanHash,
    ).toBe("a".repeat(64));
    expect(() => LaunchStartInputSchema.parse({ ...valid, mode: "future" })).toThrow();
    expect(() => LaunchStartInputSchema.parse({ ...valid, expectedPlanHash: "" })).toThrow();
    expect(LaunchPreviewInputSchema.parse({ ...valid, mode: "collaborative" })).toMatchObject({
      mode: "collaborative",
    });
    expect(LaunchPreviewInputSchema.parse({ ...valid }).teamId).toBe("coding-team");
  });

  test("preview answers with the DTO or readable blockers", () => {
    const hash = "a".repeat(64);
    const preview = {
      requestedMode: "sota",
      coordinator: {
        roleId: "tech-lead",
        roleName: "Tech Lead",
        profile: { id: "p1", name: "Profile", provider: "claude" },
        source: "role-preferred",
        issues: [],
      },
      seats: [],
      counts: { logical: 0, physical: 0, eager: 0, deferred: 0, escalation: 0, sotaPotential: 0 },
      budget: { economy: 0, sota: 0, unknown: 0, deferredSota: 0 },
      issues: [],
      warnings: [],
      planHash: hash,
    };
    expect(launchPreviewRpc.output.parse({ ok: true, preview })).toEqual({ ok: true, preview });
    expect(
      launchPreviewRpc.output.parse({
        ok: false,
        blockers: ["无法启动"],
        warnings: [],
        issues: [],
      }),
    ).toMatchObject({ ok: false });
    expect(() =>
      launchPreviewRpc.output.parse({ ok: true, preview: { ...preview, extra: true } }),
    ).toThrow();
    expect(() =>
      launchPreviewRpc.output.parse({ ok: false, blockers: [], warnings: [] }),
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
