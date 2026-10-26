import { createHash } from "node:crypto";
import { type LaunchPlanHashInput, launchPlanFingerprint } from "../shared/domain/launch-hash";

/** SHA-256 of the canonical launch fingerprint; the token the app echoes back on start. */
export function hashLaunchPlan(input: LaunchPlanHashInput): string {
  return createHash("sha256").update(launchPlanFingerprint(input), "utf8").digest("hex");
}
