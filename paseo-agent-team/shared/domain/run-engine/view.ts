import {
  RUN_READ_FAILURE_CODES,
  type RunDetailView,
  RunGetOutputSchema,
  type RunHistoryEntryView,
  type RunHistoryPage,
  type RunTaskView,
} from "../../schemas/run-engine/rpc";
import { runEngineZh as zh } from "../../zh/run-engine";
import { isDecisionPending } from "./decision-state";
import { displayText } from "./display-text";
import { eventCause } from "./timeline";
import { explainDecision, explainTask, type TaskExplanation } from "./waiting";

export { displayText };

/**
 * Pure view model for the Runs page Engine view (RE-R07). Everything here is deterministic and
 * never throws on a well-typed or a malformed input: the server text it receives is untrusted
 * display text (02 RE7.8 R07 constraints), so it is cleaned again before it reaches a component.
 */

export const MAX_DAG_NODES = 64;

/** `2026-10-29T01:02:03.000Z` -> `2026-10-29 01:02:03`: locale-free and stable. */
export function shortTime(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/u.exec(iso);
  return match ? `${match[1]} ${match[2]}` : displayText(iso, 32);
}

function textOf(value: string, max: number): string {
  return displayText(value, max, "—");
}

/** Known copy only from an own string property; prototype names and functions fall through. */
function ownText(map: Readonly<Record<string, unknown>>, key: string): string | undefined {
  if (!Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  return typeof value === "string" ? value : undefined;
}

function compareCode(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// --- get state ----------------------------------------------------------------------------------

export type EngineFailureKind = "missing" | "corrupt" | "unknown-version" | "projection-invalid";

export type EngineState =
  | { kind: "ready"; run: RunDetailView; history: RunHistoryPage; notices: string[] }
  /** W01 handoff: the caller must keep the last ready state for the same host/run; this view never caches or fakes one. */
  | { kind: "unchanged"; revision: number }
  | { kind: "failure"; failure: EngineFailureKind; detail: string | null }
  | { kind: "refresh-plugin" };

const CODE_FAILURE: Readonly<Record<string, EngineFailureKind>> = {
  "run-missing": "missing",
  "run-corrupt": "corrupt",
  "run-unknown-version": "unknown-version",
  "run-projection-invalid": "projection-invalid",
};

/** The frozen list this view has copy for; kept next to the map so a new code fails a test. */
export const ENGINE_FAILURE_CODES: readonly string[] = RUN_READ_FAILURE_CODES;

/** `run.get` output -> one of four states. Anything unparseable is "refresh the plugin". */
export function engineGetState(raw: unknown): EngineState {
  const parsed = RunGetOutputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "refresh-plugin" };
  const output = parsed.data;
  if (output.status === "unchanged") return { kind: "unchanged", revision: output.revision };
  if (output.status === "ready") {
    const notices: string[] = [];
    for (const issue of output.issues) {
      const line =
        ownText(zh.notices, issue.code) ?? zh.notices.unknown(displayText(issue.code, 64, "?"));
      if (!notices.includes(line)) notices.push(line);
    }
    return { kind: "ready", run: output.run, history: output.history, notices };
  }
  const code = output.issues[0]?.code;
  const fromCode =
    code !== undefined && Object.hasOwn(CODE_FAILURE, code) ? CODE_FAILURE[code] : undefined;
  return {
    kind: "failure",
    failure: fromCode ?? output.status,
    detail: code !== undefined && fromCode === undefined ? displayText(code, 64) : null,
  };
}

// --- DAG ----------------------------------------------------------------------------------------

export type DagNodeView = {
  taskId: string;
  title: string;
  state: string;
  deps: string[];
  depsLabel: string;
};
export type DagLayout = {
  mode: "columns" | "list";
  layers: { layer: number; title: string; nodes: DagNodeView[] }[];
  /** Model-only dependency edges (166); the read-only UI expresses dependencies as text. */
  edges: { from: string; to: string }[];
  anomalies: number;
  truncated: { shown: number; total: number } | null;
};

/** Group by topological `layer`; declaration order inside a layer. Bad edges are counted, not drawn. */
export function dagLayout(dag: RunDetailView["dag"], mode: "columns" | "list"): DagLayout {
  const nodes = dag.tasks.slice(0, MAX_DAG_NODES);
  const layerOf = new Map(nodes.map((node) => [node.taskId, node.layer]));
  let anomalies = 0;
  const edges: DagLayout["edges"] = [];
  const byLayer = new Map<number, DagNodeView[]>();
  for (const node of nodes) {
    const deps: string[] = [];
    for (const dep of node.deps) {
      const depLayer = layerOf.get(dep);
      if (depLayer === undefined || depLayer >= node.layer) {
        anomalies += 1;
        continue;
      }
      deps.push(dep);
      edges.push({ from: dep, to: node.taskId });
    }
    const view: DagNodeView = {
      taskId: textOf(node.taskId, 64),
      title: displayText(node.title, 120, textOf(node.taskId, 64)),
      state: textOf(node.state, 32),
      deps,
      depsLabel:
        deps.length === 0 ? zh.noDeps : zh.dependsOn(deps.map((id) => textOf(id, 64)).join("、")),
    };
    byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), view]);
  }
  const layers = [...byLayer.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([layer, layerNodes]) => ({ layer, title: zh.layerTitle(layer), nodes: layerNodes }));
  return {
    mode,
    layers,
    edges: mode === "columns" ? edges : [],
    anomalies,
    truncated:
      dag.tasks.length > MAX_DAG_NODES ? { shown: MAX_DAG_NODES, total: dag.tasks.length } : null,
  };
}

// --- tasks --------------------------------------------------------------------------------------

export type Tone = "success" | "danger" | "warning" | "accent" | "muted" | "neutral";
export type Badge = { label: string; tone: Tone };

const STATE_TONE: Readonly<Record<string, Tone>> = {
  pending: "muted",
  ready: "muted",
  assigned: "accent",
  in_progress: "accent",
  review: "accent",
  rework: "warning",
  done: "success",
  failed: "danger",
  blocked: "warning",
  cancelled: "muted",
};

export function taskBadge(state: string, phase: string | null, frozen: boolean): Badge {
  const known = Object.hasOwn(zh.taskState, state);
  const base = known ? (zh.taskState[state] ?? state) : displayText(state, 32, "?");
  const phaseKnown = phase !== null && Object.hasOwn(zh.taskPhase, phase);
  const phaseLabel =
    phase === null || phase === "implementation"
      ? null
      : phaseKnown
        ? (zh.taskPhase[phase] ?? phase)
        : displayText(phase, 32);
  const parts = [base];
  if (phaseLabel !== null) parts.push(phaseLabel);
  if (frozen && phase !== "frozen") parts.push(zh.frozenSuffix);
  return { label: parts.join(" · "), tone: known ? (STATE_TONE[state] ?? "neutral") : "neutral" };
}

export type TaskContext = {
  tasks: readonly RunTaskView[];
  locks: RunDetailView["locks"];
  decisions: RunDetailView["decisions"];
  history: readonly RunHistoryEntryView[];
};

export function blockedLabel(
  blockedBy: RunTaskView["blockedBy"],
  context: TaskContext,
): string | null {
  if (blockedBy === null) return null;
  const ref = blockedBy.ref === null ? null : displayText(blockedBy.ref, 64);
  switch (blockedBy.kind) {
    case "dependency":
      return zh.blockedBy.dependency(ref);
    case "lock": {
      const holder = context.locks.find((lock) => lock.claimId === blockedBy.ref)?.taskId;
      if (holder !== undefined) return zh.blockedBy.lockHeld(textOf(holder, 64));
      return ref === null ? zh.blockedBy.lock : zh.blockedBy.lockClaim(ref);
    }
    case "decision": {
      const decision = context.decisions.find((entry) => entry.decisionId === blockedBy.ref);
      return zh.blockedBy.decision(decision ? textOf(decision.category, 8) : null);
    }
    case "permission":
      return zh.blockedBy.permission(ref);
    case "capacity":
      return zh.blockedBy.capacity;
    case "channel":
      return zh.blockedBy.channel(ref);
    case "seat":
      return zh.blockedBy.seat;
    case "other":
      return zh.blockedBy.other;
    default:
      return displayText(String(blockedBy.kind), 32, zh.blockedBy.other);
  }
}

/** Quality failures in the current layer: the total minus the last escalation's baseline. */
export function layerFailures(task: Pick<RunTaskView, "qualityFailures" | "escalations">): number {
  const baseline = task.escalations.at(-1)?.qualityFailures ?? 0;
  return Math.max(0, task.qualityFailures - baseline);
}

export type TaskRowView = {
  taskId: string;
  title: string;
  badge: Badge;
  tierLine: string;
  assignee: string;
  counts: string[];
  escalations: string[];
  waiting: string | null;
  blocked: string | null;
  lastEvent: string | null;
  frozen: boolean;
  /** Why it waits, who clears it, what happens next. */
  explain: TaskExplanation;
};

export function taskRow(task: RunTaskView, context: TaskContext): TaskRowView {
  const chain =
    task.escalations.length === 0
      ? textOf(task.currentTier, 16)
      : [task.tier, ...task.escalations.map((entry) => entry.toTier)]
          .map((tier) => textOf(tier, 16))
          .join("→");
  const latest = context.history
    .filter((entry) => entry.taskId === task.taskId)
    .reduce<RunHistoryEntryView | null>(
      (best, entry) => (best === null || entry.seq > best.seq ? entry : best),
      null,
    );
  const assignee = task.assignee;
  return {
    taskId: textOf(task.taskId, 64),
    title: displayText(task.title, 120, textOf(task.taskId, 64)),
    badge: taskBadge(task.state, task.phase, task.frozen),
    tierLine: zh.taskRow.tier(chain, textOf(task.level, 16)),
    assignee:
      assignee === null
        ? zh.taskRow.noAssignee
        : [assignee.seatId, assignee.profileName, assignee.channelId]
            .map((part) => textOf(part, 80))
            .join(" · "),
    counts: [
      zh.taskRow.attempts(task.attempts),
      zh.taskRow.rework(task.reworkCount),
      zh.taskRow.evidenceReturns(task.evidenceReturns),
      zh.taskRow.protocolFailures(task.protocolFailures),
      zh.taskRow.qualityFailures(task.qualityFailures, layerFailures(task)),
    ],
    escalations: task.escalations.map((entry) =>
      zh.taskRow.escalated(textOf(entry.fromTier, 16), textOf(entry.toTier, 16), entry.atAttempt),
    ),
    waiting: task.waitingReason === null ? null : displayText(task.waitingReason, 200),
    blocked: blockedLabel(task.blockedBy, context),
    lastEvent:
      latest === null
        ? null
        : `${eventLabel(latest.kind, latest.summary)} · ${shortTime(latest.at)}`,
    frozen: task.frozen,
    explain: explainTask(task, context.decisions),
  };
}

// --- locks and capacity -------------------------------------------------------------------------

export type LockClaimView = {
  claimId: string;
  kindLabel: string;
  target: string;
  accessLabel: string;
  frozen: boolean;
};
export type LockGroupView = {
  taskId: string;
  title: string;
  claims: LockClaimView[];
  waiters: string[];
};
export type LockViewModel = {
  groups: LockGroupView[];
  capacity: { text: string; over: boolean };
};

export function lockView(run: Pick<RunDetailView, "locks" | "tasks" | "capacity">): LockViewModel {
  const titleOf = new Map(run.tasks.map((task) => [task.taskId, task.title]));
  const holderOf = new Map(run.locks.map((lock) => [lock.claimId, lock.taskId]));
  const groups = new Map<string, LockGroupView>();
  for (const lock of run.locks) {
    const group = groups.get(lock.taskId) ?? {
      taskId: textOf(lock.taskId, 64),
      title: displayText(titleOf.get(lock.taskId), 120, textOf(lock.taskId, 64)),
      claims: [],
      waiters: [],
    };
    group.claims.push({
      claimId: lock.claimId,
      kindLabel: zh.locks.kind[lock.kind] ?? displayText(lock.kind, 16),
      // hot/tool claims carry a resource name, not a repository path.
      target: displayText(lock.path, 200, "?"),
      accessLabel: zh.locks.access[lock.access] ?? displayText(lock.access, 16),
      frozen: lock.frozen,
    });
    groups.set(lock.taskId, group);
  }
  for (const task of run.tasks) {
    if (task.blockedBy?.kind !== "lock" || task.blockedBy.ref === null) continue;
    const holder = holderOf.get(task.blockedBy.ref);
    const group = holder === undefined ? undefined : groups.get(holder);
    if (group && !group.waiters.includes(task.taskId)) group.waiters.push(textOf(task.taskId, 64));
  }
  const { configuredLimit, effectiveLimit, inUse } = run.capacity;
  return {
    groups: [...groups.values()],
    capacity: {
      text: zh.locks.capacity(inUse, configuredLimit, effectiveLimit),
      over: inUse > configuredLimit,
    },
  };
}

// --- budgets ------------------------------------------------------------------------------------

export type BudgetRowView = {
  key: string;
  scopeLabel: string;
  subject: string;
  reserved: string;
  confirmed: string;
  observed: string;
  limit: string;
  ratio: number | null;
  exhausted: boolean;
};

/** Reserved, confirmed and observed turns stay three separate numbers (AC-RE7.3). */
export function budgetRows(budgets: RunDetailView["budgets"]): BudgetRowView[] {
  return budgets.map((entry) => ({
    key: `${entry.scope}:${entry.subjectId}`,
    scopeLabel: entry.scope === "seat" ? zh.budgets.seat : zh.budgets.group,
    subject: textOf(entry.subjectId, 64),
    reserved: zh.budgets.reserved(entry.reserved),
    confirmed: zh.budgets.confirmed(entry.confirmed),
    observed: zh.budgets.observed(entry.observedTurns),
    limit: zh.budgets.limit(entry.limit),
    ratio: entry.limit > 0 ? Math.min(1, entry.reserved / entry.limit) : null,
    exhausted: entry.reserved >= entry.limit,
  }));
}

// --- decisions, channels, alerts ----------------------------------------------------------------

export type DecisionRowView = {
  decisionId: string;
  category: string;
  stateLabel: string;
  open: boolean;
  subject: string | null;
  summary: string;
  createdAt: string;
  answered: string | null;
  explain: TaskExplanation;
};

export function decisionRows(
  decisions: RunDetailView["decisions"],
  tasks: readonly RunTaskView[],
): DecisionRowView[] {
  const titleOf = new Map(tasks.map((task) => [task.taskId, task.title]));
  return decisions
    .map((decision) => {
      const open = isDecisionPending(decision);
      const subject =
        decision.subjectId === null
          ? null
          : displayText(titleOf.get(decision.subjectId) ?? decision.subjectId, 120);
      const action = decision.answeredAction;
      return {
        decisionId: decision.decisionId,
        category: zh.decisions.category[decision.category] ?? textOf(decision.category, 8),
        stateLabel: zh.decisions.state[decision.state] ?? textOf(decision.state, 16),
        open,
        subject,
        summary: displayText(decision.summary, 400, "—"),
        createdAt: shortTime(decision.createdAt),
        answered:
          action === null
            ? null
            : zh.decisions.chose(zh.decisions.action[action] ?? textOf(action, 24)),
        explain: explainDecision(decision),
      };
    })
    .sort(
      (left, right) =>
        Number(right.open) - Number(left.open) ||
        compareCode(left.createdAt, right.createdAt) ||
        compareCode(left.decisionId, right.decisionId),
    );
}

export type ChannelRowView = {
  channelId: string;
  stateLabel: string;
  paused: boolean;
  until: string | null;
  code: string | null;
};

export function channelRows(channels: RunDetailView["channels"]): ChannelRowView[] {
  return channels.map((channel) => ({
    channelId: textOf(channel.channelId, 80),
    stateLabel: zh.channels.state[channel.state] ?? textOf(channel.state, 16),
    paused: channel.state === "paused",
    until:
      channel.state !== "paused"
        ? null
        : channel.unavailableUntil === null
          ? zh.channels.noUntil
          : zh.channels.until(shortTime(channel.unavailableUntil)),
    code: channel.code === null ? null : zh.channels.code(textOf(channel.code, 80)),
  }));
}

export type AlertRowView = {
  alertId: string;
  severity: string;
  critical: boolean;
  stateLabel: string;
  open: boolean;
  summary: string;
  createdAt: string;
};

const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 0, warning: 1, info: 2 };

export function alertRows(alerts: RunDetailView["alerts"]): AlertRowView[] {
  return alerts
    .map((alert) => ({
      alertId: alert.alertId,
      severity: zh.alerts.severity[alert.severity] ?? textOf(alert.severity, 16),
      critical: alert.severity === "critical",
      stateLabel: zh.alerts.state[alert.state] ?? textOf(alert.state, 16),
      open: alert.state === "open",
      summary: displayText(alert.summary, 300, "—"),
      createdAt: shortTime(alert.createdAt),
      rank: SEVERITY_RANK[alert.severity] ?? 3,
    }))
    .sort(
      (left, right) =>
        Number(right.open) - Number(left.open) ||
        left.rank - right.rank ||
        compareCode(left.createdAt, right.createdAt) ||
        compareCode(left.alertId, right.alertId),
    )
    .map(({ rank: _rank, ...row }) => row);
}

// --- needs you ----------------------------------------------------------------------------------

export type NeedsYou = { level: "needs-you" | "waiting" | "ok"; reasons: string[] };

/**
 * AC-RE7.4: an open decision, a blocked/failed task or an open critical alert needs the user; a
 * paused run/channel or an over-capacity run is waiting. A terminal run with an unanswered decision
 * is still "needs you", never "finished".
 */
export function needsYou(
  run: Pick<
    RunDetailView,
    "lifecycle" | "tasks" | "decisions" | "alerts" | "channels" | "capacity"
  >,
): NeedsYou {
  const urgent: string[] = [];
  const waiting: string[] = [];
  const openDecisions = run.decisions.filter((decision) => isDecisionPending(decision)).length;
  if (openDecisions > 0) urgent.push(zh.needsYou.decisions(openDecisions));
  const stuck = run.tasks.filter((task) => task.state === "blocked" || task.state === "failed");
  if (stuck.length > 0) urgent.push(zh.needsYou.blockedTasks(stuck.length));
  const permissions = run.tasks.filter(
    (task) =>
      (task.state === "assigned" ||
        task.state === "in_progress" ||
        task.state === "review" ||
        task.state === "rework") &&
      task.blockedBy?.kind === "permission",
  ).length;
  if (permissions > 0) urgent.push(zh.needsYou.permissions(permissions));
  const critical = run.alerts.filter((a) => a.state === "open" && a.severity === "critical");
  if (critical.length > 0) urgent.push(zh.needsYou.criticalAlerts(critical.length));
  if (run.lifecycle === "paused") waiting.push(zh.needsYou.paused);
  const paused = run.channels.filter((channel) => channel.state === "paused").length;
  if (paused > 0) waiting.push(zh.needsYou.pausedChannels(paused));
  if (run.capacity.inUse > run.capacity.configuredLimit) waiting.push(zh.needsYou.overCapacity);
  if (urgent.length > 0) return { level: "needs-you", reasons: [...urgent, ...waiting] };
  return waiting.length > 0 ? { level: "waiting", reasons: waiting } : { level: "ok", reasons: [] };
}

// --- history ------------------------------------------------------------------------------------

export type HistoryRowView = {
  seq: number;
  at: string;
  label: string;
  detail: string | null;
  known: boolean;
  /** Why this happens, from the kind alone; a kind with no words gets the general sentence. */
  cause: string;
};

function eventLabel(kind: string, summary: string): string {
  return Object.hasOwn(zh.history.kind, kind)
    ? (zh.history.kind[kind] ?? kind)
    : displayText(summary, 200, displayText(kind, 64, "?"));
}

/**
 * Pages are ascending inside and `nextCursor` walks to older events. The UI shows the newest on top:
 * merge every loaded page, drop repeated `seq`, sort descending.
 */
export function historyRows(pages: readonly RunHistoryPage[]): HistoryRowView[] {
  const bySeq = new Map<number, RunHistoryEntryView>();
  for (const page of pages) {
    for (const entry of page.events) if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
  }
  return [...bySeq.values()]
    .sort((left, right) => right.seq - left.seq)
    .map((entry) => {
      const known = Object.hasOwn(zh.history.kind, entry.kind);
      return {
        seq: entry.seq,
        at: shortTime(entry.at),
        label: eventLabel(entry.kind, entry.summary),
        detail: known && entry.taskId !== null ? textOf(entry.taskId, 64) : null,
        known,
        cause: eventCause(entry.kind).cause,
      };
    });
}

// --- one model for the component ---------------------------------------------------------------

export type EngineModel = {
  runId: string;
  lifecycle: string;
  teamName: string;
  needs: NeedsYou;
  dag: DagLayout;
  tasks: TaskRowView[];
  locks: LockViewModel;
  budgets: BudgetRowView[];
  decisions: DecisionRowView[];
  channels: ChannelRowView[];
  alerts: AlertRowView[];
  history: HistoryRowView[];
  nextCursor: string | null;
  notices: string[];
};

export function buildEngineModel(
  state: Extract<EngineState, { kind: "ready" }>,
  older: readonly RunHistoryPage[],
  compact: boolean,
): EngineModel {
  const { run, history } = state;
  const pages = [history, ...older];
  const loaded = pages.flatMap((page) => page.events);
  const context: TaskContext = {
    tasks: run.tasks,
    locks: run.locks,
    decisions: run.decisions,
    history: loaded,
  };
  return {
    runId: textOf(run.runId, 96),
    lifecycle: ownText(zh.lifecycle, run.lifecycle) ?? textOf(run.lifecycle, 32),
    teamName: displayText(run.team.name, 80, ""),
    needs: needsYou(run),
    dag: dagLayout(run.dag, compact ? "list" : "columns"),
    tasks: run.tasks.map((task) => taskRow(task, context)),
    locks: lockView(run),
    budgets: budgetRows(run.budgets),
    decisions: decisionRows(run.decisions, run.tasks),
    channels: channelRows(run.channels),
    alerts: alertRows(run.alerts),
    history: historyRows(pages),
    nextCursor: (older.at(-1) ?? history).nextCursor,
    notices: state.notices,
  };
}

/** Header level for a non-ready state, so the card never calls an unreadable run "fine". */
export function stateNeedsYou(state: EngineState): NeedsYou {
  if (state.kind === "ready") return needsYou(state.run);
  if (state.kind === "unchanged") return { level: "ok", reasons: [] };
  return { level: "needs-you", reasons: [zh.needsYou.failure] };
}
