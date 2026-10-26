import type { DesignIssue, DesignJob } from "../../shared/schemas/design";
import { TeamModeSchema } from "../../shared/schemas/team-mode";
import { isDesignJobId } from "./data-root";
import type { DesignJobStore, StoredDesignJob } from "./store";
import { type AttemptTextFact, type DesignTimelinePort, readAttemptText } from "./timeline";

export const DISCOVERY_PAGE_LIMIT = 100;
export const DISCOVERY_MAX_PAGES = 20;
export const UI_VISIBLE_LIMIT = 50;

export type DesignAgentLabelSet = Record<string, string>;

export type DiscoveredDesignAgent = {
  agentId: string;
  labels: DesignAgentLabelSet;
  archived: boolean;
  status: "initializing" | "idle" | "running" | "closed" | "error";
  pendingPermissions: readonly { id: string; kind: string; raw?: unknown }[];
  attentionReason: "finished" | "error" | "permission" | null;
};

/** TODO(G4): discovery list/refresh move to the shared design port with the timeline port. */
export type DesignDiscoveryPort = {
  list(input: { cursor: string | null }): Promise<{
    agents: readonly DiscoveredDesignAgent[];
    nextCursor: string | null;
  }>;
  refresh(agentId: string): Promise<DiscoveredDesignAgent | null>;
};

export type DiscoveryFact = {
  complete: boolean;
  owned: readonly { jobId: string; agent: DiscoveredDesignAgent }[];
  orphans: readonly { jobId: string; clientRequestId: string; mode: string }[];
  issues: readonly { code: DesignIssue["code"]; summary: string }[];
  activeCount: number;
  visibleCount: number;
};

const ACTIVE = new Set([
  "starting",
  "designing",
  "validating",
  "fixing",
  "ready",
  "saving",
  "needs_continue",
  "save_conflict",
  "canceling",
]);

function issue(code: DesignIssue["code"], summary: string): DiscoveryFact["issues"][number] {
  return { code, summary };
}

function validIdentity(
  agent: DiscoveredDesignAgent,
): { jobId: string; requestId: string; mode: string } | null {
  const jobId = agent.labels["agent-team.design"];
  const requestId = agent.labels["agent-team.design.request-id"];
  const mode = agent.labels["agent-team.design.mode"];
  if (
    !jobId ||
    !isDesignJobId(jobId) ||
    !requestId ||
    agent.labels["agent-team.design.version"] !== "1" ||
    !TeamModeSchema.safeParse(mode).success
  )
    return null;
  return { jobId, requestId, mode: mode ?? "" };
}

/** Lists labeled design agents. It never creates, archives, sends, or writes the ledger. */
export async function discoverDesignJobs(
  port: DesignDiscoveryPort,
  store: Pick<DesignJobStore, "list" | "problems">,
): Promise<DiscoveryFact> {
  const records = await store.list();
  let complete = true;
  let problems: Awaited<ReturnType<DesignJobStore["problems"]>> = [];
  try {
    problems = await store.problems();
  } catch {
    complete = false;
  }
  const byJob = new Map(records.map((record) => [record.job.jobId, record]));
  const agents: DiscoveredDesignAgent[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page += 1) {
    let result: Awaited<ReturnType<DesignDiscoveryPort["list"]>>;
    try {
      result = await port.list({ cursor });
    } catch {
      complete = false;
      break;
    }
    agents.push(...result.agents);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
    if (page === DISCOVERY_MAX_PAGES) complete = false;
  }
  const owned: { jobId: string; agent: DiscoveredDesignAgent }[] = [];
  const orphans: { jobId: string; clientRequestId: string; mode: string }[] = [];
  const issues: { code: DesignIssue["code"]; summary: string }[] = [];
  if (!complete) issues.push(issue("DESIGN_DISCOVERY_INCOMPLETE", "discovery page limit"));
  for (const problem of problems) {
    issues.push(
      issue("DESIGN_RECOVERY_INCOMPLETE", `store problem: ${problem.name} (${problem.reason})`),
    );
  }
  for (const agent of agents) {
    const identity = validIdentity(agent);
    if (!identity) {
      issues.push(issue("DESIGN_RECOVERY_INCOMPLETE", "invalid design label"));
      continue;
    }
    const record = byJob.get(identity.jobId);
    if (!record) {
      orphans.push({
        jobId: identity.jobId,
        clientRequestId: identity.requestId,
        mode: identity.mode,
      });
      continue;
    }
    const hashMatches = record.requestHash === agent.labels["agent-team.design.request-hash"];
    const agentMatches = agent.agentId === record.job.agentId;
    if (!hashMatches || !agentMatches) {
      issues.push(
        issue(
          "DESIGN_RECOVERY_INCOMPLETE",
          !agentMatches ? "agent mismatch" : "request hash mismatch",
        ),
      );
      continue;
    }
    owned.push({ jobId: identity.jobId, agent });
  }
  return {
    complete,
    owned,
    orphans,
    issues,
    activeCount: records.filter((record) => ACTIVE.has(record.job.state)).length,
    visibleCount: Math.min(records.length, UI_VISIBLE_LIMIT),
  };
}

/**
 * Recovery matrix (08 §5.1/5.3/5.5/5.6). Each row is one observation fact; terminal, cancel,
 * and missing rows must not call the provider.
 *
 * | fact | observation | precedence / note |
 * | --- | --- | --- |
 * | no ledger record | missing | before any provider call |
 * | state saved/failed/canceled | terminal | before any provider call |
 * | cancelRequested or state canceling | cancel-requested | before any provider call |
 * | refresh returns null / no valid attempt number | unknown | provider invisible is not deleted |
 * | agentId/version/jobId/requestHash mismatch | unclaimed | labels alone never claim |
 * | outcomeUnknown or ack unknown | outcome-unknown | before receipt/error/timeline |
 * | ack pending | receipt-pending | before error/timeline |
 * | attempt refresh running/active/permission | waiting | no text extraction |
 * | next non-attempt user message | external-input | timeline boundary |
 * | attempt refresh error/closed or new lastError/error entry | attempt-error | no partial JSON |
 * | timeline incomplete/gap/overlap/epoch loss | needs-continue | never guesses |
 * | complete + ack acked + idle agent | ready-candidate | other complete combinations stay unchanged |
 *
 * `unchanged` is the defensive fallback: a complete attempt that is not yet receipt-acked/idle
 * has no state decision to make. outcome-unknown and receipt-pending intentionally outrank errors
 * so an uncertain send is reconciled before spending a repair round.
 */
export type ReconcileFact = {
  jobId: string;
  record: StoredDesignJob | null;
  agent: DiscoveredDesignAgent | null;
  attempt: AttemptTextFact | null;
  observation:
    | "unchanged"
    | "ready-candidate"
    | "needs-continue"
    | "unknown"
    | "missing"
    | "terminal"
    | "cancel-requested"
    | "unclaimed"
    | "outcome-unknown"
    | "receipt-pending"
    | "waiting"
    | "external-input"
    | "attempt-error";
};

/**
 * Reads one job's ledger, live agent, and current attempt text. The returned observation is a fact
 * for G6; this function does not send a correction or mutate the ledger.
 */
export async function reconcileDesignJob(
  ports: { discovery: DesignDiscoveryPort; timeline: DesignTimelinePort },
  store: Pick<DesignJobStore, "get">,
  jobId: string,
): Promise<ReconcileFact> {
  const record = await store.get(jobId);
  if (!record) return { jobId, record: null, agent: null, attempt: null, observation: "missing" };
  if (["saved", "failed", "canceled"].includes(record.job.state))
    return { jobId, record, agent: null, attempt: null, observation: "terminal" };
  if (record.job.cancelRequested || record.job.state === "canceling")
    return { jobId, record, agent: null, attempt: null, observation: "cancel-requested" };
  const agent = await ports.discovery.refresh(record.job.agentId);
  if (!agent) return { jobId, record, agent: null, attempt: null, observation: "unknown" };
  if (
    agent.agentId !== record.job.agentId ||
    agent.labels["agent-team.design"] !== record.job.jobId ||
    agent.labels["agent-team.design.version"] !== "1" ||
    agent.labels["agent-team.design.request-hash"] !== record.requestHash
  ) {
    return { jobId, record, agent, attempt: null, observation: "unclaimed" };
  }
  const attemptNumber =
    record.job.attempt === 1 || record.job.attempt === 2 || record.job.attempt === 3
      ? record.job.attempt
      : null;
  if (attemptNumber === null) {
    return { jobId, record, agent, attempt: null, observation: "unknown" };
  }
  const attempt = await readAttemptText(ports.timeline, record, attemptNumber);
  const pending = record.attempts.find((item) => item.attempt === attemptNumber);
  const observation =
    record.outcomeUnknown || pending?.ack === "unknown"
      ? "outcome-unknown"
      : pending?.ack === "pending"
        ? "receipt-pending"
        : attempt.status === "running"
          ? "waiting"
          : attempt.status === "external-input"
            ? "external-input"
            : attempt.status === "error"
              ? "attempt-error"
              : attempt.status === "incomplete"
                ? "needs-continue"
                : attempt.status === "complete" &&
                    pending?.ack === "acked" &&
                    agent.status === "idle"
                  ? "ready-candidate"
                  : "unchanged";
  return { jobId, record, agent, attempt, observation };
}

export function permissionSummary(
  agent: DiscoveredDesignAgent,
): Pick<DesignJob, "pendingPermissions" | "attentionReason" | "permissionsTruncated"> {
  return {
    pendingPermissions: agent.pendingPermissions.slice(0, 20).map((permission) => ({
      id: permission.id,
      kind:
        permission.kind === "tool" ||
        permission.kind === "plan" ||
        permission.kind === "question" ||
        permission.kind === "mode"
          ? permission.kind
          : "other",
      title: permission.id,
    })),
    attentionReason: agent.pendingPermissions.length > 0 ? "permission" : agent.attentionReason,
    permissionsTruncated: agent.pendingPermissions.length > 20,
  };
}
