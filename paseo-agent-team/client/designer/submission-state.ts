import { routeOf } from "../../shared/domain/cheap-routing";
import { formatDesignIssue } from "../../shared/domain/design-output";
import { checkDesignRequest } from "../../shared/domain/design-request";
import type {
  DesignIssue,
  DesignJob,
  DesignResult,
  DesignStartInput,
  DesignStartOutput,
  RoleGapReport,
} from "../../shared/schemas/design";
import type {
  ModeLaunchPreview as LaunchPreviewDto,
  SeatPreview,
  SeatProfileDto,
} from "../../shared/schemas/launch-preview";
import { ModeLaunchPreviewSchema } from "../../shared/schemas/launch-preview";
import type { AllSeatsRoute, TeamMode } from "../../shared/schemas/team-mode";
import { designZh } from "../../shared/zh/design";
import { designGapZh } from "../../shared/zh/design-gap";
import { formatLaunchBudget } from "../shared/budget-format";

/** Copy limits shared with the Card; the server validates the same schema. */
export const DESIGN_JOB_MAX_ATTEMPTS = 3;
export const DESIGN_JOBS_ACTIVE_REFRESH_MS = 2_000;
export const DESIGN_JOBS_BACKSTOP_REFRESH_MS = 15_000;

const RUNNING_STATES: Record<DesignJob["state"], boolean> = {
  starting: true,
  designing: true,
  validating: true,
  fixing: true,
  ready: false,
  saving: true,
  saved: false,
  needs_continue: false,
  save_conflict: false,
  canceling: true,
  canceled: false,
  failed: false,
};

/**
 * Draft as the user sees it. `profileChoice` is deliberately three-valued: `null` follows the
 * preference, `""` explicitly asks the host to choose, and an id is an explicit Profile.
 */
export type DesignDraft = {
  request: string;
  mode: TeamMode;
  workspaceId: string;
  profileChoice: string | null;
  /**
   * "只用现有 Role". Every new draft starts true and the choice is never remembered (H2=A); a job
   * that is already running reads its own rule from the record, never from this form.
   */
  existingRolesOnly: boolean;
};

export type DesignDraftState = {
  draft: DesignDraft;
  /** Bumped by every edit; an accepted reply may only clear the version it captured. */
  draftVersion: number;
  /**
   * Bumped only when code replaces the visible text (prefill/clear). It feeds ImeTextInput, so
   * ordinary typing must never remount the native input and cancel CJK composition.
   */
  inputRevision: number;
};

export type DesignSubmissionOutcome = "accepted" | "rejected" | "unknown" | "void";
export type DesignSubmissionPhase = "idle" | DesignSubmissionOutcome;

export type DesignSubmissionState = {
  draftState: DesignDraftState;
  phase: DesignSubmissionPhase;
  submitting: boolean;
  pending: {
    clientRequestId: string;
    seq: number;
    draftVersion: number;
    fingerprint: string;
  } | null;
  /** Only an unknown transport outcome keeps an id for the next identical payload. */
  retry: { clientRequestId: string; fingerprint: string } | null;
  lastOutcome: DesignSubmissionOutcome | null;
  lastIssues: readonly DesignIssue[];
  submissionCount: number;
};

export type DesignStartBlockReason = "in-flight" | "empty" | "too-long";

export type DesignStartPlan =
  | {
      kind: "send";
      state: DesignSubmissionState;
      command: {
        clientRequestId: string;
        seq: number;
        input: DesignStartInput;
      };
    }
  | { kind: "blocked"; reason: DesignStartBlockReason; state: DesignSubmissionState };

export type DesignSubmitResult =
  | { kind: "blocked"; reason: DesignStartBlockReason }
  | { kind: "accepted"; job: DesignJob; clearedDraft: boolean }
  | { kind: "rejected"; issues: readonly DesignIssue[] }
  | { kind: "unknown" };

export type DesignSubmissionSettlement = {
  clientRequestId: string;
  seq: number;
  outcome: DesignSubmissionOutcome;
  issues?: readonly DesignIssue[];
};

/** Same fallback shape as the version flow; crypto is available in the app and Electron. */
export function createDesignClientRequestId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    return (character === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function normalizeDraft(draft: Partial<DesignDraft>): DesignDraft {
  return {
    request: draft.request ?? "",
    mode: draft.mode ?? "sota",
    workspaceId: draft.workspaceId ?? "",
    profileChoice: draft.profileChoice ?? null,
    existingRolesOnly: draft.existingRolesOnly ?? true,
  };
}

function sameDraft(left: DesignDraft, right: DesignDraft): boolean {
  return (
    left.request === right.request &&
    left.mode === right.mode &&
    left.workspaceId === right.workspaceId &&
    left.profileChoice === right.profileChoice &&
    left.existingRolesOnly === right.existingRolesOnly
  );
}

export function createDesignSubmissionState(
  draft: Partial<DesignDraft> = {},
): DesignSubmissionState {
  return {
    draftState: { draft: normalizeDraft(draft), draftVersion: 0, inputRevision: 0 },
    phase: "idle",
    submitting: false,
    pending: null,
    retry: null,
    lastOutcome: null,
    lastIssues: [],
    submissionCount: 0,
  };
}

/** Ordinary typing: updates draft identity but never the native input revision. */
export function editDesignDraft(
  state: DesignSubmissionState,
  patch: Partial<DesignDraft>,
): DesignSubmissionState {
  const draft = normalizeDraft({ ...state.draftState.draft, ...patch });
  if (sameDraft(draft, state.draftState.draft)) return state;
  return {
    ...state,
    draftState: {
      draft,
      draftVersion: state.draftState.draftVersion + 1,
      inputRevision: state.draftState.inputRevision,
    },
  };
}

/**
 * Programmatic replacement (the `/team-design` prefill). It bumps both counters even when the
 * text is identical, so the same command text with a new nonce visibly re-seeds the input.
 */
export function replaceDesignDraft(
  state: DesignSubmissionState,
  draft: Partial<DesignDraft>,
): DesignSubmissionState {
  return {
    ...state,
    draftState: {
      draft: normalizeDraft(draft),
      draftVersion: state.draftState.draftVersion + 1,
      inputRevision: state.draftState.inputRevision + 1,
    },
  };
}

export function clearDesignRequest(state: DesignSubmissionState): DesignSubmissionState {
  // An accepted request ends the draft: the next one starts with the switch on again.
  if (state.draftState.draft.request === "" && state.draftState.draft.existingRolesOnly) {
    return state;
  }
  return {
    ...state,
    draftState: {
      draft: { ...state.draftState.draft, request: "", existingRolesOnly: true },
      draftVersion: state.draftState.draftVersion + 1,
      inputRevision: state.draftState.inputRevision + 1,
    },
  };
}

/**
 * Applies a one-shot `/team-design` prefill. The command only carries what it knows: an omitted
 * mode follows the draft, a null workspace clears the target, and the designer Profile choice
 * stays unless the command explicitly replaces it.
 */
export function applyDesignPrefill(
  state: DesignSubmissionState,
  prefill: {
    request: string;
    workspaceId: string | null;
    mode?: TeamMode;
    profileChoice?: string | null;
    /** Only the close-the-switch retry sets this (false); every other prefill starts a new draft. */
    existingRolesOnly?: boolean;
  },
): DesignSubmissionState {
  return replaceDesignDraft(state, {
    request: prefill.request,
    workspaceId: prefill.workspaceId ?? "",
    mode: prefill.mode ?? state.draftState.draft.mode,
    profileChoice:
      prefill.profileChoice === undefined
        ? state.draftState.draft.profileChoice
        : prefill.profileChoice,
    existingRolesOnly: prefill.existingRolesOnly ?? true,
  });
}

/**
 * The client request id is the submission nonce. The fingerprint excludes it so an unknown
 * transport outcome can replay the exact same logical payload under the same id.
 */
export function fingerprintDesignStartInput(input: {
  request: string;
  mode?: TeamMode;
  workspaceId?: string;
  profileId?: string;
  useDefaultProfileHints?: boolean;
  existingRolesOnly?: boolean;
}): string {
  return JSON.stringify({
    request: input.request.trim(),
    mode: input.mode ?? "sota",
    workspaceId: input.workspaceId ?? "",
    profileId: input.profileId ?? "",
    useDefaultProfileHints: input.useDefaultProfileHints === true,
    // An omitted rule means the new default (on), so an old call and an explicit true are one.
    existingRolesOnly: input.existingRolesOnly !== false,
  });
}

export function buildDesignStartInput(
  draft: DesignDraft,
  clientRequestId: string,
):
  | { ok: true; input: DesignStartInput }
  | { ok: false; reason: Exclude<DesignStartBlockReason, "in-flight"> } {
  const check = checkDesignRequest(draft.request);
  if (!check.ok) return { ok: false, reason: check.reason };
  const profile =
    draft.profileChoice === null
      ? {}
      : draft.profileChoice === ""
        ? { useDefaultProfileHints: true }
        : { profileId: draft.profileChoice };
  return {
    ok: true,
    input: {
      clientRequestId,
      request: check.request,
      mode: draft.mode,
      ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
      ...profile,
      // Always an explicit boolean: the server keeps "omitted" for old callers only.
      existingRolesOnly: draft.existingRolesOnly,
    },
  };
}

/**
 * Synchronous admission. Once this returns `send`, a second call in the same render cycle is
 * blocked by `submitting`, so a double click cannot allocate a second job.
 */
export function planDesignSubmission(
  state: DesignSubmissionState,
  nextId: () => string,
): DesignStartPlan {
  if (state.submitting || state.pending !== null) {
    return { kind: "blocked", reason: "in-flight", state };
  }
  const skeleton = buildDesignStartInput(state.draftState.draft, "");
  if (!skeleton.ok) return { kind: "blocked", reason: skeleton.reason, state };
  const fingerprint = fingerprintDesignStartInput(skeleton.input);
  const clientRequestId =
    state.retry?.fingerprint === fingerprint ? state.retry.clientRequestId : nextId();
  const input: DesignStartInput = { ...skeleton.input, clientRequestId };

  const seq = state.submissionCount + 1;
  return {
    kind: "send",
    state: {
      ...state,
      phase: "idle",
      submitting: true,
      pending: {
        clientRequestId,
        seq,
        draftVersion: state.draftState.draftVersion,
        fingerprint,
      },
      retry: null,
      lastIssues: [],
      submissionCount: seq,
    },
    command: { clientRequestId, seq, input },
  };
}

/**
 * Only `accepted` may clear text, and only when the captured draft version is still current. A
 * rejection or an unknown/void reply leaves the draft untouched; a late reply is ignored.
 */
export function settleDesignSubmission(
  state: DesignSubmissionState,
  settlement: DesignSubmissionSettlement,
): { state: DesignSubmissionState; cleared: boolean; ignored: boolean } {
  const pending = state.pending;
  if (
    pending === null ||
    pending.clientRequestId !== settlement.clientRequestId ||
    pending.seq !== settlement.seq
  ) {
    return { state, cleared: false, ignored: true };
  }

  const settled: DesignSubmissionState = {
    ...state,
    phase: settlement.outcome === "void" ? "unknown" : settlement.outcome,
    submitting: false,
    pending: null,
    retry:
      settlement.outcome === "unknown" || settlement.outcome === "void"
        ? { clientRequestId: pending.clientRequestId, fingerprint: pending.fingerprint }
        : null,
    lastOutcome: settlement.outcome,
    lastIssues: settlement.outcome === "rejected" ? (settlement.issues ?? []) : [],
  };

  if (settlement.outcome !== "accepted") return { state: settled, cleared: false, ignored: false };
  if (state.draftState.draftVersion !== pending.draftVersion) {
    return { state: settled, cleared: false, ignored: false };
  }
  return { state: clearDesignRequest(settled), cleared: true, ignored: false };
}

export type DesignSubmissionController = {
  getState(): DesignSubmissionState;
  edit(patch: Partial<DesignDraft>): void;
  prefill(draft: Partial<DesignDraft>): void;
  submit(): Promise<DesignSubmitResult>;
};

/** Small controller used by hooks and tests; `start` is the injected RPC-shaped call. */
export function createDesignSubmissionController(options: {
  start: (input: DesignStartInput) => Promise<DesignStartOutput>;
  nextId?: () => string;
  initialDraft?: Partial<DesignDraft>;
}): DesignSubmissionController {
  let state = createDesignSubmissionState(options.initialDraft);
  let inFlight: Promise<DesignSubmitResult> | null = null;

  function edit(patch: Partial<DesignDraft>): void {
    state = editDesignDraft(state, patch);
  }

  function prefill(draft: Partial<DesignDraft>): void {
    state = replaceDesignDraft(state, draft);
  }

  async function run(): Promise<DesignSubmitResult> {
    const planned = planDesignSubmission(state, options.nextId ?? createDesignClientRequestId);
    if (planned.kind === "blocked") return { kind: "blocked", reason: planned.reason };
    state = planned.state;
    try {
      const output = await options.start(planned.command.input);
      if (output.ok) {
        const settled = settleDesignSubmission(state, {
          clientRequestId: planned.command.clientRequestId,
          seq: planned.command.seq,
          outcome: "accepted",
        });
        state = settled.state;
        return { kind: "accepted", job: output.job, clearedDraft: settled.cleared };
      }
      const issues = output.issues;
      const settled = settleDesignSubmission(state, {
        clientRequestId: planned.command.clientRequestId,
        seq: planned.command.seq,
        outcome: "rejected",
        issues,
      });
      state = settled.state;
      return { kind: "rejected", issues };
    } catch {
      state = settleDesignSubmission(state, {
        clientRequestId: planned.command.clientRequestId,
        seq: planned.command.seq,
        outcome: "unknown",
      }).state;
      return { kind: "unknown" };
    }
  }

  function submit(): Promise<DesignSubmitResult> {
    if (inFlight) return inFlight;
    const promise = run();
    inFlight = promise;
    void promise.then(
      () => {
        if (inFlight === promise) inFlight = null;
      },
      () => {
        if (inFlight === promise) inFlight = null;
      },
    );
    return promise;
  }

  return {
    getState: () => state,
    edit,
    prefill,
    submit,
  };
}

export type DesignSeatRow = {
  key: string;
  seatId: string;
  logicalSeatId: string;
  roleId: string;
  roleLabel: string;
  instanceLabel: string | null;
  purpose: SeatPreview["purpose"];
  purposeLabel: string;
  activation: SeatPreview["activation"];
  activationLabel: string;
  cohortId: string | null;
  profileLabel: string;
  runtimeLabel: string | null;
  sourceLabel: string | null;
  familyLabel: string | null;
  budgetLabel: string;
  reasonLabel: string | null;
  standby: boolean;
  unavailable: boolean;
};

export type DesignCoordinatorRow = {
  roleId: string;
  roleLabel: string;
  profileLabel: string;
  runtimeLabel: string | null;
  sourceLabel: string | null;
  budgetLabel: string;
  reasonLabel: string | null;
  unavailable: boolean;
};

export type DesignResultView = {
  modeLabel: string;
  summary: string;
  teamId: string;
  teamLabel: string;
  targetLabel: string;
  reuse: readonly { roleId: string; reason: string }[];
  newRoles: readonly { id: string; name: string; noveltyReason: string | null }[];
  seats: readonly DesignSeatRow[];
  coordinator: DesignCoordinatorRow | null;
  logicalCount: number;
  physicalCount: number;
  countsNote: string | null;
  warnings: readonly string[];
  launch: DesignLaunchPrefill | null;
  launchHint: string | null;
};

/**
 * G1 still types `DesignResult.preview` with its tolerant stand-in. T4 owns the runtime DTO, so
 * callers may pass the real preview without waiting for G4b, and this view validates it below.
 */
export type DesignResultViewInput = Omit<DesignResult, "preview"> & {
  preview: LaunchPreviewDto | DesignResult["preview"];
};

export type DesignLaunchPrefill = {
  initialTeamId: string;
  lockTeam: true;
  initialTask: string;
  initialWorkspaceId?: string;
};

export type DesignPermissionRow = {
  id: string;
  kind: DesignJob["pendingPermissions"][number]["kind"];
  kindLabel: string;
  title: string;
  description: string | null;
};

export type DesignJobView = {
  title: string;
  modeLabel: string;
  phase: string;
  tone: "neutral" | "attention" | "danger";
  attemptLabel: string | null;
  designerProfileLabel: string | null;
  permissions: readonly DesignPermissionRow[];
  showPermissions: boolean;
  permissionNotice: string | null;
  canOpenAgent: boolean;
  canCancel: boolean;
  canRetrySave: boolean;
  continueAction: "recheck" | "repair" | null;
  saveNote: string | null;
  issues: readonly DesignIssue[];
  issuesTruncated: number;
  recovered: boolean;
  /** Which rule this job runs under, from the job record (never from the current form). */
  rulesLabel: string;
  /** Reported gaps in the existing Roles; empty for a job without one (and for an old daemon). */
  gaps: readonly DesignGapView[];
};

export type DesignGapAction =
  | { kind: "configure-economy"; layer: "allSeats"; route?: AllSeatsRoute; profileIds: string[] }
  | { kind: "open-role"; roleId: string; profileId?: string }
  | { kind: "create-role" };

export type DesignGapView = {
  key: string;
  responsibility: string;
  reason: string;
  useLabel: string;
  /** Server-confirmed names; the UI never resolves an id itself. */
  profiles: readonly { id: string; name: string; provider: string; model?: string }[];
  /** The server answered "no suitable Profile on this host" (profiles is empty then). */
  noSuitableProfile: string | null;
  suggestedRole: {
    id: string;
    name: string;
    responsibilities: readonly string[];
    policyLabel: string;
  } | null;
  unlaunchable: {
    roleId: string;
    roleName: string;
    unavailableProfileNames: readonly string[];
  } | null;
  /** Decided by the job's own mode: an economy-all job is repaired in the route list. */
  primary: DesignGapAction | null;
  secondary: DesignGapAction | null;
};

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Identical localized messages are shown once; the server may repeat a code for several seats. */
function uniqueIssues(issues: readonly DesignIssue[]): DesignIssue[] {
  const seen = new Set<string>();
  const unique: DesignIssue[] = [];
  for (const issue of issues) {
    const key = JSON.stringify(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

function asBudget(value: string | undefined): SeatPreview["budget"] | undefined {
  return value === "economy" || value === "sota" || value === "unknown" ? value : undefined;
}

function asBudgetBasis(value: string | undefined): SeatPreview["budgetBasis"] | undefined {
  return value === "host" ||
    value === "pool" ||
    value === "route" ||
    value === "conservative-default"
    ? value
    : undefined;
}

export function formatDesignBudget(budget: unknown, basis?: unknown): string {
  const record = recordOf(budget);
  const label =
    typeof budget === "string" ? budget : (textOf(record.budget) ?? textOf(record.label));
  const basisLabel =
    typeof basis === "string" ? basis : (textOf(record.basis) ?? textOf(record.budgetBasis));
  return formatLaunchBudget(asBudget(label), asBudgetBasis(basisLabel));
}

function formatSource(source: string | undefined): string | null {
  if (source === undefined) return null;
  const sources = designZh.sources as Record<string, string>;
  return sources[source] ?? source;
}

function profileView(profile: SeatProfileDto | null): {
  label: string;
  runtimeLabel: string | null;
} {
  if (profile === null) {
    return { label: designZh.resultSeatUnavailable, runtimeLabel: null };
  }
  const runtime = [
    profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
    profile.modeId,
    profile.thinkingOptionId,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return { label: profile.name || profile.id, runtimeLabel: runtime === "" ? null : runtime };
}

/** One row per physical seat; the same Role may appear twice and must not be merged. */
export function buildDesignSeatRows(input: {
  preview: LaunchPreviewDto;
  memberReasons: DesignResult["memberReasons"];
  newRoles: DesignResult["newRoles"];
}): DesignSeatRow[] {
  const roleNames = new Map(input.newRoles.map((role) => [role.id, role.name]));
  const reasons = new Map(
    input.memberReasons.map((reason) => [reason.logicalSeatId, reason.reason]),
  );
  return input.preview.seats.map((seat) => {
    const profile = profileView(seat.profile);
    return {
      key: seat.seatId,
      seatId: seat.seatId,
      logicalSeatId: seat.logicalSeatId,
      roleId: seat.roleId,
      roleLabel: seat.roleName || roleNames.get(seat.roleId) || seat.roleId,
      instanceLabel: seat.instanceLabel ?? null,
      purpose: seat.purpose,
      purposeLabel: designZh.seatPurposes[seat.purpose],
      activation: seat.activation,
      activationLabel: designZh.seatActivations[seat.activation],
      cohortId: seat.cohortId ?? null,
      profileLabel: profile.label,
      runtimeLabel: profile.runtimeLabel,
      sourceLabel: formatSource(seat.source),
      familyLabel: seat.family ?? null,
      budgetLabel: formatDesignBudget(seat.budget, seat.budgetBasis),
      reasonLabel: reasons.get(seat.logicalSeatId) ?? null,
      standby: seat.standby,
      unavailable: seat.unavailable || seat.profile === null,
    };
  });
}

/** The coordinator is outside the seat list; its reason still comes from `memberReasons`. */
export function buildDesignCoordinatorRow(input: {
  preview: LaunchPreviewDto;
  memberReasons: DesignResult["memberReasons"];
}): DesignCoordinatorRow {
  const coordinator = input.preview.coordinator;
  const profile = profileView(coordinator.profile);
  const reason = input.memberReasons.find((entry) => entry.target === "coordinator")?.reason;
  // T4 does not project a coordinator budget today. Read it if a later projection adds it,
  // otherwise report it as unknown rather than inventing a SOTA/host claim.
  const record = recordOf(coordinator);
  return {
    roleId: coordinator.roleId,
    roleLabel: coordinator.roleName || coordinator.roleId,
    profileLabel: profile.label,
    runtimeLabel: profile.runtimeLabel,
    sourceLabel: formatSource(coordinator.source),
    budgetLabel: formatDesignBudget(record.budget, record.budgetBasis),
    reasonLabel: reason ?? null,
    unavailable: coordinator.profile === null,
  };
}

function launchPreviewOf(preview: DesignResultViewInput["preview"]): LaunchPreviewDto | null {
  const parsed = ModeLaunchPreviewSchema.safeParse(preview);
  return parsed.success ? parsed.data : null;
}

/** The launch dialog gets a replaceable target preselect; the carrier is never a business target. */
export function planDesignLaunch(
  result: Pick<DesignResult, "request" | "targetWorkspaceId">,
  savedTeamId: string | null | undefined,
): DesignLaunchPrefill | null {
  if (!savedTeamId) return null;
  return {
    initialTeamId: savedTeamId,
    lockTeam: true,
    initialTask: result.request,
    ...(result.targetWorkspaceId ? { initialWorkspaceId: result.targetWorkspaceId } : {}),
  };
}

export function resolveDesignResultView(
  result: DesignResultViewInput,
  savedTeamId: string | null | undefined,
): DesignResultView {
  const preview = launchPreviewOf(result.preview);
  const seats = preview
    ? buildDesignSeatRows({
        preview,
        memberReasons: result.memberReasons,
        newRoles: result.newRoles,
      })
    : [];
  const coordinator = preview
    ? buildDesignCoordinatorRow({ preview, memberReasons: result.memberReasons })
    : null;
  const launch = planDesignLaunch(result, savedTeamId);
  const warnings = [
    ...result.warnings.map((issue) => formatDesignIssue(issue)),
    ...(preview?.warnings ?? []),
  ];
  if (!preview) warnings.unshift(designZh.resultPreviewUnavailable);
  return {
    modeLabel: designZh.modes[result.mode],
    summary: result.summary,
    teamId: result.team.id,
    teamLabel: result.team.name,
    targetLabel: result.targetWorkspaceId ?? designZh.resultNoTarget,
    reuse: result.reuse.map((entry) => ({ roleId: entry.roleId, reason: entry.reason })),
    newRoles: result.newRoles.map((role) => ({
      id: role.id,
      name: role.name,
      noveltyReason: role.noveltyReason ?? null,
    })),
    seats,
    coordinator,
    logicalCount: preview?.counts.logical ?? 0,
    physicalCount: preview?.counts.physical ?? 0,
    countsNote: coordinator ? designZh.resultCountsNote : null,
    warnings: [...new Set(warnings)],
    launch,
    launchHint: launch === null ? designZh.resultLaunchHint : null,
  };
}

export function resolveDesignJobView(job: DesignJob): DesignJobView {
  const pending = job.pendingPermissions.map((permission) => ({
    ...permission,
    kindLabel: designZh.permissionKinds[permission.kind],
    description: permission.description ?? null,
  }));
  const permissionAttention = job.attentionReason === "permission";
  const showPermissions = pending.length > 0 || permissionAttention;
  const notes: string[] = [];
  if (permissionAttention && pending.length === 0) notes.push(designZh.jobPermissionEmpty);
  if (job.permissionsTruncated) notes.push(designZh.jobPermissionTruncated);

  const saveNotes: string[] = [];
  if (job.saveState === "roles-only") saveNotes.push(designZh.jobSaveRolesOnly);
  if (job.saveState === "unknown") saveNotes.push(designZh.jobSaveUnknown);
  if (job.saveState === "committed") {
    saveNotes.push(designZh.jobSaveCommitted(job.savedTeamId ?? designZh.resultUnknownValue));
  }

  const danger =
    job.state === "failed" || job.state === "canceled" || job.state === "save_conflict";
  const attention =
    !danger &&
    (job.state === "needs_continue" ||
      permissionAttention ||
      (job.requiresAttention && job.attentionReason !== "finished"));

  const gaps = buildDesignRoleGapViews(job);
  // The gap card says it all; the generic "reuse invalid" line it rides on would only repeat it.
  const issues = uniqueIssues(job.issues).filter(
    (issue) =>
      gaps.length === 0 ||
      !(issue.code === "DESIGN_REUSE_INVALID" && issue.params.reason === "roles-gap"),
  );

  return {
    title: job.requestExcerpt || designZh.jobUntitled,
    modeLabel: designZh.modes[job.mode],
    phase: designZh.phases[job.state],
    tone: danger ? "danger" : attention ? "attention" : "neutral",
    attemptLabel:
      job.attempt > 0 ? designZh.jobAttempt(job.attempt, DESIGN_JOB_MAX_ATTEMPTS) : null,
    designerProfileLabel: job.designerProfile
      ? [job.designerProfile.name, job.designerProfile.provider, job.designerProfile.model]
          .filter((part): part is string => Boolean(part))
          .join(" · ")
      : null,
    permissions: pending,
    showPermissions,
    permissionNotice: notes.length > 0 ? notes.join(" ") : null,
    canOpenAgent: job.agentCreated,
    canCancel: job.allowed.cancel,
    canRetrySave:
      job.allowed.save &&
      (job.state === "save_conflict" ||
        job.state === "needs_continue" ||
        job.saveState === "roles-only" ||
        job.saveState === "unknown"),
    continueAction: job.allowed.continueAction,
    saveNote: saveNotes.length > 0 ? saveNotes.join(" ") : null,
    issues,
    issuesTruncated: job.issuesTruncated,
    recovered: job.recovered,
    rulesLabel: designJobRulesLabel(job),
    gaps,
  };
}

/** The job's own rule. A job without the field was made under the old rule (<=3 new Roles). */
export function designJobRulesLabel(job: Pick<DesignJob, "existingRolesOnly">): string {
  if (job.existingRolesOnly === true) return designGapZh.rulesOnly;
  if (job.existingRolesOnly === false) return designGapZh.rulesMax3;
  return designGapZh.rulesLegacy;
}

function gapRoute(gap: RoleGapReport): AllSeatsRoute | undefined {
  if (gap.use === "coordinator") return routeOf("coordinator", "decision");
  const tier = gap.suggestedRole?.executionPolicy.tier;
  return tier === undefined ? undefined : routeOf("member", tier);
}

function gapActions(
  job: Pick<DesignJob, "mode">,
  gap: RoleGapReport,
): { primary: DesignGapAction | null; secondary: DesignGapAction | null } {
  const profileIds = [
    ...gap.profiles.map((profile) => profile.id),
    ...(gap.unlaunchableRole?.unavailableProfileIds ?? []),
  ];
  if (job.mode === "economy-all") {
    // The mode decides the way out: an economy-all job never reaches a cheap seat through a
    // Role's own binding, so the route list is the primary action for either kind of gap.
    const route = gapRoute(gap);
    return {
      primary: {
        kind: "configure-economy",
        layer: "allSeats",
        ...(route === undefined ? {} : { route }),
        profileIds,
      },
      secondary: gap.suggestedRole ? { kind: "create-role" } : null,
    };
  }
  if (gap.unlaunchableRole) {
    const profileId = gap.unlaunchableRole.unavailableProfileIds[0];
    return {
      primary: {
        kind: "open-role",
        roleId: gap.unlaunchableRole.roleId,
        ...(profileId === undefined ? {} : { profileId }),
      },
      secondary: null,
    };
  }
  return { primary: gap.suggestedRole ? { kind: "create-role" } : null, secondary: null };
}

/**
 * One view per reported gap, in the server's order. Names come only from the server-confirmed
 * report. A job with no gap (or one from an old daemon that has none) yields no view.
 */
export function buildDesignRoleGapViews(job: Pick<DesignJob, "mode" | "roleGap">): DesignGapView[] {
  const gaps = Array.isArray(job.roleGap) ? job.roleGap : [];
  return gaps.map((gap, index) => {
    const { primary, secondary } = gapActions(job, gap);
    return {
      key: `${index}:${gap.responsibility}`,
      responsibility: gap.responsibility,
      reason: gap.reason,
      useLabel: designGapZh.gapUse(gap.use),
      profiles: gap.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        ...(profile.model === undefined ? {} : { model: profile.model }),
      })),
      noSuitableProfile:
        gap.profiles.length === 0 && gap.profileGapReason !== undefined
          ? gap.profileGapReason
          : null,
      suggestedRole: gap.suggestedRole
        ? {
            id: gap.suggestedRole.id,
            name: gap.suggestedRole.name,
            responsibilities: gap.suggestedRole.responsibilities,
            policyLabel: designGapZh.suggestedRolePolicy(
              gap.suggestedRole.executionPolicy.tier,
              gap.suggestedRole.executionPolicy.taskKind,
            ),
          }
        : null,
      unlaunchable: gap.unlaunchableRole
        ? {
            roleId: gap.unlaunchableRole.roleId,
            roleName: gap.unlaunchableRole.roleName,
            unavailableProfileNames: gap.unlaunchableRole.profileNames,
          }
        : null,
      primary,
      secondary,
    };
  });
}

/** What the server (or this session) remembers about the request a gap job was started with. */
export type DesignGapRetrySource = {
  request: string;
  profileId: string | null;
  useDefaultProfileHints: boolean;
};

/**
 * The server's retry seed rides on the job read by id (`gapRetry`); an old daemon has no such
 * field. Anything malformed is "no seed", never a guess.
 */
export function readGapRetrySeed(job: unknown): DesignGapRetrySource | null {
  const seed = recordOf(job).gapRetry;
  if (typeof seed !== "object" || seed === null) return null;
  const record = recordOf(seed);
  if (typeof record.request !== "string" || record.request.trim() === "") return null;
  const profileId = record.profileId;
  if (profileId !== null && profileId !== undefined && typeof profileId !== "string") return null;
  if (typeof record.useDefaultProfileHints !== "boolean") return null;
  return {
    request: record.request,
    profileId: typeof profileId === "string" ? profileId : null,
    useDefaultProfileHints: record.useDefaultProfileHints,
  };
}

/** The one-shot prefill the designer card consumes when the user retries without the switch. */
export type DesignGapRetryPrefill = {
  nonce: string;
  text: string;
  workspaceId: string;
  mode: TeamMode;
  profileChoice: string | null;
  existingRolesOnly: false;
  /** Replacing a draft the user typed needs a yes first. */
  confirmReplace: true;
};

export type DesignGapRetryPlan =
  | { ok: true; prefill: DesignGapRetryPrefill }
  | { ok: false; reason: "request-unavailable" };

/**
 * "Close the switch and retry" only prefills: nothing is started or continued here, the original
 * job and its gaps stay as they are, and the new request id is minted when the user presses
 * start. The target is the job's own target workspace, never the carrier workspace it ran in.
 */
export function planDesignGapRetry(
  job: Pick<DesignJob, "mode" | "targetWorkspaceId">,
  source: DesignGapRetrySource | null,
  nextNonce: () => string = createDesignClientRequestId,
): DesignGapRetryPlan {
  if (source === null || source.request.trim() === "") {
    return { ok: false, reason: "request-unavailable" };
  }
  return {
    ok: true,
    prefill: {
      nonce: nextNonce(),
      text: source.request,
      workspaceId: job.targetWorkspaceId ?? "",
      mode: job.mode,
      profileChoice:
        source.profileId !== null ? source.profileId : source.useDefaultProfileHints ? "" : null,
      existingRolesOnly: false,
      confirmReplace: true,
    },
  };
}

/** A typed draft is only replaced after a yes; an identical or empty one is replaced silently. */
export function shouldConfirmDraftReplace(currentRequest: string, seedRequest: string): boolean {
  return currentRequest.trim() !== "" && currentRequest !== seedRequest;
}

const RETRY_CACHE_LIMIT = 20;

/**
 * Session memory of what each started job was asked, so a retry works without the server seed.
 * Bounded; the oldest entry goes first. It is a fallback only and dies with the page.
 */
export function createDesignRetryCache() {
  const entries = new Map<string, DesignGapRetrySource>();
  return {
    remember(jobId: string, input: DesignStartInput): void {
      entries.delete(jobId);
      entries.set(jobId, {
        request: input.request,
        profileId: input.profileId ?? null,
        useDefaultProfileHints: input.useDefaultProfileHints === true,
      });
      while (entries.size > RETRY_CACHE_LIMIT) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get(jobId: string): DesignGapRetrySource | null {
      return entries.get(jobId) ?? null;
    },
    clear(): void {
      entries.clear();
    },
  };
}

/** Folding hides only the body; progress fields keep coming from the same job object. */
export function resolveDesignJobCardSections(job: DesignJob, collapsed: boolean) {
  const view = resolveDesignJobView(job);
  return {
    showBody: !collapsed,
    phase: view.phase,
    attemptLabel: view.attemptLabel,
    issueCount: view.issues.length,
  };
}

/** A hidden Team tab must not trigger a refresh (and therefore no save attempt). */
export function resolveDesignJobsRefreshInterval(
  active: boolean,
  jobs: readonly DesignJob[],
): number | false {
  if (!active) return false;
  return jobs.some((job) => RUNNING_STATES[job.state])
    ? DESIGN_JOBS_ACTIVE_REFRESH_MS
    : DESIGN_JOBS_BACKSTOP_REFRESH_MS;
}

export type DesignAgentNavigation = {
  openAgent(input: { agentId: string; serverId?: string }): void;
};

/**
 * Permission hints only navigate. There is deliberately no approve/deny call here: the host
 * processes the request in the agent's own conversation.
 */
export function openDesignAgent(input: {
  navigation: DesignAgentNavigation | undefined;
  hostId: string;
  agentId: string;
}): boolean {
  if (!input.navigation || !input.hostId || !input.agentId) return false;
  input.navigation.openAgent({ agentId: input.agentId, serverId: input.hostId });
  return true;
}
