import type { PaseoProfile } from "../paseo/adapter";
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";

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
    `## Working with the team\n${bulletList(MEMBER_TEAMWORK)}`,
    "",
    "## When you finish a task, reply with",
    finishBlock,
  ].join("\n");
}

const MEMBER_TEAMWORK = [
  "Paseo forwards your final reply to the coordinator. Do not message the coordinator with send_agent_prompt unless it asks you to.",
  "For multi-step work, keep a short todo list so the team's progress view shows where you are.",
  "If you are blocked or the task is ambiguous, stop and state exactly what you need.",
];

export type CoordinatorRosterEntry = {
  seatId: string;
  role: PromptRole;
  instanceLabel?: string;
  profile: Pick<PaseoProfile, "name" | "provider" | "model"> | null;
  activation: "eager" | "on-demand" | "escalation-only";
};

export function compileCoordinatorSystemPrompt(input: {
  role: PromptRole;
  team: Pick<Team, "name" | "operatingRules">;
  /** Planned seats for this run. Omitted keeps the legacy "already running" prompt. */
  roster?: readonly CoordinatorRosterEntry[];
  /** False means this version cannot create standby escalation seats yet. */
  escalationAvailable?: boolean;
}): string {
  const roster = input.roster && input.roster.length > 0 ? input.roster : undefined;
  const escalationAvailable = input.escalationAvailable === true;
  const standbyPhrase = escalationAvailable
    ? "standby seats are not created until the run explicitly escalates"
    : "standby seats are not created by this version";
  const firstBullet = roster
    ? `The roster below lists this run's planned seats. "running" seats are already your subagents; "on first task" seats are created when you first delegate to them; ${standbyPhrase}. Do not use create_agent for a seat that is already planned.`
    : "Your team members are already running as your subagents. Their IDs and roles arrive in the first user message.";
  const parts = [
    `You are the ${input.role.name}, coordinator of the "${input.team.name}" team in Paseo.`,
    roleSections(input.role),
    `## How this team works
- ${firstBullet}
- Delegate with send_agent_prompt(agentId, prompt). Keep notifyOnFinish at its default: Paseo notifies you with the member's final reply when it finishes, fails, or needs permission. Do not poll get_agent_status, get_agent_activity, or list_agents in a loop.
- Give each member one self-contained task at a time: goal, relevant files, constraints, and expected output. Run independent tasks in parallel.
- A prompt sent to a member that is still working is steered into its current turn, or interrupts it when the provider cannot steer. Wait for its report unless you mean to redirect it.
- Keep your plan as a todo list with one item per delegated task, naming the member that owns it, and update it as reports arrive. The team's progress view reads this list.
- Prefer existing members. Only use create_agent for a role the roster lacks, and then call list_profiles first and copy the profile's provider/model and settings exactly.
- Never call respond_to_permission or kill_agent. Use cancel_agent only to stop a member you have redirected.
- Implementation and independent review must be done by different members when both roles exist.
- When two members would edit the same files at the same time, sequence them or ask one to work in a separate worktree via create_workspace.
- Finish by writing a synthesis for the human: what was done, evidence, open issues, and next steps.`,
  ];
  if (roster) {
    const rows = roster.map((entry) => {
      const state =
        entry.activation === "eager"
          ? "running"
          : entry.activation === "on-demand"
            ? "on first task"
            : escalationAvailable
              ? "standby"
              : "standby (not created in this version)";
      const profile = entry.profile
        ? `${entry.profile.name} (${
            entry.profile.model
              ? `${entry.profile.provider}/${entry.profile.model}`
              : entry.profile.provider
          })`
        : "unavailable";
      return `| ${entry.seatId} | ${entry.role.name}${instanceSuffix(entry.instanceLabel)} | ${profile} | ${state} |`;
    });
    parts.push(
      `## Planned seats\n\n| seatId | role | profile | state |\n| --- | --- | --- | --- |\n${rows.join("\n")}`,
    );
  }
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
    "- Start by writing the plan as a todo list (one item per member task), then delegate.",
    "- Send each member only work that matches its role. Include the concrete files, constraints, and expected output in every prompt.",
    "- Members are idle until you prompt them.",
    "- Report back to the human when the task is complete or blocked.",
  ].join("\n");
}
