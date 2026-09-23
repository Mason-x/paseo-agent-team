import type { PaseoProfile, ProviderAvailability } from "../client/paseo/adapter";
import type { Role } from "../shared/schemas/role";
import type { Team } from "../shared/schemas/team";

export const NOW = "2026-09-19T12:00:00.000Z";

export const claudeOpus: PaseoProfile = {
  id: "claude-opus-high",
  name: "Claude Opus High",
  provider: "claude",
  model: "opus",
  notes: "High thinking",
};

export const codexXhigh: PaseoProfile = {
  id: "codex-xhigh",
  name: "Codex xhigh",
  provider: "codex",
  model: "gpt-5.5",
};

export const allAvailable: ProviderAvailability[] = [
  { provider: "claude", available: true },
  { provider: "codex", available: true },
];

export function role(overrides: Partial<Role> & Pick<Role, "id" | "name">): Role {
  return {
    mission: "Do the job.",
    responsibilities: ["Ship the assigned work"],
    restrictions: [],
    systemPrompt: "Follow the coordinator.",
    outputContract: [],
    preferredProfiles: [{ profileId: claudeOpus.id, nameSnapshot: claudeOpus.name }],
    fallbackProfiles: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export const architect = role({
  id: "architect",
  name: "Architect",
  description: "Chooses structure.",
  mission: "Keep the change consistent with the architecture.",
  responsibilities: ["Pick module boundaries", "Document tradeoffs"],
  restrictions: ["Do not rewrite unrelated modules"],
  systemPrompt: "Stay inside the current architecture.",
  outputContract: ["Recommended structure"],
  fallbackProfiles: [{ profileId: codexXhigh.id, nameSnapshot: codexXhigh.name }],
});

export const developer = role({
  id: "developer",
  name: "Developer",
  preferredProfiles: [{ profileId: codexXhigh.id, nameSnapshot: codexXhigh.name }],
  systemPrompt: "Implement the assigned files.",
});

export const techLead = role({
  id: "tech-lead",
  name: "Tech Lead",
  mission: "Coordinate the team.",
  responsibilities: ["Split work", "Synthesize"],
  systemPrompt: "Delegate with send_agent_prompt.",
});

export const codingTeam: Team = {
  id: "coding-team",
  name: "Coding Team",
  description: "Implement a software change.",
  coordinatorRoleId: "tech-lead",
  members: [
    { roleId: "architect", enabled: true },
    { roleId: "developer", instanceLabel: "Backend", enabled: true },
  ],
  operatingRules: "Implementation and review must be different members.",
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};
