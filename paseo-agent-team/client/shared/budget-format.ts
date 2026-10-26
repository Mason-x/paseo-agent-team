import type { SeatPreview } from "../../shared/schemas/launch-preview";
import { zh } from "../../shared/zh";

const BUDGET_LABELS: Record<SeatPreview["budget"], string> = {
  economy: zh.modes.budgetValueEconomy,
  sota: zh.modes.budgetValueSota,
  unknown: zh.modes.budgetValueUnknown,
};

const BASIS_LABELS: Record<SeatPreview["budgetBasis"], string> = {
  host: zh.modes.budgetBasisHost,
  pool: zh.modes.budgetBasisPool,
  "conservative-default": zh.modes.budgetBasisConservative,
};

/** Shared launch/design budget wording; labels live in `zh.modes`. */
export function formatLaunchBudget(
  budget?: SeatPreview["budget"],
  basis?: SeatPreview["budgetBasis"],
): string {
  const budgetLabel = budget ? BUDGET_LABELS[budget] : zh.modes.budgetValueUnknown;
  return basis ? `${budgetLabel} · ${BASIS_LABELS[basis]}` : budgetLabel;
}
