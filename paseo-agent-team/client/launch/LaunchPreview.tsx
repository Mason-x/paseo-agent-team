import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { LaunchPreviewResult, SeatPreview } from "../../shared/schemas/launch-preview";
import { zh } from "../../shared/zh";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { launchSeatStatus, previewBlockers, previewWarnings } from "./launch-preview-state";

// The source is the planner's word. A value this page has no wording for (an earlier host still
// sends "economy-pool") is shown as its own id instead of being relabeled as a known source.
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  "role-preferred": zh.modes.sourcePreferred,
  "role-fallback": zh.modes.sourceFallback,
  unavailable: zh.modes.sourceUnavailable,
};

function sourceText(source: string): string {
  return Object.hasOwn(SOURCE_LABELS, source) ? (SOURCE_LABELS[source] as string) : source;
}

function purposeText(purpose: SeatPreview["purpose"]): string {
  return purpose === "member" ? zh.modes.purposeMember : purpose;
}

function profileText(profile: SeatPreview["profile"]): string {
  if (!profile) return zh.modes.profileUnavailable;
  const details = [profile.provider, profile.model, profile.modeId, profile.thinkingOptionId]
    .filter(Boolean)
    .join(" / ");
  return `${profile.name} · ${details}`;
}

function Row({
  theme,
  layout,
  title,
  subtitle,
  meta,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  title: string;
  subtitle: string;
  meta: string;
}) {
  return (
    <View
      style={{
        gap: 2,
        paddingVertical: layout.compact ? 6 : 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{subtitle}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexWrap: "wrap" }}>
        {meta}
      </Text>
    </View>
  );
}

/**
 * Renders the host's physical-seat preview. It shows only the display DTO: no prompts, notes,
 * MCP data, or local guesses. Missing lists stay neutral so they never block a start.
 */
export function LaunchPreview({
  theme,
  layout,
  loading,
  updating,
  error,
  result,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  loading: boolean;
  updating: boolean;
  error: string | null;
  result: LaunchPreviewResult | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const blockers = previewBlockers(result);
  const warnings = previewWarnings(result);
  const preview = result?.ok ? result.preview : null;
  const seats = preview?.seats ?? [];
  const visible = showAll ? seats : seats.slice(0, 6);
  if (!result && !loading && !error) return null;

  return (
    <View style={{ gap: 6 }}>
      {loading && !result ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {zh.modes.previewPending}
        </Text>
      ) : null}
      {updating && result ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {zh.modes.previewUpdating}
        </Text>
      ) : null}
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>
      ) : null}
      {preview ? (
        <>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {`${zh.modes.logicalSeats} ${preview.counts.logical} · ${zh.modes.physicalSeats} ${preview.counts.physical} · ${zh.modes.eagerSeats} ${preview.counts.eager} · ${zh.modes.deferredSeats} ${preview.counts.deferred}`}
          </Text>
          <Row
            theme={theme}
            layout={layout}
            title={`${zh.coordinator} · ${preview.coordinator.roleName}`}
            subtitle={profileText(preview.coordinator.profile)}
            meta={`${zh.modes.seatSource}：${sourceText(preview.coordinator.source)}`}
          />
          {visible.map((seat) => {
            const profile = [
              profileText(seat.profile),
              seat.unavailable && seat.profile ? zh.modes.sourceUnavailable : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Row
                key={seat.seatId}
                theme={theme}
                layout={layout}
                title={`${seat.roleName}${seat.instanceLabel ? ` (${seat.instanceLabel})` : ""} · ${purposeText(seat.purpose)}`}
                subtitle={profile}
                meta={[
                  `${zh.modes.seatSource}：${sourceText(seat.source)}`,
                  `${zh.modes.seatStatus}：${launchSeatStatus(seat)}`,
                ].join(" · ")}
              />
            );
          })}
          {seats.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {zh.modes.noSeats}
            </Text>
          ) : null}
          {seats.length > 6 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                showAll ? zh.modes.showFewerSeats : zh.modes.showAllSeats(seats.length)
              }
              onPress={() => setShowAll((current) => !current)}
              style={{ minHeight: 28, justifyContent: "center" }}
            >
              <Text style={{ color: theme.colors.accent, fontWeight: "600", fontSize: 13 }}>
                {showAll ? zh.modes.showFewerSeats : zh.modes.showAllSeats(seats.length)}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {warnings.map((warning) => (
        <Text key={warning} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          {warning}
        </Text>
      ))}
      {blockers.map((blocker) => (
        <Text
          key={blocker}
          style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}
        >
          {blocker}
        </Text>
      ))}
    </View>
  );
}
