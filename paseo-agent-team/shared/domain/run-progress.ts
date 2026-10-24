import { LABELS } from "../paseo/labels";

/** The agent snapshot fields progress needs; Paseo's agent list entries satisfy it. */
export type RunAgentSnapshot = {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  labels?: Readonly<Record<string, string>>;
  pendingPermissions?: readonly unknown[];
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  /** Set when the agent receives a prompt from a person or the plugin, not from another agent. */
  lastUserMessageAt?: string | null;
  /** Reported when a turn ends, so it also marks agents that only took prompts from agents. */
  lastUsage?: unknown;
  attentionTimestamp?: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  archivedAt?: string | null;
  workspaceId?: string;
};

export type MemberState =
  | "needs-input"
  | "failed"
  | "working"
  | "delivered"
  | "not-started"
  | "closed";

export const MEMBER_STATES: readonly MemberState[] = [
  "needs-input",
  "failed",
  "working",
  "delivered",
  "not-started",
  "closed",
];

function needsInput(agent: RunAgentSnapshot): boolean {
  return (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission";
}

/**
 * Whether the agent has been given work. A prompt from another agent (the coordinator's
 * `send_agent_prompt`) leaves `lastUserMessageAt` empty, so a finished turn counts too:
 * it leaves usage and an attention timestamp behind, which a never-prompted agent lacks.
 */
export function hasRun(agent: RunAgentSnapshot): boolean {
  return Boolean(agent.lastUserMessageAt || agent.lastUsage || agent.attentionTimestamp);
}

export function memberState(agent: RunAgentSnapshot): MemberState {
  if (needsInput(agent)) return "needs-input";
  if (agent.status === "error") return "failed";
  if (agent.status === "running") return "working";
  if (agent.status === "initializing") return hasRun(agent) ? "working" : "not-started";
  if (agent.status === "closed") return "closed";
  return hasRun(agent) ? "delivered" : "not-started";
}

export type TeamRun = {
  runId: string;
  teamId?: string;
  teamName?: string;
  task?: string;
  workspaceId?: string;
  coordinator?: RunAgentSnapshot;
  members: RunAgentSnapshot[];
  startedAt: string;
  lastActivityAt: string;
};

function boundary(values: readonly string[], edge: "first" | "last"): string {
  const times = values.map((value) => Date.parse(value)).filter(Number.isFinite);
  if (times.length === 0) return "";
  return new Date(edge === "first" ? Math.min(...times) : Math.max(...times)).toISOString();
}

/** Groups agents launched by this plugin into runs, newest first. Archived agents are left out. */
export function groupTeamRuns(agents: readonly RunAgentSnapshot[]): TeamRun[] {
  const byRun = new Map<string, RunAgentSnapshot[]>();
  for (const agent of agents) {
    const runId = agent.labels?.[LABELS.run]?.trim();
    if (!runId || agent.archivedAt) continue;
    const list = byRun.get(runId) ?? [];
    list.push(agent);
    byRun.set(runId, list);
  }
  const runs: TeamRun[] = [];
  for (const [runId, list] of byRun) {
    const coordinator = list.find((agent) => agent.labels?.[LABELS.kind] === "coordinator");
    const members = list
      .filter((agent) => agent !== coordinator)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const labels = coordinator?.labels ?? list[0]?.labels ?? {};
    runs.push({
      runId,
      teamId: labels[LABELS.team],
      teamName: labels[LABELS.teamName] ?? labels[LABELS.team],
      task: coordinator?.labels?.[LABELS.task],
      workspaceId: coordinator?.workspaceId ?? list[0]?.workspaceId,
      coordinator,
      members,
      startedAt:
        coordinator?.createdAt ??
        boundary(
          list.map((agent) => agent.createdAt),
          "first",
        ),
      lastActivityAt: boundary(
        list.map((agent) => agent.updatedAt),
        "last",
      ),
    });
  }
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export type RunPhase = "starting" | "running" | "needs-you" | "failed" | "done" | "idle";

export type RunProgress = {
  phase: RunPhase;
  counts: Record<MemberState, number>;
  /** Members that received at least one task. */
  assigned: number;
  /** Assigned members that are idle with their reply delivered. */
  delivered: number;
  total: number;
};

export function runProgress(run: Pick<TeamRun, "coordinator" | "members">): RunProgress {
  const counts: Record<MemberState, number> = {
    "needs-input": 0,
    failed: 0,
    working: 0,
    delivered: 0,
    "not-started": 0,
    closed: 0,
  };
  for (const member of run.members) counts[memberState(member)] += 1;
  const assigned = counts.working + counts.delivered + counts["needs-input"] + counts.failed;
  const coordinator = run.coordinator;
  let phase: RunPhase;
  if ((coordinator && needsInput(coordinator)) || counts["needs-input"] > 0) {
    phase = "needs-you";
  } else if (coordinator?.status === "error") {
    phase = "failed";
  } else if (
    coordinator?.status === "running" ||
    (coordinator?.status === "initializing" && hasRun(coordinator)) ||
    counts.working > 0
  ) {
    phase = "running";
  } else if (coordinator && !hasRun(coordinator) && coordinator.status !== "closed") {
    phase = "starting";
  } else if (coordinator?.status === "idle") {
    phase = "done";
  } else {
    phase = "idle";
  }
  return {
    phase,
    counts,
    assigned,
    delivered: counts.delivered,
    total: run.members.length,
  };
}

/**
 * What a cached timeline digest is keyed on. A working agent shares one key and is refreshed on
 * a timer, since its `updatedAt` moves with every event. Once it stops, `updatedAt` marks that
 * moment, so each finished turn is read afresh. The attention fields cannot do this job: Paseo
 * clears them at once for an agent someone is looking at, which leaves two finished turns with
 * identical keys and the older digest on screen.
 */
export function digestCacheKey(agent: Pick<RunAgentSnapshot, "id" | "status" | "updatedAt">) {
  return [
    "agent-team",
    "digest",
    agent.id,
    agent.status === "running" ? "running" : `${agent.status}@${agent.updatedAt}`,
  ] as const;
}

export type TimelineEntryLike = { item: unknown; timestamp: string };

export type TodoDigest = { done: number; total: number; active?: string };

export type TimelineDigest = {
  /** The newest prompt the agent received, from a person or from another agent. */
  assignment?: { text: string; at: string };
  /** The newest reply after that prompt; partial while the agent is still working. */
  report?: { text: string; at: string };
  todos?: TodoDigest;
};

const DIGEST_TEXT_MAX = 280;

export function excerpt(text: string, max = DIGEST_TEXT_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function todoDigest(items: unknown): TodoDigest | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  let done = 0;
  let active: string | undefined;
  let firstOpen: string | undefined;
  for (const entry of items) {
    const item = record(entry);
    if (!item) continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (item.completed === true || item.status === "completed") {
      done += 1;
      continue;
    }
    firstOpen ??= text;
    if (!active && item.status === "in_progress") {
      active = typeof item.activeForm === "string" && item.activeForm ? item.activeForm : text;
    }
  }
  const current = active ?? firstOpen;
  return { done, total: items.length, ...(current ? { active: excerpt(current, 120) } : {}) };
}

/**
 * The text of a prompt the agent received, or null when the item is not one. Paseo records a
 * prompt another agent sent (`send_agent_prompt`) as an `agent_message` tool call; the same
 * item with event `finished` is a completion notice to the sender, not work.
 */
function incomingPrompt(item: Record<string, unknown>): string | null {
  if (item.type === "user_message") return typeof item.text === "string" ? item.text.trim() : "";
  if (item.type === "tool_call" && item.name === "agent_message") {
    const message = record(item.agentMessage);
    if (message?.event === "message" && typeof message.text === "string") {
      return message.text.trim();
    }
  }
  return null;
}

/**
 * Reads the newest assignment, reply, and todo list out of a timeline tail. Unknown item
 * types are skipped so newer Paseo timeline items cannot break the progress view.
 */
export function digestTimeline(entries: readonly TimelineEntryLike[]): TimelineDigest {
  const digest: TimelineDigest = {};
  let pendingReply: { text: string; at: string } | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const item = record(entry?.item);
    if (!entry || !item) continue;
    if (item.type === "todo" && !digest.todos) {
      digest.todos = todoDigest(item.items);
    } else if (item.type === "assistant_message" && !digest.assignment && !pendingReply) {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text) pendingReply = { text: excerpt(text), at: entry.timestamp };
    } else if (!digest.assignment) {
      const prompt = incomingPrompt(item);
      if (prompt) {
        digest.assignment = { text: excerpt(prompt), at: entry.timestamp };
        if (pendingReply) digest.report = pendingReply;
      }
    }
    if (digest.assignment && digest.todos) break;
  }
  if (!digest.assignment && pendingReply) digest.report = pendingReply;
  return digest;
}
