import type { z } from "zod";
import type { StartInputSchema } from "../shared/rpc";
import {
  type AgentSpec,
  DEFAULT_PROTECTED,
  type GateCommand,
  reviewerModeProblem,
} from "../shared/run";

export type StartInput = z.input<typeof StartInputSchema>;

export const TASK_TEMPLATE = [
  "# ",
  "## 要什么结果",
  "## 相关代码在哪",
  "## 约束",
  "## 不做什么",
  "## 不能碰的文件",
  "",
].join("\n\n");

export interface Profile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Agent Profiles from the daemon config. The shape is daemon-owned, so malformed entries are skipped. */
export function profilesFromConfig(config: unknown): Profile[] {
  const raw = rec(config)?.agentProfiles;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const r = rec(entry);
    const id = str(r?.id);
    const name = str(r?.name);
    const provider = str(r?.provider);
    if (!r || !id || !name || !provider) return [];
    return [
      {
        id,
        name,
        provider,
        model: str(r.model),
        modeId: str(r.modeId),
        thinkingOptionId: str(r.thinkingOptionId),
        featureValues: rec(r.featureValues) ?? undefined,
      },
    ];
  });
}

export const profileSpec = (p: Profile): AgentSpec => ({
  profile: p.name,
  provider: p.model ? `${p.provider}/${p.model}` : p.provider,
  modeId: p.modeId,
  thinkingOptionId: p.thinkingOptionId,
  featureValues: p.featureValues,
});

export const splitLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function gateFromLines(text: string, timeouts: Record<string, number> = {}): GateCommand[] {
  return splitLines(text).map((command, i) => ({
    name: `${i + 1}-${command.split(/\s+/).slice(0, 2).join(" ")}`.slice(0, 30),
    command,
    timeoutSec: timeouts[command] ?? 600,
  }));
}

/** The server insists on a "怎么验证" section; it is generated from the commands unless the task has one. */
export function withVerification(task: string, commands: string[]): string {
  if (/^##\s*怎么验证/m.test(task)) return task;
  const lines = commands.map((c) => `- \`${c}\``).join("\n");
  return `${task.trimEnd()}\n\n## 怎么验证\n${lines}\n`;
}

export interface Draft {
  title: string;
  repoPath: string;
  baseRef: string;
  task: string;
  gate: string;
  protectedPaths: string;
  timeouts: Record<string, number>;
  limits?: StartInput["limits"];
  writer?: Profile;
  reviewers: (Profile | undefined)[];
}

export const emptyDraft = (repoPath = ""): Draft => ({
  title: "",
  repoPath,
  baseRef: "main",
  task: TASK_TEMPLATE,
  gate: "",
  protectedPaths: DEFAULT_PROTECTED.join("\n"),
  timeouts: {},
  reviewers: [undefined],
});

/** Everything that stops a launch, in the order a person would fix it. Empty means ready. */
export function draftProblems(d: Draft): string[] {
  const out: string[] = [];
  if (!d.title.trim()) out.push("填写标题");
  if (!d.repoPath.trim()) out.push("填写仓库路径");
  if (!d.baseRef.trim()) out.push("填写基线分支");
  if (!splitLines(d.gate).length) out.push("至少一条验收命令");
  if (!d.writer) out.push("选择写手 Profile");
  d.reviewers.forEach((r, i) => {
    if (!r) out.push(`选择审查者 r${i + 1} 的 Profile`);
    else {
      const problem = reviewerModeProblem(`r${i + 1}`, profileSpec(r));
      if (problem) out.push(problem);
    }
  });
  return out;
}

export function buildStartInput(d: Draft): StartInput {
  const commands = splitLines(d.gate);
  if (!d.writer || d.reviewers.some((r) => !r)) throw new Error("Profile 没有选全");
  return {
    title: d.title.trim(),
    repoPath: d.repoPath.trim(),
    baseRef: d.baseRef.trim(),
    taskMarkdown: withVerification(d.task, commands),
    gateCommands: gateFromLines(d.gate, d.timeouts),
    protectedPaths: splitLines(d.protectedPaths),
    limits: d.limits,
    writer: profileSpec(d.writer),
    reviewers: d.reviewers.flatMap((r) => (r ? [profileSpec(r)] : [])),
  };
}
