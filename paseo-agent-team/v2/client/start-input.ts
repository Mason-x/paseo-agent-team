import type { z } from "zod";
import type { StartInputSchema } from "../shared/rpc";
import {
  type AgentSpec,
  DEFAULT_PROTECTED,
  type GateCommand,
  reviewerModeProblem,
} from "../shared/run";

export type StartInput = z.input<typeof StartInputSchema>;

export const TASK_TEMPLATE =
  "# \n\n## 要什么结果\n\n## 相关代码在哪\n\n## 约束\n\n## 不做什么\n\n## 不能碰的文件\n\n";

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
    const id = str(r?.id),
      name = str(r?.name),
      provider = str(r?.provider);
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
  env?: Record<string, string>;
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
    const p = r
      ? reviewerModeProblem(`r${i + 1}`, profileSpec(r))
      : `选择审查者 r${i + 1} 的 Profile`;
    if (p) out.push(p);
  });
  return out;
}

export interface HostProject {
  name: string;
  path: string;
}

const isTempTeamWorkspace = (r: Record<string, unknown>) =>
  [r.name, r.worktreeSlug, r.workspaceDirectory, r.directory].some(
    (v) => typeof v === "string" && /(?:^|[\\/])team[/-]r-/.test(v),
  );

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) || p;

export function projectsFromHost(
  projectsPayload: unknown,
  workspacesPayload: unknown,
): HostProject[] {
  const seen = new Map<string, HostProject>();
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const add = (r: Record<string, unknown> | null) => {
    if (!r || isTempTeamWorkspace(r)) return;
    const p =
      str(r.projectRootPath) ??
      str(r.rootPath) ??
      str(r.path) ??
      str(r.workspaceDirectory) ??
      str(r.directory);
    if (!p || seen.has(p)) return;
    const n = str(r.projectDisplayName) ?? str(r.displayName) ?? str(r.name);
    seen.set(p, { path: p, name: n || baseName(p) });
  };
  const lists = [
    rec(projectsPayload)?.projects ?? projectsPayload,
    rec(workspacesPayload)?.emptyProjects,
    rec(workspacesPayload)?.entries ?? workspacesPayload,
  ];
  for (const list of lists) for (const item of arr(list)) add(rec(item));
  return [...seen.values()];
}

export function seedFromPrompt(prompt?: string): { title: string; task: string } {
  const trimmed = prompt?.trim() ?? "";
  if (!trimmed) return { title: "", task: TASK_TEMPLATE };
  const lines = trimmed.split(/\r?\n/);
  const title = (lines[0]?.trim() ?? "").slice(0, 80);
  const withTitle = TASK_TEMPLATE.replace("# ", `# ${title}`);
  if (lines.length === 1 && trimmed.length <= 80) return { title, task: withTitle };
  return { title, task: withTitle.replace("## 要什么结果", `## 要什么结果\n\n${trimmed}`) };
}

export function matchProfile(profiles: Profile[], spec?: AgentSpec): Profile | undefined {
  if (!spec) return undefined;
  const same = (p: Profile) => p.name === spec.profile && profileSpec(p).provider === spec.provider;
  return (
    profiles.find((p) => same(p) && p.modeId === spec.modeId) ??
    profiles.find(same) ??
    profiles.find((p) => p.name === spec.profile)
  );
}

export function matchReviewers(
  profiles: Profile[],
  specs: AgentSpec[] = [],
): (Profile | undefined)[] {
  const matched = specs.map((s) => matchProfile(profiles, s)).filter((p): p is Profile => !!p);
  return matched.length ? matched : [undefined];
}

export function durationLabel(createdAt: string, closedAt?: string, nowMs = Date.now()): string {
  const start = Date.parse(createdAt),
    end = closedAt ? Date.parse(closedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `耗时 ${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `耗时 ${min} 分钟`;
  const hr = Math.floor(min / 60),
    rem = min % 60;
  return rem ? `耗时 ${hr} 小时 ${rem} 分钟` : `耗时 ${hr} 小时`;
}

export function buildStartInput(d: Draft): StartInput {
  if (!d.writer || d.reviewers.some((r) => !r)) throw new Error("Profile 没有选全");
  return {
    title: d.title.trim(),
    repoPath: d.repoPath.trim(),
    baseRef: d.baseRef.trim(),
    taskMarkdown: withVerification(d.task, splitLines(d.gate)),
    gateCommands: gateFromLines(d.gate, d.timeouts),
    protectedPaths: splitLines(d.protectedPaths),
    env: d.env,
    limits: d.limits,
    writer: profileSpec(d.writer),
    reviewers: d.reviewers.flatMap((r) => (r ? [profileSpec(r)] : [])),
  };
}
