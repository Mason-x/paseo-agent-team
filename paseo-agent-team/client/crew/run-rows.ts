import { type RunProgress, runProgress, type TeamRun } from "../../shared/domain/run-progress";
import { LABELS } from "../../shared/paseo/labels";
import type { RunSummary } from "../../shared/schemas/preferences";
import { zh } from "../../shared/zh";
import type { CrewNode } from "../crew";

export type CrewRunHeader = {
  kind: "run";
  runId: string;
  title: string;
  count: number;
  run?: TeamRun;
  progress?: RunProgress;
};

export type CrewListItem = CrewRunHeader | { kind: "agent"; node: CrewNode };

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

/** Runs label their task on the coordinator; runs from older plugin versions only saved it in preferences. */
export function runTitle(
  runId: string,
  run: TeamRun | undefined,
  legacyRuns: readonly RunSummary[],
  fallbackTeamName?: string,
): string {
  const legacy = legacyRuns.find((entry) => entry.runId === runId);
  const teamName = run?.teamName ?? fallbackTeamName ?? legacy?.teamName ?? zh.teamFallback;
  const task = run?.task ?? legacy?.taskExcerpt;
  return task ? `${teamName} · ${task}` : teamName;
}

export function crewListItems(
  nodes: readonly CrewNode[],
  collapsedRunIds: ReadonlySet<string>,
  context: {
    runs?: ReadonlyMap<string, TeamRun>;
    legacyRuns?: readonly RunSummary[];
  } = {},
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
      const run = context.runs?.get(runId);
      items.push({
        kind: "run",
        runId,
        title: runTitle(
          runId,
          run,
          context.legacyRuns ?? [],
          node.entry.agent.labels?.[LABELS.teamName],
        ),
        count: counts.get(runId) ?? 0,
        run,
        progress: run ? runProgress(run) : undefined,
      });
    }
    if (runId && collapsedRunIds.has(runId)) continue;
    items.push({ kind: "agent", node });
  }
  return items;
}
