import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { StoredDesignResultSchema } from "../server/designer/store";
import {
  canonicalDesignContent,
  designResultContent,
  roleBehaviorContent,
} from "../shared/domain/design-content";
import type { DesignPlanningInput, DesignPlanningPort } from "../shared/domain/design-planning";
import type {
  DesignValidationContext,
  MaterializationIdentity,
  ValidatedDesign,
  ValidationResult,
} from "../shared/domain/design-validation";
import {
  allocateDesignTeamId,
  describeProfileChoiceMismatches,
  materializeDesign,
  validateDesign,
  validateMaterializedDesign,
} from "../shared/domain/design-validation";
import type { ModeIssue, ModeIssueCode } from "../shared/domain/role-execution";
import type {
  DesignIssue,
  DesignProposal,
  DesignResult,
  NewDesignRole,
} from "../shared/schemas/design";
import { DesignResultSchema } from "../shared/schemas/design";
import { type ModeLaunchPreview, ModeLaunchPreviewSchema } from "../shared/schemas/launch-preview";
import { PreferencesSchema } from "../shared/schemas/preferences";
import { RoleSchema } from "../shared/schemas/role";
import {
  DESIGN_JOB_ID,
  DESIGN_NONCE,
  designProposal,
  designResult,
  newDesignRole,
} from "./design-fixtures";
import {
  allAvailable,
  architect,
  claudeOpus,
  codexXhigh,
  codingTeam,
  developer,
  NOW,
  techLead,
} from "./fixtures";

const hasher = (content: string) => createHash("sha256").update(content).digest("hex");

type PreviewSeatSpec = {
  seatId?: string;
  logicalSeatId?: string;
  roleId: string;
  purpose?: "member" | "candidate" | "judge" | "escalation";
  activation?: "eager" | "on-demand" | "escalation-only";
  profileId?: string | null;
  source?: "role-preferred" | "role-fallback" | "economy-pool" | "unavailable";
  family?: string;
};

function previewFor(
  input: DesignPlanningInput,
  coordinatorProfileId: string | null,
  specs: readonly PreviewSeatSpec[],
  issues: readonly ModeIssue[] = [],
): ModeLaunchPreview {
  const seats = specs.map((spec) => {
    const profileId = spec.profileId ?? null;
    return {
      seatId: spec.seatId ?? spec.logicalSeatId ?? spec.roleId,
      logicalSeatId: spec.logicalSeatId ?? spec.seatId ?? spec.roleId,
      roleId: spec.roleId,
      roleName: spec.roleId,
      purpose: spec.purpose ?? "member",
      activation: spec.activation ?? "eager",
      profile: profileId ? { id: profileId, name: profileId, provider: "unknown" } : null,
      source: spec.source ?? (profileId ? "role-preferred" : "unavailable"),
      ...(spec.family === undefined ? {} : { family: spec.family }),
      alternates: [],
      budget: "unknown" as const,
      budgetBasis: "conservative-default" as const,
      standby: spec.activation === "escalation-only",
      unavailable: profileId === null,
      issues: [],
    };
  });
  return ModeLaunchPreviewSchema.parse({
    requestedMode: input.mode,
    coordinator: {
      roleId: input.team.coordinatorRoleId,
      roleName: input.team.coordinatorRoleId,
      profile: coordinatorProfileId
        ? { id: coordinatorProfileId, name: coordinatorProfileId, provider: "unknown" }
        : null,
      source: "role-preferred",
      issues: [],
    },
    seats,
    counts: {
      logical: input.team.members.length,
      physical: seats.length,
      eager: seats.filter((seat) => seat.activation === "eager").length,
      deferred: seats.filter((seat) => seat.activation === "on-demand").length,
      escalation: seats.filter((seat) => seat.activation === "escalation-only").length,
      sotaPotential: seats.length,
    },
    budget: { economy: 0, sota: 0, unknown: seats.length, deferredSota: 0 },
    issues,
    warnings: [],
    planHash: "a".repeat(64),
  });
}

const opusMax = { ...claudeOpus, id: "opus-max", name: "Opus", model: "opus-max" };
const opusHigh = { ...claudeOpus, id: "opus-high", name: "Opus", model: "opus-high" };

function makeContext(overrides: Partial<DesignValidationContext> = {}): DesignValidationContext {
  return {
    request: "给后台做一次改版",
    mode: "sota",
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: DESIGN_NONCE,
    roles: [techLead, architect, developer],
    teams: [codingTeam],
    preferences: PreferencesSchema.parse({ maxMembers: 24 }),
    host: {
      status: "ready",
      profiles: [claudeOpus, codexXhigh, opusMax, opusHigh],
      availability: allAvailable,
    },
    daemonConfig: {},
    carrierWorkspaceId: "ws-carrier",
    targetWorkspaceId: null,
    capabilities: { onDemand: true, expansion: true, collaboration: false },
    hasher,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<MaterializationIdentity> = {}): MaterializationIdentity {
  return {
    teamId: "rework-team",
    createdAt: NOW,
    logicalSeatIds: { m1: "seat-m1", m2: "seat-m2" },
    ...overrides,
  };
}

const DEFAULT_PROFILES: Record<string, string> = {
  coordinator: "claude-opus-high",
  m1: "codex-xhigh",
  m2: "claude-opus-high",
};

function fakePlanner(
  options: {
    profileIds?: Record<string, string | null>;
    issues?: ModeIssue[];
    launchWarnings?: string[];
    launchBlockers?: string[];
    ok?: boolean;
    candidateCounts?: Record<string, number>;
    candidateProfileIds?: Record<string, string[]>;
    purposes?: Record<string, "member" | "candidate" | "escalation">;
    extraSeats?: PreviewSeatSpec[];
    omitCoordinator?: boolean;
    omitSeats?: string[];
  } = {},
): DesignPlanningPort {
  const ids = { ...DEFAULT_PROFILES, ...options.profileIds };
  return {
    plan(input) {
      const coordinatorProfileId = ids.coordinator ?? null;
      const seats: PreviewSeatSpec[] = input.team.members.flatMap((member, index) => {
        const key = `m${index + 1}`;
        if (options.omitSeats?.includes(key)) return [];
        const count = options.candidateCounts?.[key] ?? 1;
        const candidateProfiles = options.candidateProfileIds?.[key] ?? [ids[key] ?? null];
        const purpose = options.purposes?.[key] ?? (count > 1 ? "candidate" : "member");
        return Array.from({ length: count }, (_, candidateIndex) => {
          const profileId = candidateProfiles[candidateIndex] ?? candidateProfiles[0] ?? null;
          return {
            logicalSeatId: member.seatId ?? "",
            seatId: `${member.seatId ?? `seat-m${index + 1}`}-p${candidateIndex + 1}`,
            roleId: member.roleId,
            purpose,
            profileId,
            source: profileId ? ("role-preferred" as const) : ("unavailable" as const),
          };
        });
      });
      seats.push(...(options.extraSeats ?? []));
      if (options.ok === false || (options.launchBlockers?.length ?? 0) > 0) {
        return {
          ok: false,
          issues: options.issues ?? [],
          launchBlockers: options.launchBlockers ?? [],
          launchWarnings: options.launchWarnings ?? [],
        };
      }
      return {
        ok: true,
        preview: previewFor(
          input,
          options.omitCoordinator ? null : coordinatorProfileId,
          seats,
          options.issues ?? [],
        ),
        issues: options.issues ?? [],
        launchWarnings: options.launchWarnings ?? [],
      };
    },
  };
}

function run(
  proposal: DesignProposal = designProposal(),
  options: {
    context?: Partial<DesignValidationContext>;
    planner?: DesignPlanningPort;
    identity?: Partial<MaterializationIdentity>;
  } = {},
) {
  return validateDesign(
    proposal,
    makeContext(options.context),
    options.planner ?? fakePlanner(),
    makeIdentity(options.identity),
  );
}

function codes(issues: readonly DesignIssue[]): string[] {
  return issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
}

function validNewRole(overrides: Partial<NewDesignRole> = {}): NewDesignRole {
  return newDesignRole({
    id: "eng-rework",
    name: "【工程】改版专员",
    ...overrides,
  });
}

function withNewRoles(
  roles: NewDesignRole[],
  profileIds: Record<string, string | null> = {},
): { proposal: DesignProposal; planner: DesignPlanningPort } {
  const base = designProposal();
  const members = roles.map((role, index) => ({
    key: `m${index + 3}`,
    roleId: role.id,
    instanceLabel: `新增${index + 1}`,
  }));
  const choices = roles.map((role, index) => ({
    target: `m${index + 3}`,
    profileIds: [profileIds[`m${index + 3}`] ?? "codex-xhigh"].filter(
      (profileId): profileId is string => profileId !== null,
    ),
    reason: `新增 ${role.name}`,
  }));
  return {
    proposal: {
      ...base,
      team: { ...base.team, members: [...base.team.members, ...members] },
      newRoles: roles,
      profileChoices: [...base.profileChoices, ...choices],
    },
    planner: fakePlanner({ profileIds }),
  };
}

function materialized(
  validated: ValidationResult<ValidatedDesign>,
  context: DesignValidationContext = makeContext(),
  identity: MaterializationIdentity = makeIdentity(),
): {
  context: DesignValidationContext;
  identity: MaterializationIdentity;
  result: DesignResult;
} {
  if (!validated.ok) throw new Error("expected a validated design");
  const core = materializeDesign(validated.value, context, identity);
  return {
    context,
    identity,
    result: DesignResultSchema.parse({
      ...core,
      resultId: hasher(canonicalDesignContent(core)),
      planningFingerprint: "c".repeat(64),
    }),
  };
}

function modeIssue(
  code: ModeIssueCode,
  severity: "warning" | "blocker",
  params: Record<string, string | number | boolean> = {},
): ModeIssue {
  return { code, severity, params };
}

describe("design content", () => {
  test("canonical JSON is key-ordered and stable for undefined semantics", () => {
    expect(canonicalDesignContent({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalDesignContent({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
    expect(canonicalDesignContent({ a: undefined, b: 1 })).toBe(canonicalDesignContent({ b: 1 }));
    expect(canonicalDesignContent([1, undefined])).toBe(canonicalDesignContent([1, null]));
  });

  test("role behavior includes prompt, MCP, policy, and Profile order but not decoration or origin", () => {
    const left = roleBehaviorContent(architect);
    const decorated = {
      ...architect,
      color: "#fff",
      icon: "icon",
      source: "preset",
      preset: {
        catalogId: "c",
        templateId: "t",
        catalogRevision: "r",
        templateHash: "a",
        appliedHash: "b",
        importedAt: NOW,
      },
    };
    expect(canonicalDesignContent(roleBehaviorContent(decorated))).toBe(
      canonicalDesignContent(left),
    );

    const variants = [
      { ...architect, systemPrompt: "different" },
      { ...architect, mcpServers: { local: { command: "node", args: ["x"] } } },
      { ...architect, executionPolicy: { tier: "execution" } },
      { ...architect, preferredProfiles: [{ profileId: "other" }, ...architect.preferredProfiles] },
    ];
    for (const variant of variants) {
      expect(canonicalDesignContent(roleBehaviorContent(RoleSchema.parse(variant)))).not.toBe(
        canonicalDesignContent(left),
      );
    }
  });

  test("result content is the core, so it changes with preview, request, and warnings", () => {
    const core = designResult();
    expect(designResultContent(core)).toBe(core);
    expect(canonicalDesignContent(core)).toBe(canonicalDesignContent({ ...core }));
    expect(canonicalDesignContent({ ...core, request: "另一项需求" })).not.toBe(
      canonicalDesignContent(core),
    );
    expect(
      canonicalDesignContent({
        ...core,
        warnings: [
          {
            ...(core.warnings[0] ?? {}),
            code: "DESIGN_TEAM_RENAMED",
            severity: "warning",
            path: [],
            params: {},
            action: "none",
          },
        ],
      }),
    ).not.toBe(canonicalDesignContent(core));
  });
});

describe("validateDesign", () => {
  test("accepts a complete SOTA design and materializes fixed identities", () => {
    const result = run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.team).toMatchObject({
      id: "rework-team",
      mode: "sota",
      memberCreation: "eager",
      source: "team-designer",
      designer: { jobId: DESIGN_JOB_ID },
    });
    expect(result.value.team.members.map((member) => member.seatId)).toEqual([
      "seat-m1",
      "seat-m2",
    ]);
    expect(result.value.memberReasons.map((member) => member.target)).toEqual([
      "coordinator",
      "m1",
      "m2",
    ]);

    const core = materializeDesign(result.value, makeContext(), makeIdentity());
    expect(core).not.toHaveProperty("resultId");
    expect(core).not.toHaveProperty("planningFingerprint");
    expect(core.materializedAt).toBe(NOW);
    expect(core.reuse.map((entry) => entry.roleId)).toEqual([
      "tech-lead",
      "architect",
      "developer",
    ]);
    for (const entry of core.reuse) expect(entry.behaviorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(materializeDesign(result.value, makeContext(), makeIdentity())).toEqual(core);
    expect(() =>
      materializeDesign(result.value, makeContext({ hasher: undefined }), makeIdentity()),
    ).toThrow(/hasher/);
  });

  test("host unavailability blocks instead of looking like an empty healthy host", () => {
    const result = run(designProposal(), {
      context: { host: { status: "unavailable", reason: "config-read-failed" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.issues)).toEqual(["DESIGN_CONFIG_UNAVAILABLE"]);
  });

  test("collects new-Role and reuse errors together", () => {
    const role = validNewRole({ id: "eng-rework", name: "【工程】改版专员" });
    const proposal = {
      ...designProposal(),
      newRoles: [role],
      reuse: [...designProposal().reuse, { roleId: "ghost", reason: "不存在" }],
    };
    const result = run(proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const found = codes(result.issues);
      expect(found).toContain("DESIGN_ROLE_UNUSED");
      expect(found).toContain("DESIGN_REUSE_INVALID");
    }
  });

  test("requires the reuse set to equal used existing Roles", () => {
    const missing = run(designProposal({ reuse: designProposal().reuse.slice(0, 1) }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(codes(missing.issues)).toContain("DESIGN_REUSE_INVALID");

    const extra = run(
      designProposal({
        reuse: [...designProposal().reuse, { roleId: "architect", reason: "duplicate" }],
      }),
    );
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(codes(extra.issues)).toContain("DESIGN_REUSE_INVALID");

    const missingRole = run(designProposal(), {
      context: { roles: [techLead, developer] },
    });
    expect(missingRole.ok).toBe(false);
    if (!missingRole.ok) expect(codes(missingRole.issues)).toContain("DESIGN_REUSE_INVALID");

    const disabled = run(designProposal(), {
      context: { roles: [techLead, { ...architect, enabled: false }, developer] },
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(codes(disabled.issues)).toContain("DESIGN_REUSE_INVALID");
  });

  test("rejects coordinator membership, duplicate keys, and duplicate instance labels", () => {
    const coordinatorMember = {
      ...designProposal(),
      team: {
        ...designProposal().team,
        members: [
          ...designProposal().team.members,
          { key: "m3", roleId: "tech-lead", instanceLabel: "兼任" },
        ],
      },
    };
    const coordinatorResult = run(coordinatorMember);
    expect(coordinatorResult.ok).toBe(false);
    if (!coordinatorResult.ok)
      expect(codes(coordinatorResult.issues)).toContain("DESIGN_TEAM_INVALID");

    const gap = {
      ...designProposal(),
      team: {
        ...designProposal().team,
        members: [
          designProposal().team.members[0],
          { ...designProposal().team.members[1], key: "m3" },
        ],
      },
    };
    const gapResult = run(gap);
    expect(gapResult.ok).toBe(false);
    if (!gapResult.ok) expect(codes(gapResult.issues)).toContain("DESIGN_TEAM_INVALID");

    const noLabel = {
      ...designProposal(),
      team: {
        ...designProposal().team,
        members: [...designProposal().team.members, { key: "m3", roleId: "developer" }],
      },
      profileChoices: [
        ...designProposal().profileChoices,
        { target: "m3", profileIds: ["claude-opus-high"], reason: "重复实现" },
      ],
    };
    const noLabelResult = run(noLabel, {
      planner: fakePlanner({ profileIds: { m3: "claude-opus-high" } }),
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(noLabelResult.ok).toBe(false);
    if (!noLabelResult.ok) expect(codes(noLabelResult.issues)).toContain("DESIGN_TEAM_INVALID");

    const sameLabel = {
      ...noLabel,
      team: {
        ...noLabel.team,
        members: [
          ...designProposal().team.members,
          { key: "m3", roleId: "developer", instanceLabel: "实现" },
        ],
      },
    };
    const sameLabelResult = run(sameLabel, {
      planner: fakePlanner({ profileIds: { m3: "claude-opus-high" } }),
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(sameLabelResult.ok).toBe(false);
    if (!sameLabelResult.ok) expect(codes(sameLabelResult.issues)).toContain("DESIGN_TEAM_INVALID");
  });

  test("valid new Roles require prefix naming, explicit policy, and a used seat", () => {
    const role = validNewRole();
    const { proposal, planner } = withNewRoles([role], { m3: "codex-xhigh" });
    const result = run(proposal, {
      planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newRoles[0]).toMatchObject({
        id: "eng-rework",
        source: "team-designer",
        designer: { jobId: DESIGN_JOB_ID },
        preferredProfiles: [{ profileId: "codex-xhigh" }],
      });
    }

    for (const [prefix, category] of [
      ["lead-", "【统筹】"],
      ["plan-", "【规划】"],
      ["eng-", "【工程】"],
      ["qa-", "【质量】"],
      ["research-", "【研究】"],
      ["content-", "【内容】"],
    ] as const) {
      const named = validNewRole({ id: `${prefix}item`, name: `${category}项目` });
      const built = withNewRoles([named], { m3: "codex-xhigh" });
      const accepted = run(built.proposal, {
        planner: built.planner,
        identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
      });
      expect(accepted.ok).toBe(true);
    }

    const badPrefix = withNewRoles([validNewRole({ id: "ops-item" })]);
    const badPrefixResult = run(badPrefix.proposal, {
      planner: badPrefix.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(badPrefixResult.ok).toBe(false);
    if (!badPrefixResult.ok) expect(codes(badPrefixResult.issues)).toContain("DESIGN_ROLE_NAMING");

    const badName = withNewRoles([validNewRole({ name: "改版专员" })]);
    const badNameResult = run(badName.proposal, {
      planner: badName.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(badNameResult.ok).toBe(false);
    if (!badNameResult.ok) expect(codes(badNameResult.issues)).toContain("DESIGN_ROLE_NAMING");
  });

  test("rejects duplicate ids, existing ids, name collisions, and invalid policy", () => {
    const duplicate = validNewRole();
    const { proposal: duplicateProposal } = withNewRoles([duplicate, duplicate]);
    const duplicateResult = run(duplicateProposal);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok)
      expect(codes(duplicateResult.issues)).toContain("DESIGN_ROLE_ID_CONFLICT");

    const existing = withNewRoles([validNewRole({ id: "architect", name: "【工程】架构" })]);
    const existingResult = run(existing.proposal, {
      planner: existing.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(existingResult.ok).toBe(false);
    if (!existingResult.ok)
      expect(codes(existingResult.issues)).toContain("DESIGN_ROLE_ID_CONFLICT");

    const colliding = withNewRoles([
      validNewRole({ id: "eng-a", name: "【工程】改版 专员" }),
      validNewRole({ id: "eng-b", name: "【工程】改版　专员" }),
    ]);
    const collidingResult = run(colliding.proposal, {
      planner: colliding.planner,
      identity: {
        logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3", m4: "seat-m4" },
      },
    });
    expect(collidingResult.ok).toBe(false);
    if (!collidingResult.ok)
      expect(codes(collidingResult.issues)).toContain("DESIGN_ROLE_NAME_CONFLICT");

    const invalidPolicy = withNewRoles([
      validNewRole({
        executionPolicy: {
          tier: "economy",
          taskKind: "coding",
        } as unknown as NewDesignRole["executionPolicy"],
      }),
    ]);
    const invalidPolicyResult = run(invalidPolicy.proposal, {
      planner: invalidPolicy.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(invalidPolicyResult.ok).toBe(false);
    if (!invalidPolicyResult.ok) {
      expect(codes(invalidPolicyResult.issues)).toContain("DESIGN_MODE_PLAN_INVALID");
    }
  });

  test("enforces new-Role count and Profile references without blocking legacy reused placeholders", () => {
    const roles = ["a", "b", "c", "d"].map((suffix) =>
      validNewRole({ id: `eng-${suffix}`, name: `【工程】${suffix.toUpperCase()}` }),
    );
    const four = withNewRoles(roles);
    const fourResult = run(four.proposal, {
      planner: four.planner,
      identity: {
        logicalSeatIds: {
          m1: "seat-m1",
          m2: "seat-m2",
          m3: "seat-m3",
          m4: "seat-m4",
          m5: "seat-m5",
          m6: "seat-m6",
        },
      },
    });
    expect(fourResult.ok).toBe(false);
    if (!fourResult.ok) expect(codes(fourResult.issues)).toContain("DESIGN_NEW_ROLE_LIMIT");

    const missingProfile = withNewRoles([
      validNewRole({ preferredProfiles: [{ profileId: "missing" }] }),
    ]);
    const missingResult = run(missingProfile.proposal, {
      planner: missingProfile.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(codes(missingResult.issues)).toContain("DESIGN_PROFILE_MISSING");

    const duplicateProfile = withNewRoles([
      validNewRole({
        preferredProfiles: [{ profileId: "codex-xhigh" }],
        fallbackProfiles: [{ profileId: "codex-xhigh" }],
      }),
    ]);
    const duplicateProfileResult = run(duplicateProfile.proposal, {
      planner: duplicateProfile.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(duplicateProfileResult.ok).toBe(false);
    if (!duplicateProfileResult.ok) {
      expect(codes(duplicateProfileResult.issues)).toContain("DESIGN_PROFILE_DUPLICATE");
    }

    const empty = withNewRoles([validNewRole({ preferredProfiles: [] })]);
    const emptyResult = run(empty.proposal, {
      planner: empty.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) expect(codes(emptyResult.issues)).toContain("DESIGN_INPUT_INVALID");

    const existingName = RoleSchema.parse({
      ...architect,
      id: "legacy-eng",
      name: "【工程】改版专员",
    });
    const colliding = withNewRoles([validNewRole()]);
    const existingNameResult = run(colliding.proposal, {
      context: { roles: [techLead, architect, developer, existingName] },
      planner: colliding.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(existingNameResult.ok).toBe(false);
    if (!existingNameResult.ok) {
      expect(codes(existingNameResult.issues)).toContain("DESIGN_ROLE_NAME_CONFLICT");
    }

    const legacy = { ...architect, preferredProfiles: [{ profileId: "missing-legacy" }] };
    const legacyResult = run(designProposal(), {
      context: { roles: [techLead, legacy, developer] },
    });
    expect(legacyResult.ok).toBe(true);
  });

  test("binds new Roles by exact Profile ID even when names match", () => {
    const role = validNewRole({ preferredProfiles: [{ profileId: "opus-max" }] });
    const built = withNewRoles([role], { m3: "opus-high" });
    const result = run(built.proposal, {
      planner: built.planner,
      identity: { logicalSeatIds: { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newRoles[0]?.preferredProfiles[0]?.profileId).toBe("opus-max");
      expect(result.value.newRoles[0]?.preferredProfiles[0]?.nameSnapshot).toBe("Opus");
      const core = materializeDesign(result.value, makeContext(), makeIdentity());
      expect(core.newRoles[0]?.preferredProfiles[0]?.profileId).toBe("opus-max");
      expect(
        core.memberReasons.find((reason) => reason.target === "m3")?.expectedProfileIds,
      ).toEqual(["opus-high"]);
    }
  });

  test("maps planner blockers, launch blockers, and ordered choices", () => {
    const planner = fakePlanner({
      issues: [modeIssue("MODE_JUDGE_REQUIRED", "blocker")],
      launchBlockers: ["missing tools"],
    });
    const result = run(designProposal(), { planner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.issues)).toEqual(
        expect.arrayContaining(["DESIGN_MODE_PLAN_INVALID", "DESIGN_LAUNCH_BLOCKED"]),
      );
      const mode = result.issues.find((issue) => issue.code === "DESIGN_MODE_PLAN_INVALID");
      expect(mode?.params.modeCode).toBe("MODE_JUDGE_REQUIRED");
      expect(mode?.action).toBe("repair");
    }

    const unavailable = run(designProposal(), {
      planner: fakePlanner({
        ok: false,
        issues: [modeIssue("MODE_CONTEXT_UNAVAILABLE", "blocker")],
      }),
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(
        unavailable.issues.find((issue) => issue.code === "DESIGN_MODE_PLAN_INVALID")?.action,
      ).toBe("refresh");
    }
    const configInvalid = run(designProposal(), {
      planner: fakePlanner({
        ok: false,
        issues: [modeIssue("MODE_POOL_CONFIG_INVALID", "blocker")],
      }),
    });
    expect(configInvalid.ok).toBe(false);
    if (!configInvalid.ok) {
      expect(
        configInvalid.issues.find((issue) => issue.code === "DESIGN_MODE_PLAN_INVALID")?.action,
      ).toBe("inspect");
    }
    const successBlocker = run(designProposal(), {
      planner: fakePlanner({ issues: [modeIssue("MODE_JUDGE_REQUIRED", "blocker")] }),
    });
    expect(successBlocker.ok).toBe(false);

    const warnings = run(designProposal(), {
      planner: fakePlanner({
        issues: [modeIssue("MODE_FAMILIES_REDUCED", "warning")],
        launchWarnings: ["legacy warning"],
      }),
    });
    expect(warnings.ok).toBe(true);
    if (warnings.ok) {
      expect(warnings.issues.map((issue) => issue.severity)).toEqual(["warning", "warning"]);
    }

    const choice = run(
      {
        ...designProposal(),
        profileChoices: [
          designProposal().profileChoices[0],
          { target: "m1", profileIds: ["claude-opus-high"], reason: "wrong order" },
          designProposal().profileChoices[2],
        ],
      },
      { planner: fakePlanner() },
    );
    expect(choice.ok).toBe(false);
    if (!choice.ok) {
      const mismatch = choice.issues.find((issue) => issue.code === "DESIGN_PROFILE_CHOICE");
      expect(mismatch?.params.actualProfileIds).toBe('["claude-opus-high"]');
      expect(mismatch?.params.expectedProfileIds).toBe('["codex-xhigh"]');
    }
  });

  test("supports collaboration only when capability is open and validates its member refs", () => {
    const collaborative = designProposal({
      team: {
        ...designProposal().team,
        mode: "collaborative",
        collaboration: { replicas: 2, judgeRoleId: "architect" },
      },
    });
    const blocked = run(collaborative, { context: { mode: "collaborative" } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(codes(blocked.issues)).toContain("DESIGN_MODE_UNAVAILABLE");

    const accepted = run(collaborative, {
      context: {
        mode: "collaborative",
        capabilities: { onDemand: true, expansion: true, collaboration: true },
      },
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.team.memberCreation).toBe("on-demand");

    const wrongMode = run(
      designProposal({
        team: {
          ...designProposal().team,
          collaboration: { replicas: 2, judgeRoleId: "architect" },
        },
      }),
    );
    expect(wrongMode.ok).toBe(false);
    if (!wrongMode.ok) expect(codes(wrongMode.issues)).toContain("DESIGN_TEAM_INVALID");

    const badJudge = designProposal({
      team: {
        ...designProposal().team,
        mode: "collaborative",
        collaboration: { replicas: 2, judgeRoleId: "developer" },
        members: [designProposal().team.members[0]],
      },
      profileChoices: designProposal().profileChoices.slice(0, 2),
    });
    const badJudgeResult = run(badJudge, {
      context: {
        mode: "collaborative",
        capabilities: { onDemand: true, expansion: true, collaboration: true },
      },
    });
    expect(badJudgeResult.ok).toBe(false);
    if (!badJudgeResult.ok) expect(codes(badJudgeResult.issues)).toContain("DESIGN_TEAM_INVALID");

    const fallbackPlanner: DesignPlanningPort = {
      plan(input) {
        return {
          ok: true,
          preview: previewFor(
            input,
            "claude-opus-high",
            input.team.members.map((member, index) => ({
              seatId: member.seatId,
              roleId: member.roleId,
              profileId: index === 0 ? "codex-xhigh" : "claude-opus-high",
            })),
          ),
          issues: [],
          launchWarnings: [],
        };
      },
    };
    const fallback = run(designProposal(), { planner: fallbackPlanner });
    expect(fallback.ok).toBe(true);
  });

  test("uses eager creation for economy without on-demand support", () => {
    const economy = designProposal({
      team: { ...designProposal().team, mode: "economy" },
    });
    const eager = run(economy, {
      context: {
        mode: "economy",
        capabilities: { onDemand: false, expansion: true, collaboration: false },
      },
    });
    expect(eager.ok).toBe(true);
    if (eager.ok) expect(eager.value.team.memberCreation).toBe("eager");
    const onDemand = run(economy, {
      context: {
        mode: "economy",
        capabilities: { onDemand: true, expansion: true, collaboration: false },
      },
    });
    expect(onDemand.ok).toBe(true);
    if (onDemand.ok) expect(onDemand.value.team.memberCreation).toBe("on-demand");
  });

  test("rejects identity collisions and missing logical seats", () => {
    const occupied = run(designProposal(), {
      context: { teams: [codingTeam, { ...codingTeam, id: "rework-team" }] },
    });
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(codes(occupied.issues)).toContain("DESIGN_TEAM_ID_CONFLICT");

    const missingSeat = run(designProposal(), {
      identity: { logicalSeatIds: { m1: "seat-m1" } },
    });
    expect(missingSeat.ok).toBe(false);
    if (!missingSeat.ok) expect(codes(missingSeat.issues)).toContain("DESIGN_TEAM_INVALID");

    const duplicateSeat = run(designProposal(), {
      identity: { logicalSeatIds: { m1: "seat", m2: "seat" } },
    });
    expect(duplicateSeat.ok).toBe(false);
    if (!duplicateSeat.ok) expect(codes(duplicateSeat.issues)).toContain("DESIGN_TEAM_INVALID");

    const reservedSeat = run(designProposal(), {
      identity: { logicalSeatIds: { m1: "coordinator", m2: "seat-m2" } },
    });
    expect(reservedSeat.ok).toBe(false);
    if (!reservedSeat.ok) {
      expect(reservedSeat.issues).toContainEqual(
        expect.objectContaining({
          code: "DESIGN_TEAM_INVALID",
          path: ["identity", "logicalSeatIds", "m1"],
          params: { key: "m1", reason: "reserved-seat" },
        }),
      );
    }

    const renamed = run(designProposal(), {
      identity: { teamId: "rework-team-2" },
    });
    expect(renamed.ok).toBe(true);
    if (renamed.ok)
      expect(renamed.issues).toContainEqual(
        expect.objectContaining({ code: "DESIGN_TEAM_RENAMED", severity: "warning" }),
      );
  });
});

test("maps model mN keys through logicalSeatIds and supports ordered candidates", () => {
  const candidateProposal = designProposal({
    profileChoices: [
      designProposal().profileChoices[0],
      {
        target: "m1",
        profileIds: ["codex-xhigh", "claude-opus-high"],
        reason: "两个候选",
      },
      designProposal().profileChoices[2],
    ],
  });
  const candidates = run(candidateProposal, {
    planner: fakePlanner({
      candidateCounts: { m1: 2 },
      candidateProfileIds: { m1: ["codex-xhigh", "claude-opus-high"] },
    }),
  });
  expect(candidates.ok).toBe(true);
  if (candidates.ok) {
    expect(
      candidates.value.memberReasons.find((reason) => reason.target === "m1")?.expectedProfileIds,
    ).toEqual(["codex-xhigh", "claude-opus-high"]);
  }

  const base = designProposal();
  const sameRoleProposal: DesignProposal = {
    ...base,
    team: {
      ...base.team,
      members: [
        { key: "m1", roleId: "developer", instanceLabel: "A" },
        { key: "m2", roleId: "developer", instanceLabel: "B" },
      ],
    },
    reuse: [
      { roleId: "tech-lead", reason: "统筹" },
      { roleId: "developer", reason: "实现" },
    ],
    profileChoices: [
      base.profileChoices[0],
      { target: "m1", profileIds: ["codex-xhigh"], reason: "A" },
      { target: "m2", profileIds: ["claude-opus-high"], reason: "B" },
    ],
  };
  const sameRole = run(sameRoleProposal);
  expect(sameRole.ok).toBe(true);
  if (sameRole.ok) {
    expect(
      sameRole.value.memberReasons.find((reason) => reason.target === "m1")?.expectedProfileIds,
    ).toEqual(["codex-xhigh"]);
    expect(
      sameRole.value.memberReasons.find((reason) => reason.target === "m2")?.expectedProfileIds,
    ).toEqual(["claude-opus-high"]);
  }

  const standby = run(designProposal(), {
    planner: fakePlanner({
      extraSeats: [
        {
          logicalSeatId: "seat-m1",
          roleId: "architect",
          purpose: "judge",
          profileId: "claude-opus-high",
        },
      ],
    }),
  });
  expect(standby.ok, JSON.stringify(standby.issues)).toBe(true);

  const sameRoleStandby = run(designProposal(), {
    planner: fakePlanner({
      extraSeats: [
        {
          logicalSeatId: "seat-m1",
          roleId: "architect",
          purpose: "escalation",
          activation: "escalation-only",
          profileId: "claude-opus-high",
          source: "role-preferred",
        },
      ],
    }),
  });
  expect(sameRoleStandby.ok).toBe(true);
  if (sameRoleStandby.ok) {
    expect(
      sameRoleStandby.value.memberReasons.find((reason) => reason.target === "m1")
        ?.expectedProfileIds,
    ).toEqual(["codex-xhigh"]);
  }

  const emptyChoice = designProposal({
    profileChoices: [
      designProposal().profileChoices[0],
      { target: "m1", profileIds: [], reason: "空" },
      designProposal().profileChoices[2],
    ],
  });
  const missingSeat = run(designProposal(), {
    planner: fakePlanner({ omitSeats: ["m2"] }),
  });
  expect(missingSeat.ok).toBe(false);
  if (!missingSeat.ok) expect(codes(missingSeat.issues)).toContain("DESIGN_PROFILE_CHOICE");

  const normalEmpty = run(emptyChoice, {
    planner: fakePlanner({ profileIds: { m1: null }, purposes: { m1: "member" } }),
  });
  expect(normalEmpty.ok).toBe(false);
  if (!normalEmpty.ok) expect(codes(normalEmpty.issues)).toContain("DESIGN_PROFILE_CHOICE");

  const optionalEmpty = run(emptyChoice, {
    planner: fakePlanner({ profileIds: { m1: null }, purposes: { m1: "escalation" } }),
  });
  expect(optionalEmpty.ok).toBe(true);
  if (optionalEmpty.ok) {
    expect(
      optionalEmpty.value.memberReasons.find((reason) => reason.target === "m1")
        ?.expectedProfileIds,
    ).toEqual([]);
  }

  const missingCoordinator = run(designProposal(), {
    planner: fakePlanner({ omitCoordinator: true }),
  });
  expect(missingCoordinator.ok).toBe(false);
  if (!missingCoordinator.ok) {
    expect(codes(missingCoordinator.issues)).toContain("DESIGN_PROFILE_CHOICE");
  }
});

test("aggregates profileChoices structure before calling the planner and exposes diagnostics", () => {
  let planCalls = 0;
  const countingPlanner: DesignPlanningPort = {
    plan(input) {
      planCalls += 1;
      return fakePlanner().plan(input);
    },
  };
  const badChoices = designProposal({
    profileChoices: [
      designProposal().profileChoices[0],
      designProposal().profileChoices[1],
      designProposal().profileChoices[1],
      { target: "m9", profileIds: ["codex-xhigh"], reason: "extra" },
    ],
  });
  const result = run(badChoices, { planner: countingPlanner });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(codes(result.issues)).toContain("DESIGN_PROFILE_CHOICE");
  expect(planCalls).toBe(0);

  const valid = run();
  expect(valid.ok).toBe(true);
  if (!valid.ok) return;
  const mismatched: DesignProposal = {
    ...valid.value.proposal,
    profileChoices: valid.value.proposal.profileChoices.map((choice) =>
      choice.target === "m1" ? { ...choice, profileIds: ["claude-opus-high"] } : choice,
    ),
  };
  expect(
    describeProfileChoiceMismatches(
      mismatched,
      valid.value.plan,
      valid.value.team,
      valid.value.logicalSeatIds,
    ),
  ).toEqual([
    {
      target: "m1",
      actualProfileIds: ["claude-opus-high"],
      expectedProfileIds: ["codex-xhigh"],
      reason: "mismatch",
    },
  ]);
});

test("returns choice diagnostics from real failure paths and excludes valid optional-empty", () => {
  const wrong = designProposal({
    profileChoices: [
      designProposal().profileChoices[0],
      { target: "m1", profileIds: ["claude-opus-high"], reason: "wrong" },
      designProposal().profileChoices[2],
    ],
  });
  const failed = run(wrong);
  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.choiceMismatches).toEqual([
      {
        target: "m1",
        actualProfileIds: ["claude-opus-high"],
        expectedProfileIds: ["codex-xhigh"],
        reason: "mismatch",
      },
    ]);
    const issue = failed.issues.find((entry) => entry.code === "DESIGN_PROFILE_CHOICE");
    expect(JSON.parse(String(issue?.params.actualProfileIds))).toEqual(["claude-opus-high"]);
    expect(JSON.parse(String(issue?.params.expectedProfileIds))).toEqual(["codex-xhigh"]);
    expect(issue?.params.reason).toBeUndefined();
  }

  const missing = run(designProposal(), {
    planner: fakePlanner({ omitSeats: ["m2"] }),
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.choiceMismatches).toContainEqual({
      target: "m2",
      actualProfileIds: ["claude-opus-high"],
      expectedProfileIds: [],
      reason: "missing-seat",
    });
  }

  const emptyChoice = designProposal({
    profileChoices: [
      designProposal().profileChoices[0],
      { target: "m1", profileIds: [], reason: "空" },
      designProposal().profileChoices[2],
    ],
  });
  const invalid = run(emptyChoice, {
    planner: fakePlanner({ profileIds: { m1: null }, purposes: { m1: "member" } }),
  });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) {
    expect(invalid.choiceMismatches).toContainEqual({
      target: "m1",
      actualProfileIds: [],
      expectedProfileIds: [],
      reason: "missing-profile",
    });
  }

  const optional = run(emptyChoice, {
    planner: fakePlanner({ profileIds: { m1: null }, purposes: { m1: "escalation" } }),
  });
  expect(optional.ok).toBe(true);
  if (optional.ok) {
    expect(
      describeProfileChoiceMismatches(
        optional.value.proposal,
        optional.value.plan,
        optional.value.team,
        optional.value.logicalSeatIds,
      ),
    ).toEqual([]);
  }
});

test("save-time revalidation catches missing new-Role bindings, reuse loss, and incomplete origin", () => {
  const role = validNewRole({ preferredProfiles: [{ profileId: "codex-xhigh" }] });
  const built = withNewRoles([role], { m3: "codex-xhigh" });
  const seats = { m1: "seat-m1", m2: "seat-m2", m3: "seat-m3" };
  const validated = run(built.proposal, {
    planner: built.planner,
    identity: { logicalSeatIds: seats },
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) return;
  const context = makeContext();
  const identity = makeIdentity({ logicalSeatIds: seats });
  const full = materialized(validated, context, identity);

  const futurePreview = {
    ...full.result.preview,
    futureTop: true,
    seats: full.result.preview.seats.map((seat) => ({ ...seat, futureSeat: true })),
  };
  const ledgerResult = StoredDesignResultSchema.parse({
    ...full.result,
    preview: futurePreview,
  });
  const revalidated = validateMaterializedDesign(ledgerResult, context, built.planner);
  expect(revalidated.ok).toBe(true);
  const rpcResult = DesignResultSchema.parse(ledgerResult);
  expect(JSON.stringify(rpcResult)).not.toContain("futureTop");
  expect(JSON.stringify(rpcResult)).not.toContain("futureSeat");

  const withoutProfile = makeContext({
    host: {
      status: "ready",
      profiles: [claudeOpus, opusMax, opusHigh],
      availability: allAvailable,
    },
  });
  const missingBinding = validateMaterializedDesign(
    full.result,
    withoutProfile,
    fakePlanner({ profileIds: { m3: "claude-opus-high" } }),
  );
  expect(missingBinding.ok).toBe(false);
  if (!missingBinding.ok) expect(codes(missingBinding.issues)).toContain("DESIGN_PROFILE_MISSING");

  const noReuse = validateMaterializedDesign({ ...full.result, reuse: [] }, context, fakePlanner());
  expect(noReuse.ok).toBe(false);
  if (!noReuse.ok) expect(codes(noReuse.issues)).toContain("DESIGN_REUSE_INVALID");

  const incompleteOrigin = validateMaterializedDesign(
    {
      ...full.result,
      team: { ...full.result.team, designer: { jobId: DESIGN_JOB_ID } },
    },
    context,
    fakePlanner(),
  );
  expect(incompleteOrigin.ok).toBe(false);
  if (!incompleteOrigin.ok)
    expect(codes(incompleteOrigin.issues)).toContain("DESIGN_INPUT_INVALID");

  const savedRole = full.result.newRoles[0];
  if (!savedRole) throw new Error("expected a saved new Role");
  const ownRowContext = makeContext({ roles: [...context.roles, savedRole] });
  expect(validateMaterializedDesign(full.result, ownRowContext, built.planner)).toMatchObject({
    ok: true,
  });

  const editedOwnRowContext = makeContext({
    roles: [...context.roles, { ...savedRole, systemPrompt: "edited" }],
  });
  const editedOwn = validateMaterializedDesign(full.result, editedOwnRowContext, built.planner);
  expect(editedOwn.ok).toBe(false);
  if (!editedOwn.ok) expect(codes(editedOwn.issues)).toContain("DESIGN_ROLE_ID_CONFLICT");
});

describe("allocateDesignTeamId", () => {
  test("keeps a free base and allocates a warning suffix when occupied", () => {
    expect(allocateDesignTeamId("rework-team", new Set())).toMatchObject({
      ok: true,
      value: "rework-team",
    });
    const allocated = allocateDesignTeamId("rework-team", new Set(["rework-team"]));
    expect(allocated.ok).toBe(true);
    if (allocated.ok) {
      expect(allocated.value).toBe("rework-team-2");
      expect(allocated.issues[0]).toMatchObject({
        code: "DESIGN_TEAM_RENAMED",
        severity: "warning",
      });
    }
  });

  test("keeps the 48-character limit and reports exhaustion", () => {
    const base = "a".repeat(48);
    const allocated = allocateDesignTeamId(base, new Set([base]));
    expect(allocated.ok).toBe(true);
    if (allocated.ok) {
      expect(allocated.value).toHaveLength(48);
      expect(allocated.value.endsWith("-2")).toBe(true);
    }

    const occupied = new Set([
      "team",
      ...Array.from({ length: 999 }, (_, index) => `team-${index + 2}`),
    ]);
    const exhausted = allocateDesignTeamId("team", occupied);
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.issues[0].code).toBe("DESIGN_TEAM_ID_CONFLICT");

    const invalid = allocateDesignTeamId("Bad Team", new Set());
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues[0].code).toBe("DESIGN_TEAM_INVALID");
  });
});

describe("validateMaterializedDesign", () => {
  test("accepts the materialized result and rejects job, source, reference, and planner changes", () => {
    const validated = run();
    const { context, result } = materialized(validated);
    const accepted = validateMaterializedDesign(result, context, fakePlanner());
    expect(accepted.ok).toBe(true);

    const wrongJob = validateMaterializedDesign(
      { ...result, jobId: "99999999-9999-4999-8999-999999999999" },
      context,
      fakePlanner(),
    );
    expect(wrongJob.ok).toBe(false);
    if (!wrongJob.ok) expect(codes(wrongJob.issues)).toContain("DESIGN_INPUT_INVALID");

    const noSource = validateMaterializedDesign(
      { ...result, team: { ...result.team, source: undefined, designer: undefined } },
      context,
      fakePlanner(),
    );
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(codes(noSource.issues)).toContain("DESIGN_INPUT_INVALID");

    const missingRef = validateMaterializedDesign(
      {
        ...result,
        team: {
          ...result.team,
          members: [{ ...result.team.members[0], roleId: "ghost" }],
        },
      },
      context,
      fakePlanner(),
    );
    expect(missingRef.ok).toBe(false);
    if (!missingRef.ok) expect(codes(missingRef.issues)).toContain("DESIGN_REUSE_INVALID");

    const plannerFail = validateMaterializedDesign(
      result,
      context,
      fakePlanner({ ok: false, launchBlockers: ["blocked"] }),
    );
    expect(plannerFail.ok).toBe(false);
    if (!plannerFail.ok) expect(codes(plannerFail.issues)).toContain("DESIGN_LAUNCH_BLOCKED");

    const staleHash = validateMaterializedDesign(
      {
        ...result,
        reuse: [{ ...result.reuse[0], behaviorHash: "d".repeat(64) }, ...result.reuse.slice(1)],
      },
      context,
      fakePlanner(),
    );
    expect(staleHash.ok).toBe(false);
    if (!staleHash.ok) expect(codes(staleHash.issues)).toContain("DESIGN_CONTEXT_CHANGED");

    const wrongReasons = validateMaterializedDesign(
      {
        ...result,
        memberReasons: result.memberReasons.map((reason, index) =>
          index === 0 ? { ...reason, expectedProfileIds: ["wrong"] } : reason,
        ),
      },
      context,
      fakePlanner(),
    );
    expect(wrongReasons.ok).toBe(false);
    if (!wrongReasons.ok) expect(codes(wrongReasons.issues)).toContain("DESIGN_PROFILE_CHOICE");

    const duplicateSeats = validateMaterializedDesign(
      {
        ...result,
        team: {
          ...result.team,
          members: result.team.members.map((member) => ({ ...member, seatId: "same" })),
        },
      },
      context,
      fakePlanner(),
    );
    expect(duplicateSeats.ok).toBe(false);
    if (!duplicateSeats.ok) expect(codes(duplicateSeats.issues)).toContain("DESIGN_TEAM_INVALID");

    const invalidShape = validateMaterializedDesign(
      { ...result, attempt: 9 },
      context,
      fakePlanner(),
    );
    expect(invalidShape.ok).toBe(false);
    if (!invalidShape.ok) expect(codes(invalidShape.issues)).toContain("DESIGN_OUTPUT_SCHEMA");
  });

  test("reports oversized results", () => {
    const validated = run();
    const { context, result } = materialized(validated);
    const oversized = {
      ...result,
      warnings: [
        {
          code: "DESIGN_TEAM_RENAMED" as const,
          severity: "warning" as const,
          path: [],
          params: { blob: "x".repeat(130000) },
          action: "none" as const,
        },
      ],
    };
    const checked = validateMaterializedDesign(oversized, context, fakePlanner());
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(codes(checked.issues)).toContain("DESIGN_OUTPUT_TOO_LARGE");
  });
});
