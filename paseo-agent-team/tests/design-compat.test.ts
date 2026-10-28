import { describe, expect, test } from "vitest";
import {
  legacyModeIssue,
  modeVisibleTo,
  projectJobForContract,
  projectResultForContract,
  projectStatusForContract,
} from "../server/designer/compat";
import {
  DesignCancelInputSchema,
  DesignContinueInputSchema,
  DesignJobSchema,
  DesignMarkSavedInputSchema,
  DesignPrepareSaveInputSchema,
  DesignResultInputSchema,
  DesignSaveFailedInputSchema,
  DesignStartInputSchema,
  DesignStatusInputSchema,
} from "../shared/schemas/design";
import { designJob, designResult } from "./design-fixtures";

const v2Job = (overrides: Record<string, unknown> = {}) =>
  designJob({
    existingRolesOnly: true,
    outputContractVersion: 2,
    roleGap: null,
    ...overrides,
  });

describe("design contract projection", () => {
  test("a legacy caller sees only the three baseline modes", () => {
    for (const mode of ["sota", "economy", "collaborative"] as const) {
      expect(modeVisibleTo(mode, 1)).toBe(true);
    }
    expect(modeVisibleTo("economy-all", 1)).toBe(false);
    expect(modeVisibleTo("economy-all", 2)).toBe(true);
  });

  test("a contract-2 caller gets the job unchanged, a legacy caller loses the new fields", () => {
    const job = v2Job({ mode: "economy-all" });
    expect(projectJobForContract(job, 2)).toMatchObject({
      existingRolesOnly: true,
      outputContractVersion: 2,
      roleGap: null,
    });
    const legacy = projectJobForContract(v2Job({ mode: "sota" }), 1);
    expect(legacy).not.toHaveProperty("existingRolesOnly");
    expect(legacy).not.toHaveProperty("outputContractVersion");
    expect(legacy).not.toHaveProperty("roleGap");
    // What remains parses with the strip-mode DTO a baseline page uses.
    expect(DesignJobSchema.safeParse(legacy).success).toBe(true);
  });

  test("keys the ledger kept for a newer writer never leave the service", () => {
    const polluted = { ...designJob(), futureKey: "x" } as unknown as ReturnType<typeof designJob>;
    expect(projectJobForContract(polluted, 2)).not.toHaveProperty("futureKey");
    const result = { ...designResult(), futureKey: 1 } as unknown as ReturnType<
      typeof designResult
    >;
    expect(projectResultForContract(result)).not.toHaveProperty("futureKey");
    expect(projectResultForContract(null)).toBeNull();
  });

  test("a list hides jobs a legacy caller cannot represent and says so", () => {
    const visible = designJob({ jobId: "aaaaaaaa-0000-4000-8000-000000000001", mode: "sota" });
    const hidden = designJob({
      jobId: "aaaaaaaa-0000-4000-8000-000000000002",
      mode: "economy-all",
    });
    const input = { jobs: [visible, hidden], truncated: false, discoveryIssues: [] };

    const legacy = projectStatusForContract(input, 1);
    expect(legacy.jobs.map((job) => job.jobId)).toEqual([visible.jobId]);
    expect(legacy.truncated).toBe(true);
    expect(legacy.discoveryIssues).toEqual([
      expect.objectContaining({
        code: "DESIGN_MODE_UNAVAILABLE",
        action: "refresh",
        params: expect.objectContaining({ reason: "hidden-by-contract", hidden: 1 }),
      }),
    ]);

    const current = projectStatusForContract(input, 2);
    expect(current.jobs).toHaveLength(2);
    expect(current.truncated).toBe(false);
    expect(current.discoveryIssues).toEqual([]);
  });

  test("the refusal issue is the existing code with the contract the caller must declare", () => {
    expect(legacyModeIssue("economy-all")).toMatchObject({
      code: "DESIGN_MODE_UNAVAILABLE",
      severity: "error",
      action: "refresh",
      params: { mode: "economy-all", reason: "contract-required", contractVersion: 2 },
    });
  });
});

describe("contractVersion on all eight design RPC inputs", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const hash = "a".repeat(64);
  const inputs: [string, { safeParse(value: unknown): { success: boolean } }, object][] = [
    ["start", DesignStartInputSchema, { clientRequestId: uuid, request: "补一个 Role" }],
    ["status", DesignStatusInputSchema, {}],
    ["result", DesignResultInputSchema, { jobId: uuid }],
    ["prepare-save", DesignPrepareSaveInputSchema, { jobId: uuid, resultId: hash, clientId: uuid }],
    ["mark-saved", DesignMarkSavedInputSchema, { jobId: uuid, resultId: hash }],
    [
      "save-failed",
      DesignSaveFailedInputSchema,
      { jobId: uuid, resultId: hash, leaseId: uuid, phase: "team", reason: "unknown" },
    ],
    ["cancel", DesignCancelInputSchema, { jobId: uuid }],
    [
      "continue",
      DesignContinueInputSchema,
      { jobId: uuid, expectedRevision: uuid, action: "recheck" },
    ],
  ];

  test.each(inputs)(
    "%s accepts any integer, rejects a non-integer, and works without it",
    (_name, schema, base) => {
      expect(schema.safeParse(base).success).toBe(true);
      for (const contractVersion of [0, 1, 2, 3, -1]) {
        expect(schema.safeParse({ ...base, contractVersion }).success).toBe(true);
      }
      for (const contractVersion of [2.5, "2", Number.NaN, null]) {
        expect(schema.safeParse({ ...base, contractVersion }).success).toBe(false);
      }
    },
  );
});
