import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ProfileRef } from "../../shared/schemas/profile-ref";
import { zh } from "../../shared/zh";
import type { PaseoProfile } from "../paseo/adapter";
import type { PluginTheme } from "../shared/theme";

function profileLine(profile: PaseoProfile): string {
  const model = profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
  const extras = [profile.modeId, profile.thinkingOptionId].filter(Boolean).join(" · ");
  return extras ? `${model} · ${extras}` : model;
}

export function ProfilePicker({
  theme,
  label,
  selected,
  profiles,
  loading,
  error,
  onChange,
  onRefresh,
}: {
  theme: PluginTheme;
  label: string;
  selected: ProfileRef[];
  profiles: readonly PaseoProfile[];
  loading?: boolean;
  error?: string;
  onChange: (next: ProfileRef[]) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const styles = useMemo(
    () => ({
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      missing: { borderColor: theme.colors.statusDanger },
      name: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      row: {
        paddingVertical: 8,
        gap: 2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
    }),
    [theme],
  );

  function move(index: number, direction: -1 | 1) {
    const next = [...selected];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh profiles"
          onPress={onRefresh}
        >
          <Icon name="RefreshCw" size={14} color={theme.colors.accent} />
        </Pressable>
      </View>
      {selected.map((ref, index) => {
        const live = byId.get(ref.profileId);
        const missing = !live;
        return (
          <View key={ref.profileId} style={[styles.chip, missing && styles.missing]}>
            <Text style={missing ? styles.danger : styles.name}>
              {live?.name ?? zh.missingProfile(ref.nameSnapshot ?? ref.profileId)}
            </Text>
            {live ? <Text style={styles.meta}>{profileLine(live)}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move up"
              onPress={() => move(index, -1)}
            >
              <Icon name="ChevronUp" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move down"
              onPress={() => move(index, 1)}
            >
              <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove profile"
              onPress={() => onChange(selected.filter((_, itemIndex) => itemIndex !== index))}
              hitSlop={4}
            >
              <Icon name="X" size={14} color={theme.colors.statusDanger} />
            </Pressable>
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${label}`}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={{ color: theme.colors.accent, fontWeight: "600", fontSize: 13 }}>
          {open ? zh.hideProfiles : zh.addProfile}
        </Text>
      </Pressable>
      {loading ? <Text style={styles.meta}>{zh.loadingProfiles}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {open
        ? profiles.map((profile) => (
            <Pressable
              key={profile.id}
              accessibilityRole="button"
              accessibilityLabel={`Select ${profile.name}`}
              onPress={() => {
                if (selected.some((ref) => ref.profileId === profile.id)) return;
                onChange([...selected, { profileId: profile.id, nameSnapshot: profile.name }]);
                setOpen(false);
              }}
              style={styles.row}
            >
              <Text style={styles.name}>{profile.name}</Text>
              <Text style={styles.meta}>{profileLine(profile)}</Text>
              {profile.notes ? <Text style={styles.meta}>{profile.notes.slice(0, 80)}</Text> : null}
            </Pressable>
          ))
        : null}
    </View>
  );
}
