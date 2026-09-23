import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import type { PaseoProfile } from "../paseo/adapter";

export type PromptRole = Pick<
  Role,
  | "name"
  | "mission"
  | "responsibilities"
  | "restrictions"
  | "systemPrompt"
  | "outputContract"
  | "description"
>;

function instanceSuffix(instanceLabel?: string): string {
  return instanceLabel ? ` (${instanceLabel})` : "";
}

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function roleSections(role: PromptRole): string {
  const parts = [
    `## Mission\n${role.mission}`,
    `## Responsibilities\n${bulletList(role.responsibilities)}`,
  ];
  if (role.restrictions.length > 0) {
    parts.push(`## Restrictions\n${bulletList(role.restrictions)}`);
  }
  parts.push(`## Role instructions\n${role.systemPrompt}`);
  return parts.join("\n\n");
}

const MEMBER_HARD_RESTRICTIONS = [
  "Do not create, archive, or kill other agents unless the coordinator explicitly asks you to.",
  "Never call respond_to_permission; permission decisions belong to the human.",
];

const DEFAULT_FINISH = [
  "Summary",
  "Evidence (files, commands, sources)",
  "Decisions and open issues",
  "Risks",
  "Recommended next step",
];

export function compileMemberSystemPrompt(input: {
  role: PromptRole;
  teamName: string;
  coordinatorTitle: string;
  instanceLabel?: string;
}): string {
  const restrictionLines = [...input.role.restrictions, ...MEMBER_HARD_RESTRICTIONS];
  const finish = [...DEFAULT_FINISH, ...input.role.outputContract];
  const finishBlock = finish.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const restrictionSection =
    input.role.restrictions.length > 0
      ? `## Restrictions\n${bulletList(restrictionLines)}`
      : `## Restrictions\n${bulletList(MEMBER_HARD_RESTRICTIONS)}`;

  return [
    `You are the ${input.role.name}${instanceSuffix(input.instanceLabel)} of the "${input.teamName}" team in Paseo.`,
    `Your coordinator is the agent "${input.coordinatorTitle}". Work only on tasks it sends you.`,
    "",
    `## Mission\n${input.role.mission}`,
    "",
    `## Responsibilities\n${bulletList(input.role.responsibilities)}`,
    "",
    restrictionSection,
    "",
    `## Role instructions\n${input.role.systemPrompt}`,
    "",
    "## When you finish a task, reply with",
    finishBlock,
  ].join("\n");
}

export function compileCoordinatorSystemPrompt(input: {
  role: PromptRole;
  team: Pick<Team, "name" | "operatingRules">;
}): string {
  const parts = [
    `You are the ${input.role.name}, coordinator of the "${input.team.name}" team in Paseo.`,
    roleSections(input.role),
    `## How this team works
- Your team members are already running as your subagents. Their IDs and roles arrive in the first user message.
- Delegate with send_agent_prompt(agentId, prompt). Leave background/notifyOnFinish at their defaults and wait for finish notifications; do not poll.
- Prefer existing members. Only use create_agent for a role the roster lacks, and then call list_profiles first and copy the profile fields exactly.
- Never call respond_to_permission or kill_agent. Use cancel_agent only to stop a member you have redirected.
- Implementation and independent review must be done by different members when both roles exist.
- When two members would edit the same files at the same time, sequence them or ask one to work in a separate worktree via create_workspace.
- Finish by writing a synthesis for the human: what was done, evidence, open issues, and next steps.`,
  ];
  if (input.team.operatingRules?.trim()) {
    parts.push(input.team.operatingRules.trim());
  }
  return parts.join("\n\n");
}

export type KickoffRosterEntry = {
  agentId: string;
  role: PromptRole;
  instanceLabel?: string;
  profile: Pick<PaseoProfile, "name" | "provider" | "model">;
};

export function compileKickoffMessage(input: {
  task: string;
  runId: string;
  roster: readonly KickoffRosterEntry[];
}): string {
  const rows = input.roster.map((entry) => {
    const roleLabel = `${entry.role.name}${instanceSuffix(entry.instanceLabel)}`;
    const summary =
      entry.role.description ?? entry.role.mission.split(/(?<=\.)\s/)[0] ?? entry.role.mission;
    const model = entry.profile.model
      ? `${entry.profile.provider}/${entry.profile.model}`
      : entry.profile.provider;
    return `| ${entry.agentId} | ${roleLabel} — ${summary} | ${entry.profile.name} (${model}) |`;
  });
  return [
    "# Task",
    input.task,
    "",
    `# Your team (run ${input.runId})`,
    "| agentId | role | profile |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "# Rules",
    "- Send each member only work that matches its role. Include the concrete files, constraints, and expected output in every prompt.",
    "- Members are idle until you prompt them.",
    "- Report back to the human when the task is complete or blocked.",
  ].join("\n");
}
