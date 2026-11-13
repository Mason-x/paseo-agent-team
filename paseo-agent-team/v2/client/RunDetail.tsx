import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { View, type ViewStyle } from "react-native";
import {
  type ResolveChoice,
  runArtifactRpc,
  runCloseRpc,
  runGetRpc,
  runResolveRpc,
} from "../shared/rpc";
import { type GateAttempt, isActive, type Review, type Run } from "../shared/run";
import { durationLabel } from "./start-input";
import {
  ago,
  Badge,
  BLOCKED_LABEL,
  Box,
  Btn,
  Card,
  Col,
  CopyBtn,
  errorText,
  Input,
  type Nav,
  Row,
  runAccent,
  StatusPill,
  short,
  type Theme,
  Txt,
  usePoll,
  useTheme,
} from "./ui";

const OPTION_LABEL: Record<string, string> = {
  "more-attempts": "再给 3 次验收",
  message: "给写手留言",
  "more-round": "再审一轮",
  "accept-current": "接受当前提交（越过审查）",
  resubmit: "从当前提交重新送审",
  retry: "重试",
  abandon: "放弃",
  merged: "已合并",
  abandoned: "放弃",
};
const NEEDS_CONFIRM = new Set(["abandon", "abandoned", "merged", "accept-current"]);
const STAGES = ["写手实现", "门禁验收", "独立审查", "待合并"] as const;
type ArtifactEntry = { loading: boolean; content?: string | null; path?: string; error?: string };

function stageIndex(run: Run): number {
  const map: Record<string, number> = { writing: 0, gating: 1, reviewing: 2, ready: 3, merged: 4 };
  if (run.state in map) return map[run.state] ?? 0;
  if (run.blockedFrom && run.blockedFrom in map) return map[run.blockedFrom] ?? 0;
  return run.reviews.length > 0 ? 2 : run.attempts.length > 0 ? 1 : 0;
}

const attemptMeta = (res: GateAttempt["result"], c: Theme["colors"]): [string, string] =>
  res === "pass"
    ? ["通过", c.statusSuccess]
    : res === "fail" || res === "error"
      ? [res === "fail" ? "失败" : "出错", c.statusDanger]
      : ["进行中", c.accent];

const reviewMeta = (r: Review, c: Theme["colors"]): [string, string] =>
  r.void
    ? [`已作废：${r.void}`, c.foregroundMuted]
    : r.verdict === "approve"
      ? ["通过", c.statusSuccess]
      : r.verdict === "request-changes"
        ? [`打回 · 阻断 ${r.blocking} 条`, c.statusWarning]
        : ["审查中", c.accent];

const DOT_BASE: ViewStyle = {
  width: 22,
  height: 22,
  borderRadius: 11,
  borderWidth: 1.5,
  alignItems: "center",
  justifyContent: "center",
};

function PipelineStepper({ run }: { run: Run }) {
  const c = useTheme().colors;
  const idx = stageIndex(run);
  const stopped = run.state === "blocked" || run.state === "abandoned";
  const sRow: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 4 };
  return (
    <Card>
      <View style={sRow}>
        {STAGES.map((label, i) => {
          const done = run.state === "merged" || i < idx;
          const fail = stopped && i === idx;
          const curr = !stopped && i === idx;
          const bad = run.state === "blocked" ? c.statusDanger : c.foregroundMuted;
          const ok = done || (curr && run.state === "ready") ? c.statusSuccess : c.accent;
          const col = fail ? bad : done || curr ? ok : c.foregroundMuted;
          const bg = done || fail || curr ? c.surface2 : "transparent";
          const tc = done || curr || fail ? col : undefined;
          const bar: ViewStyle = {
            flex: 1,
            height: 2,
            marginBottom: 16,
            backgroundColor: i < idx ? c.statusSuccess : c.border,
          };
          return (
            <View key={label} style={{ flex: 1, ...sRow }}>
              <View style={{ alignItems: "center", gap: 3 }}>
                <View style={[DOT_BASE, { borderColor: col, backgroundColor: bg }]}>
                  {done || fail ? (
                    <Icon name={done ? "Check" : "X"} size={12} color={col} />
                  ) : (
                    <Txt size={11} bold color={col}>{`${i + 1}`}</Txt>
                  )}
                </View>
                <Txt size={11} bold={curr || fail} color={tc} muted={!tc}>
                  {label}
                </Txt>
              </View>
              {i < STAGES.length - 1 && <View style={bar} />}
            </View>
          );
        })}
      </View>
    </Card>
  );
}

export function RunDetail(p: { id: string; onBack?: () => void; navigation?: Nav }) {
  const { id, onBack, navigation } = p;
  const get = useRpc(runGetRpc);
  const resolve = useRpc(runResolveRpc);
  const close = useRpc(runCloseRpc);
  const fetchArtifact = useRpc(runArtifactRpc);
  const toast = useToast();
  const c = useTheme().colors;
  const { value, error, reload } = usePoll(
    () => get({ id }),
    5000,
    (v) => isActive(v.run),
    id,
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactEntry>>({});
  const autoExpandedRun = useRef<string | null>(null);

  const setArt = (file: string, entry: ArtifactEntry) =>
    setArtifacts((s) => ({ ...s, [file]: entry }));

  async function loadFile(file: string, force = false) {
    if (!force && artifacts[file]?.content !== undefined) return;
    setArt(file, { ...artifacts[file], loading: true, error: undefined });
    try {
      const res = await fetchArtifact({ id, file });
      setArt(file, { loading: false, content: res.content, path: res.path });
    } catch (e) {
      setArt(file, { loading: false, error: errorText(e) });
    }
  }

  function toggleFile(file: string, refresh = false) {
    const next = !openFiles[file];
    setOpenFiles((s) => ({ ...s, [file]: next }));
    if (next) void loadFile(file, refresh);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-expand latest finished review once per Run
  useEffect(() => {
    const run = value?.run;
    if (!run || autoExpandedRun.current === run.id) return;
    const latest = run.reviews.filter((r) => r.verdict).at(-1);
    if (!latest) return;
    autoExpandedRun.current = run.id;
    setOpenFiles((s) => ({ ...s, [latest.reportFile]: true }));
    void loadFile(latest.reportFile);
  }, [value?.run?.id, value?.run?.reviews.length]);

  if (!value) return <Txt muted>{error ?? "读取中…"}</Txt>;
  const { run, waiting, behindBase, pendingPermission, pendingPermissionAgentId } = value;
  const options = waiting.options.filter((o) => o !== "approve-permission");

  async function act(option: string) {
    if (NEEDS_CONFIRM.has(option) && confirm !== option) return setConfirm(option);
    setConfirm(null);
    setBusy(true);
    try {
      if (option === "merged" || option === "abandoned") await close({ id, outcome: option });
      else {
        const extra = option === "more-attempts" ? { n: 3 } : option === "message" ? { text } : {};
        await resolve({ id, choice: { kind: option, ...extra } as ResolveChoice });
        setText("");
      }
      reload();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const why = run.blockedReason
    ? `${BLOCKED_LABEL[run.blockedReason]}${run.blockedNote ? `：${run.blockedNote}` : ""}`
    : waiting.why;
  const openAgent = (agentId?: string | null) => agentId && navigation?.openAgent({ agentId });
  const sub1 = `${run.workspace.branch} ← ${run.repo.baseRef}@${short(run.repo.baseSha)} · 写手 ${run.writer.profile} · ${durationLabel(run.createdAt, run.closedAt)}`;
  const sub2 = `${run.id} · 第 ${run.round}/${run.limits.maxReviewRounds} 轮 · 验收 ${run.attempts.length}/${run.limits.maxGateAttempts} 次 · ${ago(run.lastProgressAt)}更新`;
  const taskOpen = !!openFiles[run.task.file];
  const taskText = artifacts[run.task.file]?.content;
  const sbtn = (label: string, icon: string, onPress: () => void) => (
    <Btn sm icon={icon} label={label} onPress={onPress} />
  );
  const rebaseCmd = `git rebase ${run.repo.baseRef}`;
  const openWs = () => navigation?.openWorkspace({ workspaceId: run.workspace.id });
  const openWr = () => openAgent(run.writer.agentId);
  const openPerm = () => openAgent(pendingPermissionAgentId);
  const togTask = () => toggleFile(run.task.file);
  const [tl, ti] = taskOpen ? ["收起", "ChevronUp"] : ["展开任务说明", "ChevronDown"];
  const art = (file: string, empty: string, md?: boolean, fb?: string) => (
    <ArtifactView entry={artifacts[file]} emptyText={empty} markdown={md} fallbackPath={fb} />
  );
  const actBtn = (o: string) => {
    const kind =
      o === "abandon" || o === "abandoned" ? "danger" : o === "merged" ? "primary" : "plain";
    const label = confirm === o ? `再点一次确认：${OPTION_LABEL[o]}` : (OPTION_LABEL[o] ?? o);
    const dis = busy || (o === "message" && !text.trim());
    return <Btn key={o} kind={kind} label={label} disabled={dis} onPress={() => void act(o)} />;
  };

  return (
    <Col gap={12}>
      <Row between>
        <Row>{onBack && sbtn("返回列表", "ArrowLeft", onBack)}</Row>
        <Row>
          {isActive(run) && navigation && sbtn("打开工作区", "FolderOpen", openWs)}
          {navigation && sbtn("跳到写手", "SquareArrowOutUpRight", openWr)}
          <CopyBtn text={run.workspace.branch} label="复制分支名" toastMsg="已复制分支名" />
          {sbtn("刷新", "RefreshCw", reload)}
        </Row>
      </Row>

      <Col gap={6}>
        <Row>
          <Txt bold size={18} flex>
            {run.title}
          </Txt>
          <Badge state={run.state} />
        </Row>
        <Txt muted size={12}>{`${sub1}\n${sub2}`}</Txt>
      </Col>

      <PipelineStepper run={run} />

      <Card accent={runAccent(run.state, c) ?? c.accent}>
        <Txt muted size={12}>{`现在在等：${waiting.who}`}</Txt>
        <Txt bold color={run.state === "blocked" ? c.statusDanger : undefined}>
          {why}
        </Txt>
        {pendingPermission && (
          <Box bg={c.surface2} border={c.statusWarning}>
            <Txt color={c.statusWarning} bold size={13}>
              有一个权限请求在等人批准
            </Txt>
            {navigation && pendingPermissionAgentId ? (
              <Btn sm kind="primary" icon="ShieldAlert" label="去批准权限" onPress={openPerm} />
            ) : (
              <Txt muted size={12}>
                请到对应 agent 的标签页处理权限请求
              </Txt>
            )}
          </Box>
        )}
        {run.state === "ready" && behindBase ? (
          <Col gap={6}>
            <Txt color={c.statusWarning} size={13}>
              {`基线分支已前进 ${behindBase} 个提交，合并前建议先 rebase 并重新验证`}
            </Txt>
            <CopyBtn text={rebaseCmd} label={`复制 ${rebaseCmd}`} />
          </Col>
        ) : null}
        {options.includes("message") && (
          <Input value={text} onChange={setText} placeholder="留言内容" lines={2} />
        )}
        <Row>{options.map(actBtn)}</Row>
      </Card>

      <Card>
        <Row between>
          <Txt bold>任务说明</Txt>
          <Row>
            {taskOpen && taskText && <CopyBtn text={taskText} label="复制说明" />}
            {sbtn(tl, ti, togTask)}
          </Row>
        </Row>
        {taskOpen && art(run.task.file, `${run.task.file} 不存在`, true)}
      </Card>

      <Txt bold>验收历史</Txt>
      {run.attempts.length === 0 && <Txt muted>还没有送审</Txt>}
      {run.attempts.map((a) => {
        const [resLabel, resColor] = attemptMeta(a.result, c);
        const notes = [...a.policyViolations, ...(a.error ? [a.error] : [])];
        return (
          <Card key={a.n}>
            <Row between>
              <Row>
                <Txt bold>{`第 ${a.n} 次`}</Txt>
                <StatusPill label={resLabel} color={resColor} />
              </Row>
              <CopyBtn text={a.sha} label={short(a.sha)} toastMsg="已复制提交 SHA" />
            </Row>
            {a.checks.map((k) => {
              const isOpen = !!openFiles[k.logFile];
              const code = k.exitCode === null ? "超时" : `退出码 ${k.exitCode}`;
              const line = `${k.name} · ${code} · ${Math.round(k.durationMs / 1000)} 秒`;
              const tog = () => toggleFile(k.logFile, !a.finishedAt);
              const fb = `${run.workspace.path}/${k.logFile}`;
              return (
                <Col key={k.name} gap={6}>
                  <Row between>
                    <Txt size={13} color={k.exitCode === 0 ? c.statusSuccess : c.statusDanger} flex>
                      {line}
                    </Txt>
                    {sbtn(isOpen ? "收起日志" : "展开日志", isOpen ? "ChevronUp" : "Terminal", tog)}
                  </Row>
                  {isOpen && art(k.logFile, "（日志为空或不存在）", false, fb)}
                </Col>
              );
            })}
            {notes.map((v) => (
              <Txt key={v} size={13} color={c.statusDanger}>
                {v}
              </Txt>
            ))}
            {a.summary && (
              <Txt muted size={13}>
                {a.summary}
              </Txt>
            )}
          </Card>
        );
      })}

      <Txt bold>审查历史</Txt>
      {run.reviews.length === 0 && <Txt muted>还没有审查</Txt>}
      {run.reviews.map((r) => {
        const isOpen = !!openFiles[r.reportFile];
        const entry = artifacts[r.reportFile];
        const [label, color] = reviewMeta(r, c);
        const openRev = () => openAgent(r.reviewer.agentId);
        const tog = () => toggleFile(r.reportFile);
        const heading = `第 ${r.round} 轮 ${r.seat} · ${r.reviewer.profile}（${r.reviewer.family}）`;
        return (
          <Card key={r.id}>
            <Row between>
              <Row>
                <Txt bold>{heading}</Txt>
                <StatusPill label={label} color={color} />
                <Txt muted size={12} mono>
                  {short(r.sha)}
                </Txt>
              </Row>
              <Row>
                {navigation && sbtn("跳到审查会话", "SquareArrowOutUpRight", openRev)}
                {r.verdict &&
                  sbtn(isOpen ? "收起报告" : "展开报告", isOpen ? "ChevronUp" : "FileText", tog)}
                {isOpen && entry?.content && <CopyBtn text={entry.content} label="复制报告" />}
              </Row>
            </Row>
            {isOpen && art(r.reportFile, "暂无报告内容", true)}
          </Card>
        );
      })}

      <Txt muted size={12}>{`工作区路径：${run.workspace.path}`}</Txt>
    </Col>
  );
}

function ArtifactView(p: {
  entry?: ArtifactEntry;
  emptyText: string;
  markdown?: boolean;
  fallbackPath?: string;
}) {
  const c = useTheme().colors;
  const { entry } = p;
  const err = entry?.error;
  const msg = !entry || entry.loading ? "读取中…" : (err ?? (!entry.content ? p.emptyText : null));
  if (msg) {
    return (
      <Box>
        <Txt muted={!err} color={err ? c.statusDanger : undefined} size={12}>
          {msg}
        </Txt>
      </Box>
    );
  }
  const content = entry?.content ?? "";
  return (
    <Box>
      {p.markdown ? (
        <Markdown>{content}</Markdown>
      ) : (
        <>
          <Txt mono size={12}>
            {content}
          </Txt>
          <Row>
            <CopyBtn text={content} label="复制日志" />
            <CopyBtn text={entry?.path ?? p.fallbackPath ?? ""} label="复制路径" />
          </Row>
        </>
      )}
    </Box>
  );
}
