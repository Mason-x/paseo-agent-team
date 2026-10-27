import {
  TEAM_MODE_DISPLAY,
  TEAM_MODES,
  type TeamModeDisplay,
} from "../../shared/domain/mode-contract";
import type { RoleTier, TaskKind, TeamMode } from "../../shared/schemas/team-mode";
import { zh } from "../../shared/zh";
import { modesZh } from "../../shared/zh/modes";

/**
 * The single picker table, derived from the mode contract: 旗舰（SOTA）/ 标准 / 经济 / 协作 in
 * `TEAM_MODES` order, with labels keyed by display identity so no two modes share a name.
 */
export const TEAM_MODE_OPTIONS: readonly {
  value: TeamMode;
  display: TeamModeDisplay;
  label: string;
  hint: string;
}[] = TEAM_MODES.map((value) => {
  const display = TEAM_MODE_DISPLAY[value];
  return { value, display, label: modesZh.modeLabels[display], hint: modesZh.modeHints[display] };
});

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
