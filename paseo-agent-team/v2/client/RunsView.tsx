import type { PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { type RunSummary, runListRpc } from "../shared/rpc";
import { NewRunDialog } from "./NewRunDialog";
import { RunDetail } from "./RunDetail";
import {
  ago,
  Badge,
  BLOCKED_LABEL,
  Btn,
  Card,
  type Theme,
  ThemeProvider,
  Txt,
  usePoll,
} from "./ui";

const GROUPS: { title: string; states: RunSummary["state"][] }[] = [
  { title: "需要你处理", states: ["blocked", "ready"] },
  { title: "进行中", states: ["writing", "gating", "reviewing"] },
  { title: "已结束", states: ["merged", "abandoned"] },
];

export function RunsView({ repoPath, startOpen }: { repoPath?: string; startOpen?: boolean }) {
  const list = useRpc(runListRpc);
  const { value, error } = usePoll(
    () => list({}),
    5000,
    () => true,
    "list",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(startOpen === true);
  if (selected) return <RunDetail id={selected} onBack={() => setSelected(null)} />;

  const runs = [...(value?.runs ?? [])].sort((a, b) =>
    b.lastProgressAt.localeCompare(a.lastProgressAt),
  );
  return (
    <View style={{ gap: 12 }}>
      <Btn kind="primary" label="新建 Team Run" onPress={() => setOpen(true)} />
      {!value && <Txt muted>{error ?? "读取中…"}</Txt>}
      {value && runs.length === 0 && <Txt muted>还没有 Run。点“新建 Team Run”交一个任务出去。</Txt>}
      {GROUPS.map((g) => {
        const rows = runs
          .filter((r) => g.states.includes(r.state))
          .slice(0, g.title === "已结束" ? 10 : 50);
        if (!rows.length) return null;
        return (
          <View key={g.title} style={{ gap: 8 }}>
            <Txt bold>{`${g.title}（${rows.length}）`}</Txt>
            {rows.map((r) => (
              <Pressable
                key={r.id}
                accessibilityRole="button"
                accessibilityLabel={`打开 ${r.title}`}
                onPress={() => setSelected(r.id)}
              >
                <Card>
                  <Txt bold>{r.title}</Txt>
                  <Badge state={r.state} />
                  <Txt muted size={12}>
                    {r.blockedReason ? BLOCKED_LABEL[r.blockedReason] : r.waiting.why}
                  </Txt>
                  <Txt
                    muted
                    size={12}
                  >{`第 ${r.round} 轮 · 验收 ${r.gateAttempts} 次 · ${ago(r.lastProgressAt)}有进展`}</Txt>
                </Card>
              </Pressable>
            ))}
          </View>
        );
      })}
      <NewRunDialog
        open={open}
        repoPath={repoPath}
        onClose={() => setOpen(false)}
        onStarted={(id) => {
          setOpen(false);
          setSelected(id);
        }}
      />
    </View>
  );
}

const scroll = (theme: Theme, compact: boolean) => ({
  flex: 1,
  backgroundColor: theme.colors.surface0,
  padding: compact ? 16 : 24,
});

export function RunsScreen({ theme, layout, params }: PluginScreenProps) {
  return (
    <ThemeProvider value={theme}>
      <ScrollView style={scroll(theme, layout.compact)}>
        <RunsView startOpen={params.new === "1"} />
      </ScrollView>
    </ThemeProvider>
  );
}

/** 0.15.4 snapshots have no `branch` and the host may rename `name`, so the directory `team-<runId>-…` counts too. */
export function RunPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const where = useWorkspace(workspaceId, (w) => `${w.name} ${w.directory}`);
  const root = useWorkspace(workspaceId, (w) => w.projectRootPath);
  const runId = /team[/-](r-\d{8}-[0-9a-f]{4})[/-](?:writer|review)/.exec(where ?? "")?.[1];
  return (
    <ThemeProvider value={theme}>
      <ScrollView style={scroll(theme, layout.compact)}>
        {runId ? <RunDetail id={runId} /> : <RunsView repoPath={root ?? undefined} />}
      </ScrollView>
    </ThemeProvider>
  );
}
