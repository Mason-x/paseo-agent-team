import type { RoleTier, TaskKind, TeamMode } from "../../shared/schemas/team-mode";
import { zh } from "../../shared/zh";

export const TEAM_MODE_OPTIONS: readonly {
  value: TeamMode;
  label: string;
  hint: string;
}[] = [
  { value: "sota", label: zh.teamModeSota, hint: zh.teamModeSotaHint },
  { value: "economy", label: zh.teamModeEconomy, hint: zh.teamModeEconomyHint },
  {
    value: "collaborative",
    label: zh.teamModeCollaborative,
    hint: zh.teamModeCollaborativeHint,
  },
];

export const ROLE_TIER_OPTIONS: readonly { value: RoleTier; label: string }[] = [
  { value: "decision", label: zh.roleTierDecision },
  { value: "execution", label: zh.roleTierExecution },
  { value: "escalation", label: zh.roleTierEscalation },
  { value: "retain", label: zh.roleTierRetain },
];

export const TASK_KIND_OPTIONS: readonly { value: TaskKind; label: string }[] = [
  { value: "coding", label: zh.taskKindCoding },
  { value: "testing", label: zh.taskKindTesting },
  { value: "acceptance", label: zh.taskKindAcceptance },
  { value: "codebase", label: zh.taskKindCodebase },
  { value: "ops", label: zh.taskKindOps },
  { value: "general", label: zh.taskKindGeneral },
];

export type MemberCreation = "" | "eager" | "on-demand";

export const MEMBER_CREATION_OPTIONS: readonly { value: MemberCreation; label: string }[] = [
  { value: "", label: zh.memberCreationDefault },
  { value: "eager", label: zh.memberCreationEager },
  { value: "on-demand", label: zh.memberCreationOnDemand },
];

export type RolePolicyChoiceState = {
  executionTier: string;
  executionTaskKind: string;
  executionTierTouched: boolean;
  executionTaskKindTouched: boolean;
};

/** One shared mapping for both policy pickers: choosing an option always marks that field edited. */
export function applyRolePolicyChoice<Draft extends RolePolicyChoiceState>(
  draft: Draft,
  field: "tier" | "taskKind",
  value: string,
): Draft {
  return field === "tier"
    ? { ...draft, executionTier: value, executionTierTouched: true }
    : { ...draft, executionTaskKind: value, executionTaskKindTouched: true };
}
