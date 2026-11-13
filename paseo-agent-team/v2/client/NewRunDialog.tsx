import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { projectConfigRpc, runStartRpc } from "../shared/rpc";
import { SEATS } from "../shared/run";
import {
  buildStartInput,
  type Draft,
  draftProblems,
  emptyDraft,
  type Profile,
  profilesFromConfig,
} from "./start-input";
import { Btn, errorText, inputStyle, ROW, ThemeProvider, Txt, useTheme } from "./ui";

interface Props {
  open: boolean;
  repoPath?: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
}

export function NewRunDialog({ open, repoPath, onClose, onStarted }: Props) {
  const paseo = usePaseo();
  const start = useRpc(runStartRpc);
  const projectConfig = useRpc(projectConfigRpc);
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => emptyDraft(repoPath));
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((s) => ({ ...s, ...patch }));
  const theme = useTheme();
  const c = theme.colors;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the profiles each time the dialog opens
  useEffect(() => {
    if (!open) return;
    paseo.config
      .get()
      .then((r) => setProfiles(profilesFromConfig(r.config)))
      .catch((e) => toast.error(`读取 Agent Profile 失败：${errorText(e)}`));
  }, [open]);

  // Defaults from the repository's paseo-team.json, once the path has settled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the path matters here
  useEffect(() => {
    if (!open || !d.repoPath.trim()) return;
    const timer = setTimeout(() => {
      projectConfig({ path: d.repoPath.trim() })
        .then(({ config }) => {
          if (!config) return;
          const timeouts = Object.fromEntries(
            (config.gate ?? []).map((g) => [g.command, g.timeoutSec]),
          );
          set({
            ...(config.gate && { gate: config.gate.map((g) => g.command).join("\n"), timeouts }),
            ...(config.protectedPaths && { protectedPaths: config.protectedPaths.join("\n") }),
            limits: config.limits,
          });
        })
        .catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [open, d.repoPath]);

  const problems = draftProblems(d);
  async function submit() {
    setBusy(true);
    try {
      const { run, warnings } = await start(buildStartInput(d));
      if (warnings.length) toast.show(warnings.join("\n"), { variant: "warning" });
      setD(emptyDraft(repoPath));
      onStarted(run.id);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const input = (value: string, onChange: (v: string) => void, lines?: number) => (
    <TextInput
      value={value}
      onChangeText={onChange}
      multiline={lines !== undefined}
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={c.foregroundMuted}
      style={{ ...inputStyle(theme), minHeight: lines ? lines * 20 : undefined }}
    />
  );

  return (
    <Modal title="新建 Team Run" open={open} onOpenChange={(o) => !o && onClose()}>
      <Modal.Content>
        <ThemeProvider value={theme}>
          <Field label="标题">{input(d.title, (title) => set({ title }))}</Field>
          <Field label="仓库路径">{input(d.repoPath, (v) => set({ repoPath: v }))}</Field>
          <Field label="基线分支">{input(d.baseRef, (baseRef) => set({ baseRef }))}</Field>
          <Field label="任务说明（“怎么验证”一节由验收命令生成）">
            {input(d.task, (task) => set({ task }), 10)}
          </Field>
          <Field label="验收命令（每行一条，启动后冻结）">
            {input(d.gate, (gate) => set({ gate }), 3)}
          </Field>
          <Field label="受保护路径（每行一个 glob，写手不能改）">
            {input(d.protectedPaths, (protectedPaths) => set({ protectedPaths }), 3)}
          </Field>
          <Field label="写手">
            <Chips profiles={profiles} value={d.writer} onPick={(writer) => set({ writer })} />
          </Field>
          {SEATS.slice(0, d.reviewers.length).map((seat, i) => (
            <Field key={seat} label={`审查者 ${seat}（须是不逐次等人批准的模式）`}>
              <Chips
                profiles={profiles}
                value={d.reviewers[i]}
                onPick={(p) => set({ reviewers: d.reviewers.map((x, j) => (j === i ? p : x)) })}
              />
              {d.reviewers.length > 1 && (
                <Btn
                  label="移除"
                  onPress={() => set({ reviewers: d.reviewers.filter((_, j) => j !== i) })}
                />
              )}
            </Field>
          ))}
          {d.reviewers.length < 3 && (
            <Btn
              label="＋ 添加审查者"
              onPress={() => set({ reviewers: [...d.reviewers, undefined] })}
            />
          )}
          <Txt size={13} color={c.statusWarning}>
            {problems.join("；")}
          </Txt>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn
              kind="primary"
              label={busy ? "启动中…" : "启动"}
              disabled={busy || problems.length > 0}
              onPress={() => void submit()}
            />
            <Btn label="取消" onPress={onClose} />
          </View>
        </ThemeProvider>
      </Modal.Content>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Txt muted size={12}>
        {label}
      </Txt>
      {children}
    </View>
  );
}

function Chips(p: { profiles: Profile[]; value?: Profile; onPick: (p: Profile) => void }) {
  const { profiles, value, onPick } = p;
  const c = useTheme().colors;
  if (!profiles.length)
    return (
      <Txt muted size={13}>
        没有可选的 Agent Profile：请先在 Paseo 设置里创建
      </Txt>
    );
  return (
    <View style={ROW}>
      {profiles.map((p) => {
        const on = value?.id === p.id;
        return (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityLabel={`选择 ${p.name}`}
            accessibilityState={{ selected: on }}
            onPress={() => onPick(p)}
            style={{
              borderColor: on ? c.accent : c.border,
              borderWidth: 1,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
              backgroundColor: on ? c.surface2 : "transparent",
            }}
          >
            <Text style={{ color: c.foreground, fontSize: 13 }}>{p.name}</Text>
            <Text
              style={{ color: c.foregroundMuted, fontSize: 11 }}
            >{`${p.provider}${p.model ? `/${p.model}` : ""}${p.modeId ? ` · ${p.modeId}` : ""}`}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
