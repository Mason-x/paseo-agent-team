import type { LaunchTarget } from "../../shared/rpc";
import type {
  LaunchPreviewResult,
  ModeIssueDto,
  SeatPreview,
} from "../../shared/schemas/launch-preview";
import { zh } from "../../shared/zh";

export const PREVIEW_TASK_DEBOUNCE_MS = 400;

/** The preview identity. No mode and no contract version are sent, so neither is part of it. */
export type LaunchPreviewKeyInput = {
  hostId: string;
  teamId: string;
  task: string;
  target: LaunchTarget | null;
};

/** The debounced task is the preview identity; a non-empty difference keeps start disabled. */
export function previewTaskState(
  liveTask: string,
  debouncedTask: string,
  composing: boolean,
): { task: string; pending: boolean } {
  const task = debouncedTask.trim();
  return { task, pending: composing || liveTask.trim() !== task };
}

/** A task change invalidates the previous preview immediately; trim is part of the contract. */
export function launchPreviewQueryKey(input: LaunchPreviewKeyInput): readonly unknown[] {
  return [
    "agent-team",
    "launch-preview",
    input.hostId,
    input.teamId,
    input.task.trim(),
    input.target,
  ] as const;
}

export function launchPreviewIdentity(input: LaunchPreviewKeyInput): string {
  return JSON.stringify(launchPreviewQueryKey(input));
}

export function launchActivationText(activation: SeatPreview["activation"]): string {
  if (activation === "on-demand") return zh.modes.activationOnDemand;
  if (activation === "eager") return zh.modes.activationEager;
  // An earlier host can still send "escalation-only"; it is shown as its own id.
  return activation;
}

/** A seat's status is its activation; the retired standby marker is no longer shown. */
export function launchSeatStatus(seat: Pick<SeatPreview, "activation">): string {
  return launchActivationText(seat.activation);
}

function labelOf(issue: ModeIssueDto): string {
  const instanceLabel =
    typeof issue.params.instanceLabel === "string" ? issue.params.instanceLabel : "";
  if (issue.roleId) return instanceLabel ? `${issue.roleId} (${instanceLabel})` : issue.roleId;
  const profileId = typeof issue.params.profileId === "string" ? issue.params.profileId : "";
  return instanceLabel || profileId;
}

function reasonOf(issue: ModeIssueDto): string {
  return typeof issue.params.reason === "string" ? issue.params.reason : "";
}

/**
 * Turns a preview issue code into the same user-facing language the launch planner uses. Only the
 * codes the single planning path still emits have wording; a code from an earlier host falls back
 * to the generic text.
 */
export function modeIssueText(issue: ModeIssueDto): string {
  const label = labelOf(issue);
  const reason = reasonOf(issue);
  switch (issue.code) {
    case "MODE_MEMBER_LIMIT":
      return zh.exceedMax(Number(issue.params.members), Number(issue.params.limit));
    case "MODE_SEAT_DUPLICATE":
      return zh.modes.duplicateLabelWarning(label);
    case "MODE_PROFILE_UNRESOLVED":
      return reason === "role-missing"
        ? zh.memberMissing(issue.roleId ?? "")
        : zh.memberProfileFail(label, reason);
    case "MODE_ROLE_DISABLED":
      return zh.modes.roleDisabled(label);
    case "MODE_CONTEXT_UNAVAILABLE":
      return zh.modes.contextUnavailable;
    case "MODE_UNKNOWN": {
      const detail = [issue.params.field, issue.params.value].filter(Boolean).join("=");
      return zh.modes.unknown(String(detail));
    }
    case "MODE_ONDEMAND_UNAVAILABLE":
      return zh.modes.onDemandUnavailable;
    case "MODE_REVIEW_FAMILY_SAME":
      return zh.modes.reviewFamilySame(String(issue.params.family ?? ""));
    case "MODE_LIMIT_CLAMPED":
      return zh.modes.limitClamped(Number(issue.params.limit));
    case "MODE_PLAN_CHANGED":
      return zh.modes.planChanged;
    default:
      return zh.modes.unknownFallback(issue.code);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function previewBlockers(result: LaunchPreviewResult | undefined): string[] {
  if (!result) return [];
  if (!result.ok) return uniqueStrings(result.blockers);
  return uniqueStrings(
    result.preview.issues.filter((issue) => issue.severity === "blocker").map(modeIssueText),
  );
}

/** `preview.warnings` is already the server's final user-facing list; never re-translate issues. */
export function previewWarnings(result: LaunchPreviewResult | undefined): string[] {
  if (!result) return [];
  return uniqueStrings(result.ok ? result.preview.warnings : result.warnings);
}

export type LaunchGateInput = {
  starting: boolean;
  running: boolean;
  contextLoading: boolean;
  taskReady: boolean;
  taskPending: boolean;
  targetReady: boolean;
  preview: LaunchPreviewResult | undefined;
  previewIdentity: string;
  currentIdentity: string;
  fetching: boolean;
  error: string | null;
};

export type LaunchGate = { disabled: boolean; reason: string | null };

/**
 * Start is allowed only for a completed preview whose identity still matches every input.
 * A task change, a refetch, or a preview blocker disables it; an old plan hash is never reused.
 */
export function launchGate(input: LaunchGateInput): LaunchGate {
  if (input.starting || input.running) return { disabled: true, reason: null };
  if (input.contextLoading) return { disabled: true, reason: zh.modes.previewLoadingContext };
  if (!input.taskReady) return { disabled: true, reason: zh.modes.previewNoTask };
  if (input.taskPending) return { disabled: true, reason: zh.modes.previewDebouncing };
  if (!input.targetReady) return { disabled: true, reason: zh.modes.previewNoTarget };
  if (input.error) return { disabled: true, reason: zh.modes.previewFailed };
  if (input.fetching) return { disabled: true, reason: zh.modes.previewUpdating };
  if (!input.preview) return { disabled: true, reason: zh.modes.previewPending };
  if (input.previewIdentity !== input.currentIdentity) {
    return { disabled: true, reason: zh.modes.previewPending };
  }
  const blockers = previewBlockers(input.preview);
  if (!input.preview.ok || blockers.length > 0) {
    return { disabled: true, reason: zh.modes.previewBlocked };
  }
  return { disabled: false, reason: null };
}

export function isPlanChanged(blockers: readonly string[]): boolean {
  return blockers.includes(zh.modes.planChanged);
}

/** A plan change must refetch and ask for a new confirmation; other blockers just stay visible. */
export function startFailureAction(
  blockers: readonly string[],
): "refresh-preview" | "show-blockers" {
  return isPlanChanged(blockers) ? "refresh-preview" : "show-blockers";
}
