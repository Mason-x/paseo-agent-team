import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { availableProfileIds } from "../shared/domain/design-planning";
import type { ProfileSelection } from "../shared/domain/mode-resolver";
import { LABELS } from "../shared/paseo/labels";
import {
  defaultCatalogPreviewRpc,
  exampleCatalogRpc,
  launchStartRpc,
  launchStatusRpc,
} from "../shared/rpc";
import {
  designCancelRpc,
  designContinueRpc,
  designMarkSavedRpc,
  designPrepareSaveRpc,
  designResultRpc,
  designSaveFailedRpc,
  designStartRpc,
  designStatusRpc,
} from "../shared/rpc/design";
import type { DesignStartOutput } from "../shared/schemas/design";
import {
  DESIGN_ISSUE_CODES,
  DesignCancelInputSchema,
  DesignContinueInputSchema,
  DesignMarkSavedInputSchema,
  DesignPrepareSaveInputSchema,
  DesignResultInputSchema,
  DesignSaveFailedInputSchema,
  DesignStartInputSchema,
  DesignStatusInputSchema,
} from "../shared/schemas/design";
import { preferencesSettings, rolesSettings, teamsSettings } from "../shared/settings";
import { DESIGN_ISSUE_KEY_BY_CODE, designZh } from "../shared/zh/design";
import {
  DESIGN_CLIENT_REQUEST_ID,
  DESIGN_HASH,
  DESIGN_JOB_ID,
  DESIGN_LEASE_ID,
  DESIGN_STATE_REVISION,
  designJob,
  designResult,
} from "./design-fixtures";

const failures = { ok: false, issues: [], job: null };

describe("planning port", () => {
  test("standby selections contribute no expected Profile IDs", () => {
    const ready: ProfileSelection = {
      unavailable: false,
      profile: { id: "p1", name: "Profile 1", provider: "claude" },
      source: "role-preferred",
      budget: "sota",
      budgetBasis: "host",
      standby: false,
      issues: [],
    };
    const standby: ProfileSelection = {
      unavailable: true,
      profile: null,
      source: "unavailable",
      budget: "unknown",
      budgetBasis: "conservative-default",
      standby: true,
      issues: [],
    };

    expect(
      availableProfileIds([ready, standby, { ...ready, profile: { ...ready.profile, id: "p2" } }]),
    ).toEqual(["p1", "p2"]);
  });
});

describe("design RPC contracts", () => {
  test("the eight wire names are fixed", () => {
    expect([
      designStartRpc.name,
      designStatusRpc.name,
      designResultRpc.name,
      designPrepareSaveRpc.name,
      designMarkSavedRpc.name,
      designSaveFailedRpc.name,
      designCancelRpc.name,
      designContinueRpc.name,
    ]).toEqual([
      "agent-team.design.start",
      "agent-team.design.status",
      "agent-team.design.result",
      "agent-team.design.prepare-save",
      "agent-team.design.mark-saved",
      "agent-team.design.save-failed",
      "agent-team.design.cancel",
      "agent-team.design.continue",
    ]);
  });

  test("every RPC has strict input, output, and a discriminated failure reply", () => {
    const rpcInputs = [
      [designStartRpc.input, { clientRequestId: DESIGN_JOB_ID, request: "改版" }],
      [designStatusRpc.input, {}],
      [designResultRpc.input, { jobId: DESIGN_JOB_ID }],
      [
        designPrepareSaveRpc.input,
        { jobId: DESIGN_JOB_ID, resultId: DESIGN_HASH, clientId: DESIGN_CLIENT_REQUEST_ID },
      ],
      [designMarkSavedRpc.input, { jobId: DESIGN_JOB_ID, resultId: DESIGN_HASH }],
      [
        designSaveFailedRpc.input,
        {
          jobId: DESIGN_JOB_ID,
          resultId: DESIGN_HASH,
          leaseId: DESIGN_LEASE_ID,
          phase: "roles",
          reason: "write-failed",
        },
      ],
      [designCancelRpc.input, { jobId: DESIGN_JOB_ID }],
      [
        designContinueRpc.input,
        { jobId: DESIGN_JOB_ID, expectedRevision: DESIGN_STATE_REVISION, action: "recheck" },
      ],
    ] as const;

    for (const [schema, input] of rpcInputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, extra: true }).success).toBe(false);
    }

    for (const rpc of [
      designStartRpc,
      designStatusRpc,
      designResultRpc,
      designPrepareSaveRpc,
      designMarkSavedRpc,
      designSaveFailedRpc,
      designCancelRpc,
      designContinueRpc,
    ]) {
      expect(rpc.output.safeParse(failures).success).toBe(true);
    }
  });

  test("success payloads parse and infer the documented types", () => {
    const job = designJob();
    const startOutput: DesignStartOutput = designStartRpc.output.parse({
      ok: true,
      job,
    });
    expect(startOutput).toMatchObject({ ok: true, job: { jobId: DESIGN_JOB_ID } });

    expect(
      designStatusRpc.output.parse({
        ok: true,
        scopeId: DESIGN_JOB_ID,
        jobs: [job],
        truncated: false,
        discoveryIssues: [],
      }),
    ).toMatchObject({ ok: true });
    expect(
      designResultRpc.output.parse({
        ok: true,
        job,
        request: "改版",
        result: designResult(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      designPrepareSaveRpc.output.parse({
        ok: true,
        prepared: { outcome: "already-saved", job },
      }),
    ).toMatchObject({ ok: true });
    for (const rpc of [
      designMarkSavedRpc,
      designSaveFailedRpc,
      designCancelRpc,
      designContinueRpc,
    ]) {
      expect(rpc.output.parse({ ok: true, job })).toMatchObject({ ok: true });
    }
  });

  test("input schemas are the exported strict objects, not loose duplicates", () => {
    expect(designStartRpc.input).toBe(DesignStartInputSchema);
    expect(designStatusRpc.input).toBe(DesignStatusInputSchema);
    expect(designResultRpc.input).toBe(DesignResultInputSchema);
    expect(designPrepareSaveRpc.input).toBe(DesignPrepareSaveInputSchema);
    expect(designMarkSavedRpc.input).toBe(DesignMarkSavedInputSchema);
    expect(designSaveFailedRpc.input).toBe(DesignSaveFailedInputSchema);
    expect(designCancelRpc.input).toBe(DesignCancelInputSchema);
    expect(designContinueRpc.input).toBe(DesignContinueInputSchema);
  });

  test("every issue code has Chinese copy", () => {
    expect(Object.keys(DESIGN_ISSUE_KEY_BY_CODE).sort()).toEqual([...DESIGN_ISSUE_CODES].sort());
    for (const code of DESIGN_ISSUE_CODES) {
      expect(designZh[DESIGN_ISSUE_KEY_BY_CODE[code]]).toBeTypeOf("string");
    }
  });
});

describe("shared boundary", () => {
  test("shared imports neither Node, React, nor @getpaseo/client", () => {
    const root = join(import.meta.dirname, "..", "shared");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);

    const forbidden =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:node:[^"']+|react(?:\/[^"']*)?|@getpaseo\/client(?:\/[^"']*)?)["']/;
    const violations = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));

    expect(files.length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  });

  test("existing RPC names, settings ids, and labels stay unchanged", () => {
    expect([
      launchStartRpc.name,
      launchStatusRpc.name,
      exampleCatalogRpc.name,
      defaultCatalogPreviewRpc.name,
    ]).toEqual([
      "agent-team.launch.start",
      "agent-team.launch.status",
      "agent-team.templates.examples",
      "agent-team.templates.defaults.preview",
    ]);
    expect([rolesSettings.id, teamsSettings.id, preferencesSettings.id]).toEqual([
      "agent-team-roles",
      "agent-team-teams",
      "agent-team-preferences",
    ]);
    expect(LABELS).toMatchObject({
      run: "agent-team.run",
      team: "agent-team.team",
      teamName: "agent-team.team-name",
      role: "agent-team.role",
      roleName: "agent-team.role-name",
      instance: "agent-team.instance",
      kind: "agent-team.kind",
      task: "agent-team.task",
    });
  });

  test.todo("D3.27/I1: only owned agent hooks enqueue a design job");
  test.todo("D3.27/I1: no global before-create override is registered");
  test.todo(
    "D3.27/I1: contributions expose no server.paseo; discovery starts only after the first adapter-bound RPC/hook",
  );
  test.todo(
    "D3.27/I1: shared modules read zh.design through shared/zh.ts instead of importing ../zh/design directly",
  );
});
