import { useMemo } from "react";
import type { TeamMember } from "../../shared/schemas/team";
import type { TeamPlanRow } from "../../shared/schemas/team-plan";
import type { PluginTheme } from "../shared/theme";
import { RunEngineEditor } from "./RunEngineEditor";
import { seatProfileFactsFromPlan } from "./seat-profile-facts";

/**
 * The Run Engine part of the Team editor: `RunEngineEditor` plus the one piece of wiring that
 * decides what it is shown. The Profile each seat will use comes from the Team plan's rows, found by
 * the row key the editor sent (`seatProfileFactsFromPlan`); until the plan has answered there are none,
 * and the editor then simply has nothing to warn about. It lives in its own component so a test can
 * mount it without the whole Team editor.
 */
export function RunEngineSection({
  theme,
  members,
  planRows,
  value,
  revision,
  onChange,
}: {
  theme: PluginTheme;
  members: readonly TeamMember[];
  /** The rows of the Team plan's last answer; absent until it has answered. */
  planRows: readonly TeamPlanRow[] | undefined;
  /** The stored `Team.runEngine`, whatever it is. */
  value: unknown;
  revision: string | number;
  onChange: (next: unknown) => void;
}) {
  const seatProfiles = useMemo(
    () => (planRows ? seatProfileFactsFromPlan(members, planRows) : undefined),
    [planRows, members],
  );
  return (
    <RunEngineEditor
      theme={theme}
      members={members}
      value={value}
      revision={revision}
      seatProfiles={seatProfiles}
      onChange={onChange}
    />
  );
}
