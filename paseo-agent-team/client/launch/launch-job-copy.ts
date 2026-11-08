import type { LaunchJob } from "../../shared/rpc";
import { zh } from "../../shared/zh";
import { runEngineZh } from "../../shared/zh/run-engine";

const copy = runEngineZh.launchJob;

/**
 * What the launch dialog says while a job runs, and when it is done. A job the Run Engine started
 * carries `engine.launchState`; one that did not (the coordinator chain) is worded exactly as before.
 *
 * For an Engine Run the last step is the plan request: a message to the coordinator that asks for the
 * task graph. It is prepared in the Run's record and sent once; whether it arrived can stay unproven
 * for a while (`kickoff-pending`), and the coordinator then needs time to read the task and answer, so
 * nothing is dispatched for a few minutes. Saying so keeps a person from starting it a second time.
 */
export function jobProgressLabel(job: LaunchJob): string {
  if (job.step === "workspace") return zh.creatingWorkspace;
  if (job.step === "coordinator") return zh.creatingCoordinator;
  if (job.step === "member") return zh.creatingMember(job.memberIndex ?? 1, job.memberTotal);
  return job.engine ? copy.sendingPlanRequest : zh.sendingKickoff;
}

/** The toast when the job has finished. */
export function jobDoneText(job: LaunchJob): string {
  if (job.engine?.launchState === "kickoff-pending") return copy.donePending;
  if (job.engine) return copy.done;
  return zh.launched;
}
