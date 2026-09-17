import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import {
  type ComposerPillKey,
  type ComposerPillSettings,
  composerPillSettings,
  DEFAULT_COMPOSER_PILL_SETTINGS,
} from "../shared/composer-pill-settings";

type ReadySettings = Extract<
  SettingsState<typeof composerPillSettings.schema>,
  { status: "ready" }
>;

const PILLS: readonly { key: ComposerPillKey; label: string; hint: string }[] = [
  {
    key: "mcp",
    label: "MCP",
    hint: "OMP-native server controls on OMP Plugin agents",
  },
  {
    key: "hub",
    label: "Hub",
    hint: "Supervised process status when this workspace has Hub processes",
  },
  {
    key: "memory",
    label: "Memory",
    hint: "Retained facts for the current workspace",
  },
  {
    key: "sessions",
    label: "Sessions",
    hint: "Recent OMP prompts for the current workspace",
  },
  {
    key: "quota",
    label: "Quota",
    hint: "Provider quota usage when OMP has matching account data",
  },
];

function ComposerPillControls({
  settings,
  onChange,
}: {
  settings: ReadySettings;
  onChange(settings: ComposerPillSettings): void;
}) {
  const save = useCallback(
    async (key: ComposerPillKey, value: boolean) => {
      const next = { ...settings.values, [key]: value };
      if (await settings.save(next, settings.revision)) onChange(next);
    },
    [onChange, settings],
  );

  return (
    <SettingsSection
      title="Composer pills"
      info="Applies to all workspaces and connected clients on this host."
    >
      <SettingsCard>
        {PILLS.map(({ key, label, hint }) => (
          <SettingsSwitch
            key={key}
            label={label}
            hint={hint}
            value={settings.values[key]}
            disabled={settings.saving}
            onValueChange={(value) => void save(key, value)}
          />
        ))}
        <SettingsAction
          label="Restore composer pill defaults"
          actionLabel="Reset"
          disabled={settings.saving}
          onPress={async () => {
            if (await settings.reset()) onChange({ ...DEFAULT_COMPOSER_PILL_SETTINGS });
          }}
        />
        {settings.saveError ? (
          <SettingsAction
            label="Reload saved composer preferences"
            hint="Use after a conflict or connection error"
            error={settings.saveError}
            actionLabel="Reload"
            disabled={settings.saving}
            onPress={settings.reload}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ComposerPillSettingsSection({
  theme,
  onChange,
}: {
  theme: PluginSurfaceProps["theme"];
  onChange(settings: ComposerPillSettings): void;
}) {
  const settings = useSettings(composerPillSettings);
  const styles = useMemo(
    () => ({
      root: { gap: 12 },
      text: { color: theme.colors.foreground },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
  const readyValues = settings.status === "ready" ? settings.values : undefined;

  useEffect(() => {
    if (readyValues) onChange(readyValues);
  }, [onChange, readyValues]);

  if (settings.status === "loading") return <Text style={styles.text}>Loading preferences…</Text>;
  if (settings.status !== "ready") {
    return (
      <View style={styles.root}>
        <SettingsSection title="Composer pills">
          <Text accessibilityRole="alert" style={styles.error}>
            {settings.error}
          </Text>
          <SettingsCard>
            <SettingsAction
              label="Read composer preferences again"
              actionLabel="Reload"
              onPress={settings.reload}
            />
            {settings.status === "invalid" ? (
              <SettingsAction
                label="Replace invalid preferences with defaults"
                actionLabel="Reset"
                disabled={settings.saving}
                onPress={async () => {
                  if (await settings.reset()) onChange({ ...DEFAULT_COMPOSER_PILL_SETTINGS });
                }}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      </View>
    );
  }

  return <ComposerPillControls settings={settings} onChange={onChange} />;
}
