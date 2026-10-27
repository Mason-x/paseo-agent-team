import { formatDesignIssue } from "../../shared/domain/design-output";
import type { DesignIssue, DesignJob } from "../../shared/schemas/design";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { designZh } from "../../shared/zh/design";
import type { DesignPrefillEvent } from "./events";
import type { DesignLaunchPrefill } from "./submission-state";

/** The minimal prefill the designer card consumes; the command token is the nonce. */
export type DesignerPrefill = {
  nonce: string;
  text: string;
  workspaceId: string | null;
  mode?: TeamMode;
};

export function designerPrefillFromEvent(event: DesignPrefillEvent): DesignerPrefill {
  return {
    nonce: event.token,
    text: event.request,
    workspaceId: event.workspaceId,
    ...(event.mode ? { mode: event.mode } : {}),
  };
}

export type DesignLaunchSeed = {
  key: string;
  teamId: string;
  lockTeam: true;
  initialTask: string;
  initialWorkspaceId?: string;
};

/** Opens the existing LaunchDialog; the dialog re-previews and owns the actual start. */
export function designLaunchSeed(prefill: DesignLaunchPrefill, key: string): DesignLaunchSeed {
  return {
    key,
    teamId: prefill.initialTeamId,
    lockTeam: true,
    initialTask: prefill.initialTask,
    ...(prefill.initialWorkspaceId ? { initialWorkspaceId: prefill.initialWorkspaceId } : {}),
  };
}

/** G4a's only-workspace blocker reads better as an instruction than as a raw error. */
export function designStartFailureMessage(issues: readonly DesignIssue[]): string {
  const special = issues.find(
    (issue) =>
      issue.code === "DESIGN_NO_WORKSPACE" && issue.params.reason === "target-is-only-workspace",
  );
  if (special) return designZh.targetOnlyWorkspace;
  const first = issues[0];
  return first ? formatDesignIssue(first) : designZh.agentFailed;
}

/** A hidden Team tab must never start a save; only a ready, server-allowed result does. */
export function shouldAutoSaveDesignJob(active: boolean, job: DesignJob): boolean {
  return active && job.state === "ready" && job.allowed.save && job.resultId !== null;
}

/** Stable per-result key: one automatic save attempt per mounted panel, not per render. */
export function designSaveAttemptKey(job: DesignJob): string | null {
  return job.resultId ? `${job.jobId}:${job.resultId}` : null;
}

/**
 * Cleanup is a canceled/conflicted partial write that is safe to compensate. Unknown writes must
 * be read back by a human first, and a save still in flight owns the document.
 */
export function shouldCleanupDesignJob(input: {
  active: boolean;
  job: DesignJob;
  unknownWrite: boolean;
  attempted: boolean;
  savePending: boolean;
}): boolean {
  if (!input.active || input.unknownWrite || input.attempted || input.savePending) return false;
  if (input.job.resultId === null) return false;
  const canceledPartial = input.job.state === "canceled" && input.job.saveState === "roles-only";
  const needsCleanup =
    input.job.needsCleanup &&
    (input.job.state === "canceled" || input.job.state === "save_conflict");
  return canceledPartial || needsCleanup;
}

/** A single host workspace cannot be both the target and the carrier for a design. */
export function shouldWarnOnlyWorkspace(
  workspaceIds: readonly string[],
  selectedId: string,
): boolean {
  return selectedId !== "" && workspaceIds.length === 1 && workspaceIds[0] === selectedId;
}
