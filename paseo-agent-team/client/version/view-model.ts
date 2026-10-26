import type {
  Blocker,
  BlockerCode,
  InstallSource,
  Job,
  JobState,
  Phase,
  Relation,
  RemedyCode,
  RemoteTarget,
  VersionInfo,
} from "../../shared/version";
import { CHECK_TTL_MS } from "../../shared/version";
import { zh } from "../../shared/zh";

export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SHORT_COMMIT_LENGTH = 7;

/** Every version query is host-scoped; switching hosts must never reuse another host's data. */
export function versionQueryKey(hostId: string): readonly [string, string, string] {
  return ["agent-team", "version", hostId];
}

const BLOCKERS: Record<BlockerCode, { reason: string; next: string }> = zh.versionBlockers;
const REMEDIES: Record<RemedyCode, string> = zh.versionRemedies;
const PHASES: Record<Phase, string> = zh.versionPhases;
const JOB_STATES: Record<JobState, string> = zh.versionJobStates;
const RELATIONS: Record<Relation, string> = zh.versionRelations;

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "accent";

export function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.slice(0, SHORT_COMMIT_LENGTH) : zh.versionNotAvailable;
}

export function phaseText(phase: Phase): string {
  return PHASES[phase];
}

export function jobStateText(state: JobState): string {
  return JOB_STATES[state];
}

export function relationText(relation: Relation): string {
  return RELATIONS[relation];
}

export function remedyText(remedy: RemedyCode): string {
  return REMEDIES[remedy];
}

export function sourceLabel(source: InstallSource): string {
  if (source.kind === "directory") {
    return source.isGit ? zh.versionSourceDirectoryGit : zh.versionSourceDirectory;
  }
  if (source.kind === "git") {
    return source.registry ? zh.versionSourceRegistry : zh.versionSourceManagedGit;
  }
  if (source.kind === "npm") return zh.versionSourceNpm;
  return zh.versionSourceUnknown;
}

export function targetLabel(target: RemoteTarget | null): string {
  if (!target) return zh.versionNotAvailable;
  if (target.kind === "release-tag") {
    return target.ref?.replace(/^refs\/tags\//, "") ?? target.version ?? zh.versionTargetUnknown;
  }
  if (target.kind === "default-branch") {
    const branch = target.ref?.replace(/^refs\/heads\//, "") ?? zh.versionNotAvailable;
    return zh.versionTargetBranch(
      branch,
      shortCommit(target.commit),
      target.version ?? zh.versionUnknown,
    );
  }
  if (target.kind === "npm-latest") {
    return zh.versionTargetNpm(target.version ?? zh.versionUnknown);
  }
  return zh.versionTargetRegistry(target.version ?? zh.versionUnknown);
}

export function currentVersionText(info: VersionInfo): string {
  return `${info.current.packageVersion ?? zh.versionNotAvailable} · ${shortCommit(info.current.commit)}`;
}

export function currentBranchLabel(info: VersionInfo): string {
  return info.current.branch ?? zh.versionNotAvailable;
}

export function remoteBranchLabel(info: VersionInfo): string {
  const target = info.remote.installTarget;
  if (target?.kind !== "default-branch") return zh.versionNotAvailable;
  return target.ref?.replace(/^refs\/heads\//, "") ?? zh.versionNotAvailable;
}

export function remoteLatestLabel(info: VersionInfo): string {
  if (info.remote.state === "error") {
    const previous = info.remote.installTarget
      ? `${targetLabel(info.remote.installTarget)}（${zh.versionStale}）`
      : null;
    return previous ?? zh.versionCheckFailed;
  }
  if (info.remote.installTarget) return targetLabel(info.remote.installTarget);
  if (info.remote.state === "checking") return zh.versionChecking;
  if (info.remote.state === "unchecked") return zh.versionUnchecked;
  return zh.versionNotAvailable;
}

export function checkedAtLabel(info: VersionInfo): string {
  const value = info.remote.checkedAt;
  if (!value) return zh.versionNeverChecked;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return zh.versionUnknown;
  const stale = info.remote.stale || info.remote.state === "error";
  return `${date.toLocaleString("zh-CN")}${stale ? `（${zh.versionStale}）` : ""}`;
}

export function isJobActive(job: Job | null | undefined): boolean {
  return job?.state === "queued" || job?.state === "running";
}

export type HeaderStatus = "update" | "unknown" | "latest";

export type HeaderVersionView = {
  versionLabel: string;
  status: HeaderStatus;
  statusText: string;
  accessibilityLabel: string;
};

/**
 * A failed check has no trustworthy answer, so it must read as unknown, never as "up to date".
 * `updateAvailable === null` covers failed, incomplete, and unsupported-source checks alike.
 */
export function headerVersionView(
  info: VersionInfo | null,
  job: Job | null = null,
): HeaderVersionView {
  const version = info?.current.packageVersion ?? zh.versionNotAvailable;
  const failedCheck = job?.kind === "check" && job.state === "failed";
  const status: HeaderStatus =
    info && !failedCheck && info.remote.state !== "error" && info.updateAvailable === true
      ? "update"
      : info && !failedCheck && info.remote.state !== "error" && info.updateAvailable === false
        ? "latest"
        : "unknown";
  const statusText =
    status === "update"
      ? zh.versionUpdateAvailable
      : status === "latest"
        ? zh.versionLatest
        : zh.versionUnknown;
  return {
    versionLabel: info?.current.packageVersion ? `v${version}` : zh.versionNotAvailable,
    status,
    statusText,
    accessibilityLabel: zh.versionButtonLabel(version, statusText),
  };
}

export type StatusView = {
  title: string;
  next: string;
  tone: StatusTone;
};

function blockerFor(info: VersionInfo, code: BlockerCode): Blocker | undefined {
  return info.blockers.find((item) => item.code === code);
}

/** A single primary status plus the next action; detailed blocker text stays in the list. */
export function statusView(info: VersionInfo, job: Job | null, reconnecting: boolean): StatusView {
  if (reconnecting) {
    return {
      title: zh.versionReconnecting,
      next: zh.versionReconnectingBody,
      tone: "warning",
    };
  }
  if (job?.kind === "update") {
    if (isJobActive(job)) {
      return {
        title: `${zh.versionUpdating} · ${phaseText(job.phase)}`,
        next: zh.versionKeepOpen,
        tone: "warning",
      };
    }
    const tone: StatusTone =
      job.state === "succeeded" ? "success" : job.state === "rolled_back" ? "warning" : "danger";
    const next =
      job.state === "succeeded"
        ? zh.versionUpdatedBody
        : job.state === "rolled_back"
          ? zh.versionRolledBackBody
          : job.error
            ? BLOCKERS[job.error.code].next
            : zh.versionRecoveryBody;
    return { title: jobStateText(job.state), next, tone };
  }
  if (job?.kind === "check" && isJobActive(job)) {
    return { title: zh.versionChecking, next: zh.versionKeepOpen, tone: "neutral" };
  }
  if (job?.kind === "check" && job.state === "failed") {
    return {
      title: zh.versionCheckFailed,
      next: job.error ? BLOCKERS[job.error.code].next : zh.versionCheckFailedBody,
      tone: "danger",
    };
  }
  if (info.remote.state === "error") {
    return { title: zh.versionCheckFailed, next: zh.versionCheckFailedBody, tone: "danger" };
  }
  if (
    info.installSource.kind === "npm" ||
    (info.installSource.kind === "git" && info.installSource.registry)
  ) {
    return {
      title: zh.versionManagedSource,
      next: zh.versionManagedSourceBody,
      tone: "neutral",
    };
  }

  const dirty = blockerFor(info, "dirty");
  if (dirty) {
    return {
      title: BLOCKERS[dirty.code].reason,
      next: BLOCKERS[dirty.code].next,
      tone: "warning",
    };
  }

  if (info.installSource.kind === "directory" && !info.installSource.isGit) {
    return { title: BLOCKERS.not_git.reason, next: zh.versionNotGitBody, tone: "warning" };
  }
  const detached = blockerFor(info, "detached_head");
  const noUpstream = blockerFor(info, "no_upstream");
  if (detached || noUpstream) {
    return {
      title: zh.versionNoUpstream,
      next: BLOCKERS.detached_head.next,
      tone: "warning",
    };
  }
  if (info.relation === "ahead") {
    return { title: relationText("ahead"), next: zh.versionLocalAheadBody, tone: "warning" };
  }
  if (info.relation === "diverged") {
    return { title: relationText("diverged"), next: zh.versionDivergedBody, tone: "warning" };
  }
  if (info.updateAvailable === true) {
    const sameVersion =
      info.current.packageVersion !== null &&
      info.remote.installTarget?.version === info.current.packageVersion;
    const blocker = info.blockers[0];
    return {
      title: sameVersion ? zh.versionSameVersionUpdate : zh.versionUpdateAvailable,
      next: blocker ? BLOCKERS[blocker.code].next : zh.versionReadyToUpdate,
      tone: "accent",
    };
  }
  if (info.updateAvailable === false) {
    const blocker = info.blockers[0];
    return {
      title: zh.versionLatest,
      next: blocker ? BLOCKERS[blocker.code].next : "",
      tone: "success",
    };
  }
  if (info.remote.state === "checking") {
    return { title: zh.versionChecking, next: zh.versionKeepOpen, tone: "neutral" };
  }
  if (info.remote.state === "unchecked") {
    return { title: zh.versionUnchecked, next: zh.versionCheckFailedBody, tone: "neutral" };
  }
  return { title: zh.versionUnknown, next: zh.versionCheckFailedBody, tone: "neutral" };
}

export type UpdateButtonView = {
  visible: boolean;
  enabled: boolean;
  requiresCheck: boolean;
  reason: string | null;
};

/** The backend stores checks for five minutes; an older checkId would be refused. */
export function isCheckFresh(info: VersionInfo, nowMs: number = Date.now()): boolean {
  if (!info.checkId || !info.remote.checkedAt) return false;
  const checked = Date.parse(info.remote.checkedAt);
  if (Number.isNaN(checked)) return false;
  return nowMs - checked <= CHECK_TTL_MS;
}

/** npm, registry, and unknown installs never get a one-click update button (AC-4.12). */
export function updateButtonView(
  info: VersionInfo,
  job: Job | null,
  nowMs: number = Date.now(),
): UpdateButtonView {
  const source = info.installSource;
  if (
    source.kind === "npm" ||
    source.kind === "unknown" ||
    (source.kind === "git" && source.registry)
  ) {
    return { visible: false, enabled: false, requiresCheck: false, reason: null };
  }
  if (job?.kind === "update" && isJobActive(job)) {
    return {
      visible: true,
      enabled: false,
      requiresCheck: false,
      reason: zh.versionUpdateRunning,
    };
  }
  if (job?.kind === "check" && isJobActive(job)) {
    return {
      visible: true,
      enabled: false,
      requiresCheck: false,
      reason: zh.versionCheckRunning,
    };
  }
  if (source.kind === "directory" && !source.isGit) {
    return {
      visible: true,
      enabled: false,
      requiresCheck: false,
      reason: zh.versionNotGitBody,
    };
  }
  if (info.remote.state === "error") {
    return {
      visible: true,
      enabled: false,
      requiresCheck: false,
      reason: zh.versionCheckFailedBody,
    };
  }
  if (info.updateAvailable === true) {
    if (info.canUpdate) {
      if (!isCheckFresh(info, nowMs)) {
        return {
          visible: true,
          enabled: false,
          requiresCheck: true,
          reason: zh.versionCheckExpired,
        };
      }
      return { visible: true, enabled: true, requiresCheck: false, reason: null };
    }
    const blocker = info.blockers[0];
    return {
      visible: true,
      enabled: false,
      requiresCheck: false,
      reason: blocker ? BLOCKERS[blocker.code].next : zh.versionNotReady,
    };
  }
  const blocker = info.blockers[0];
  return {
    visible: true,
    enabled: false,
    requiresCheck: false,
    reason: blocker
      ? BLOCKERS[blocker.code].next
      : info.updateAvailable === false
        ? zh.versionLatest
        : zh.versionUnchecked,
  };
}

export type BlockerView = {
  key: string;
  reason: string;
  next: string;
  detail: string | null;
  remedy: string;
};

export function blockerViews(blockers: readonly Blocker[]): BlockerView[] {
  const seen = new Set<string>();
  return blockers.flatMap((blocker) => {
    const key = `${blocker.code}\u0000${blocker.remedy}\u0000${blocker.detail ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        reason: BLOCKERS[blocker.code].reason,
        next: BLOCKERS[blocker.code].next,
        detail: blocker.detail,
        remedy: remedyText(blocker.remedy),
      },
    ];
  });
}

/** Both the informational blockers and the terminal job's failure can be worth showing. */
export function blockersFor(info: VersionInfo, job: Job | null): BlockerView[] {
  return blockerViews(job?.error ? [...info.blockers, job.error] : info.blockers);
}

export type UpdateConfirmation = {
  source: string;
  current: string;
  target: string;
  /** Reserved for the backend's pending-commit list; one placeholder line until that field lands. */
  commits: string[];
  npmCi: string;
  restart: string;
};

export function updateConfirmation(info: VersionInfo): UpdateConfirmation | null {
  const target = info.remote.installTarget;
  if (!target) return null;
  return {
    source: zh.versionConfirmSource(sourceLabel(info.installSource)),
    current: zh.versionConfirmCurrent(
      info.current.packageVersion ?? zh.versionNotAvailable,
      shortCommit(info.current.commit),
    ),
    target: zh.versionConfirmTarget(
      target.kind === "release-tag"
        ? `${targetLabel(target)} · ${shortCommit(target.commit)}`
        : targetLabel(target),
    ),
    commits: [zh.versionConfirmCommitsPending],
    npmCi: zh.versionConfirmNpmCi,
    restart: zh.versionConfirmRestart,
  };
}

export function updateConfirmationLines(info: VersionInfo): string[] {
  const confirmation = updateConfirmation(info);
  if (!confirmation) return [];
  return [
    confirmation.source,
    confirmation.current,
    confirmation.target,
    ...confirmation.commits,
    confirmation.npmCi,
    confirmation.restart,
  ];
}

/** Server-side check throttling is authoritative; this also covers a failed check with no time. */
export function shouldAutoCheck(
  info: VersionInfo,
  job: Job | null,
  nowMs: number = Date.now(),
): boolean {
  if (job?.kind === "update" && isJobActive(job)) return false;
  if (job?.kind === "check" && isJobActive(job)) return false;
  if (info.remote.state === "checking") return false;
  const candidates = [
    info.remote.checkedAt,
    job?.kind === "check" ? (job.finishedAt ?? job.startedAt) : null,
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => !Number.isNaN(value));
  if (candidates.length === 0) return true;
  return nowMs - Math.max(...candidates) >= AUTO_CHECK_INTERVAL_MS;
}

const RECOVERY_WINDOW_MS = 30_000;

export type RecoveryStep = "found" | "keep-waiting" | "timed-out" | "reconnecting";

/**
 * Decide what to do when a start request may have been lost. A transport failure only means
 * reconnect and keep asking for the latest job; it never means resend `update.start`.
 */
export function resolveRecoveryStep(input: {
  job: Job | null;
  failed: boolean;
  startedAtMs: number;
  nowMs: number;
  requestId: string | null;
}): RecoveryStep {
  if (input.failed) return "reconnecting";
  if (input.requestId && input.job?.kind === "update" && input.job.requestId === input.requestId) {
    // Identity beats clocks: a matching request is ours even if daemon and client clocks differ.
    return "found";
  }
  if (input.nowMs - input.startedAtMs > RECOVERY_WINDOW_MS) return "timed-out";
  return "keep-waiting";
}

/**
 * Adopt a job snapshot monotonically. Same job: only a strictly higher seq is accepted, and a
 * terminal snapshot never goes back to queued/running. Different jobs: only a task that started
 * later may replace the displayed one, so an old active snapshot cannot clobber a newer terminal.
 */
export function adoptJobSnapshot(current: Job | null, next: Job | null): Job | null {
  if (!next) return current;
  if (!current) return next;
  if (current.id === next.id) {
    if (next.seq <= current.seq) return current;
    if (!isJobActive(current) && isJobActive(next)) return current;
    return next;
  }
  const currentStart = Date.parse(current.startedAt);
  const nextStart = Date.parse(next.startedAt);
  if (Number.isNaN(currentStart)) return next;
  if (Number.isNaN(nextStart)) return current;
  return nextStart > currentStart ? next : current;
}

/** Whether a persisted update snapshot is an allowed replacement for the displayed job. */
export function shouldAdoptLatestUpdateJob(latest: Job | null, current: Job | null): boolean {
  if (latest?.kind !== "update") return false;
  return adoptJobSnapshot(current, latest) === latest;
}

export type UpdatePollStep = "reconnecting" | "waiting" | "finished";

/** A failed status request is transient: keep the task and retry rather than marking it failed. */
export function resolveUpdatePoll(job: Job | null, failed: boolean): UpdatePollStep {
  if (failed) return "reconnecting";
  if (!job) return "waiting";
  return isJobActive(job) ? "waiting" : "finished";
}

const POST_UPDATE_CHECK_STATES: Record<string, true> = {
  succeeded: true,
  rolled_back: true,
};

/** One post-update check per terminal job, bypassing the six-hour automatic-check throttle. */
export function shouldCheckAfterUpdate(
  job: Job | null,
  checkedJobIds: ReadonlySet<string>,
): boolean {
  return (
    job?.kind === "update" &&
    POST_UPDATE_CHECK_STATES[job.state] === true &&
    !checkedJobIds.has(job.id)
  );
}
