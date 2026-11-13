import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { projectConfigRpc, runStartRpc, teamSettings } from "../shared/rpc";
import {
  buildStartInput,
  type Draft,
  draftProblems,
  emptyDraft,
  type HostProject,
  matchProfile,
  matchReviewers,
  profileSpec,
  projectsFromHost,
  seedFromPrompt,
} from "./start-input";
import {
  Btn,
  Chip,
  errorText,
  Field,
  Input,
  ProfileChips,
  ReviewerSeats,
  Row,
  ThemeProvider,
  Txt,
  useProfiles,
  useTheme,
} from "./ui";

type Props = {
  open: boolean;
  repoPath?: string;
  prompt?: string;
  openNonce?: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
};

export function NewRunDialog({ open, repoPath, prompt, openNonce, onClose, onStarted }: Props) {
  const paseo = usePaseo();
  const start = useRpc(runStartRpc);
  const projectConfig = useRpc(projectConfigRpc);
  const settings = useSettings(teamSettings);
  const toast = useToast();
  const profiles = useProfiles(open);
  const [d, setD] = useState<Draft>(() => emptyDraft(repoPath));
  const [hostProjects, setHostProjects] = useState<HostProject[]>([]);
  const [cfgMsg, setCfgMsg] = useState<{ color?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const touched = useRef({ repo: false, profiles: false });
  const lastNonce = useRef<string | undefined>(undefined);
  const set = (patch: Partial<Draft>) => setD((s) => ({ ...s, ...patch }));
  const theme = useTheme();
  const c = theme.colors;
  const readyValues = settings.status === "ready" ? settings.values : null;

  useEffect(() => {
    if (!open) return;
    Promise.all([
      paseo.projects.list().catch(() => null),
      paseo.workspaces.list().catch(() => null),
    ]).then(([p, w]) => setHostProjects(projectsFromHost(p, w)));
  }, [open, paseo]);

  useEffect(() => {
    if (!open) return;
    if (openNonce !== lastNonce.current) {
      lastNonce.current = openNonce;
      touched.current.repo = false;
      setD((s) => ({
        ...s,
        ...(prompt?.trim() ? seedFromPrompt(prompt) : {}),
        ...(repoPath ? { repoPath } : {}),
      }));
    } else if (repoPath && !touched.current.repo) setD((s) => ({ ...s, repoPath }));
  }, [open, repoPath, prompt, openNonce]);

  useEffect(() => {
    if (!open || !profiles.length || !readyValues || touched.current.profiles) return;
    const defWriter = matchProfile(profiles, readyValues.writer);
    const defReviewers = matchReviewers(profiles, readyValues.reviewers);
    setD((s) => ({
      ...s,
      ...(defWriter && !s.writer ? { writer: defWriter } : {}),
      ...(s.reviewers.every((r) => !r) && defReviewers.some(Boolean)
        ? { reviewers: defReviewers }
        : {}),
    }));
  }, [open, profiles, readyValues]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the path matters here
  useEffect(() => {
    if (!open || !d.repoPath.trim()) return setCfgMsg(null);
    const timer = setTimeout(async () => {
      setCfgMsg({ text: "正在检查 paseo-team.json…" });
      try {
        const { config, error } = await projectConfig({ path: d.repoPath.trim() });
        if (error || !config) {
          set({ env: undefined, limits: undefined, timeouts: {} });
          return setCfgMsg(
            error ? { color: c.statusDanger, text: `paseo-team.json 解析失败：${error}` } : null,
          );
        }
        const timeouts = Object.fromEntries(
          (config.gate ?? []).map((g) => [g.command, g.timeoutSec]),
        );
        set({
          ...(config.gate && { gate: config.gate.map((g) => g.command).join("\n"), timeouts }),
          ...(config.protectedPaths && { protectedPaths: config.protectedPaths.join("\n") }),
          env: config.env,
          limits: config.limits,
        });
        setCfgMsg({
          color: c.statusSuccess,
          text: `已载入 paseo-team.json（${config.gate?.length ?? 0} 条门禁命令）`,
        });
      } catch {
        setCfgMsg(null);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [open, d.repoPath]);

  const problems = draftProblems(d);
  async function submit() {
    setBusy(true);
    try {
      const { run, warnings } = await start(buildStartInput(d));
      if (warnings.length) toast.show(warnings.join("\n"), { variant: "warning" });
      if (settings.status === "ready" && d.writer && d.reviewers.every(Boolean)) {
        const next = {
          maxActiveRuns: settings.values.maxActiveRuns,
          writer: profileSpec(d.writer),
          reviewers: d.reviewers.flatMap((r) => (r ? [profileSpec(r)] : [])),
        };
        void settings.save(next, settings.revision);
      }
      touched.current = { repo: false, profiles: false };
      setD(emptyDraft(repoPath));
      onStarted(run.id);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const textField = (
    label: string,
    key: "title" | "baseRef" | "task" | "gate" | "protectedPaths",
    lines?: number,
  ) => (
    <Field label={label}>
      <Input value={d[key]} onChange={(v) => set({ [key]: v })} lines={lines} />
    </Field>
  );
  const pickRepo = (repoPath: string) => {
    touched.current.repo = true;
    set({ repoPath });
  };
  const pickPref =
    <K extends "writer" | "reviewers">(k: K) =>
    (v: Draft[K]) => {
      touched.current.profiles = true;
      set({ [k]: v });
    };

  return (
    <Modal title="新建 Team Run" open={open} onOpenChange={(o) => !o && onClose()}>
      <Modal.Content>
        <ThemeProvider value={theme}>
          {textField("标题", "title")}
          <Field label="仓库路径">
            {hostProjects.length > 0 && (
              <Row>
                {hostProjects.map((p) => (
                  <Chip
                    key={p.path}
                    icon="FolderGit2"
                    label={p.name}
                    a11y={`选择仓库 ${p.name}`}
                    on={d.repoPath.trim() === p.path}
                    onPress={() => pickRepo(p.path)}
                  />
                ))}
              </Row>
            )}
            <Input value={d.repoPath} onChange={pickRepo} />
            {cfgMsg && (
              <Txt size={12} color={cfgMsg.color} muted={!cfgMsg.color}>
                {cfgMsg.text}
              </Txt>
            )}
          </Field>
          {textField("基线分支", "baseRef")}
          {textField("任务说明（“怎么验证”一节由验收命令生成）", "task", 10)}
          {textField("验收命令（每行一条，启动后冻结）", "gate", 3)}
          {textField("受保护路径（每行一个 glob，写手不能改）", "protectedPaths", 3)}
          <Field label="写手">
            <ProfileChips profiles={profiles} value={d.writer} onPick={pickPref("writer")} />
          </Field>
          <ReviewerSeats
            profiles={profiles}
            reviewers={d.reviewers}
            onChange={pickPref("reviewers")}
          />
          {problems.length > 0 && (
            <Txt size={13} color={c.statusWarning}>
              {problems.join("；")}
            </Txt>
          )}
          <Row>
            <Btn
              kind="primary"
              icon="Play"
              label={busy ? "启动中…" : "启动"}
              disabled={busy || problems.length > 0}
              onPress={() => void submit()}
            />
            <Btn label="取消" onPress={onClose} />
          </Row>
        </ThemeProvider>
      </Modal.Content>
    </Modal>
  );
}
