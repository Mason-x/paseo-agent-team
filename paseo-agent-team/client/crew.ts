import type { usePaseo } from "@getpaseo/plugin/client";

export type PaseoApi = ReturnType<typeof usePaseo>;
export type PaseoWorkspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
export type AgentEntry = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number];
type AgentSnapshot = AgentEntry["agent"];

const LEGACY_PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export type CrewState = "needs-input" | "failed" | "working" | "ready" | "idle" | "closed";

export const CREW_STATES: readonly CrewState[] = [
  "needs-input",
  "failed",
  "working",
  "ready",
  "idle",
  "closed",
];

export const CREW_STATE_LABELS: Record<CrewState, string> = {
  "needs-input": "需要输入",
  failed: "失败",
  working: "工作中",
  ready: "就绪",
  idle: "空闲",
  closed: "已关闭",
};

const CREW_STATE_ORDER: Record<CrewState, number> = {
  "needs-input": 0,
  failed: 1,
  ready: 2,
  working: 3,
  idle: 4,
  closed: 5,
};

export interface CrewNode {
  entry: AgentEntry;
  depth: number;
  descendantCount: number;
  contextOnly: boolean;
  member: boolean;
}

export interface CrewTreeOptions {
  state: CrewState | null;
  query: string;
  workspaceNames?: ReadonlyMap<string, string>;
}

export function parentAgentId(agent: AgentSnapshot): string | null {
  const firstClass = "parentAgentId" in agent ? agent.parentAgentId : null;
  if (typeof firstClass === "string" && firstClass.trim()) return firstClass.trim();
  const legacy = agent.labels?.[LEGACY_PARENT_AGENT_ID_LABEL];
  return typeof legacy === "string" && legacy.trim().length > 0 ? legacy.trim() : null;
}

export function crewState(agent: AgentSnapshot): CrewState {
  if (agent.status === "error") return "failed";
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") {
    return "needs-input";
  }
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.requiresAttention || agent.attentionReason === "finished") return "ready";
  if (agent.status === "closed") return "closed";
  return "idle";
}

export function isWorking(agent: AgentSnapshot): boolean {
  return agent.status === "running" || agent.status === "initializing";
}

export function agentTitle(entry: AgentEntry): string {
  const title = entry.agent.title?.trim();
  if (title) return title;
  return `Agent ${entry.agent.id.slice(0, 8)}`;
}

export function agentAgeTimestamp(agent: AgentSnapshot): number {
  const value = agent.attentionTimestamp ?? agent.activeTurn?.startedAt ?? agent.updatedAt;
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatAge(timestamp: number, now: number): string {
  if (timestamp <= 0) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  return `${Math.floor(hours / 24)}天`;
}

export function crewCounts(nodes: readonly CrewNode[]): Record<CrewState, number> {
  const counts: Record<CrewState, number> = {
    "needs-input": 0,
    failed: 0,
    working: 0,
    ready: 0,
    idle: 0,
    closed: 0,
  };
  for (const node of nodes) {
    if (node.member) counts[crewState(node.entry.agent)] += 1;
  }
  return counts;
}

function compareEntries(left: AgentEntry, right: AgentEntry): number {
  const byState =
    CREW_STATE_ORDER[crewState(left.agent)] - CREW_STATE_ORDER[crewState(right.agent)];
  if (byState !== 0) return byState;
  const byCreated = Date.parse(left.agent.createdAt) - Date.parse(right.agent.createdAt);
  if (byCreated !== 0) return byCreated;
  return left.agent.id.localeCompare(right.agent.id);
}

function matches(
  entry: AgentEntry,
  query: string,
  workspaceNames: ReadonlyMap<string, string>,
): boolean {
  if (!query) return true;
  const agent = entry.agent;
  const values = [
    agent.title,
    agent.id,
    agent.provider,
    agent.model,
    agent.cwd,
    agent.workspaceId ? workspaceNames.get(agent.workspaceId) : undefined,
    ...Object.values(agent.labels ?? {}),
  ];
  return values.some((value) => value?.toLowerCase().includes(query));
}

export function buildCrewForest(
  entries: readonly AgentEntry[],
  workspaceId: string,
  options: CrewTreeOptions = { state: null, query: "" },
): CrewNode[] {
  const entriesById = new Map(
    entries.filter((entry) => !entry.agent.archivedAt).map((entry) => [entry.agent.id, entry]),
  );
  const childrenByParent = new Map<string, AgentEntry[]>();
  for (const entry of entriesById.values()) {
    const parentId = parentAgentId(entry.agent);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(entry);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareEntries);

  const workspaceMembers = [...entriesById.values()].filter(
    (entry) => entry.agent.workspaceId === workspaceId,
  );
  const memberIds = new Set(workspaceMembers.map((entry) => entry.agent.id));
  const descendantsToVisit = [...memberIds];
  for (let index = 0; index < descendantsToVisit.length; index += 1) {
    const agentId = descendantsToVisit[index];
    if (!agentId) continue;
    for (const child of childrenByParent.get(agentId) ?? []) {
      if (memberIds.has(child.agent.id)) continue;
      memberIds.add(child.agent.id);
      descendantsToVisit.push(child.agent.id);
    }
  }

  const contextIds = new Set<string>();
  for (const member of workspaceMembers) {
    let parentId = parentAgentId(member.agent);
    const ancestors = new Set<string>([member.agent.id]);
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      const parent = entriesById.get(parentId);
      if (!parent) break;
      if (!memberIds.has(parentId)) contextIds.add(parentId);
      parentId = parentAgentId(parent.agent);
    }
  }

  const visibleIds = new Set([...memberIds, ...contextIds]);
  const visibleEntries = [...visibleIds]
    .map((id) => entriesById.get(id))
    .filter((entry): entry is AgentEntry => entry !== undefined);
  const roots = visibleEntries
    .filter((entry) => {
      const parentId = parentAgentId(entry.agent);
      return !parentId || !visibleIds.has(parentId);
    })
    .sort(compareEntries);
  const query = options.query.trim().toLowerCase();
  const workspaceNames = options.workspaceNames ?? new Map<string, string>();

  function countDescendants(agentId: string): number {
    const seen = new Set([agentId]);
    const pending = [...(childrenByParent.get(agentId) ?? [])];
    let total = 0;
    while (pending.length > 0) {
      const child = pending.pop();
      if (!child || seen.has(child.agent.id) || !visibleIds.has(child.agent.id)) continue;
      seen.add(child.agent.id);
      if (memberIds.has(child.agent.id)) total += 1;
      pending.push(...(childrenByParent.get(child.agent.id) ?? []));
    }
    return total;
  }

  function visit(entry: AgentEntry, depth: number, ancestors: ReadonlySet<string>): CrewNode[] {
    if (ancestors.has(entry.agent.id)) return [];
    const nextAncestors = new Set(ancestors).add(entry.agent.id);
    const descendants = (childrenByParent.get(entry.agent.id) ?? []).flatMap((child) =>
      visibleIds.has(child.agent.id) ? visit(child, depth + 1, nextAncestors) : [],
    );
    const member = memberIds.has(entry.agent.id);
    const selfMatches =
      member &&
      (options.state === null || crewState(entry.agent) === options.state) &&
      matches(entry, query, workspaceNames);
    if (!selfMatches && descendants.length === 0) return [];
    return [
      {
        entry,
        depth,
        descendantCount: countDescendants(entry.agent.id),
        contextOnly: !selfMatches,
        member,
      },
      ...descendants,
    ];
  }

  const nodes: CrewNode[] = [];
  const emittedIds = new Set<string>();
  function appendTree(entry: AgentEntry) {
    const tree = visit(entry, 0, new Set());
    for (const node of tree) emittedIds.add(node.entry.agent.id);
    nodes.push(...tree);
  }
  for (const root of roots) appendTree(root);
  for (const entry of visibleEntries.sort(compareEntries)) {
    if (!emittedIds.has(entry.agent.id)) appendTree(entry);
  }
  return nodes;
}

export function collapseCrewNodes(
  nodes: readonly CrewNode[],
  collapsedAgentIds: ReadonlySet<string>,
): CrewNode[] {
  const visible: CrewNode[] = [];
  let hiddenBelowDepth: number | null = null;
  for (const node of nodes) {
    if (hiddenBelowDepth !== null && node.depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = null;
    visible.push(node);
    if (node.descendantCount > 0 && collapsedAgentIds.has(node.entry.agent.id)) {
      hiddenBelowDepth = node.depth;
    }
  }
  return visible;
}
