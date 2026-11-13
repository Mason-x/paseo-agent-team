import {
  type PluginScreenProps,
  type PluginWorkspacePanelProps,
  useRpc,
  useSettings,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";
import { type RunSummary, runListRpc, teamSettings } from "../shared/rpc";
import { isActive } from "../shared/run";
import { NewRunDialog } from "./NewRunDialog";
import { RunDetail } from "./RunDetail";
import { durationLabel } from "./start-input";
import { TeamSettingsModal } from "./TeamSettings";
import {
  ago,
  Badge,
  BLOCKED_LABEL,
  Btn,
  Card,
  Chip,
  Col,
  type Nav,
  Row,
  runAccent,
  StatusPill,
  type Theme,
  ThemeProvider,
  Txt,
  usePoll,
  useTheme,
} from "./ui";

type FilterKey = "all" | "attention" | "running" | "done";
const GROUPS: { key: Exclude<FilterKey, "all">; title: string; states: RunSummary["state"][] }[] = [
  { key: "attention", title: "需要你处理", states: ["blocked", "ready"] },
  { key: "running", title: "进行中", states: ["writing", "gating", "reviewing"] },
  { key: "done", title: "已结束", states: ["merged", "abandoned"] },
];

export function RunsView(p: {
  repoPath?: string;
  startOpen?: boolean;
  prompt?: string;
  openNonce?: string;
  navigation?: Nav;
}) {
  const list = useRpc(runListRpc);
  const settings = useSettings(teamSettings);
  const c = useTheme().colors;
  const { value, error } = usePoll(
    () => list({}),
    5000,
    () => true,
    "list",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(p.startOpen === true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [showAllDone, setShowAllDone] = useState(false);
  const lastNonce = useRef<string | undefined>(p.openNonce);

  useEffect(() => {
    if (!p.startOpen || p.openNonce === lastNonce.current) return;
    lastNonce.current = p.openNonce;
    setSelected(null);
    setOpen(true);
  }, [p.startOpen, p.openNonce]);

  const back = () => setSelected(null);
  const nav = p.navigation;
  if (selected) return <RunDetail key={selected} id={selected} onBack={back} navigation={nav} />;

  const runs = [...(value?.runs ?? [])].sort((a, b) =>
    b.lastProgressAt.localeCompare(a.lastProgressAt),
  );
  const activeCount = runs.filter(isActive).length;
  const maxActive = settings.status === "ready" ? settings.values.maxActiveRuns : 3;
  const ofGroup = (k: Exclude<FilterKey, "all">) =>
    runs.filter((r) => GROUPS.find((g) => g.key === k)?.states.includes(r.state));
  const attnCount = ofGroup("attention").length;
  const tabs: [FilterKey, string, boolean?][] = [
    ["all", `全部 (${runs.length})`],
    ["attention", `待处理 (${attnCount})`, attnCount > 0],
    ["running", `进行中 (${ofGroup("running").length})`],
    ["done", `已结束 (${ofGroup("done").length})`],
  ];
  const visible = filter === "all" ? GROUPS : GROUPS.filter((g) => g.key === filter);
  const goNew = () => setOpen(true);
  const goSet = () => setSettingsOpen(true);
  const onStarted = (id: string) => {
    setOpen(false);
    setSelected(id);
  };

  return (
    <Col gap={14}>
      <Row between>
        <Row>
          <Txt bold size={20}>
            Agent Team
          </Txt>
          <StatusPill
            dot={false}
            label={`活跃 ${activeCount} / ${maxActive}`}
            color={activeCount >= maxActive ? c.statusWarning : c.foregroundMuted}
          />
        </Row>
        <Row>
          <Btn sm icon="SlidersHorizontal" label="默认设置" onPress={goSet} />
          <Btn kind="primary" sm icon="Plus" label="新建任务" onPress={goNew} />
        </Row>
      </Row>

      {runs.length > 0 && (
        <Row>
          {tabs.map(([k, lbl, hi]) => (
            <Chip
              key={k}
              pill
              label={lbl}
              on={filter === k}
              warn={hi}
              onPress={() => setFilter(k)}
            />
          ))}
        </Row>
      )}

      {!value && <Txt muted>{error ?? "读取中…"}</Txt>}

      {value && runs.length === 0 && (
        <Card accent={c.accent}>
          <Txt bold size={16}>
            还没有 Team Run
          </Txt>
          <Txt muted size={13}>
            单写手实现 → 插件跑验收命令 → 跨家族独立审查 → 你决定合并
          </Txt>
          <Row>
            <Btn kind="primary" icon="Plus" label="新建任务" onPress={goNew} />
            <Btn icon="SlidersHorizontal" label="配置默认 Profile" onPress={goSet} />
          </Row>
        </Card>
      )}

      {visible.map((g) => {
        const allRows = ofGroup(g.key);
        if (!allRows.length) return null;
        const rows = allRows.slice(0, g.key === "done" && !showAllDone ? 15 : allRows.length);
        const tog = showAllDone ? "仅看最近 15 条" : `显示全部（${allRows.length}）`;
        return (
          <Col key={g.key}>
            <Row between>
              <Txt bold>{`${g.title}（${allRows.length}）`}</Txt>
              {g.key === "done" && allRows.length > 15 && (
                <Btn sm label={tog} onPress={() => setShowAllDone((v) => !v)} />
              )}
            </Row>
            {rows.map((r) => {
              const subCol =
                r.state === "blocked"
                  ? c.statusDanger
                  : r.state === "ready"
                    ? c.statusWarning
                    : undefined;
              const meta = `写手 ${r.writerProfile} · 第 ${r.round} 轮 · 验收 ${r.gateAttempts} 次 · ${ago(r.lastProgressAt)}更新`;
              const why = r.blockedReason ? BLOCKED_LABEL[r.blockedReason] : r.waiting.why;
              const openWs = () => p.navigation?.openWorkspace({ workspaceId: r.workspaceId });
              const goW = () => p.navigation?.openAgent({ agentId: r.writerAgentId });
              return (
                <Pressable
                  key={r.id}
                  accessibilityRole="button"
                  accessibilityLabel={`打开 ${r.title}`}
                  onPress={() => setSelected(r.id)}
                >
                  <Card accent={runAccent(r.state, c)}>
                    <Row between>
                      <Row flex>
                        <Badge state={r.state} />
                        <Txt bold flex lines={1}>
                          {r.title}
                        </Txt>
                      </Row>
                      <Txt muted size={12}>
                        {durationLabel(r.createdAt, r.closedAt)}
                      </Txt>
                    </Row>
                    <Txt size={13} color={subCol} muted={!subCol}>
                      {why}
                    </Txt>
                    <Row between>
                      <Txt muted size={12} flex>
                        {meta}
                      </Txt>
                      {p.navigation && (
                        <Row>
                          {isActive(r) && (
                            <Btn sm icon="FolderOpen" a11y="打开工作区" onPress={openWs} />
                          )}
                          {r.writerAgentId && (
                            <Btn
                              sm
                              icon="SquareArrowOutUpRight"
                              a11y="打开写手会话"
                              onPress={goW}
                            />
                          )}
                        </Row>
                      )}
                    </Row>
                  </Card>
                </Pressable>
              );
            })}
          </Col>
        );
      })}

      <NewRunDialog
        open={open}
        repoPath={p.repoPath}
        prompt={p.prompt}
        openNonce={p.openNonce}
        onClose={() => setOpen(false)}
        onStarted={onStarted}
      />
      <TeamSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Col>
  );
}

const wrap = (theme: Theme, compact: boolean, body: ReactNode) => (
  <ThemeProvider value={theme}>
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0, padding: compact ? 16 : 24 }}
    >
      {body}
    </ScrollView>
  </ThemeProvider>
);

export function RunsScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  return wrap(
    theme,
    layout.compact,
    <RunsView
      startOpen={params.new === "1"}
      repoPath={params.repo}
      prompt={params.prompt}
      openNonce={params.nonce}
      navigation={navigation}
    />,
  );
}

/** 0.15.4 snapshots have no `branch` and the host may rename `name`, so the directory `team-<runId>-…` counts too. */
export function RunPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const where = useWorkspace(workspaceId, (w) => `${w.name} ${w.directory}`);
  const root = useWorkspace(workspaceId, (w) => w.projectRootPath);
  const runId = /team[/-](r-\d{8}-[0-9a-f]{4})[/-](?:writer|review)/.exec(where ?? "")?.[1];
  return wrap(
    theme,
    layout.compact,
    runId ? (
      <RunDetail key={runId} id={runId} navigation={navigation} />
    ) : (
      <RunsView repoPath={root ?? undefined} navigation={navigation} />
    ),
  );
}
