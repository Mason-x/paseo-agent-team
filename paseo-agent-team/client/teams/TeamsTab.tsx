import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useState } from "react";
import { View } from "react-native";
import type { Role } from "../../shared/schemas/role";
import type { Team } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { resolveCollapseDefault } from "../designer/card-state";
import { TeamDesignerCard, type TeamDesignerCardProps } from "../designer/TeamDesignerCard";
import { ImeTextInput } from "../shared/ImeTextInput";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { TeamList, type TeamListPlans } from "./TeamList";
import type { TeamBindingTarget } from "./team-plan-state";

/**
 * The Team page: the designer on top, then the Team search and list. It renders inside the
 * screen's scroll container, so the designer and the list scroll together.
 */
export function TeamsTab({
  theme,
  layout,
  teams,
  roles,
  designer,
  progress,
  empty,
  onLaunch,
  onEdit,
  onCopy,
  onDelete,
  plans,
  onConfigureEconomy,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  teams: readonly Team[];
  roles: readonly Role[];
  /** Everything the designer card needs except what this tab decides from the Team list. */
  designer: Omit<TeamDesignerCardProps, "theme" | "layout" | "collapseByDefault">;
  /** Jobs and results below the designer; stays mounted while the card is folded. */
  progress?: ReactNode;
  /** Shown between the search box and the list, e.g. the empty-catalog state. */
  empty?: ReactNode;
  onLaunch: (team: Team) => void;
  onEdit: (team: Team) => void;
  onCopy: (team: Team) => void;
  onDelete: (team: Team) => void;
  /** Model-plan summaries supplied by the screen (I02); absent keeps the list as before. */
  plans?: TeamListPlans;
  onConfigureEconomy?: (target: Extract<TeamBindingTarget, { kind: "economy" }>) => void;
}) {
  const [query, setQuery] = useState("");
  const styles = useMemo(
    () => ({
      root: { gap: 10 },
      searchWrap: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        minHeight: 36,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface2,
      },
      search: {
        flex: 1,
        minHeight: 34,
        color: theme.colors.foreground,
        fontSize: 14,
      },
    }),
    [theme],
  );

  return (
    <View style={styles.root}>
      {/* A populated list leaves a narrow screen no room for a full form: fold it to one line. */}
      <TeamDesignerCard
        {...designer}
        theme={theme}
        layout={layout}
        collapseByDefault={resolveCollapseDefault(layout.compact, teams.length)}
      />
      {progress}
      <View style={styles.searchWrap}>
        <Icon name="Search" size={15} color={theme.colors.foregroundMuted} />
        <ImeTextInput
          accessibilityLabel={zh.searchTeams}
          initialValue={query}
          onChangeText={setQuery}
          placeholder={zh.searchTeams}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.search}
        />
      </View>
      {empty}
      <TeamList
        theme={theme}
        teams={teams}
        roles={roles}
        query={query}
        plans={plans}
        onConfigureEconomy={onConfigureEconomy}
        onLaunch={onLaunch}
        onEdit={onEdit}
        onCopy={onCopy}
        onDelete={onDelete}
      />
    </View>
  );
}
