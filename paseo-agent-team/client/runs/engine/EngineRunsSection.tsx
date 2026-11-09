import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { displayText, shortTime } from "../../../shared/domain/run-engine/view";
import type { RunHealthEntrySchema, RunSummaryView } from "../../../shared/schemas/run-engine/rpc";
import { runEngineZh as zh } from "../../../shared/zh/run-engine";
import type { PluginLayout, PluginTheme } from "../../shared/theme";
import { EngineView } from "./EngineView";
import { useReasonDrafts } from "./reason-drafts";
import { useEngineControls } from "./use-engine-controls";
import { useEngineRun, type useEngineRuns } from "./use-engine-run";

type Health = z.output<typeof RunHealthEntrySchema>;

export function RunDetailPane({
  theme,
  layout,
  hostId,
  runId,
}: {
  theme: PluginTheme;
  layout: Pick<PluginLayout, "compact">;
  hostId: string;
  runId: string;
}) {
  const { session, error, loadingOlder, refresh, loadOlder } = useEngineRun(hostId, runId, true);
  // The pane stays mounted while a poll cannot show the Run, so the words a person typed live here.
  const drafts = useReasonDrafts(runId);
  const { state: controlState, runner } = useEngineControls(runId, refresh, drafts.clear);
  return (
    <View>
      <EngineView
        theme={theme}
        layout={layout}
        state={session.state}
        older={session.older}
        loadingOlder={loadingOlder}
        embedded
        controls={{
          state: controlState,
          drafts,
          onReplan: (reason) => {
            const held = session.state;
            if (held?.kind === "ready") void runner.replan(reason, held.run.revision);
          },
          onRetry: (offer) => {
            const held = session.state;
            if (held?.kind === "ready") void runner.retry(offer, held.run.revision);
          },
          onAddBudget: (offer, by) => {
            const held = session.state;
            if (held?.kind === "ready") void runner.addBudget(offer, by, held.run.revision);
          },
          onCancelRun: (reason) => {
            const held = session.state;
            if (held?.kind === "ready") void runner.cancelRun(reason, held.run.revision);
          },
          onCancelTask: (offer) => {
            const held = session.state;
            if (held?.kind === "ready") void runner.cancelTask(offer, held.run.revision);
          },
          onKick: () => void runner.kick(),
          onPause: () => {
            const held = session.state;
            if (held?.kind === "ready") void runner.pause(held.run.revision);
          },
          onResume: () => {
            const held = session.state;
            if (held?.kind === "ready") void runner.resume(held.run.revision);
          },
          onDismiss: () => runner.dismiss(),
        }}
        onRefresh={() => void refresh()}
        onLoadOlder={(cursor) => void loadOlder(cursor)}
      />
      {error ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12, padding: 12 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function RunRow({
  theme,
  layout,
  hostId,
  run,
}: {
  theme: PluginTheme;
  layout: Pick<PluginLayout, "compact">;
  hostId: string;
  run: RunSummaryView;
}) {
  const [open, setOpen] = useState(false);
  const counts = useMemo(
    () =>
      Object.entries(run.stateCounts)
        .filter(([, count]) => count > 0)
        .map(([state, count]) => `${zh.taskState[state] ?? displayText(state, 32)} ${count}`)
        .join(" · "),
    [run.stateCounts],
  );
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? zh.list.close : zh.list.open} ${run.teamName}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ padding: 12, gap: 4 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
            {displayText(run.teamName, 80)}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.lifecycle[run.lifecycle] ?? displayText(run.lifecycle, 32)}
          </Text>
          {run.needsAttention ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
              {zh.list.needsAttention}
            </Text>
          ) : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {[counts, shortTime(run.updatedAt)].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {open ? (
        <RunDetailPane theme={theme} layout={layout} hostId={hostId} runId={run.runId} />
      ) : null}
    </View>
  );
}

function HealthRow({ theme, entry }: { theme: PluginTheme; entry: Health }) {
  const subject = entry.runId === null ? zh.list.healthStore : zh.list.healthRun(entry.runId);
  return (
    <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
      {`${subject} · ${zh.list.health[entry.status] ?? displayText(entry.status, 32)}`}
    </Text>
  );
}

/**
 * Engine runs on this host. Renders nothing while there is nothing to show, so a host without any
 * Engine run looks exactly like before. The list and detail read with `run.list` and `run.get`; the
 * controls in a detail (replan, retry, kick, pause, resume) are the only writes, and only what the server names.
 */
export function EngineRunsSection({
  theme,
  layout,
  hostId,
  engine,
}: {
  theme: PluginTheme;
  layout: Pick<PluginLayout, "compact">;
  hostId: string;
  /** The page's one Engine list: the label-derived list reads the same answer, so they never disagree. */
  engine: ReturnType<typeof useEngineRuns>;
}) {
  const { runs, health, capabilities, error } = engine;
  if (runs.length === 0 && health.length === 0 && !error) return null;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          {zh.list.title}
        </Text>
        {capabilities && capabilities.supportedControls.length > 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.list.controlsHint}
          </Text>
        ) : capabilities ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.list.observeOnly}
          </Text>
        ) : null}
      </View>
      {error ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {zh.list.loadFailed}
        </Text>
      ) : null}
      {health.map((entry) => (
        <HealthRow key={`${entry.runId ?? "store"}-${entry.status}`} theme={theme} entry={entry} />
      ))}
      {runs.map((run) => (
        <RunRow key={run.runId} theme={theme} layout={layout} hostId={hostId} run={run} />
      ))}
    </View>
  );
}
