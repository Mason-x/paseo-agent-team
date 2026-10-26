import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Blocker, Job, VersionInfo } from "../../shared/version";
import { zh } from "../../shared/zh";
import { FilledButton } from "../shared/buttons";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import {
  blockersFor,
  blockerViews,
  checkedAtLabel,
  currentBranchLabel,
  currentVersionText,
  jobStateText,
  phaseText,
  relationText,
  remoteBranchLabel,
  remoteLatestLabel,
  type StatusTone,
  sourceLabel,
  statusView,
  updateButtonView,
  updateConfirmationLines,
} from "./view-model";

function toneColor(theme: PluginTheme, tone: StatusTone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "accent":
      return theme.colors.accent;
    default:
      return theme.colors.foreground;
  }
}

export function VersionPanel({
  theme,
  layout,
  open,
  info,
  job,
  loading,
  checking,
  starting,
  reconnecting,
  recovering,
  checkError,
  startBlockers,
  onCheck,
  onUpdate,
  onClose,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  info: VersionInfo | null;
  job: Job | null;
  loading: boolean;
  checking: boolean;
  starting: boolean;
  reconnecting: boolean;
  recovering: boolean;
  checkError: string | null;
  startBlockers: Blocker[] | null;
  onCheck: () => void;
  onUpdate: () => void;
  onClose: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  useEffect(() => {
    if (open) return;
    setConfirmOpen(false);
    setDiagnosticsOpen(false);
  }, [open]);
  const status = info ? statusView(info, job, reconnecting) : null;
  const button = info ? updateButtonView(info, job) : null;
  const blockers = info ? blockersFor(info, job) : [];
  const startViews = startBlockers ? blockerViews(startBlockers) : [];
  const updateBlockedByStart = startViews.length > 0;
  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 10 : 14 },
      section: { gap: 5 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      row: { flexDirection: "row" as const, gap: 8, alignItems: "flex-start" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 12, minWidth: 96 },
      value: { color: theme.colors.foreground, fontSize: 12, flex: 1, minWidth: 0 },
      statusTitle: { fontSize: 14, fontWeight: "600" as const },
      statusNext: { color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      divider: { height: 1, backgroundColor: theme.colors.border },
      blocker: {
        gap: 3,
        padding: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      blockerReason: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      blockerNext: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      diagnostics: {
        gap: 6,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      diagnosticLabel: { color: theme.colors.foregroundMuted, fontSize: 11 },
      diagnosticValue: {
        color: theme.colors.foreground,
        fontSize: 11,
        fontFamily: "monospace",
      },
      reconnect: {
        padding: 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
    }),
    [layout.compact, theme],
  );

  const diagnostics: Array<{ label: string; value: string }> = [];
  if (info) {
    diagnostics.push(
      { label: zh.versionPluginPath, value: info.current.pluginPath ?? zh.versionNotAvailable },
      {
        label: zh.versionRepoPath,
        value: info.current.repositoryPath ?? zh.versionNotAvailable,
      },
      {
        label: zh.versionCheckedAt,
        value: info.remote.checkedAt ?? zh.versionNeverChecked,
      },
    );
    const source = info.installSource;
    if (source.kind === "directory") {
      diagnostics.push({ label: zh.versionDiagIsGit, value: String(source.isGit) });
    } else if (source.kind === "git") {
      diagnostics.push(
        { label: zh.versionDiagRemote, value: source.remote },
        {
          label: zh.versionDiagInstalledCommit,
          value: source.installedCommit ?? zh.versionNotAvailable,
        },
        { label: zh.versionDiagRef, value: source.ref ?? zh.versionNotAvailable },
        { label: zh.versionDiagRegistry, value: source.registry?.url ?? zh.versionNotAvailable },
      );
    } else if (source.kind === "npm") {
      diagnostics.push(
        { label: zh.versionDiagPackage, value: source.packageName },
        {
          label: zh.versionDiagInstalledVersion,
          value: source.installedVersion ?? zh.versionNotAvailable,
        },
      );
    }
    const target = info.remote.installTarget;
    if (target) {
      diagnostics.push(
        { label: zh.versionRemoteUrl, value: target.sourceUrl ?? zh.versionNotAvailable },
        { label: zh.versionDiagRef, value: target.ref ?? zh.versionNotAvailable },
        { label: zh.versionDiagCommit, value: target.commit ?? zh.versionNotAvailable },
      );
    }
    if (info.current.commit) {
      diagnostics.push({ label: zh.versionDiagCommit, value: info.current.commit });
    }
    for (const blocker of blockers) {
      if (blocker.detail) {
        diagnostics.push({
          label: `${zh.versionBlockerDetail}: ${blocker.reason}`,
          value: blocker.detail,
        });
      }
      diagnostics.push({ label: `${zh.versionDetail}: ${blocker.reason}`, value: blocker.remedy });
    }
  }
  if (job) {
    diagnostics.push(
      { label: zh.versionJobId, value: job.id },
      { label: zh.versionDiagState, value: jobStateText(job.state) },
      { label: zh.versionDiagPhase, value: phaseText(job.phase) },
      { label: zh.versionRollback, value: job.rollback },
    );
    if (job.error?.detail) {
      diagnostics.push({ label: zh.versionBlockerDetail, value: job.error.detail });
    }
  }
  for (const blocker of startViews) {
    if (blocker.detail) {
      diagnostics.push({
        label: `${zh.versionBlockerDetail}: ${blocker.reason}`,
        value: blocker.detail,
      });
    }
  }

  const confirmationBody = info ? updateConfirmationLines(info).join("\n") : "";

  return (
    <>
      <Modal title={zh.versionTitle} open={open} onOpenChange={(next) => !next && onClose()}>
        <Modal.Content>
          <View style={styles.root}>
            {loading && !info ? <Text style={styles.muted}>{zh.versionLoading}</Text> : null}
            {reconnecting ? (
              <View style={styles.reconnect}>
                <Text style={styles.warning}>{zh.versionReconnecting}</Text>
                <Text style={styles.muted}>{zh.versionReconnectingBody}</Text>
              </View>
            ) : null}
            {status ? (
              <View style={styles.section}>
                <Text style={[styles.statusTitle, { color: toneColor(theme, status.tone) }]}>
                  {status.title}
                </Text>
                {status.next ? <Text style={styles.statusNext}>{status.next}</Text> : null}
              </View>
            ) : null}
            {checkError ? <Text style={styles.danger}>{checkError}</Text> : null}
            {startViews.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.danger}>{zh.versionStartBlocked}</Text>
                {startViews.map((blocker) => (
                  <View key={blocker.key} style={styles.blocker}>
                    <Text style={styles.blockerReason}>{blocker.reason}</Text>
                    <Text style={styles.blockerNext}>{blocker.next}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {info ? (
              <>
                <View style={styles.section}>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionCurrent}</Text>
                    <Text style={styles.value}>{currentVersionText(info)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionSource}</Text>
                    <Text style={styles.value}>{sourceLabel(info.installSource)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionBranch}</Text>
                    <Text style={styles.value}>{currentBranchLabel(info)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionRemoteBranch}</Text>
                    <Text style={styles.value}>{remoteBranchLabel(info)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionRemoteLatest}</Text>
                    <Text style={styles.value}>{remoteLatestLabel(info)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionCheckedAt}</Text>
                    <Text style={styles.value}>{checkedAtLabel(info)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionRelation}</Text>
                    <Text style={styles.value}>{relationText(info.relation)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>{zh.versionCanUpdate}</Text>
                    <Text style={styles.value}>
                      {info.updateAvailable === null
                        ? zh.versionUnknown
                        : info.updateAvailable
                          ? info.canUpdate
                            ? zh.versionUpdateAvailable
                            : zh.versionNotReady
                          : zh.versionLatest}
                    </Text>
                  </View>
                </View>

                {blockers.length > 0 ? (
                  <View style={styles.section}>
                    {blockers.map((blocker) => (
                      <View key={blocker.key} style={styles.blocker}>
                        <Text style={styles.blockerReason}>{blocker.reason}</Text>
                        <Text style={styles.blockerNext}>{blocker.next}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {job ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{zh.versionRecentJob}</Text>
                    <Text style={styles.value}>
                      {jobStateText(job.state)} · {phaseText(job.phase)}
                    </Text>
                    {job.error ? (
                      <Text style={styles.danger}>
                        {blockerViews([job.error])[0]?.reason ?? job.error.code}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                <View style={styles.actions}>
                  <View style={{ flex: 1, minWidth: 150 }}>
                    <FilledButton
                      theme={theme}
                      label={checking ? zh.versionChecking : zh.versionCheckNow}
                      variant="secondary"
                      disabled={checking || starting}
                      onPress={onCheck}
                    />
                  </View>
                  {button?.visible ? (
                    <View style={{ flex: 1, minWidth: 150 }}>
                      <FilledButton
                        theme={theme}
                        label={
                          starting
                            ? zh.versionUpdating
                            : button.requiresCheck
                              ? zh.versionRecheckThenUpdate
                              : zh.versionUpdate
                        }
                        variant="primary"
                        disabled={
                          !button.enabled ||
                          starting ||
                          reconnecting ||
                          recovering ||
                          updateBlockedByStart
                        }
                        onPress={() => setConfirmOpen(true)}
                      />
                    </View>
                  ) : null}
                </View>
                {button?.visible && !button.enabled && button.reason ? (
                  <Text style={styles.muted}>{button.reason}</Text>
                ) : null}
                <View style={styles.divider} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: diagnosticsOpen }}
                  onPress={() => setDiagnosticsOpen((value) => !value)}
                >
                  <Text style={styles.link}>
                    {diagnosticsOpen ? zh.versionHideDiagnostics : zh.versionShowDiagnostics}
                  </Text>
                </Pressable>
                {diagnosticsOpen ? (
                  <View style={styles.diagnostics}>
                    <Text style={styles.sectionTitle}>{zh.versionDiagnostics}</Text>
                    {diagnostics.map((entry) => (
                      <View key={`${entry.label}:${entry.value}`} style={{ gap: 1 }}>
                        <Text style={styles.diagnosticLabel}>{entry.label}</Text>
                        <Text selectable style={styles.diagnosticValue}>
                          {entry.value}
                        </Text>
                      </View>
                    ))}
                    {diagnostics.length === 0 ? (
                      <Text style={styles.muted}>{zh.versionNotAvailable}</Text>
                    ) : null}
                  </View>
                ) : null}
              </>
            ) : null}
            {!info ? (
              <View style={styles.actions}>
                <View style={{ flex: 1 }}>
                  <FilledButton
                    theme={theme}
                    label={checking ? zh.versionChecking : zh.versionCheckNow}
                    variant="secondary"
                    disabled={checking || starting}
                    onPress={onCheck}
                  />
                </View>
              </View>
            ) : null}
            <View style={styles.actions}>
              <View style={{ flex: 1 }}>
                <FilledButton
                  theme={theme}
                  label={zh.versionClose}
                  variant="secondary"
                  onPress={onClose}
                />
              </View>
            </View>
          </View>
        </Modal.Content>
      </Modal>
      {info ? (
        <ConfirmDialog
          theme={theme}
          open={confirmOpen}
          title={zh.versionConfirmTitle}
          body={confirmationBody}
          confirmLabel={zh.versionConfirm}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            onUpdate();
          }}
        />
      ) : null}
    </>
  );
}
