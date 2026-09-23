import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { zh } from "../../shared/zh";
import {
  DEFAULT_ROLE_ICON,
  IDENTITY_COLOR_NAMES,
  type IdentityColor,
  identityForeground,
  pickerIconNames,
  resolveIdentityColor,
  resolveRoleIcon,
  storedIdentityColor,
  storedRoleIcon,
} from "./appearance";
import { RoleGlyph } from "./RoleGlyph";
import type { PluginTheme } from "./theme";

/** Matches native Agent Profile appearance popover (5×40 cells + gaps + padding). */
const GRID_COLUMNS = 5;
const CELL = 40;
const ICON = 20;
const COLOR_CELL = 32;
const SWATCH = 20;
const GAP = 4;
const PAD = 12;
const GRID_WIDTH = GRID_COLUMNS * CELL + (GRID_COLUMNS - 1) * GAP;
const POPOVER_WIDTH = GRID_WIDTH + PAD * 2;
const TRIGGER_HEIGHT = 32;

export function AppearanceField({
  theme,
  label,
  icon,
  color,
  onChange,
  children,
}: {
  theme: PluginTheme;
  label: string;
  icon: string;
  color: string;
  onChange: (next: { icon: string; color: string }) => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const selectedColor = resolveIdentityColor(color);
  const selectedIcon = resolveRoleIcon(icon);
  const iconIsDefault = !icon.trim() || selectedIcon === DEFAULT_ROLE_ICON;
  const gridIcons = useMemo(() => pickerIconNames(icon), [icon]);
  const styles = useMemo(
    () => ({
      root: {
        position: "relative" as const,
        zIndex: open ? 20 : 0,
      },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      trigger: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        alignSelf: "flex-start" as const,
        gap: 4,
        height: TRIGGER_HEIGHT,
        minWidth: 44,
        paddingHorizontal: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: open ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      dismiss: {
        position: "absolute" as const,
        top: 56,
        left: -48,
        width: 800,
        height: 1200,
        zIndex: 15,
      },
      picker: {
        position: "absolute" as const,
        top: 56,
        left: 0,
        width: POPOVER_WIDTH,
        zIndex: 20,
        gap: 12,
        padding: PAD,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        overflow: "hidden" as const,
        shadowColor: theme.colors.foreground,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.16,
        shadowRadius: 18,
        elevation: 12,
      },
      colorRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: GAP,
        width: GRID_WIDTH,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      grid: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: GAP,
        width: GRID_WIDTH,
      },
      cell: {
        width: CELL,
        height: CELL,
        flexGrow: 0,
        flexShrink: 0,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "transparent",
        overflow: "hidden" as const,
      },
      cellSelected: {
        backgroundColor: theme.colors.surface2,
        borderColor: theme.colors.border,
      },
      colorCell: {
        width: COLOR_CELL,
        height: COLOR_CELL,
        flexGrow: 0,
        flexShrink: 0,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
      },
      swatch: {
        width: SWATCH,
        height: SWATCH,
        borderRadius: SWATCH / 2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
    }),
    [open, theme],
  );

  function selectColor(next: IdentityColor) {
    onChange({ icon, color: storedIdentityColor(next) ?? "" });
  }

  function selectIcon(next: string | null) {
    onChange({ icon: next ? (storedRoleIcon(next) ?? "") : "", color });
    setOpen(false);
  }

  const colors: IdentityColor[] = ["none", ...IDENTITY_COLOR_NAMES];

  return (
    <View style={styles.root}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <View style={{ gap: 4, flexShrink: 0 }}>
          <Text style={styles.label}>{label}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${label}${selectedColor === "none" ? "" : `, ${selectedColor}`}`}
            onPress={() => setOpen((value) => !value)}
            style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.72 }]}
          >
            <RoleGlyph theme={theme} icon={icon} color={color} size={16} />
            <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        {children}
      </View>
      {open ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={zh.dismissPicker}
          onPress={() => setOpen(false)}
          style={styles.dismiss}
        />
      ) : null}
      {open ? (
        <View style={styles.picker}>
          <View style={styles.colorRow}>
            {colors.map((option) => {
              const selected = option === selectedColor;
              const fill =
                option === "none"
                  ? theme.colors.surface2
                  : (identityForeground(option, theme.colors.surface0) ?? theme.colors.surface2);
              const checkColor =
                option === "none" ? theme.colors.foregroundMuted : theme.colors.surface0;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option === "none" ? zh.defaultColor : option}
                  onPress={() => selectColor(option)}
                  style={({ pressed }) => [styles.colorCell, pressed && { opacity: 0.7 }]}
                >
                  <View style={[styles.swatch, { backgroundColor: fill }]}>
                    {selected ? <Icon name="Check" size={12} color={checkColor} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.grid}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: iconIsDefault }}
              accessibilityLabel={zh.defaultIcon}
              onPress={() => selectIcon(null)}
              style={({ pressed }) => [
                styles.cell,
                iconIsDefault && styles.cellSelected,
                pressed && { opacity: 0.7 },
              ]}
            >
              <RoleGlyph theme={theme} icon={DEFAULT_ROLE_ICON} color={color} size={ICON} />
            </Pressable>
            {gridIcons.map((name) => {
              const selected = !iconIsDefault && selectedIcon === name;
              return (
                <Pressable
                  key={name}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={name}
                  onPress={() => selectIcon(name)}
                  style={({ pressed }) => [
                    styles.cell,
                    selected && styles.cellSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <RoleGlyph theme={theme} icon={name} color={color} size={ICON} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}
