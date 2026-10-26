import { Pressable, Text, View } from "react-native";
import {
  memberState,
  type RunAgentSnapshot,
  runProgress,
  type TeamRun,
} from "../../shared/domain/run-progress";
import { LABELS } from "../../shared/paseo/labels";
import { zh } from "../../shared/zh";
import type { PluginTheme } from "../shared/theme";
import {
  deliveredRatio,
  MEMBER_STATE_LABELS,
  memberStateColor,
  PHASE_LABELS,
  ProgressBar,
} from "./progress-ui";
import { useTimelineDigest } from "./use-digest";

function agentRole(agent: RunAgentSnapshot): string {
  const labels = agent.labels ?? {};
  const role =
    labels[LABELS.roleName] ?? labels[LABELS.role] ?? agent.title ?? agent.id.slice(0, 8);
  const instance = labels[LABELS.instance];
  return instance ? `${role} (${instance})` : role;
}

function providerModel(agent: RunAgentSnapshot): string {
  return agent.model ? `${agent.provider}/${agent.model}` : agent.provider;
}

/** The coordinator's own todo list is the best overall measure; member delivery is the fallback. */
function PlanSummary({
  theme,
  run,
  coordinator,
}: {
  theme: PluginTheme;
  run: TeamRun;
  coordinator: RunAgentSnapshot;
}) {
  const digest = useTimelineDigest(coordinator);
  const todos = digest.data?.todos;
  const progress = runProgress(run);
  const ratio = deliveredRatio(progress);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
          {zh.plan} · {PHASE_LABELS[progress.phase]}
        </Text>
        <Text style={muted}>
          {todos
            ? zh.todoProgress(todos.done, todos.total)
            : progress.assigned > 0
              ? zh.memberProgress(progress.delivered, progress.assigned)
              : zh.waitingForDelegation}
        </Text>
      </View>
      {todos ? (
        <ProgressBar theme={theme} value={todos.total > 0 ? todos.done / todos.total : 0} />
      ) : ratio !== null ? (
        <ProgressBar theme={theme} value={ratio} />
      ) : null}
      {todos?.active ? (
        <Text style={muted} numberOfLines={2}>
          ▸ {todos.active}
        </Text>
      ) : null}
      {digest.data?.report && coordinator.status !== "running" ? (
        <Text style={muted} numberOfLines={3}>
          {zh.lastReport}：{digest.data.report.text}
        </Text>
      ) : null}
    </View>
  );
}

function MemberProgressRow({
  theme,
  agent,
  onOpen,
}: {
  theme: PluginTheme;
  agent: RunAgentSnapshot;
  onOpen?: (agentId: string) => void;
}) {
  const state = memberState(agent);
  const digest = useTimelineDigest(agent, state !== "not-started");
  const color = memberStateColor(state, theme.colors);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 };
  const todos = digest.data?.todos;
  const body = (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
        <Text
          style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}
          numberOfLines={1}
        >
          {agentRole(agent)}
        </Text>
        <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{MEMBER_STATE_LABELS[state]}</Text>
        {todos ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {zh.todoProgress(todos.done, todos.total)}
          </Text>
        ) : null}
        <Text
          style={{ color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 }}
          numberOfLines={1}
        >
          {providerModel(agent)}
        </Text>
      </View>
      {state === "not-started" ? (
        <Text style={muted}>{zh.noAssignment}</Text>
      ) : digest.isPending ? (
        <Text style={muted}>{zh.loadingDetail}</Text>
      ) : (
        <>
          {digest.data?.assignment ? (
            <Text style={muted} numberOfLines={2}>
              {zh.assignment}：{digest.data.assignment.text}
            </Text>
          ) : null}
          {todos?.active && state === "working" ? (
            <Text style={muted} numberOfLines={1}>
              ▸ {todos.active}
            </Text>
          ) : null}
          {digest.data?.report ? (
            <Text style={muted} numberOfLines={3}>
              {zh.lastReport}：{digest.data.report.text}
            </Text>
          ) : null}
        </>
      )}
      {agent.lastError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }} numberOfLines={2}>
          {agent.lastError}
        </Text>
      ) : null}
    </View>
  );
  if (!onOpen) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={zh.openAgent(agentRole(agent))}
      onPress={() => onOpen(agent.id)}
      style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
    >
      {body}
    </Pressable>
  );
}

/** Plan and per-member assignment/report for one run. Timelines load only while it is shown. */
export function RunDetail({
  theme,
  run,
  onOpenAgent,
}: {
  theme: PluginTheme;
  run: TeamRun;
  onOpenAgent?: (agentId: string) => void;
}) {
  return (
    <View
      style={{
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      {run.coordinator ? (
        <PlanSummary theme={theme} run={run} coordinator={run.coordinator} />
      ) : null}
      {run.members.map((member) => (
        <MemberProgressRow key={member.id} theme={theme} agent={member} onOpen={onOpenAgent} />
      ))}
    </View>
  );
}
