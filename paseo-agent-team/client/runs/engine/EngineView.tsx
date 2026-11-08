import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { controlsOf } from "../../../shared/domain/run-engine/controls";
import {
  type Badge,
  buildEngineModel,
  type EngineModel,
  type EngineState,
  type Tone,
} from "../../../shared/domain/run-engine/view";
import type { RunHistoryPage } from "../../../shared/schemas/run-engine/rpc";
import { runEngineZh as zh } from "../../../shared/zh/run-engine";
import type { PluginLayout, PluginTheme } from "../../shared/theme";
import { EngineControls, type EngineControlsProps } from "./EngineControls";
import { EngineStatus } from "./EngineStatus";

export type EngineViewProps = {
  theme: PluginTheme;
  layout: Pick<PluginLayout, "compact">;
  /**
   * `null` while the first `run.get` is in flight. W01 must retain the last ready state for the
   * same host/run when the response is `unchanged`; passing `unchanged` here intentionally renders
   * nothing, and this component never caches or fabricates a ready view.
   */
  state: EngineState | null;
  /** Older history pages already loaded by the caller, newest page first. */
  older?: readonly RunHistoryPage[];
  loadingOlder?: boolean;
  /** Render without its own scroller, for a page that already scrolls. */
  embedded?: boolean;
  /**
   * The controls of this Run (replan, retry, kick, pause, resume). Left out, the view only observes: no button is
   * drawn, and nothing is said about controls either.
   */
  controls?: Pick<
    EngineControlsProps,
    | "state"
    | "onReplan"
    | "onRetry"
    | "onCancelTask"
    | "onCancelRun"
    | "onAddBudget"
    | "onKick"
    | "onPause"
    | "onResume"
    | "onDismiss"
  >;
  onRefresh: () => void;
  onLoadOlder: (cursor: string) => void;
};

function toneColor(theme: PluginTheme, tone: Tone): string {
  const colors = theme.colors;
  if (tone === "success") return colors.statusSuccess;
  if (tone === "danger") return colors.statusDanger;
  if (tone === "warning") return colors.statusWarning;
  if (tone === "accent") return colors.accent;
  return colors.foregroundMuted;
}

function BadgePill({ theme, badge }: { theme: PluginTheme; badge: Badge }) {
  const color = toneColor(theme, badge.tone);
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: color,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{badge.label}</Text>
    </View>
  );
}

function Section({
  theme,
  title,
  empty,
  children,
}: {
  theme: PluginTheme;
  title: string;
  empty?: string;
  children?: ReactNode;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: 12,
        gap: 8,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {title}
      </Text>
      {children ?? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{empty}</Text>
      )}
    </View>
  );
}

function Muted({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{children}</Text>;
}

function Header({ theme, model }: { theme: PluginTheme; model: EngineModel }) {
  const tone: Tone =
    model.needs.level === "needs-you"
      ? "warning"
      : model.needs.level === "waiting"
        ? "accent"
        : "success";
  const label =
    model.needs.level === "needs-you"
      ? zh.level.needsYou
      : model.needs.level === "waiting"
        ? zh.level.waiting
        : zh.level.ok;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
          {zh.title}
        </Text>
        <BadgePill theme={theme} badge={{ label, tone }} />
        <Muted theme={theme}>{model.lifecycle}</Muted>
      </View>
      <Muted theme={theme}>{[model.teamName, model.runId].filter(Boolean).join(" · ")}</Muted>
      {model.needs.reasons.map((reason) => (
        <Text key={reason} style={{ color: toneColor(theme, tone), fontSize: 12 }}>
          {reason}
        </Text>
      ))}
    </View>
  );
}

function DagPanel({ theme, model }: { theme: PluginTheme; model: EngineModel }) {
  const dag = model.dag;
  const column = (layer: EngineModel["dag"]["layers"][number], width?: number) => (
    <View key={layer.layer} style={{ gap: 6, width }}>
      <Muted theme={theme}>{layer.title}</Muted>
      {layer.nodes.map((node) => (
        <View
          key={node.taskId}
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 8,
            padding: 8,
            gap: 2,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {node.title}
          </Text>
          <Muted theme={theme}>{`${node.taskId} · ${node.state}`}</Muted>
          <Muted theme={theme}>{node.depsLabel}</Muted>
        </View>
      ))}
    </View>
  );
  return (
    <Section
      theme={theme}
      title={zh.sections.dag}
      empty={dag.layers.length === 0 ? zh.empty.dag : undefined}
    >
      {dag.layers.length === 0 ? undefined : dag.mode === "columns" ? (
        <ScrollView horizontal>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {dag.layers.map((layer) => column(layer, 180))}
          </View>
        </ScrollView>
      ) : (
        <View style={{ gap: 10 }}>{dag.layers.map((layer) => column(layer))}</View>
      )}
      {dag.anomalies > 0 ? <Muted theme={theme}>{zh.anomalies(dag.anomalies)}</Muted> : null}
      {dag.truncated ? (
        <Muted theme={theme}>{zh.truncated(dag.truncated.shown, dag.truncated.total)}</Muted>
      ) : null}
    </Section>
  );
}

function Explain({
  theme,
  explain,
}: {
  theme: PluginTheme;
  explain: { why: string; who: string; next: string };
}) {
  return (
    <View style={{ gap: 1 }}>
      <Muted theme={theme}>{`${zh.explain.why}：${explain.why}`}</Muted>
      <Muted theme={theme}>{`${zh.explain.who}：${explain.who}`}</Muted>
      <Muted theme={theme}>{`${zh.explain.next}：${explain.next}`}</Muted>
    </View>
  );
}

function TaskRow({ theme, row }: { theme: PluginTheme; row: EngineModel["tasks"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 4, paddingVertical: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? zh.taskRow.collapse : zh.taskRow.expand} ${row.taskId}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ gap: 4 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <BadgePill theme={theme} badge={row.badge} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13, flex: 1 }}>{row.title}</Text>
        </View>
        <Muted theme={theme}>{row.tierLine}</Muted>
        {row.blocked ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{row.blocked}</Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ gap: 2, paddingLeft: 8 }}>
          <Muted theme={theme}>{row.assignee}</Muted>
          <Muted theme={theme}>{row.counts.join(" · ")}</Muted>
          {row.escalations.map((line) => (
            <Muted key={line} theme={theme}>
              {line}
            </Muted>
          ))}
          {row.waiting ? (
            <Muted theme={theme}>{`${zh.taskRow.reasonLabel}：${row.waiting}`}</Muted>
          ) : null}
          {row.lastEvent ? (
            <Muted theme={theme}>{zh.taskRow.lastEvent(row.lastEvent)}</Muted>
          ) : null}
          <Explain theme={theme} explain={row.explain} />
        </View>
      ) : null}
    </View>
  );
}

function LocksPanel({ theme, model }: { theme: PluginTheme; model: EngineModel }) {
  const { groups, capacity } = model.locks;
  return (
    <Section theme={theme} title={zh.sections.locks}>
      <Text
        style={{
          color: capacity.over ? theme.colors.statusWarning : theme.colors.foreground,
          fontSize: 12,
        }}
      >
        {capacity.text}
      </Text>
      {capacity.over ? <Muted theme={theme}>{zh.locks.over}</Muted> : null}
      {groups.length === 0 ? <Muted theme={theme}>{zh.empty.locks}</Muted> : null}
      {groups.map((group) => (
        <View key={group.taskId} style={{ gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {zh.locks.holder(group.title)}
          </Text>
          {group.claims.map((claim) => (
            <Muted key={claim.claimId} theme={theme}>
              {`${claim.kindLabel} · ${claim.target} · ${claim.accessLabel}${claim.frozen ? ` · ${zh.locks.frozen}` : ""}`}
            </Muted>
          ))}
          {group.waiters.length > 0 ? (
            <Muted theme={theme}>{zh.locks.waiters(group.waiters.join("、"))}</Muted>
          ) : null}
        </View>
      ))}
    </Section>
  );
}

function BudgetPanel({ theme, model }: { theme: PluginTheme; model: EngineModel }) {
  return (
    <Section
      theme={theme}
      title={zh.sections.budgets}
      empty={model.budgets.length === 0 ? zh.empty.budgets : undefined}
    >
      {model.budgets.length === 0
        ? undefined
        : model.budgets.map((row) => (
            <View key={row.key} style={{ gap: 2 }}>
              <Text
                style={{
                  color: row.exhausted ? theme.colors.statusWarning : theme.colors.foreground,
                  fontSize: 12,
                }}
              >
                {`${row.scopeLabel} ${row.subject}${row.exhausted ? ` · ${zh.budgets.exhausted}` : ""}`}
              </Text>
              <Muted theme={theme}>
                {[row.reserved, row.confirmed, row.observed, row.limit].join(" · ")}
              </Muted>
              <Muted theme={theme}>{zh.budgets.ratio(row.ratio)}</Muted>
            </View>
          ))}
    </Section>
  );
}

function DecisionPanel({ theme, model }: { theme: PluginTheme; model: EngineModel }) {
  return (
    <Section
      theme={theme}
      title={zh.sections.decisions}
      empty={model.decisions.length === 0 ? zh.empty.decisions : undefined}
    >
      {model.decisions.length === 0
        ? undefined
        : model.decisions.map((row) => (
            <View key={row.decisionId} style={{ gap: 2 }}>
              <Text
                style={{
                  color: row.open ? theme.colors.statusWarning : theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                {`${row.category} · ${row.stateLabel}`}
              </Text>
              {row.subject ? (
                <Muted theme={theme}>{zh.decisions.subject(row.subject)}</Muted>
              ) : null}
              <Muted theme={theme}>{row.summary}</Muted>
              {row.answered ? <Muted theme={theme}>{row.answered}</Muted> : null}
              <Explain theme={theme} explain={row.explain} />
            </View>
          ))}
    </Section>
  );
}

function ChannelAlertPanel({ theme, model }: { theme: PluginTheme; model: EngineModel }) {
  const empty = model.channels.length === 0 && model.alerts.length === 0;
  return (
    <Section
      theme={theme}
      title={zh.sections.channels}
      empty={empty ? zh.empty.channels : undefined}
    >
      {empty
        ? undefined
        : [
            ...model.channels.map((row) => (
              <View key={`c-${row.channelId}`} style={{ gap: 2 }}>
                <Text
                  style={{
                    color: row.paused ? theme.colors.statusWarning : theme.colors.foreground,
                    fontSize: 12,
                  }}
                >
                  {`${row.channelId} · ${row.stateLabel}`}
                </Text>
                {row.until ? <Muted theme={theme}>{row.until}</Muted> : null}
                {row.code ? <Muted theme={theme}>{row.code}</Muted> : null}
              </View>
            )),
            ...model.alerts.map((row) => (
              <View key={`a-${row.alertId}`} style={{ gap: 2 }}>
                <Text
                  style={{
                    color: row.critical ? theme.colors.statusDanger : theme.colors.foreground,
                    fontSize: 12,
                  }}
                >
                  {`${row.severity} · ${row.stateLabel}`}
                </Text>
                <Muted theme={theme}>{row.summary}</Muted>
              </View>
            )),
          ]}
    </Section>
  );
}

function HistoryList({
  theme,
  model,
  loadingOlder,
  onLoadOlder,
}: {
  theme: PluginTheme;
  model: EngineModel;
  loadingOlder: boolean;
  onLoadOlder: (cursor: string) => void;
}) {
  const cursor = model.nextCursor;
  return (
    <Section
      theme={theme}
      title={zh.sections.history}
      empty={model.history.length === 0 ? zh.empty.history : undefined}
    >
      {model.history.length === 0
        ? undefined
        : model.history.map((row) => (
            <View key={row.seq} style={{ gap: 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                {row.detail ? `${row.label} · ${row.detail}` : row.label}
              </Text>
              <Muted theme={theme}>{row.cause}</Muted>
              <Muted theme={theme}>{`#${row.seq} · ${row.at}`}</Muted>
            </View>
          ))}
      {cursor !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={zh.history.loadOlder}
          disabled={loadingOlder}
          onPress={() => onLoadOlder(cursor)}
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 8,
            backgroundColor: theme.colors.surface2,
            opacity: loadingOlder ? 0.5 : 1,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
            {zh.history.loadOlder}
          </Text>
        </Pressable>
      ) : model.history.length > 0 ? (
        <Muted theme={theme}>
          {model.compactedThroughSeq !== null
            ? zh.history.compacted(model.compactedThroughSeq)
            : zh.history.noMore}
        </Muted>
      ) : null}
    </Section>
  );
}

export function EngineView(props: EngineViewProps) {
  const { theme, layout, state, older, loadingOlder, onRefresh, onLoadOlder } = props;
  const model = useMemo(
    () => (state?.kind === "ready" ? buildEngineModel(state, older ?? [], layout.compact) : null),
    [state, older, layout.compact],
  );
  if (state === null || state.kind !== "ready" || model === null) {
    if (state?.kind === "unchanged") return null;
    return <EngineStatus theme={theme} state={state} onRefresh={onRefresh} />;
  }
  const Frame = props.embedded ? EmbeddedFrame : ScrollView;
  return (
    <Frame>
      <View style={{ padding: layout.compact ? 12 : 16, gap: 12 }}>
        <Header theme={theme} model={model} />
        {props.controls && state.kind === "ready" ? (
          <EngineControls theme={theme} view={controlsOf(state.run)} {...props.controls} />
        ) : null}
        {model.notices.map((notice) => (
          <Muted key={notice} theme={theme}>
            {notice}
          </Muted>
        ))}
        <DagPanel theme={theme} model={model} />
        <Section
          theme={theme}
          title={zh.sections.tasks}
          empty={model.tasks.length === 0 ? zh.empty.tasks : undefined}
        >
          {model.tasks.length === 0
            ? undefined
            : model.tasks.map((row) => <TaskRow key={row.taskId} theme={theme} row={row} />)}
        </Section>
        <LocksPanel theme={theme} model={model} />
        <BudgetPanel theme={theme} model={model} />
        <DecisionPanel theme={theme} model={model} />
        <ChannelAlertPanel theme={theme} model={model} />
        <HistoryList
          theme={theme}
          model={model}
          loadingOlder={loadingOlder === true}
          onLoadOlder={onLoadOlder}
        />
      </View>
    </Frame>
  );
}

/** Inside a page that already scrolls: no second vertical scroller. */
function EmbeddedFrame({ children }: { children: ReactNode }) {
  return <View>{children}</View>;
}
