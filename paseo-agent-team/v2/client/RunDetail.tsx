import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { type ResolveChoice, runCloseRpc, runGetRpc, runResolveRpc } from "../shared/rpc";
import { isActive } from "../shared/run";
import {
  ago,
  Badge,
  BLOCKED_LABEL,
  Btn,
  Card,
  errorText,
  inputStyle,
  ROW,
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
const short = (sha: string) => sha.slice(0, 8);

export function RunDetail({ id, onBack }: { id: string; onBack?: () => void }) {
  const get = useRpc(runGetRpc);
  const resolve = useRpc(runResolveRpc);
  const close = useRpc(runCloseRpc);
  const toast = useToast();
  const theme = useTheme();
  const { value, error, reload } = usePoll(
    () => get({ id }),
    5000,
    (v) => isActive(v.run),
    id,
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  if (!value) {
    return <Txt muted>{error ?? "读取中…"}</Txt>;
  }
  const { run, waiting, behindBase, pendingPermission } = value;
  const options = waiting.options.filter((o) => o !== "approve-permission");
  const c = theme.colors;

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
  return (
    <View style={{ gap: 12 }}>
      {onBack && <Btn label="← 返回列表" onPress={onBack} />}
      <Txt bold size={18}>
        {run.title}
      </Txt>
      <Badge state={run.state} />
      <Txt muted size={12}>
        {`${run.id} · 第 ${run.round}/${run.limits.maxReviewRounds} 轮 · 验收 ${run.attempts.length}/${run.limits.maxGateAttempts} 次 · ${ago(run.lastProgressAt)}有进展`}
      </Txt>

      <Card>
        <Txt muted size={12}>{`现在在等：${waiting.who}`}</Txt>
        <Txt bold color={run.state === "blocked" ? c.statusDanger : undefined}>
          {why}
        </Txt>
        {pendingPermission && (
          <Txt color={c.statusWarning}>有一个权限请求在等人批准，请到对应 agent 的标签页处理</Txt>
        )}
        {run.state === "ready" && behindBase ? (
          <Txt color={c.statusWarning}>
            {`基线分支已前进 ${behindBase} 个提交，合并前请先 rebase 并重新验证`}
          </Txt>
        ) : null}
        {options.includes("message") && (
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="留言内容"
            placeholderTextColor={c.foregroundMuted}
            multiline
            style={inputStyle(theme)}
          />
        )}
        <View style={ROW}>
          {options.map((o) => (
            <Btn
              key={o}
              kind={
                o === "abandon" || o === "abandoned"
                  ? "danger"
                  : o === "merged"
                    ? "primary"
                    : "plain"
              }
              label={confirm === o ? `再点一次确认：${OPTION_LABEL[o]}` : (OPTION_LABEL[o] ?? o)}
              disabled={busy || (o === "message" && !text.trim())}
              onPress={() => void act(o)}
            />
          ))}
        </View>
      </Card>

      <Txt bold>验收历史</Txt>
      {run.attempts.length === 0 && <Txt muted>还没有送审</Txt>}
      {run.attempts.map((a) => (
        <Card key={a.n}>
          <Txt
            bold
            color={a.result === "pass" ? c.statusSuccess : a.result ? c.statusDanger : undefined}
          >
            {`第 ${a.n} 次 · ${a.result ?? "进行中"} · ${short(a.sha)}`}
          </Txt>
          {a.checks.map((k) => (
            <Txt key={k.name} size={13} color={k.exitCode === 0 ? c.statusSuccess : c.statusDanger}>
              {`${k.name}：退出码 ${k.exitCode ?? "超时"}，${Math.round(k.durationMs / 1000)} 秒\n日志 ${run.workspace.path}/${k.logFile}`}
            </Txt>
          ))}
          {[...a.policyViolations, ...(a.error ? [a.error] : [])].map((v) => (
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
      ))}

      <Txt bold>审查历史</Txt>
      {run.reviews.length === 0 && <Txt muted>还没有审查</Txt>}
      {run.reviews.map((r) => (
        <Card key={r.id}>
          <Txt
            bold
          >{`第 ${r.round} 轮 ${r.seat} · ${r.reviewer.profile}（${r.reviewer.family}）`}</Txt>
          <Txt size={13} color={r.verdict === "approve" ? c.statusSuccess : undefined}>
            {r.void
              ? `已作废：${r.void}`
              : r.verdict
                ? `${r.verdict === "approve" ? "通过" : "打回"}，阻断 ${r.blocking} 条 · ${short(r.sha)}\n报告 ${run.workspace.path}/${r.reportFile}`
                : "等待结论"}
          </Txt>
        </Card>
      ))}

      <Txt muted size={12}>
        {`分支 ${run.workspace.branch}\n工作区 ${run.workspace.path}\n基线 ${run.repo.baseRef}（${short(run.repo.baseSha)}）`}
      </Txt>
    </View>
  );
}
