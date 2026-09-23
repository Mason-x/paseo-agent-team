import type { RunSummary } from "../../shared/schemas/preferences";
import { zh } from "../../shared/zh";
import type { CrewNode } from "../crew";
import { LABELS } from "../paseo/labels";

export type CrewListItem =
  | { kind: "run"; runId: string; title: string; count: number }
  | { kind: "agent"; node: CrewNode };

export function runIdOf(node: CrewNode): string | undefined {
  const value = node.entry.agent.labels?.[LABELS.run];
  return value?.trim() ? value : undefined;
}

export function roleLine(node: CrewNode): string | undefined {
  const labels = node.entry.agent.labels ?? {};
  const roleName = labels[LABELS.roleName] ?? labels[LABELS.role];
  if (!roleName) return undefined;
  const instance = labels[LABELS.instance];
  const teamName = labels[LABELS.teamName] ?? labels[LABELS.team];
  return `${roleName}${instance ? ` (${instance})` : ""}${teamName ? ` · ${teamName}` : ""}`;
}

export function crewListItems(
  nodes: readonly CrewNode[],
  collapsedRunIds: ReadonlySet<string>,
  recentRuns: readonly RunSummary[],
): CrewListItem[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const runId = runIdOf(node);
    if (runId) counts.set(runId, (counts.get(runId) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const items: CrewListItem[] = [];
  for (const node of nodes) {
    const runId = runIdOf(node);
    if (runId && !seen.has(runId)) {
      seen.add(runId);
      const summary = recentRuns.find((run) => run.runId === runId);
      const teamName =
        node.entry.agent.labels?.[LABELS.teamName] ?? summary?.teamName ?? zh.teamFallback;
      const excerpt = summary?.taskExcerpt ?? "";
      const count = counts.get(runId) ?? 0;
      const title = excerpt
        ? `${teamName} · ${excerpt} · ${count} ${zh.agentsSuffix}`
        : `${teamName} · ${count} ${zh.agentsSuffix}`;
      items.push({ kind: "run", runId, title, count });
    }
    if (runId && collapsedRunIds.has(runId)) continue;
    items.push({ kind: "agent", node });
  }
  return items;
}
