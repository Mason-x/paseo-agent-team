import { useMemo } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import type { SeatProfileFacts } from "../../shared/domain/run-engine/team-config";
import {
  addMissingSeats,
  ENGINE_DUTIES,
  ENGINE_NUMBER_FIELDS,
  ENGINE_TIERS,
  engineNumberLabel,
  evaluateEngineBlock,
  logicalSeatIdsOf,
  readEngineEdit,
  removeOrphanSeats,
  type SeatPatch,
  setEngineEnabled,
  setEngineNumber,
  setEngineSeat,
  startFreshEngineBlock,
} from "../../shared/domain/run-engine/team-config-edit";
import type { TeamMember } from "../../shared/schemas/team";
import { runEngineZh } from "../../shared/zh/run-engine";
import { inputStyle } from "../shared/Field";
import { ImeTextInput } from "../shared/ImeTextInput";
import type { PluginTheme } from "../shared/theme";

const zh = runEngineZh.teamEditor;

function Chip({
  theme,
  label,
  hint,
  on,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  /** Said to a screen reader after the label, e.g. which seat it belongs to. */
  hint: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${hint}`}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{
        minHeight: 32,
        justifyContent: "center",
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: on ? theme.colors.accent : theme.colors.border,
        backgroundColor: on ? theme.colors.surface2 : "transparent",
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

function TextButton({
  theme,
  label,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center" }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The `runEngine` block of a Team: the switch, one seat per Team member, and the policy numbers. The
 * block is edited as the stored value (`team-config-edit.ts`), so fields this editor does not know are
 * carried through; what launch would refuse or warn about is shown live, from the same gate.
 */
export function RunEngineEditor({
  theme,
  members,
  value,
  revision,
  onChange,
  seatProfiles,
}: {
  theme: PluginTheme;
  members: readonly TeamMember[];
  /** The stored `Team.runEngine`, whatever it is. */
  value: unknown;
  revision: string | number;
  onChange: (next: unknown) => void;
  /** The Profile each seat is planned to use; absent until the Team plan has answered. */
  seatProfiles?: readonly SeatProfileFacts[];
}) {
  const seatIds = useMemo(() => logicalSeatIdsOf(members), [members]);
  const state = useMemo(() => readEngineEdit(value, seatIds), [value, seatIds]);
  const evaluation = useMemo(
    () => evaluateEngineBlock(value, { seatIds, seatProfiles }),
    [value, seatIds, seatProfiles],
  );
  const color = theme.colors;
  const muted = { color: color.foregroundMuted, fontSize: 12 } as const;

  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: color.border,
        borderRadius: 10,
        backgroundColor: color.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: color.foreground, fontSize: 13, fontWeight: "600" }}>{zh.title}</Text>
        <Text style={muted}>{zh.statusLabel[state.status] ?? state.status}</Text>
      </View>
      <Text style={muted}>{zh.help}</Text>

      {state.status === "invalid" ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: color.statusWarning, fontSize: 12, fontWeight: "600" }}>
            {zh.invalidTitle}
          </Text>
          <Text style={muted}>{zh.invalidHelp}</Text>
          {state.issues.map((line) => (
            <Text key={line} style={muted}>
              {line}
            </Text>
          ))}
          <TextButton
            theme={theme}
            label={zh.startFresh}
            onPress={() => onChange(startFreshEngineBlock(seatIds))}
          />
        </View>
      ) : (
        <>
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <Text style={{ color: color.foreground }}>{zh.enable}</Text>
            <Switch
              accessibilityLabel={zh.enable}
              value={state.enabled}
              onValueChange={(enabled) => onChange(setEngineEnabled(value, enabled, seatIds))}
            />
          </View>

          {state.status !== "absent" ? (
            <>
              <Text style={{ color: color.foreground, fontSize: 12, fontWeight: "600" }}>
                {zh.seats}
              </Text>
              <Text style={muted}>{zh.seatHelp}</Text>
              {state.seats.map((seat) => (
                <View
                  key={seat.seatId}
                  style={{
                    gap: 6,
                    padding: 8,
                    borderWidth: 1,
                    borderColor: color.border,
                    borderRadius: 8,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: color.foreground, fontSize: 12, fontWeight: "600" }}>
                      {seat.seatId}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={muted}>{zh.seatEnabled}</Text>
                      <Switch
                        accessibilityLabel={`${zh.seatEnabled} ${seat.seatId}`}
                        value={seat.enabled}
                        onValueChange={(enabled) =>
                          onChange(setEngineSeat(value, seat.seatId, { enabled }))
                        }
                      />
                    </View>
                  </View>
                  <Text style={muted}>{zh.tier}</Text>
                  <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                    {ENGINE_TIERS.map((tier) => (
                      <Chip
                        key={tier}
                        theme={theme}
                        label={tier}
                        hint={seat.seatId}
                        on={seat.tier === tier}
                        onPress={() => onChange(setEngineSeat(value, seat.seatId, { tier }))}
                      />
                    ))}
                  </View>
                  <Text style={muted}>{zh.duties}</Text>
                  <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                    {ENGINE_DUTIES.map((duty) => {
                      const on = seat.duties.includes(duty);
                      const patch: SeatPatch = { duty: { name: duty, on: !on } };
                      return (
                        <Chip
                          key={duty}
                          theme={theme}
                          label={zh.duty[duty] ?? duty}
                          hint={seat.seatId}
                          on={on}
                          onPress={() => onChange(setEngineSeat(value, seat.seatId, patch))}
                        />
                      );
                    })}
                  </View>
                  <Text style={muted}>{zh.channel}</Text>
                  <ImeTextInput
                    accessibilityLabel={`${zh.channel} ${seat.seatId}`}
                    initialValue={seat.channelId}
                    revision={`${revision}:${seat.seatId}`}
                    placeholder={zh.channelPlaceholder}
                    placeholderTextColor={color.foregroundMuted}
                    onChangeText={(channelId: string) =>
                      onChange(setEngineSeat(value, seat.seatId, { channelId }))
                    }
                    style={inputStyle(theme, { error: seat.channelId.trim() === "" })}
                  />
                </View>
              ))}
              {state.missingSeats.length > 0 ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ color: color.statusWarning, fontSize: 12 }}>
                    {zh.missingSeats(state.missingSeats.join("、"))}
                  </Text>
                  <TextButton
                    theme={theme}
                    label={zh.addMissing}
                    onPress={() => onChange(addMissingSeats(value, seatIds))}
                  />
                </View>
              ) : null}
              {state.orphanSeats.length > 0 ? (
                <View style={{ gap: 2 }}>
                  <Text style={{ color: color.statusWarning, fontSize: 12 }}>
                    {zh.orphanSeats(state.orphanSeats.join("、"))}
                  </Text>
                  <TextButton
                    theme={theme}
                    label={zh.removeOrphans}
                    onPress={() => onChange(removeOrphanSeats(value, seatIds))}
                  />
                </View>
              ) : null}

              <Text style={{ color: color.foreground, fontSize: 12, fontWeight: "600" }}>
                {zh.policy}
              </Text>
              <Text style={muted}>{zh.policyHelp}</Text>
              {ENGINE_NUMBER_FIELDS.map((field) => (
                <View key={field} style={{ gap: 2 }}>
                  <Text style={muted}>{engineNumberLabel(field)}</Text>
                  <ImeTextInput
                    accessibilityLabel={engineNumberLabel(field)}
                    initialValue={state.numbers[field] === null ? "" : String(state.numbers[field])}
                    revision={`${revision}:${field}`}
                    keyboardType="number-pad"
                    onChangeText={(text: string) => onChange(setEngineNumber(value, field, text))}
                    style={inputStyle(theme)}
                  />
                </View>
              ))}
              <Text style={muted}>{zh.unknownKept}</Text>

              {evaluation.issues.map((line) => (
                <Text key={line} style={{ color: color.statusDanger, fontSize: 12 }}>
                  {line}
                </Text>
              ))}
              {evaluation.blockers.length > 0 ? (
                <Text style={{ color: color.statusDanger, fontSize: 12, fontWeight: "600" }}>
                  {zh.blockers}
                </Text>
              ) : null}
              {evaluation.blockers.map((line) => (
                <Text key={line} style={{ color: color.statusDanger, fontSize: 12 }}>
                  {line}
                </Text>
              ))}
              {evaluation.warnings.length > 0 ? (
                <Text style={{ color: color.statusWarning, fontSize: 12, fontWeight: "600" }}>
                  {zh.warnings}
                </Text>
              ) : null}
              {evaluation.warnings.map((line) => (
                <Text key={line} style={{ color: color.statusWarning, fontSize: 12 }}>
                  {line}
                </Text>
              ))}
              {evaluation.ready && evaluation.warnings.length === 0 ? (
                <Text style={{ color: color.statusSuccess, fontSize: 12 }}>{zh.ready}</Text>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
