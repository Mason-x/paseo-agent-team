import { realpath } from "node:fs/promises";
import path from "node:path";

/** Ledger version directory required by §5.2. Job files live one level below it. */
export const DESIGN_LEDGER_DIRNAME = "agent-team-designer";
export const DESIGN_LEDGER_VERSION = "v1";
export const DESIGN_JOBS_DIRNAME = "jobs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DesignDataRoot = {
  home: string;
  root: string;
  jobs: string;
};

export type DesignDataRootError = "missing-home" | "relative-home" | "escape" | "unreadable";

export class DesignDataRootErrorException extends Error {
  readonly reason: DesignDataRootError;

  constructor(reason: DesignDataRootError) {
    super(`design ledger unavailable: ${reason}`);
    this.name = "DesignDataRootError";
    this.reason = reason;
  }
}

export function isDesignJobId(jobId: string): boolean {
  return UUID_PATTERN.test(jobId);
}

/**
 * Resolves the ledger only from an explicit absolute home. A missing or relative value never falls
 * back to ~/.paseo; the caller reports DESIGN_STORAGE_UNAVAILABLE instead.
 */
export async function resolveDesignDataRoot(home: string | undefined): Promise<DesignDataRoot> {
  if (home === undefined || home.trim() === "") {
    throw new DesignDataRootErrorException("missing-home");
  }
  if (!path.isAbsolute(home)) throw new DesignDataRootErrorException("relative-home");

  let homeReal: string;
  try {
    homeReal = await realpath(home);
  } catch {
    throw new DesignDataRootErrorException("unreadable");
  }
  const jobs = path.resolve(
    homeReal,
    DESIGN_LEDGER_DIRNAME,
    DESIGN_LEDGER_VERSION,
    DESIGN_JOBS_DIRNAME,
  );
  if (!isContained(homeReal, jobs)) throw new DesignDataRootErrorException("escape");
  return { home: homeReal, root: path.dirname(jobs), jobs };
}

export function designJobPath(root: DesignDataRoot, jobId: string): string {
  if (!isDesignJobId(jobId)) throw new DesignDataRootErrorException("escape");
  const file = path.resolve(root.jobs, `${jobId}.json`);
  if (!isContained(root.jobs, file)) throw new DesignDataRootErrorException("escape");
  return file;
}

/** Rejects a jobs directory whose real path leaves the explicit home, including through a symlink. */
export async function confirmDesignJobsContainment(root: DesignDataRoot): Promise<void> {
  const jobsReal = await realpath(root.jobs);
  if (!isContained(root.home, jobsReal)) throw new DesignDataRootErrorException("escape");
}

export function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return !relative.split(/[/\\]/u).includes("..");
}
