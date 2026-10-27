import { isSlug } from "../ids";
import type { PaseoProfile } from "../paseo/adapter";
import { taskExcerpt } from "../paseo/labels";
import type {
  DesignChoiceTarget,
  DesignIssue,
  DesignIssueAction,
  DesignMemberKey,
  DesignResult,
  DesignRoleGapProposal,
  DesignTeamProposal,
  MemberReason,
  NewDesignRole,
  ProfileSummary,
  ProposalProfileRef,
  RoleGapReport,
} from "../schemas/design";
import {
  DesignResultSchema,
  DesignRoleGapProposalSchema,
  DesignTimeSchema,
} from "../schemas/design";
import type { Preferences } from "../schemas/preferences";
import type { Role } from "../schemas/role";
import { RoleSchema } from "../schemas/role";
import type { Team, TeamMember } from "../schemas/team";
import { TeamSchema } from "../schemas/team";
import type { TeamMode } from "../schemas/team-mode";
import type { DesignResultCore } from "./design-content";
import { canonicalDesignContent, roleBehaviorContent } from "./design-content";
import { utf8ByteLength } from "./design-output";
import type { DesignPlanCheck, DesignPlanningPort } from "./design-planning";
import { designNewRoleLimit } from "./design-planning";
import type { HostSnapshot } from "./mode-resolver";
import { identifyModelFamily, namesHighCostFamily } from "./model-family";
import type { ModeIssue, ModeIssueCode } from "./role-execution";
import { isRoleTier, isTaskKind } from "./role-execution";

export type DesignPlanSuccess = Extract<DesignPlanCheck, { ok: true }>;

export type DesignValidationContext = {
  request: string;
  mode: TeamMode;
  jobId: string;
  attempt: 1 | 2 | 3;
  nonce: string;
  roles: readonly Role[];
  teams: readonly Team[];
  preferences: Preferences;
  /**
   * T2's host snapshot, not separate arrays: a failed query must surface as
   * `{status:"unavailable"}` and block instead of looking like an empty healthy host.
   */
  host: HostSnapshot;
  daemonConfig: unknown;
  carrierWorkspaceId: string;
  targetWorkspaceId: string | null;
  capabilities: { onDemand: boolean; expansion: boolean; collaboration: boolean };
  /** Injected by the server; only materializeDesign needs it to fill reuse[].behaviorHash. */
  hasher?: (canonicalContent: string) => string;
  /**
   * The same planner's per-purpose verdicts for existing Roles (C02/C03 inject them). A claim of
   * `unlaunchable-role` is judged by the use it names; without a verified verdict it is rejected.
   */
  roleLaunch?: DesignRoleLaunchTables;
};

export type DesignRoleLaunchVerdict = {
  launchable: boolean;
  /** Bindings the planner found unavailable for this use, in its order. */
  unavailableProfileIds: readonly string[];
  /** False when availability could not be verified: such a verdict proves nothing. */
  verified: boolean;
};

/**
 * The same planner's verdicts, keyed by Role and split by use: a Role can be launchable as a
 * member and not as coordinator (or the reverse), so one flat answer would misreport a gap.
 * C02/C03 build these tables from `computeRoleLaunchability`; shared never imports server code.
 */
export type DesignRoleLaunchTables = {
  readonly member: Readonly<Record<string, DesignRoleLaunchVerdict>>;
  readonly coordinator: Readonly<Record<string, DesignRoleLaunchVerdict>>;
};

export type MaterializationIdentity = {
  teamId: string;
  createdAt: string;
  logicalSeatIds: Readonly<Record<string, string>>;
};

export type ValidationResult<T> =
  | { ok: true; value: T; issues: DesignIssue[]; issuesTruncated: number }
  | {
      ok: false;
      issues: DesignIssue[];
      issuesTruncated: number;
      choiceMismatches?: readonly ProfileChoiceDiagnostic[];
    };

/** The read-only output of a successful validateDesign call. */
export type ValidatedDesign = {
  /** v1 or v2 team shape, exactly as decoded for the record's contract. */
  proposal: DesignTeamProposal;
  team: Team;
  newRoles: readonly Role[];
  reusedRoles: readonly Role[];
  logicalSeatIds: Readonly<Record<string, string>>;
  plan: DesignPlanSuccess;
  memberReasons: readonly MemberReason[];
  warnings: readonly DesignIssue[];
};

/**
 * The record's own rule (04 §6.1). Omitted means the legacy contract — 3 new Roles — so a caller
 * that has not been taught about the record keeps the old behaviour instead of silently tightening
 * or loosening it. C03 must pass the record value explicitly.
 */
export type DesignValidationRules = {
  existingRolesOnly?: boolean;
};

/** A validated gap: the model's claim plus the server-resolved names and reasons. */
export type ValidatedRoleGap = {
  proposal: DesignRoleGapProposal;
  gaps: readonly RoleGapReport[];
};

const ROLE_PREFIXES = [
  ["lead-", "【统筹】"],
  ["plan-", "【规划】"],
  ["eng-", "【工程】"],
  ["qa-", "【质量】"],
  ["research-", "【研究】"],
  ["content-", "【内容】"],
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function finalizeDesignIssues(issues: readonly DesignIssue[]): {
  issues: DesignIssue[];
  issuesTruncated: number;
} {
  const unique = new Map<string, DesignIssue>();
  for (const issue of issues) {
    const key = [
      issue.code,
      JSON.stringify(issue.path),
      JSON.stringify(Object.entries(issue.params).sort(([a], [b]) => compareText(a, b))),
    ].join("|");
    if (!unique.has(key)) unique.set(key, issue);
  }
  const sorted = [...unique.values()].sort((left, right) => {
    const pathOrder = compareText(JSON.stringify(left.path), JSON.stringify(right.path));
    return pathOrder !== 0 ? pathOrder : compareText(left.code, right.code);
  });
  return {
    issues: sorted.slice(0, 100),
    issuesTruncated: Math.max(0, sorted.length - 100),
  };
}

function designIssue(
  code: DesignIssue["code"],
  severity: DesignIssue["severity"],
  path: DesignIssue["path"],
  params: DesignIssue["params"] = {},
  action: DesignIssueAction = "repair",
): DesignIssue {
  return { code, severity, path, params, action };
}

function error(
  code: DesignIssue["code"],
  path: DesignIssue["path"] = [],
  params: DesignIssue["params"] = {},
  action: DesignIssueAction = "repair",
): DesignIssue {
  return designIssue(code, "error", path, params, action);
}

function warning(
  code: DesignIssue["code"],
  path: DesignIssue["path"] = [],
  params: DesignIssue["params"] = {},
  action: DesignIssueAction = "none",
): DesignIssue {
  return designIssue(code, "warning", path, params, action);
}

function schemaIssues(
  errors: readonly { path: readonly PropertyKey[]; message: string }[],
  prefix: DesignIssue["path"],
  code: DesignIssue["code"] = "DESIGN_OUTPUT_SCHEMA",
): DesignIssue[] {
  return errors.map((issue) => {
    const path = [
      ...prefix,
      ...issue.path.map((part) => (typeof part === "number" ? part : String(part))),
    ];
    return error(code, path, { path: path.length === 0 ? "(root)" : path.join(".") });
  });
}

function modeAction(code: ModeIssueCode): DesignIssueAction {
  switch (code) {
    case "MODE_CONTEXT_UNAVAILABLE":
    case "MODE_POOL_EMPTY":
    case "MODE_POOL_UNAVAILABLE":
    case "MODE_POOL_ENTRY_MISSING":
    case "MODE_PROFILE_UNRESOLVED":
    case "MODE_FAMILY_MISSING":
    case "MODE_FAMILIES_REDUCED":
    case "MODE_ESCALATION_UNAVAILABLE":
    case "MODE_NO_EXECUTION_COHORT":
      return "refresh";
    case "MODE_UNKNOWN":
    case "MODE_POOL_CONFIG_INVALID":
    case "MODE_POOL_DUPLICATE":
    case "MODE_POOL_ORDER_IGNORED":
      return "inspect";
    default:
      return "repair";
  }
}

function wrappedModeIssue(issue: ModeIssue, index: number): DesignIssue {
  const params: DesignIssue["params"] = {
    ...issue.params,
    modeCode: issue.code,
    modeSeverity: issue.severity,
  };
  if (issue.roleId !== undefined) params.roleId = issue.roleId;
  if (issue.seatId !== undefined) params.seatId = issue.seatId;
  if (issue.profileId !== undefined) params.profileId = issue.profileId;
  return designIssue(
    "DESIGN_MODE_PLAN_INVALID",
    issue.severity === "blocker" ? "error" : "warning",
    ["plan", "issues", index],
    params,
    modeAction(issue.code),
  );
}

function normalizeRoleName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function expectedRolePrefix(roleId: string): string | undefined {
  return ROLE_PREFIXES.find(([prefix]) => roleId.startsWith(prefix))?.[1];
}

function memberCreationFor(mode: TeamMode, onDemand: boolean): string {
  if (mode === "sota" || !onDemand) return "eager";
  return "on-demand";
}

function materializedProfileRef(profile: PaseoProfile): {
  profileId: string;
  nameSnapshot: string;
  hint: {
    name: string;
    provider: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  };
} {
  return {
    profileId: profile.id,
    nameSnapshot: profile.name,
    hint: {
      name: profile.name,
      provider: profile.provider,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
      ...(profile.modeId !== undefined ? { modeId: profile.modeId } : {}),
      ...(profile.thinkingOptionId !== undefined
        ? { thinkingOptionId: profile.thinkingOptionId }
        : {}),
    },
  };
}

function buildNewRole(
  role: NewDesignRole,
  profiles: ReadonlyMap<string, PaseoProfile>,
  context: DesignValidationContext,
  identity: MaterializationIdentity,
): Role {
  const refs = (list: readonly ProposalProfileRef[]) =>
    list.map((ref) => {
      const profile = profiles.get(ref.profileId);
      if (!profile) throw new Error(`unvalidated Profile ${ref.profileId}`);
      return materializedProfileRef(profile);
    });
  return RoleSchema.parse({
    id: role.id,
    name: role.name,
    ...(role.description !== undefined ? { description: role.description } : {}),
    mission: role.mission,
    responsibilities: role.responsibilities,
    restrictions: role.restrictions,
    systemPrompt: role.systemPrompt,
    outputContract: role.outputContract,
    preferredProfiles: refs(role.preferredProfiles),
    fallbackProfiles: refs(role.fallbackProfiles),
    ...(role.color !== undefined ? { color: role.color } : {}),
    ...(role.icon !== undefined ? { icon: role.icon } : {}),
    executionPolicy: role.executionPolicy,
    enabled: true,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
    source: "team-designer",
    designer: {
      jobId: context.jobId,
      createdAt: identity.createdAt,
      requestExcerpt: taskExcerpt(context.request),
    },
  });
}

function buildTeam(
  proposal: DesignTeamProposal,
  context: DesignValidationContext,
  identity: MaterializationIdentity,
): Team {
  const members: TeamMember[] = proposal.team.members.map((member) => ({
    roleId: member.roleId,
    ...(member.instanceLabel !== undefined ? { instanceLabel: member.instanceLabel } : {}),
    seatId: identity.logicalSeatIds[member.key],
    enabled: true,
  }));
  return TeamSchema.parse({
    id: identity.teamId,
    name: proposal.team.name,
    ...(proposal.team.description !== undefined ? { description: proposal.team.description } : {}),
    mode: context.mode,
    memberCreation: memberCreationFor(context.mode, context.capabilities.onDemand),
    ...(proposal.team.collaboration !== undefined
      ? { collaboration: proposal.team.collaboration }
      : {}),
    coordinatorRoleId: proposal.team.coordinatorRoleId,
    members,
    ...(proposal.team.operatingRules !== undefined
      ? { operatingRules: proposal.team.operatingRules }
      : {}),
    enabled: true,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
    source: "team-designer",
    designer: {
      jobId: context.jobId,
      createdAt: identity.createdAt,
      requestExcerpt: taskExcerpt(context.request),
    },
  });
}

type PreviewSeatView = {
  seatId?: string;
  logicalSeatId?: string;
  roleId?: string;
  profileId?: string;
  profileNull: boolean;
  purpose?: string;
  activation?: string;
  source?: string;
};

/** Read both the G1 stand-in (profileId) and T4's SeatPreview (profile object). */
function asPreviewSeat(value: unknown): PreviewSeatView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const seat: PreviewSeatView = { profileNull: false };
  if ("seatId" in value && typeof value.seatId === "string") seat.seatId = value.seatId;
  if ("logicalSeatId" in value && typeof value.logicalSeatId === "string") {
    seat.logicalSeatId = value.logicalSeatId;
  }
  if ("roleId" in value && typeof value.roleId === "string") seat.roleId = value.roleId;
  if ("purpose" in value && typeof value.purpose === "string") seat.purpose = value.purpose;
  if ("activation" in value && typeof value.activation === "string") {
    seat.activation = value.activation;
  }
  if ("source" in value && typeof value.source === "string") seat.source = value.source;
  if ("profileId" in value && typeof value.profileId === "string") {
    seat.profileId = value.profileId;
  }
  if ("profile" in value) {
    const profile = value.profile;
    if (profile === null) seat.profileNull = true;
    else if (typeof profile === "object" && "id" in profile && typeof profile.id === "string") {
      seat.profileId = profile.id;
    }
  }
  return seat;
}

function coordinatorSeat(plan: DesignPlanSuccess, team: Team): PreviewSeatView | undefined {
  if ("coordinator" in plan.preview) {
    const seat = asPreviewSeat(plan.preview.coordinator);
    if (seat) return seat;
  }
  const memberSeatIds = new Set(
    team.members
      .map((member) => member.seatId)
      .filter((seatId): seatId is string => typeof seatId === "string"),
  );
  return plan.preview.seats
    .map(asPreviewSeat)
    .filter((seat): seat is PreviewSeatView => seat !== undefined)
    .find(
      (seat) =>
        seat.purpose === "coordinator" ||
        (seat.roleId === team.coordinatorRoleId &&
          (seat.logicalSeatId === undefined || !memberSeatIds.has(seat.logicalSeatId))),
    );
}

const COORDINATOR_LOGICAL_SEAT_ID = "coordinator";

/** T4 has no coordinator logical-seat field; the launch contract uses this synthetic id. */
function coordinatorLogicalSeatId(plan: DesignPlanSuccess): string {
  const seat = "coordinator" in plan.preview ? asPreviewSeat(plan.preview.coordinator) : undefined;
  return seat?.logicalSeatId ?? COORDINATOR_LOGICAL_SEAT_ID;
}

function targetRoleId(team: Team, target: DesignChoiceTarget): string | undefined {
  if (target === "coordinator") return team.coordinatorRoleId;
  const index = Number(target.slice(1)) - 1;
  return team.members[index]?.roleId;
}

type ExpectedProfileIds =
  | { kind: "profiles"; profileIds: string[] }
  | { kind: "missing"; reason: "missing-seat" | "missing-coordinator" }
  | { kind: "invalid"; reason: "missing-profile" }
  | { kind: "optional-empty" };

/**
 * T4 seam: ordered Profile IDs for one logical target. The model's mN key is not a logical seat
 * id: members first map through identity.logicalSeatIds to the real logicalSeatId, then match
 * member/candidate seats for that logical seat. Coordinator comes from T4's independent field.
 * Automatic judge/standby seats are excluded; only an explicitly unavailable escalation seat may
 * produce an empty choice.
 */
function expectedProfileIdsForTarget(
  plan: DesignPlanSuccess,
  target: DesignChoiceTarget,
  team: Team,
  logicalSeatIds: Readonly<Record<string, string>>,
): ExpectedProfileIds {
  if (target === "coordinator") {
    const seat = coordinatorSeat(plan, team);
    if (!seat) return { kind: "missing", reason: "missing-coordinator" };
    return seat.profileId
      ? { kind: "profiles", profileIds: [seat.profileId] }
      : { kind: "invalid", reason: "missing-profile" };
  }

  const logicalSeatId = logicalSeatIds[target];
  if (!logicalSeatId) return { kind: "missing", reason: "missing-seat" };
  const roleId = targetRoleId(team, target);
  const candidates = plan.preview.seats
    .map(asPreviewSeat)
    .filter((seat): seat is PreviewSeatView => seat !== undefined)
    .filter((seat) => {
      const sameLogicalSeat =
        seat.logicalSeatId !== undefined
          ? seat.logicalSeatId === logicalSeatId
          : seat.seatId === logicalSeatId;
      return sameLogicalSeat;
    });
  // A same-Role standby escalation channel may share the member's logical seat. Use it only
  // when there is no primary member/candidate seat to choose from.
  const primary = candidates.filter(
    (seat) => seat.activation !== "escalation-only" && seat.purpose !== "judge",
  );
  const matching =
    primary.length > 0
      ? primary
      : candidates.filter(
          (seat) =>
            (seat.purpose === "judge" || seat.purpose === "escalation") && seat.roleId === roleId,
        );
  if (matching.length === 0) return { kind: "missing", reason: "missing-seat" };
  if (
    matching.every((seat) => seat.purpose === "escalation") &&
    matching.every((seat) => seat.profileId === undefined) &&
    matching.every((seat) => seat.source === "unavailable" || seat.activation === "escalation-only")
  ) {
    return { kind: "optional-empty" };
  }
  if (matching.some((seat) => seat.profileId === undefined)) {
    return { kind: "invalid", reason: "missing-profile" };
  }
  return {
    kind: "profiles",
    profileIds: matching.map((seat) => seat.profileId as string),
  };
}

export type ProfileChoiceMismatchReason =
  | "mismatch"
  | "missing-seat"
  | "missing-coordinator"
  | "missing-profile";

export type ProfileChoiceDiagnostic = {
  target: DesignChoiceTarget;
  actualProfileIds: string[];
  expectedProfileIds: string[];
  reason: ProfileChoiceMismatchReason;
};

/**
 * Pure correction data for G3: actual vs authoritative planner IDs for each logical target.
 * G6 can pass this to the correction prompt; it does not need to copy preview matching logic.
 */
export function describeProfileChoiceMismatches(
  proposal: DesignTeamProposal,
  plan: DesignPlanSuccess,
  team: Team,
  logicalSeatIds: Readonly<Record<string, string>>,
): ProfileChoiceDiagnostic[] {
  const targets: DesignChoiceTarget[] = [
    "coordinator",
    ...team.members.map((_member, index) => `m${index + 1}` as DesignMemberKey),
  ];
  const choices = new Map(proposal.profileChoices.map((choice) => [choice.target, choice]));
  const mismatches: ProfileChoiceDiagnostic[] = [];
  for (const target of targets) {
    const expected = expectedProfileIdsForTarget(plan, target, team, logicalSeatIds);
    const expectedProfileIds = expected.kind === "profiles" ? expected.profileIds : [];
    const actualProfileIds = choices.get(target)?.profileIds ?? [];
    if (expected.kind === "optional-empty") {
      if (actualProfileIds.length > 0) {
        mismatches.push({
          target,
          actualProfileIds,
          expectedProfileIds: [],
          reason: "mismatch",
        });
      }
      continue;
    }
    if (expected.kind === "missing" || expected.kind === "invalid") {
      mismatches.push({
        target,
        actualProfileIds,
        expectedProfileIds: [],
        reason: expected.reason,
      });
      continue;
    }
    const same =
      actualProfileIds.length === expectedProfileIds.length &&
      actualProfileIds.every((profileId, index) => profileId === expectedProfileIds[index]);
    if (!same) {
      mismatches.push({ target, actualProfileIds, expectedProfileIds, reason: "mismatch" });
    }
  }
  return mismatches;
}

function sameContent(left: unknown, right: unknown): boolean {
  return canonicalDesignContent(left) === canonicalDesignContent(right);
}

function completeOrigin(value: unknown, jobId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const source = "source" in value ? value.source : undefined;
  if (source !== "team-designer") return false;
  const designer = "designer" in value ? value.designer : undefined;
  if (!designer || typeof designer !== "object") return false;
  const id = "jobId" in designer ? designer.jobId : undefined;
  const createdAt = "createdAt" in designer ? designer.createdAt : undefined;
  const requestExcerpt = "requestExcerpt" in designer ? designer.requestExcerpt : undefined;
  return (
    typeof id === "string" &&
    id === jobId &&
    typeof createdAt === "string" &&
    createdAt.trim() !== "" &&
    typeof requestExcerpt === "string"
  );
}

export type DesignContentCheckInput = {
  team: Team;
  newRoles: readonly Role[];
  reuse: readonly { roleId: string; reason: string; behaviorHash?: string }[];
  memberReasons?: readonly MemberReason[];
  roles: readonly Role[];
  profiles: readonly PaseoProfile[];
  jobId: string;
  mode: TeamMode;
  logicalSeatIds: Readonly<Record<string, string>>;
  hasher?: (canonicalContent: string) => string;
  allowExistingOwnRows?: boolean;
  /**
   * The record's rule. Omitted keeps the legacy 3 so an unaware caller cannot tighten a record;
   * C03 passes the record value on every revalidation, and the limit is derived only here.
   */
  existingRolesOnly?: boolean;
};

/**
 * Content invariants shared by the initial validation and the save-time revalidation. The latter
 * passes allowExistingOwnRows so a partially written, byte-identical row from this job is not
 * mistaken for an id collision. Callers must supply a ready host; the planner remains responsible
 * for mode selection and launch readiness.
 */
export function checkDesignContent(input: DesignContentCheckInput): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const roleById = new Map(input.roles.map((role) => [role.id, role]));
  const newRoleLimit = designNewRoleLimit(input);
  const profileIds = new Set(input.profiles.map((profile) => profile.id));
  const newRoleIds = new Set(input.newRoles.map((role) => role.id));
  const usedRoleIds = new Set<string>([
    input.team.coordinatorRoleId,
    ...input.team.members.map((member) => member.roleId),
  ]);
  const ownSavedRoleIds = new Set<string>();
  if (input.allowExistingOwnRows) {
    for (const candidate of input.newRoles) {
      const existing = roleById.get(candidate.id);
      if (existing && completeOrigin(existing, input.jobId) && sameContent(existing, candidate)) {
        ownSavedRoleIds.add(candidate.id);
      }
    }
  }

  if (input.newRoles.length > newRoleLimit) {
    issues.push(
      error("DESIGN_NEW_ROLE_LIMIT", ["newRoles"], {
        count: input.newRoles.length,
        limit: newRoleLimit,
      }),
    );
  }
  const names = new Map<string, string>();
  for (const role of input.roles) {
    if (!ownSavedRoleIds.has(role.id)) names.set(normalizeRoleName(role.name), role.id);
  }
  const seenNewRoleIds = new Set<string>();
  input.newRoles.forEach((role, index) => {
    if (seenNewRoleIds.has(role.id)) {
      issues.push(error("DESIGN_ROLE_ID_CONFLICT", ["newRoles", index, "id"], { roleId: role.id }));
    }
    seenNewRoleIds.add(role.id);
    if (roleById.has(role.id) && !ownSavedRoleIds.has(role.id)) {
      issues.push(error("DESIGN_ROLE_ID_CONFLICT", ["newRoles", index, "id"], { roleId: role.id }));
    }
    const prefix = expectedRolePrefix(role.id);
    if (!prefix || !role.name.trim().startsWith(prefix)) {
      issues.push(
        error("DESIGN_ROLE_NAMING", ["newRoles", index, "name"], {
          roleId: role.id,
          prefix: prefix ?? "",
        }),
      );
    }
    const normalizedName = normalizeRoleName(role.name);
    if (names.has(normalizedName)) {
      issues.push(
        error("DESIGN_ROLE_NAME_CONFLICT", ["newRoles", index, "name"], { name: role.name }),
      );
    }
    names.set(normalizedName, role.id);
    if (!role.enabled) {
      issues.push(
        error("DESIGN_INPUT_INVALID", ["newRoles", index, "enabled"], { roleId: role.id }),
      );
    }
    if (!completeOrigin(role, input.jobId)) {
      issues.push(
        error("DESIGN_INPUT_INVALID", ["newRoles", index, "source"], { roleId: role.id }),
      );
    }
    if (
      typeof role.executionPolicy?.tier !== "string" ||
      !isRoleTier(role.executionPolicy.tier) ||
      typeof role.executionPolicy.taskKind !== "string" ||
      !isTaskKind(role.executionPolicy.taskKind)
    ) {
      issues.push(
        error("DESIGN_MODE_PLAN_INVALID", ["newRoles", index, "executionPolicy"], {
          modeCode: "MODE_ROLE_POLICY_UNKNOWN",
          roleId: role.id,
        }),
      );
    }
    if (role.preferredProfiles.length === 0 || role.preferredProfiles.length > 5) {
      issues.push(
        error("DESIGN_INPUT_INVALID", ["newRoles", index, "preferredProfiles"], {
          reason: role.preferredProfiles.length === 0 ? "empty" : "too-many",
        }),
      );
    }
    if (role.fallbackProfiles.length > 5) {
      issues.push(
        error("DESIGN_INPUT_INVALID", ["newRoles", index, "fallbackProfiles"], {
          reason: "too-many",
        }),
      );
    }
    const seenProfiles = new Set<string>();
    const lists = [
      ["preferredProfiles", role.preferredProfiles],
      ["fallbackProfiles", role.fallbackProfiles],
    ] as const;
    for (const [list, refs] of lists) {
      refs.forEach((ref, refIndex) => {
        if (seenProfiles.has(ref.profileId)) {
          issues.push(
            error("DESIGN_PROFILE_DUPLICATE", ["newRoles", index, list, refIndex, "profileId"], {
              profileId: ref.profileId,
            }),
          );
        }
        seenProfiles.add(ref.profileId);
        if (!profileIds.has(ref.profileId)) {
          issues.push(
            error("DESIGN_PROFILE_MISSING", ["newRoles", index, list, refIndex, "profileId"], {
              profileId: ref.profileId,
            }),
          );
        }
      });
    }
    if (!usedRoleIds.has(role.id)) {
      issues.push(error("DESIGN_ROLE_UNUSED", ["newRoles", index, "id"], { roleId: role.id }));
    }
  });

  const expectedReuse = new Set([...usedRoleIds].filter((roleId) => !newRoleIds.has(roleId)));
  const reuseIds = new Set<string>();
  let hasherMissing = false;
  input.reuse.forEach((entry, index) => {
    if (reuseIds.has(entry.roleId)) {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "roleId"], { roleId: entry.roleId }),
      );
    }
    reuseIds.add(entry.roleId);
    if (newRoleIds.has(entry.roleId)) {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "roleId"], { roleId: entry.roleId }),
      );
    }
    if (entry.reason.trim() === "") {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "reason"], { roleId: entry.roleId }),
      );
    }
    const role = roleById.get(entry.roleId);
    if (!role?.enabled) {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "roleId"], { roleId: entry.roleId }),
      );
    }
    if (entry.behaviorHash !== undefined) {
      if (!input.hasher) {
        hasherMissing = true;
      } else if (
        role &&
        input.hasher(canonicalDesignContent(roleBehaviorContent(role))) !== entry.behaviorHash
      ) {
        issues.push(
          error(
            "DESIGN_CONTEXT_CHANGED",
            ["reuse", index, "behaviorHash"],
            { roleId: entry.roleId },
            "refresh",
          ),
        );
      }
    }
  });
  if (hasherMissing) {
    issues.push(
      error("DESIGN_CONFIG_UNAVAILABLE", ["reuse"], { reason: "hasher-missing" }, "refresh"),
    );
  }
  for (const roleId of expectedReuse) {
    if (!reuseIds.has(roleId)) {
      issues.push(error("DESIGN_REUSE_INVALID", ["reuse"], { roleId }));
    }
  }
  for (const roleId of reuseIds) {
    if (!expectedReuse.has(roleId)) {
      issues.push(error("DESIGN_REUSE_INVALID", ["reuse"], { roleId }));
    }
  }

  if (!isSlug(input.team.id)) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "id"], { teamId: input.team.id }));
  }
  if (input.team.mode !== input.mode) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "mode"], { mode: String(input.team.mode) }));
  }
  if (!completeOrigin(input.team, input.jobId)) {
    issues.push(error("DESIGN_INPUT_INVALID", ["team", "source"], {}));
  }
  if (input.team.members.length === 0 || input.team.members.length > 64) {
    issues.push(
      error(
        input.team.members.length === 0 ? "DESIGN_TEAM_INVALID" : "DESIGN_MEMBER_LIMIT",
        ["team", "members"],
        input.team.members.length === 0
          ? { reason: "empty" }
          : { count: input.team.members.length, limit: 64 },
      ),
    );
  }
  if (input.team.members.some((member) => member.roleId === input.team.coordinatorRoleId)) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "members"], { reason: "coordinator-member" }),
    );
  }
  const coordinator = roleById.get(input.team.coordinatorRoleId);
  if (!coordinator && !newRoleIds.has(input.team.coordinatorRoleId)) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "coordinatorRoleId"], {
        roleId: input.team.coordinatorRoleId,
      }),
    );
  } else if (coordinator && !coordinator.enabled) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "coordinatorRoleId"], {
        roleId: input.team.coordinatorRoleId,
      }),
    );
  }
  const expectedSeatIds: string[] = [];
  input.team.members.forEach((member, index) => {
    const role = roleById.get(member.roleId);
    if (!role && !newRoleIds.has(member.roleId)) {
      issues.push(
        error("DESIGN_TEAM_INVALID", ["team", "members", index, "roleId"], {
          roleId: member.roleId,
        }),
      );
    } else if (role && !role.enabled) {
      issues.push(
        error("DESIGN_TEAM_INVALID", ["team", "members", index, "roleId"], {
          roleId: member.roleId,
        }),
      );
    }
    const key = `m${index + 1}`;
    const expectedSeatId = input.logicalSeatIds[key];
    if (
      typeof member.seatId !== "string" ||
      !member.seatId.trim() ||
      member.seatId !== expectedSeatId
    ) {
      issues.push(
        error("DESIGN_TEAM_INVALID", ["team", "members", index, "seatId"], {
          key,
        }),
      );
    }
    if (typeof member.seatId === "string" && member.seatId.trim()) {
      expectedSeatIds.push(member.seatId);
    }
    if (!member.enabled) {
      issues.push(
        error("DESIGN_TEAM_INVALID", ["team", "members", index, "enabled"], {
          roleId: member.roleId,
        }),
      );
    }
  });
  if (new Set(expectedSeatIds).size !== expectedSeatIds.length) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "members"], { reason: "duplicate-seat" }));
  }
  for (const key of Object.keys(input.logicalSeatIds)) {
    if (!/^m[1-9][0-9]?$/.test(key) || Number(key.slice(1)) > input.team.members.length) {
      issues.push(error("DESIGN_TEAM_INVALID", ["identity", "logicalSeatIds", key], { key }));
    } else if (input.logicalSeatIds[key] === COORDINATOR_LOGICAL_SEAT_ID) {
      issues.push(
        error("DESIGN_TEAM_INVALID", ["identity", "logicalSeatIds", key], {
          key,
          reason: "reserved-seat",
        }),
      );
    }
  }
  const membersByRole = new Map<string, number[]>();
  input.team.members.forEach((member, index) => {
    const list = membersByRole.get(member.roleId) ?? [];
    list.push(index);
    membersByRole.set(member.roleId, list);
  });
  for (const [roleId, group] of membersByRole) {
    if (group.length < 2) continue;
    const labels = new Set<string>();
    for (const index of group) {
      const label = input.team.members[index]?.instanceLabel?.trim() ?? "";
      if (!label) {
        issues.push(
          error("DESIGN_TEAM_INVALID", ["team", "members", index, "instanceLabel"], { roleId }),
        );
      }
      const normalized = label.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
      if (labels.has(normalized)) {
        issues.push(
          error("DESIGN_TEAM_INVALID", ["team", "members", index, "instanceLabel"], {
            roleId,
            label,
          }),
        );
      }
      labels.add(normalized);
    }
  }
  if (input.team.collaboration && input.mode !== "collaborative") {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "collaboration"], { reason: "mode-not-collaborative" }),
    );
  }
  if (input.team.collaboration) {
    const memberRoleIds = new Set(input.team.members.map((member) => member.roleId));
    for (const field of ["judgeRoleId", "escalationRoleId"] as const) {
      const value = input.team.collaboration[field];
      if (value === undefined) continue;
      if (
        typeof value !== "string" ||
        !memberRoleIds.has(value) ||
        value === input.team.coordinatorRoleId
      ) {
        issues.push(
          error("DESIGN_TEAM_INVALID", ["team", "collaboration", field], {
            roleId: String(value),
          }),
        );
      }
    }
  }

  if (input.memberReasons) {
    const targets: DesignChoiceTarget[] = [
      "coordinator",
      ...input.team.members.map((_member, index) => `m${index + 1}` as DesignMemberKey),
    ];
    const reasons = new Map<string, MemberReason>();
    input.memberReasons.forEach((reason) => {
      if (!targets.includes(reason.target) || reasons.has(reason.target)) {
        issues.push(error("DESIGN_PROFILE_CHOICE", ["memberReasons"], { target: reason.target }));
        return;
      }
      reasons.set(reason.target, reason);
    });
    for (const target of targets) {
      const reason = reasons.get(target);
      if (!reason) {
        issues.push(error("DESIGN_PROFILE_CHOICE", ["memberReasons"], { target }));
        continue;
      }
      const expectedLogicalSeatId =
        target === "coordinator" ? COORDINATOR_LOGICAL_SEAT_ID : input.logicalSeatIds[target];
      if (!expectedLogicalSeatId || reason.logicalSeatId !== expectedLogicalSeatId) {
        issues.push(error("DESIGN_PROFILE_CHOICE", ["memberReasons"], { target }));
      }
    }
  }

  return finalizeDesignIssues(issues).issues;
}

function planningInput(team: Team, roles: readonly Role[], context: DesignValidationContext) {
  return {
    jobId: context.jobId,
    team,
    roles,
    host: context.host,
    preferences: context.preferences,
    daemonConfig: context.daemonConfig,
    mode: context.mode,
    workspaceId: context.targetWorkspaceId ?? context.carrierWorkspaceId,
    request: context.request,
  };
}

export function allocateDesignTeamId(
  base: string,
  occupied: ReadonlySet<string>,
): ValidationResult<string> {
  if (!isSlug(base)) {
    return {
      ok: false,
      issues: [error("DESIGN_TEAM_INVALID", ["team", "id"], { teamId: base })],
      issuesTruncated: 0,
    };
  }
  if (!occupied.has(base)) {
    return { ok: true, value: base, issues: [], issuesTruncated: 0 };
  }
  for (let suffix = 2; suffix <= 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, 48 - tail.length).replace(/-+$/u, "")}${tail}`;
    if (isSlug(candidate) && !occupied.has(candidate)) {
      return {
        ok: true,
        value: candidate,
        issues: [warning("DESIGN_TEAM_RENAMED", ["team", "id"], { teamId: candidate })],
        issuesTruncated: 0,
      };
    }
  }
  return {
    ok: false,
    issues: [error("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: base }, "inspect")],
    issuesTruncated: 0,
  };
}

export function validateDesign(
  proposal: DesignTeamProposal,
  context: DesignValidationContext,
  planner: DesignPlanningPort,
  identity: MaterializationIdentity,
  rules?: DesignValidationRules,
): ValidationResult<ValidatedDesign> {
  // A v2 output carries the existing-roles-only contract; without the record's rule the limit
  // would silently fall back to 3 and let a save-time revalidation pass what the initial one
  // rejected. An empty rules object counts as missing. Legacy v1 output keeps the old rule.
  if (proposal.version === 2 && rules?.existingRolesOnly === undefined) {
    return {
      ok: false,
      issues: [
        error("DESIGN_INPUT_INVALID", ["existingRolesOnly"], { reason: "record-rule-required" }),
      ],
      issuesTruncated: 0,
    };
  }
  if (context.host.status === "unavailable") {
    return {
      ok: false,
      issues: [
        error(
          "DESIGN_CONFIG_UNAVAILABLE",
          [],
          { reason: context.host.reason ?? "unavailable" },
          "refresh",
        ),
      ],
      issuesTruncated: 0,
    };
  }

  const liveProfiles = context.host.profiles;
  const profiles = new Map(liveProfiles.map((profile) => [profile.id, profile]));
  const rolesById = new Map(context.roles.map((role) => [role.id, role]));
  const teamIds = new Set(context.teams.map((team) => team.id));
  const issues: DesignIssue[] = [];
  const warnings: DesignIssue[] = [];
  const newRoleIds = new Set<string>();
  const usedRoleIds = new Set<string>([
    proposal.team.coordinatorRoleId,
    ...proposal.team.members.map((member) => member.roleId),
  ]);

  // Step 2: new Role set. The limit comes from the record rule, never from a literal here.
  const newRoleLimit = designNewRoleLimit(rules);
  if (proposal.newRoles.length > newRoleLimit) {
    issues.push(
      error("DESIGN_NEW_ROLE_LIMIT", ["newRoles"], {
        count: proposal.newRoles.length,
        limit: newRoleLimit,
      }),
    );
  }
  const existingNames = new Set(context.roles.map((role) => normalizeRoleName(role.name)));
  const newNames = new Set<string>();
  proposal.newRoles.forEach((role, index) => {
    if (newRoleIds.has(role.id)) {
      issues.push(error("DESIGN_ROLE_ID_CONFLICT", ["newRoles", index, "id"], { roleId: role.id }));
    }
    newRoleIds.add(role.id);
    if (rolesById.has(role.id)) {
      issues.push(error("DESIGN_ROLE_ID_CONFLICT", ["newRoles", index, "id"], { roleId: role.id }));
    }
    if (!usedRoleIds.has(role.id)) {
      issues.push(error("DESIGN_ROLE_UNUSED", ["newRoles", index, "id"], { roleId: role.id }));
    }
    const prefix = expectedRolePrefix(role.id);
    if (!prefix || !role.name.trim().startsWith(prefix)) {
      issues.push(
        error("DESIGN_ROLE_NAMING", ["newRoles", index, "name"], {
          roleId: role.id,
          prefix: prefix ?? "",
        }),
      );
    }
    const normalizedName = normalizeRoleName(role.name);
    if (existingNames.has(normalizedName) || newNames.has(normalizedName)) {
      issues.push(
        error("DESIGN_ROLE_NAME_CONFLICT", ["newRoles", index, "name"], { name: role.name }),
      );
    }
    newNames.add(normalizedName);
    if (
      typeof role.executionPolicy?.tier !== "string" ||
      !isRoleTier(role.executionPolicy.tier) ||
      typeof role.executionPolicy.taskKind !== "string" ||
      !isTaskKind(role.executionPolicy.taskKind)
    ) {
      issues.push(
        error("DESIGN_MODE_PLAN_INVALID", ["newRoles", index, "executionPolicy"], {
          modeCode: "MODE_ROLE_POLICY_UNKNOWN",
          roleId: role.id,
        }),
      );
    }
  });

  // Step 3: reuse set exactness.
  const expectedReuse = new Set([...usedRoleIds].filter((roleId) => !newRoleIds.has(roleId)));
  const reuseIds = new Set<string>();
  proposal.reuse.forEach((entry, index) => {
    if (reuseIds.has(entry.roleId)) {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "roleId"], { roleId: entry.roleId }),
      );
    }
    reuseIds.add(entry.roleId);
    if (entry.reason.trim() === "") {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "reason"], { roleId: entry.roleId }),
      );
    }
    const role = rolesById.get(entry.roleId);
    if (!role?.enabled) {
      issues.push(
        error("DESIGN_REUSE_INVALID", ["reuse", index, "roleId"], { roleId: entry.roleId }),
      );
    }
  });
  for (const roleId of expectedReuse) {
    if (!reuseIds.has(roleId)) {
      issues.push(error("DESIGN_REUSE_INVALID", ["reuse"], { roleId }));
    }
  }
  for (const roleId of reuseIds) {
    if (!expectedReuse.has(roleId)) {
      issues.push(error("DESIGN_REUSE_INVALID", ["reuse"], { roleId }));
    }
  }

  // Step 4: Profile references for new Roles only. Existing Role placeholders stay as-is.
  proposal.newRoles.forEach((role, index) => {
    if (role.preferredProfiles.length === 0) {
      issues.push(
        error("DESIGN_INPUT_INVALID", ["newRoles", index, "preferredProfiles"], {
          reason: "empty",
        }),
      );
    }
    if (role.preferredProfiles.length > 5 || role.fallbackProfiles.length > 5) {
      issues.push(
        error("DESIGN_INPUT_INVALID", ["newRoles", index, "preferredProfiles"], {
          reason: "too-many",
        }),
      );
    }
    const seen = new Set<string>();
    const lists = [
      ["preferredProfiles", role.preferredProfiles],
      ["fallbackProfiles", role.fallbackProfiles],
    ] as const;
    for (const [list, refs] of lists) {
      refs.forEach((ref, refIndex) => {
        if (seen.has(ref.profileId)) {
          issues.push(
            error("DESIGN_PROFILE_DUPLICATE", ["newRoles", index, list, refIndex, "profileId"], {
              profileId: ref.profileId,
            }),
          );
        }
        seen.add(ref.profileId);
        if (!profiles.has(ref.profileId)) {
          issues.push(
            error("DESIGN_PROFILE_MISSING", ["newRoles", index, list, refIndex, "profileId"], {
              profileId: ref.profileId,
            }),
          );
        }
      });
    }
  });

  // Step 5: Team structure.
  if (proposal.team.mode !== context.mode) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "mode"], { mode: proposal.team.mode }));
  }
  if (proposal.team.members.length === 0) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "members"], { reason: "empty" }));
  }
  if (proposal.team.members.length > 64) {
    issues.push(
      error("DESIGN_MEMBER_LIMIT", ["team", "members"], {
        count: proposal.team.members.length,
        limit: 64,
      }),
    );
  }
  if (proposal.team.members.some((member) => member.roleId === proposal.team.coordinatorRoleId)) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "members"], { reason: "coordinator-member" }),
    );
  }
  proposal.team.members.forEach((member, index) => {
    if (member.key !== `m${index + 1}`) {
      issues.push(
        error("DESIGN_TEAM_INVALID", ["team", "members", index, "key"], { key: member.key }),
      );
    }
  });
  const membersByRole = new Map<string, number[]>();
  proposal.team.members.forEach((member, index) => {
    const list = membersByRole.get(member.roleId) ?? [];
    list.push(index);
    membersByRole.set(member.roleId, list);
  });
  for (const [roleId, group] of membersByRole) {
    if (group.length < 2) continue;
    const labels = new Set<string>();
    for (const index of group) {
      const label = proposal.team.members[index]?.instanceLabel?.trim() ?? "";
      if (!label) {
        issues.push(
          error("DESIGN_TEAM_INVALID", ["team", "members", index, "instanceLabel"], {
            roleId,
          }),
        );
      }
      const normalized = label.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
      if (labels.has(normalized)) {
        issues.push(
          error("DESIGN_TEAM_INVALID", ["team", "members", index, "instanceLabel"], {
            roleId,
            label,
          }),
        );
      }
      labels.add(normalized);
    }
  }
  if (proposal.team.collaboration && context.mode !== "collaborative") {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "collaboration"], { reason: "mode-not-collaborative" }),
    );
  }
  if (context.mode === "collaborative" && !context.capabilities.collaboration) {
    issues.push(error("DESIGN_MODE_UNAVAILABLE", ["mode"], { mode: context.mode }));
  }
  if (proposal.team.collaboration) {
    const memberRoleIds = new Set(proposal.team.members.map((member) => member.roleId));
    for (const field of ["judgeRoleId", "escalationRoleId"] as const) {
      const roleId = proposal.team.collaboration[field];
      if (roleId === undefined) continue;
      if (
        typeof roleId !== "string" ||
        !memberRoleIds.has(roleId) ||
        roleId === proposal.team.coordinatorRoleId
      ) {
        issues.push(
          error("DESIGN_TEAM_INVALID", ["team", "collaboration", field], {
            roleId: String(roleId),
          }),
        );
      }
    }
  }
  const coordinatorIsNew = newRoleIds.has(proposal.team.coordinatorRoleId);
  const coordinator = rolesById.get(proposal.team.coordinatorRoleId);
  if (!coordinator && !coordinatorIsNew) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "coordinatorRoleId"], {
        roleId: proposal.team.coordinatorRoleId,
      }),
    );
  } else if (coordinator && !coordinator.enabled) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["team", "coordinatorRoleId"], {
        roleId: proposal.team.coordinatorRoleId,
      }),
    );
  }

  // Step 6: fixed materialization identity.
  if (!isSlug(identity.teamId)) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "id"], { teamId: identity.teamId }));
  } else if (teamIds.has(identity.teamId)) {
    issues.push(
      error("DESIGN_TEAM_ID_CONFLICT", ["team", "id"], { teamId: identity.teamId }, "inspect"),
    );
  }
  if (identity.teamId !== proposal.team.id) {
    warnings.push(warning("DESIGN_TEAM_RENAMED", ["team", "id"], { teamId: identity.teamId }));
  }
  if (!DesignTimeSchema.safeParse(identity.createdAt).success) {
    issues.push(error("DESIGN_INPUT_INVALID", ["identity", "createdAt"], {}));
  }
  const memberKeys = proposal.team.members.map((member) => member.key);
  for (const key of memberKeys) {
    const seatId = identity.logicalSeatIds[key];
    if (typeof seatId !== "string" || !seatId.trim()) {
      issues.push(error("DESIGN_TEAM_INVALID", ["identity", "logicalSeatIds", key], { key }));
    }
  }
  for (const key of Object.keys(identity.logicalSeatIds)) {
    if (!memberKeys.includes(key)) {
      issues.push(error("DESIGN_TEAM_INVALID", ["identity", "logicalSeatIds", key], { key }));
    }
  }
  const seatIds = memberKeys
    .map((key) => identity.logicalSeatIds[key])
    .filter((seatId): seatId is string => typeof seatId === "string" && seatId.trim() !== "");
  if (new Set(seatIds).size !== seatIds.length) {
    issues.push(
      error("DESIGN_TEAM_INVALID", ["identity", "logicalSeatIds"], { reason: "duplicate" }),
    );
  }
  // Choice structure is independent of the planner; collect it before spending a plan call.
  const targets: DesignChoiceTarget[] = [
    "coordinator",
    ...proposal.team.members.map((member) => member.key as DesignMemberKey),
  ];
  const choices = new Map<string, { index: number; profileIds: string[]; reason: string }>();
  proposal.profileChoices.forEach((choice, index) => {
    if (!targets.includes(choice.target)) {
      issues.push(
        error("DESIGN_PROFILE_CHOICE", ["profileChoices", index, "target"], {
          target: choice.target,
        }),
      );
      return;
    }
    if (choices.has(choice.target)) {
      issues.push(
        error("DESIGN_PROFILE_CHOICE", ["profileChoices", index, "target"], {
          target: choice.target,
        }),
      );
      return;
    }
    choices.set(choice.target, {
      index,
      profileIds: choice.profileIds,
      reason: choice.reason,
    });
  });
  for (const target of targets) {
    if (!choices.has(target)) {
      issues.push(error("DESIGN_PROFILE_CHOICE", ["profileChoices"], { target }));
    }
  }
  if (issues.some((issue) => issue.severity === "error")) {
    const finalized = finalizeDesignIssues([...issues, ...warnings]);
    return { ok: false, ...finalized };
  }

  let newRoles: Role[];
  let team: Team;
  try {
    newRoles = proposal.newRoles.map((role) => buildNewRole(role, profiles, context, identity));
    team = buildTeam(proposal, context, identity);
  } catch {
    const finalized = finalizeDesignIssues([
      ...issues,
      ...warnings,
      error("DESIGN_INPUT_INVALID", [], {}, "inspect"),
    ]);
    return { ok: false, ...finalized };
  }

  const contentIssues = checkDesignContent({
    team,
    newRoles,
    reuse: proposal.reuse,
    roles: context.roles,
    profiles: liveProfiles,
    jobId: context.jobId,
    mode: context.mode,
    logicalSeatIds: identity.logicalSeatIds,
    existingRolesOnly: rules?.existingRolesOnly,
  });
  if (contentIssues.some((entry) => entry.severity === "error")) {
    const finalized = finalizeDesignIssues([...issues, ...warnings, ...contentIssues]);
    return { ok: false, ...finalized };
  }

  // Step 7/8: one planner call; all blockers stop the design.
  let plan: DesignPlanCheck;
  try {
    plan = planner.plan(planningInput(team, [...context.roles, ...newRoles], context));
  } catch {
    const finalized = finalizeDesignIssues([
      ...issues,
      ...warnings,
      error("DESIGN_CONFIG_UNAVAILABLE", ["plan"], { reason: "planner-failed" }, "refresh"),
    ]);
    return { ok: false, ...finalized };
  }
  if (!plan.ok) {
    const planIssues = [
      ...plan.issues.map(wrappedModeIssue),
      ...plan.launchBlockers.map((reason, index) =>
        error("DESIGN_LAUNCH_BLOCKED", ["plan", "blockers", index], { reason }, "inspect"),
      ),
    ];
    const finalized = finalizeDesignIssues([...issues, ...warnings, ...planIssues]);
    return { ok: false, ...finalized };
  }
  const planWarnings = [
    ...plan.issues.map(wrappedModeIssue),
    ...plan.launchWarnings.map((reason, index) =>
      warning("DESIGN_LAUNCH_BLOCKED", ["plan", "warnings", index], { reason }, "inspect"),
    ),
  ];
  const unexpectedBlockers = planWarnings.filter((entry) => entry.severity === "error");
  if (unexpectedBlockers.length > 0) {
    const finalized = finalizeDesignIssues([...issues, ...warnings, ...planWarnings]);
    return { ok: false, ...finalized };
  }

  // Step 9: one choice per logical target, ordered IDs exactly as the planner reports.
  const memberReasons: MemberReason[] = [];
  for (const target of targets) {
    const choice = choices.get(target);
    if (!choice) continue;
    const expected = expectedProfileIdsForTarget(plan, target, team, identity.logicalSeatIds);
    const expectedProfileIds = expected.kind === "profiles" ? expected.profileIds : [];
    const matches =
      expected.kind === "profiles"
        ? choice.profileIds.length === expectedProfileIds.length &&
          choice.profileIds.every((profileId, index) => profileId === expectedProfileIds[index])
        : expected.kind === "optional-empty" && choice.profileIds.length === 0;
    if (!matches) {
      const params: DesignIssue["params"] = {
        target,
        actualProfileIds: JSON.stringify(choice.profileIds),
        expectedProfileIds: JSON.stringify(expectedProfileIds),
      };
      if (expected.kind === "missing" || expected.kind === "invalid") {
        params.reason = expected.reason;
      } else if (expected.kind === "optional-empty") {
        params.reason = "optional-empty";
      }
      issues.push(
        error("DESIGN_PROFILE_CHOICE", ["profileChoices", choice.index, "profileIds"], params),
      );
    }
    const logicalSeatId =
      target === "coordinator" ? coordinatorLogicalSeatId(plan) : identity.logicalSeatIds[target];
    if (!logicalSeatId) {
      issues.push(error("DESIGN_TEAM_INVALID", ["identity", "logicalSeatIds"], { target }));
      continue;
    }
    memberReasons.push({
      target,
      logicalSeatId,
      reason: choice.reason,
      expectedProfileIds,
    });
  }
  if (issues.some((issue) => issue.severity === "error")) {
    const finalized = finalizeDesignIssues([...issues, ...warnings, ...planWarnings]);
    return {
      ok: false,
      ...finalized,
      choiceMismatches: describeProfileChoiceMismatches(
        proposal,
        plan,
        team,
        identity.logicalSeatIds,
      ),
    };
  }

  const reusedRoles = proposal.reuse
    .map((entry) => rolesById.get(entry.roleId))
    .filter((role): role is Role => role !== undefined);
  const finalizedWarnings = finalizeDesignIssues([...warnings, ...planWarnings]);
  return {
    ok: true,
    value: {
      proposal,
      team,
      newRoles,
      reusedRoles,
      logicalSeatIds: { ...identity.logicalSeatIds },
      plan,
      memberReasons,
      warnings: finalizedWarnings.issues,
    },
    issues: finalizedWarnings.issues,
    issuesTruncated: finalizedWarnings.issuesTruncated,
  };
}

export function materializeDesign(
  validated: ValidatedDesign,
  context: DesignValidationContext,
  identity: MaterializationIdentity,
): DesignResultCore {
  const hasher = context.hasher;
  if (!hasher) throw new Error("materializeDesign requires DesignValidationContext.hasher");
  const reusedById = new Map(validated.reusedRoles.map((role) => [role.id, role]));
  const reuse = validated.proposal.reuse.map((entry) => {
    const role = reusedById.get(entry.roleId);
    if (!role) throw new Error(`materialized design lost reused Role ${entry.roleId}`);
    return {
      roleId: entry.roleId,
      behaviorHash: hasher(canonicalDesignContent(roleBehaviorContent(role))),
      reason: entry.reason,
    };
  });
  return {
    version: 1,
    jobId: context.jobId,
    attempt: context.attempt,
    materializedAt: identity.createdAt,
    request: context.request,
    mode: context.mode,
    summary: validated.proposal.summary,
    carrierWorkspaceId: context.carrierWorkspaceId,
    targetWorkspaceId: context.targetWorkspaceId,
    team: validated.team,
    newRoles: [...validated.newRoles],
    reuse,
    memberReasons: [...validated.memberReasons],
    preview: validated.plan.preview,
    warnings: [...validated.warnings],
  };
}

export function validateMaterializedDesign(
  result: DesignResult,
  context: DesignValidationContext,
  planner: DesignPlanningPort,
  rules: DesignValidationRules = {},
): ValidationResult<DesignPlanSuccess> {
  const parsed = DesignResultSchema.safeParse(result);
  if (!parsed.success) {
    const finalized = finalizeDesignIssues(schemaIssues(parsed.error.issues, []));
    return { ok: false, ...finalized };
  }
  const value = parsed.data;
  if (context.host.status === "unavailable") {
    return {
      ok: false,
      issues: [
        error(
          "DESIGN_CONFIG_UNAVAILABLE",
          [],
          { reason: context.host.reason ?? "unavailable" },
          "refresh",
        ),
      ],
      issuesTruncated: 0,
    };
  }
  const issues: DesignIssue[] = [];
  const warnings: DesignIssue[] = [...value.warnings];
  const logicalSeatIds = Object.fromEntries(
    value.team.members.map((member, index) => [`m${index + 1}`, member.seatId ?? ""]),
  );
  const contentIssues = checkDesignContent({
    team: value.team,
    newRoles: value.newRoles,
    reuse: value.reuse,
    memberReasons: value.memberReasons,
    roles: context.roles,
    profiles: context.host.profiles,
    jobId: context.jobId,
    mode: context.mode,
    logicalSeatIds,
    hasher: context.hasher,
    allowExistingOwnRows: true,
    existingRolesOnly: rules?.existingRolesOnly,
  });
  issues.push(...contentIssues);
  if (value.jobId !== context.jobId) {
    issues.push(error("DESIGN_INPUT_INVALID", ["jobId"], {}, "inspect"));
  }
  if (value.attempt !== context.attempt) {
    issues.push(error("DESIGN_INPUT_INVALID", ["attempt"], {}, "inspect"));
  }
  if (value.mode !== context.mode) {
    issues.push(error("DESIGN_INPUT_INVALID", ["mode"], {}, "inspect"));
  }
  if (value.team.mode !== context.mode) {
    issues.push(error("DESIGN_TEAM_INVALID", ["team", "mode"], { mode: String(value.team.mode) }));
  }
  if (value.request !== context.request.trim()) {
    issues.push(error("DESIGN_INPUT_INVALID", ["request"], {}, "inspect"));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    const finalized = finalizeDesignIssues([...issues, ...warnings]);
    return { ok: false, ...finalized };
  }

  let plan: DesignPlanCheck;
  try {
    plan = planner.plan(planningInput(value.team, [...context.roles, ...value.newRoles], context));
  } catch {
    const finalized = finalizeDesignIssues([
      ...issues,
      ...warnings,
      error("DESIGN_CONFIG_UNAVAILABLE", ["plan"], { reason: "planner-failed" }, "refresh"),
    ]);
    return { ok: false, ...finalized };
  }
  if (!plan.ok) {
    const planIssues = [
      ...plan.issues.map(wrappedModeIssue),
      ...plan.launchBlockers.map((reason, index) =>
        error("DESIGN_LAUNCH_BLOCKED", ["plan", "blockers", index], { reason }, "inspect"),
      ),
    ];
    const finalized = finalizeDesignIssues([...issues, ...warnings, ...planIssues]);
    return { ok: false, ...finalized };
  }
  const size = utf8ByteLength(canonicalDesignContent(value));
  if (size > 128 * 1024) {
    const finalized = finalizeDesignIssues([
      ...issues,
      ...warnings,
      error("DESIGN_OUTPUT_TOO_LARGE", ["result"], { bytes: size, limit: 128 * 1024 }),
    ]);
    return { ok: false, ...finalized };
  }
  const targets: DesignChoiceTarget[] = [
    "coordinator",
    ...value.team.members.map((_member, index) => `m${index + 1}` as DesignMemberKey),
  ];
  const reasons = new Map(value.memberReasons.map((reason) => [reason.target, reason]));
  for (const target of targets) {
    const reason = reasons.get(target);
    if (!reason) {
      issues.push(error("DESIGN_PROFILE_CHOICE", ["memberReasons"], { target }));
      continue;
    }
    const expected = expectedProfileIdsForTarget(plan, target, value.team, logicalSeatIds);
    const expectedProfileIds = expected.kind === "profiles" ? expected.profileIds : [];
    const matches =
      expected.kind === "profiles"
        ? reason.expectedProfileIds.length === expectedProfileIds.length &&
          reason.expectedProfileIds.every(
            (profileId, index) => profileId === expectedProfileIds[index],
          )
        : expected.kind === "optional-empty" && reason.expectedProfileIds.length === 0;
    if (!matches) {
      const params: DesignIssue["params"] = {
        target,
        actualProfileIds: JSON.stringify(reason.expectedProfileIds),
        expectedProfileIds: JSON.stringify(expectedProfileIds),
      };
      if (expected.kind === "missing" || expected.kind === "invalid") {
        params.reason = expected.reason;
      } else if (expected.kind === "optional-empty") {
        params.reason = "optional-empty";
      }
      issues.push(error("DESIGN_PROFILE_CHOICE", ["memberReasons"], params));
    }
  }
  if (issues.some((entry) => entry.severity === "error")) {
    const finalized = finalizeDesignIssues([...issues, ...warnings]);
    return { ok: false, ...finalized };
  }
  const finalizedWarnings = finalizeDesignIssues([
    ...warnings,
    ...plan.issues.map(wrappedModeIssue),
    ...plan.launchWarnings.map((reason, index) =>
      warning("DESIGN_LAUNCH_BLOCKED", ["plan", "warnings", index], { reason }, "inspect"),
    ),
  ]);
  if (finalizedWarnings.issues.some((entry) => entry.severity === "error")) {
    return { ok: false, ...finalizedWarnings };
  }
  return {
    ok: true,
    value: plan,
    issues: finalizedWarnings.issues,
    issuesTruncated: finalizedWarnings.issuesTruncated,
  };
}

export type { DesignResultCore } from "./design-content";

export type RoleGapValidationRules = {
  /** The record's rule. A gap is only legal while the job is existing-roles-only. */
  existingRolesOnly: boolean;
};

/** The live Profile as the gap card shows it; names come from the host, never from the model. */
function gapProfileSummary(profile: PaseoProfile): ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.modeId === undefined ? {} : { modeId: profile.modeId }),
    ...(profile.thinkingOptionId === undefined
      ? {}
      : { thinkingOptionId: profile.thinkingOptionId }),
  };
}

/**
 * Validates a `kind:"role-gap"` output and resolves everything the UI must not trust the model
 * for: Profile names, the existing Role's name, and the planner's per-use verdict. A gap never
 * carries a Team, and the branch is only legal for an existing-roles-only record.
 *
 * `unlaunchable-role` requires the injected `context.roleLaunch`: without a verdict, or when the
 * planner says the Role is launchable in that use, the gap is rejected rather than accepted on
 * the model's word.
 */
export function validateRoleGap(
  proposal: DesignRoleGapProposal,
  context: DesignValidationContext,
  rules: RoleGapValidationRules,
): ValidationResult<ValidatedRoleGap> {
  if (context.host.status === "unavailable") {
    return {
      ok: false,
      issues: [
        error(
          "DESIGN_CONFIG_UNAVAILABLE",
          [],
          { reason: context.host.reason ?? "unavailable" },
          "refresh",
        ),
      ],
      issuesTruncated: 0,
    };
  }
  if (!rules.existingRolesOnly) {
    return {
      ok: false,
      issues: [
        error("DESIGN_OUTPUT_SCHEMA", ["kind"], {
          path: "kind",
          reason: "role-gap-not-requested",
        }),
      ],
      issuesTruncated: 0,
    };
  }
  const parsed = DesignRoleGapProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return { ok: false, ...finalizeDesignIssues(schemaIssues(parsed.error.issues, [])) };
  }

  const profiles = new Map(context.host.profiles.map((profile) => [profile.id, profile]));
  const roleById = new Map(context.roles.map((role) => [role.id, role]));
  const existingNames = new Set(context.roles.map((role) => normalizeRoleName(role.name)));
  const suggestedIds = new Set<string>();
  const suggestedNames = new Set<string>();
  const issues: DesignIssue[] = [];
  const reports: RoleGapReport[] = [];

  parsed.data.gaps.forEach((gap, index) => {
    const path = ["gaps", index];
    const report: RoleGapReport = {
      responsibility: gap.responsibility,
      reason: gap.reason,
      use: gap.use,
      profiles: [],
    };

    if (gap.profiles.kind === "existing") {
      gap.profiles.profileIds.forEach((profileId, profileIndex) => {
        const profile = profiles.get(profileId);
        const at = [...path, "profiles", "profileIds", profileIndex];
        if (!profile) {
          issues.push(error("DESIGN_PROFILE_MISSING", at, { profileId }));
          return;
        }
        // A suggested Profile must be a low-cost one this build can verify. Full economy-all
        // eligibility and route membership stay with C02 (D02 exports); this is the cheap floor.
        const family = identifyModelFamily({ model: profile.model });
        const familyReason = namesHighCostFamily(family)
          ? "high-cost-family"
          : family.status === "identified" && family.cost === "low"
            ? null
            : "family-unverified";
        if (familyReason) {
          issues.push(
            error("DESIGN_OUTPUT_SCHEMA", at, {
              path: at.join("."),
              reason: familyReason,
              profileId,
            }),
          );
          return;
        }
        report.profiles.push(gapProfileSummary(profile));
      });
    } else {
      report.profileGapReason = gap.profiles.reason;
    }

    if (gap.kind === "missing-role") {
      const suggested = gap.suggestedRole;
      if (roleById.has(suggested.id) || suggestedIds.has(suggested.id)) {
        issues.push(
          error("DESIGN_ROLE_ID_CONFLICT", [...path, "suggestedRole", "id"], {
            roleId: suggested.id,
          }),
        );
      }
      suggestedIds.add(suggested.id);
      const normalizedName = normalizeRoleName(suggested.name);
      if (existingNames.has(normalizedName) || suggestedNames.has(normalizedName)) {
        issues.push(
          error("DESIGN_ROLE_NAME_CONFLICT", [...path, "suggestedRole", "name"], {
            name: suggested.name,
          }),
        );
      }
      suggestedNames.add(normalizedName);
      const prefix = expectedRolePrefix(suggested.id);
      if (!prefix || !suggested.name.trim().startsWith(prefix)) {
        issues.push(
          error("DESIGN_ROLE_NAMING", [...path, "suggestedRole", "name"], {
            roleId: suggested.id,
            prefix: prefix ?? "",
          }),
        );
      }
      report.suggestedRole = {
        id: suggested.id,
        name: suggested.name,
        responsibilities: [...suggested.responsibilities],
        executionPolicy: { ...suggested.executionPolicy },
      };
    } else {
      const role = roleById.get(gap.roleId);
      // Look the claim up in the table for the use it names: member and coordinator differ.
      const verdict = role ? context.roleLaunch?.[gap.use]?.[gap.roleId] : undefined;
      if (!role) {
        issues.push(
          error("DESIGN_OUTPUT_SCHEMA", [...path, "roleId"], {
            path: [...path, "roleId"].join("."),
            reason: "unknown-role",
            roleId: gap.roleId,
          }),
        );
      } else if (!verdict?.verified) {
        // No verdict, or an availability query that failed: this proves nothing about the Role.
        // Reporting it as a gap would turn a config failure into a responsibility claim.
        issues.push(
          error("DESIGN_OUTPUT_SCHEMA", [...path, "roleId"], {
            path: [...path, "roleId"].join("."),
            reason: "role-launch-unverified",
            roleId: gap.roleId,
          }),
        );
      } else if (verdict.launchable) {
        issues.push(
          error("DESIGN_OUTPUT_SCHEMA", [...path, "roleId"], {
            path: [...path, "roleId"].join("."),
            reason: "role-launchable",
            roleId: gap.roleId,
          }),
        );
      } else {
        const unavailable = [...verdict.unavailableProfileIds].slice(0, 5);
        report.unlaunchableRole = {
          roleId: gap.roleId,
          roleName: role.name,
          unavailableProfileIds: unavailable,
          profileNames: unavailable.map((id) => profiles.get(id)?.name ?? id),
        };
      }
    }

    reports.push(report);
  });

  if (issues.some((issue) => issue.severity === "error")) {
    return { ok: false, ...finalizeDesignIssues(issues) };
  }
  return {
    ok: true,
    value: { proposal: parsed.data, gaps: reports },
    issues: [],
    issuesTruncated: 0,
  };
}

/**
 * The terminal issue for a design that ended with a role-gap: it reuses DESIGN_REUSE_INVALID so a
 * legacy client renders a readable failure, carries `reason: "roles-gap"`, and falls back to an
 * empty roleId when the first gap has no existing Role (a missing-role suggestion).
 */
export function roleGapFinalIssue(gaps: readonly RoleGapReport[]): DesignIssue {
  const roleId = gaps[0]?.unlaunchableRole?.roleId ?? "";
  return error("DESIGN_REUSE_INVALID", [], { reason: "roles-gap", roleId }, "choose-profile");
}
