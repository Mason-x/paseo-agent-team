import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  Modal,
  ScrollView,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { teamSettings } from "../shared/rpc";
import { reviewerModeProblem } from "../shared/run";
import { matchProfile, matchReviewers, type Profile, profileSpec } from "./start-input";
import {
  Btn,
  Chip,
  Col,
  ProfileChips,
  ReviewerSeats,
  Row,
  ThemeProvider,
  Txt,
  useProfiles,
  useTheme,
} from "./ui";

const PRESETS = [1, 2, 3, 5, 8, 10];

function TeamSettingsBody({
  settings,
  profiles,
  onSaved,
}: {
  settings: SettingsState<typeof teamSettings.schema>;
  profiles: Profile[];
  onSaved?: () => void;
}) {
  const c = useTheme().colors;
  const toast = useToast();
  const [maxActive, setMaxActive] = useState(3);
  const [writer, setWriter] = useState<Profile | undefined>();
  const [reviewers, setReviewers] = useState<(Profile | undefined)[]>([undefined]);
  const readyValues = settings.status === "ready" ? settings.values : null;

  useEffect(() => {
    if (!readyValues) return;
    setMaxActive(readyValues.maxActiveRuns);
    setWriter(matchProfile(profiles, readyValues.writer));
    setReviewers(matchReviewers(profiles, readyValues.reviewers));
  }, [readyValues, profiles]);

  if (settings.status === "loading") return <Txt muted>正在读取设置…</Txt>;
  if (settings.status === "error") return <Txt color={c.statusDanger}>{settings.error}</Txt>;
  if (settings.status === "invalid") {
    return (
      <Col gap={10}>
        <Txt color={c.statusDanger}>{`设置文件无效：${settings.error}`}</Txt>
        <Btn label="重置为默认设置" kind="danger" onPress={() => void settings.reset()} />
      </Col>
    );
  }

  const chosen = reviewers.filter((r): r is Profile => !!r);
  const invalidRev = reviewers.some(
    (r, i) => r && reviewerModeProblem(`r${i + 1}`, profileSpec(r)),
  );

  async function save() {
    if (settings.status !== "ready") return;
    const next = {
      maxActiveRuns: maxActive,
      ...(writer ? { writer: profileSpec(writer) } : {}),
      reviewers: chosen.map(profileSpec),
    };
    const ok = await settings.save(next, settings.revision);
    if (ok) {
      toast.show("默认设置已保存", { variant: "success" });
      onSaved?.();
    } else if (settings.saveError) toast.error(settings.saveError);
  }

  const bump = (delta: number) => setMaxActive((n) => Math.max(1, Math.min(10, n + delta)));
  const saveLabel = settings.saving ? "保存中…" : "保存设置";
  const writerHint = writer ? `已选：${writer.name}` : "未设置时每次新建手动选择";

  const dis = settings.saving || invalidRev;
  return (
    <Col gap={14}>
      <SettingsSection title="并发限制">
        <SettingsCard>
          <SettingsRow
            label="同时活跃的任务上限"
            hint="建议按自己能及时验收与合并的节奏设置（1–10）。"
          >
            <Row>
              <Btn sm icon="Minus" a11y="减少" disabled={maxActive <= 1} onPress={() => bump(-1)} />
              <Txt bold size={15}>{`${maxActive}`}</Txt>
              <Btn sm icon="Plus" a11y="增加" disabled={maxActive >= 10} onPress={() => bump(1)} />
              {PRESETS.map((n) => (
                <Chip
                  key={n}
                  label={`${n}`}
                  on={maxActive === n}
                  a11y={`设为 ${n}`}
                  onPress={() => setMaxActive(n)}
                />
              ))}
            </Row>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="默认角色 Profile">
        <SettingsCard>
          <SettingsRow label="默认写手" hint={writerHint}>
            <Col>
              <ProfileChips profiles={profiles} value={writer} onPick={setWriter} />
              {writer && <Btn sm label="清除默认写手" onPress={() => setWriter(undefined)} />}
            </Col>
          </SettingsRow>
          <SettingsRow label="默认审查者" hint="支持 1–3 个席位；新建任务时自动预填。">
            <ReviewerSeats profiles={profiles} reviewers={reviewers} onChange={setReviewers} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {settings.saveError && (
        <Txt size={13} color={c.statusDanger}>
          {settings.saveError}
        </Txt>
      )}
      <Btn
        kind="primary"
        icon="Save"
        label={saveLabel}
        disabled={dis}
        onPress={() => void save()}
      />
    </Col>
  );
}

export function TeamSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(teamSettings);
  const profiles = useProfiles(true);
  const st = { flex: 1, backgroundColor: theme.colors.surface0, padding: layout.compact ? 16 : 24 };
  return (
    <ThemeProvider value={theme}>
      <ScrollView style={st}>
        <TeamSettingsBody settings={settings} profiles={profiles} />
      </ScrollView>
    </ThemeProvider>
  );
}

export function TeamSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const settings = useSettings(teamSettings);
  const profiles = useProfiles(open);
  return (
    <Modal title="Agent Team 默认设置" open={open} onOpenChange={(o) => !o && onClose()}>
      <Modal.Content>
        <ThemeProvider value={theme}>
          <TeamSettingsBody settings={settings} profiles={profiles} onSaved={onClose} />
        </ThemeProvider>
      </Modal.Content>
    </Modal>
  );
}
