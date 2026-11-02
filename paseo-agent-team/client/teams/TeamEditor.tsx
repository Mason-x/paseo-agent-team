import { settingsRpc } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { JSONType } from "zod";
import { createAutoSlug, slugify } from "../../shared/ids";
import { toJsonValue } from "../../shared/json";
import type { Role } from "../../shared/schemas/role";
import type { Team, TeamMember } from "../../shared/schemas/team";
import { TeamSchema } from "../../shared/schemas/team";
import { TeamsDocumentSchema, teamsSettings } from "../../shared/settings";
import { zh } from "../../shared/zh";
import { teamPlanZh } from "../../shared/zh/team-plan";
import {
  type EditorDocumentSnapshot,
  type EditorParsed,
  type EditorSaveResult,
  loadEditorSnapshot,
  saveEditorRow,
} from "../catalog/editor-save";
import { keepTeamMetadata } from "../catalog/preset-metadata";
import { shouldRetire } from "../catalog/retirement";
import { useRetirement, useRetirementProbe } from "../catalog/use-retirement";
import { ModalActions } from "../shared/buttons";
import { CompactPicker } from "../shared/CompactPicker";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TextField } from "../shared/Field";
import { RolePicker } from "../shared/RolePicker";
import { SlugInput } from "../shared/SlugInput";
import { MEMBER_CREATION_OPTIONS, type MemberCreation } from "../shared/team-mode-options";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { MemberEditor } from "./MemberEditor";
import { ModelRow } from "./ModelRow";
import {
  buildMemberCreationField,
  duplicateMemberPair,
  newTeamMember,
  type RetiredTeamNotice,
  readMemberCreation,
  readRetiredTeamNotice,
  retiredTeamNoticeLines,
  usedSeatIds,
} from "./team-mode-edit";
import {
  buildTeamModelRows,
  buildTeamPlanIssues,
  draftRowKey,
  type TeamModelRowView,
  type TeamPlanClient,
  type TeamPlanDraftRequest,
} from "./team-plan-state";
import { useTeamDraftPlan } from "./use-team-plans";

const teamsRead = settingsRpc(teamsSettings.id).read;
const teamsWrite = settingsRpc(teamsSettings.id).write;

type ConflictKind = Extract<EditorSaveResult, "modified" | "deleted" | "id-taken">;

function parseTeamsDocument(values: unknown): EditorParsed<Team> {
  const parsed = TeamsDocumentSchema.safeParse(values);
  return parsed.success
    ? { ok: true, rows: parsed.data.teams }
    : { ok: false, error: parsed.error.issues.map((entry) => entry.message).join("\n") };
}

export function TeamEditor({
  theme,
  layout,
  open,
  mode,
  team,
  roles,
  existingIds,
  saving,
  onClose,
  planClient,
  onOpenRole,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  mode: "create" | "edit";
  team: Team | null;
  roles: readonly Role[];
  existingIds: ReadonlySet<string>;
  saving: boolean;
  onClose: () => void;
  /** Shared Team-plan client; absent means the plan UI is not wired yet (I02 supplies it). */
  planClient?: TeamPlanClient | null;
  onOpenRole?: (roleId: string, profileId?: string) => void;
}) {
  const readTeamsDoc = useRpc(teamsRead);
  const writeTeamsDoc = useRpc(teamsWrite);
  const retirementProbe = useRetirementProbe();
  const defaultCoordinatorId = roles[0]?.id ?? "";
  const [name, setName] = useState(team?.name ?? "");
  const [id, setId] = useState(team?.id ?? slugify(team?.name ?? "", "team"));
  const [description, setDescription] = useState(team?.description ?? "");
  const [coordinatorRoleId, setCoordinatorRoleId] = useState(
    team?.coordinatorRoleId ?? defaultCoordinatorId,
  );
  const [members, setMembers] = useState<TeamMember[]>(
    team?.members ?? [
      newTeamMember(roles, team?.coordinatorRoleId ?? defaultCoordinatorId, new Set()),
    ],
  );
  const [operatingRules, setOperatingRules] = useState(team?.operatingRules ?? "");
  const [retiredNotice, setRetiredNotice] = useState<RetiredTeamNotice | null>(null);
  const [memberCreation, setMemberCreation] = useState<MemberCreation>("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [memberCreationTouched, setMemberCreationTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictKind | null>(null);
  const [formSeed, setFormSeed] = useState(0);
  const [idSeed, setIdSeed] = useState(0);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingHere, setSavingHere] = useState(false);
  const opened = useRef<EditorDocumentSnapshot<Team> | null>(null);
  const baseline = useRef<Team | null>(team);
  const teamState = useSettings(teamsSettings);
  const idLocked = mode === "edit";
  const autoSlug = useRef(createAutoSlug("team")).current;
  const nameRef = useRef(name);

  // E1: a Team that carries retired settings always shows a line; its wording follows the target
  // host (deleted on save, or kept because that host's plugin is not upgraded yet).
  const hostRetires = useRetirement(retirementProbe, open && retiredNotice !== null);
  const retiredLines = retiredTeamNoticeLines(retiredNotice, hostRetires);

  const planSessionToken = useRef<string | null>(null);
  if (planSessionToken.current === null) {
    planSessionToken.current =
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const planSessionId = `team-editor:${team?.id ?? "new"}:${planSessionToken.current}`;
  const planRequest = useMemo<TeamPlanDraftRequest | null>(() => {
    if (!planClient) return null;
    return {
      sessionId: planSessionId,
      coordinatorRoleId,
      ...(memberCreation === "" ? {} : { memberCreation }),
      members: members.map((member, index) => ({
        rowKey: draftRowKey(member, index),
        roleId: member.roleId,
        ...(member.instanceLabel === undefined ? {} : { instanceLabel: member.instanceLabel }),
        enabled: member.enabled,
      })),
    };
  }, [planClient, planSessionId, coordinatorRoleId, memberCreation, members]);
  const draftPlan = useTeamDraftPlan({
    client: planClient ?? null,
    sessionId: planSessionId,
    active: open,
    request: planRequest,
  });
  const planResult = draftPlan.state.status === "result" ? draftPlan.state.result : null;
  const planLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const [index, member] of members.entries()) {
      const label = member.instanceLabel?.trim();
      if (label) labels.set(draftRowKey(member, index), label);
    }
    return labels;
  }, [members]);
  const modelRows = useMemo(
    () => (planResult ? buildTeamModelRows({ result: planResult, labels: planLabels }) : []),
    [planResult, planLabels],
  );
  const coordinatorModel = modelRows.find((view) => view.kind === "coordinator") ?? null;
  const rowsByKey = useMemo(() => {
    const grouped = new Map<string, TeamModelRowView[]>();
    for (const view of modelRows) {
      if (view.kind !== "member") continue;
      const group = grouped.get(view.rowKey) ?? [];
      group.push(view);
      grouped.set(view.rowKey, group);
    }
    return grouped;
  }, [modelRows]);
  const planIssues = useMemo(() => {
    if (!planResult || planResult.effectiveMode === null) return [];
    return buildTeamPlanIssues(planResult);
  }, [planResult]);

  const seedTeam = useCallback(
    (next: Team | null) => {
      const nextName = next?.name ?? "";
      const nextId = next?.id ?? slugify(nextName, "team");
      autoSlug.reset(mode === "edit", nextId, nextName);
      nameRef.current = nextName;
      baseline.current = next;
      setName(nextName);
      setId(nextId);
      setDescription(next?.description ?? "");
      setCoordinatorRoleId(next?.coordinatorRoleId ?? defaultCoordinatorId);
      const nextCoordinator = next?.coordinatorRoleId ?? defaultCoordinatorId;
      setMembers(next?.members ?? [newTeamMember(roles, nextCoordinator, new Set())]);
      setOperatingRules(next?.operatingRules ?? "");
      setRetiredNotice(readRetiredTeamNotice(next));
      setMemberCreation(readMemberCreation(next?.memberCreation));
      setAdvancedOpen(false);
      setMemberCreationTouched(false);
      setErrors({});
      setConflict(null);
      setFormSeed((seed) => seed + 1);
      setIdSeed((seed) => seed + 1);
    },
    [autoSlug, defaultCoordinatorId, mode, roles],
  );

  useEffect(() => {
    if (open) seedTeam(team);
  }, [open, team, seedTeam]);

  useEffect(() => {
    opened.current = null;
    setSnapshotReady(false);
    setSaveError(null);
    if (!open) return;
    let live = true;
    void loadEditorSnapshot(() => readTeamsDoc({}), parseTeamsDocument).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setSaveError(result.error || zh.saveFail);
        return;
      }
      opened.current = result.snapshot;
      setSnapshotReady(true);
    });
    return () => {
      live = false;
    };
  }, [open, readTeamsDoc]);

  async function reloadDraft() {
    setConflict(null);
    const result = await loadEditorSnapshot(() => readTeamsDoc({}), parseTeamsDocument);
    if (!result.ok) {
      setSaveError(result.error || zh.saveFail);
      return;
    }
    opened.current = result.snapshot;
    const id = baseline.current?.id;
    const latest = id ? result.snapshot.rows.find((row) => row.id === id) : undefined;
    if (!latest) {
      onClose();
      return;
    }
    seedTeam(latest);
  }

  async function submit(overwrite = false) {
    const resolvedName = nameRef.current;
    const resolvedId = autoSlug.resolve(idLocked, resolvedName, id);
    if (mode === "create" && existingIds.has(resolvedId)) {
      setErrors({ id: zh.idUsed(zh.teamKind, resolvedId) });
      return;
    }
    const now = new Date().toISOString();
    const parsed = TeamSchema.safeParse({
      id: resolvedId,
      name: resolvedName,
      description: description.trim() || undefined,
      coordinatorRoleId,
      members,
      ...buildMemberCreationField({
        original: baseline.current,
        memberCreation,
        memberCreationTouched,
      }),
      operatingRules: operatingRules.trim() || undefined,
      enabled: true,
      createdAt: baseline.current?.createdAt ?? now,
      updatedAt: now,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    const result = await saveEditorRowWithSnapshot(
      mode,
      (retireLegacyFields) =>
        keepTeamMetadata(baseline.current, parsed.data, { retireLegacyFields }),
      overwrite,
    );
    if (result === "saved") {
      try {
        await teamState.reload();
      } catch {
        // The host event refreshes the list; the save itself succeeded.
      }
      onClose();
      return;
    }
    if (result === "modified" || result === "deleted" || result === "id-taken") {
      setConflict(result);
      return;
    }
    if (result === "busy") setSaveError(zh.saveConflictRetry);
  }

  async function saveEditorRowWithSnapshot(
    editorMode: "create" | "edit",
    buildRow: (retireLegacyFields: boolean) => Team,
    overwrite: boolean,
  ) {
    const snapshot = opened.current;
    if (!snapshot) {
      setSaveError(zh.saveFail);
      return "failed" as const;
    }
    setSaveError(null);
    setSavingHere(true);
    try {
      // E2: the retired keys are dropped only if the host this Team is written to ignores them.
      const retireLegacyFields = await shouldRetire(retirementProbe, "team", baseline.current);
      const result = await saveEditorRow({
        mode: editorMode,
        key: "teams",
        row: buildRow(retireLegacyFields),
        baseline: baseline.current,
        opened: snapshot,
        forceOverwrite: overwrite,
        read: () => readTeamsDoc({}),
        write: (document, revision) =>
          writeTeamsDoc({ revision, values: toJsonValue(document) as JSONType }),
        parse: parseTeamsDocument,
      });
      if (result === "invalid" || result === "failed") setSaveError(zh.saveFail);
      return result;
    } finally {
      setSavingHere(false);
    }
  }

  return (
    <>
      <Modal
        title={mode === "create" ? zh.newTeam : zh.editTeam}
        icon={<Icon name="Users" size={18} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={(next) => !next && onClose()}
      >
        <Modal.Content>
          <View style={{ gap: layout.compact ? 10 : 14 }}>
            {planClient ? (
              <View style={{ gap: 4 }}>
                {draftPlan.state.status === "pending" ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    {teamPlanZh.pending}
                  </Text>
                ) : null}
                {draftPlan.state.status === "error" ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
                      {draftPlan.state.message}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={teamPlanZh.retry}
                      onPress={draftPlan.retry}
                    >
                      <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
                        {teamPlanZh.retry}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
                {planIssues.map((issue) => (
                  <Text
                    key={`${issue.severity}:${issue.text}`}
                    style={{
                      color:
                        issue.severity === "blocker"
                          ? theme.colors.statusDanger
                          : theme.colors.statusWarning,
                      fontSize: 12,
                    }}
                  >
                    {issue.text}
                  </Text>
                ))}
              </View>
            ) : null}
            <TextField
              theme={theme}
              label={zh.name}
              value={name}
              revision={formSeed}
              error={errors.name}
              placeholder={zh.placeholderTeamName}
              onChange={(next) => {
                nameRef.current = next;
                setName(next);
              }}
              onBlur={() => {
                const nextId = autoSlug.nextFromName(idLocked, nameRef.current);
                if (nextId === null) return;
                setId(nextId);
                setIdSeed((seed) => seed + 1);
              }}
            />
            <SlugInput
              theme={theme}
              value={id}
              revision={`${formSeed}:${idSeed}`}
              locked={idLocked}
              error={errors.id}
              onChange={(next) => {
                autoSlug.markManual();
                setId(next);
              }}
            />
            <TextField
              theme={theme}
              label={zh.description}
              value={description}
              revision={formSeed}
              error={errors.description}
              onChange={setDescription}
            />
            {retiredLines.map((line) => (
              <Text key={line} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {line}
              </Text>
            ))}
            <RolePicker
              theme={theme}
              label={zh.coordinator}
              roles={roles}
              selectedId={coordinatorRoleId}
              error={errors.coordinatorRoleId}
              onChange={setCoordinatorRoleId}
            />
            {coordinatorModel ? (
              <ModelRow theme={theme} view={coordinatorModel} onOpenRole={onOpenRole} />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedOpen }}
              accessibilityLabel={advancedOpen ? zh.teamAdvancedHide : zh.teamAdvancedShow}
              onPress={() => setAdvancedOpen((value) => !value)}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 30 }}
            >
              <Icon
                name={advancedOpen ? "ChevronDown" : "ChevronRight"}
                size={14}
                color={theme.colors.foregroundMuted}
              />
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                {zh.teamAdvanced}
              </Text>
            </Pressable>
            {advancedOpen ? (
              <View style={{ gap: 10 }}>
                <CompactPicker
                  theme={theme}
                  label={zh.memberCreation}
                  items={MEMBER_CREATION_OPTIONS.map((option) => ({
                    id: option.value,
                    name: option.label,
                  }))}
                  selectedId={memberCreation}
                  placeholder={zh.memberCreationDefault}
                  searchPlaceholder={zh.searchOptions}
                  emptyLabel={zh.noMatches}
                  onChange={(id) => {
                    setMemberCreation(id as MemberCreation);
                    setMemberCreationTouched(true);
                  }}
                />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {zh.memberCreationHint}
                </Text>
                {!memberCreationTouched &&
                team?.memberCreation !== undefined &&
                !MEMBER_CREATION_OPTIONS.some((option) => option.value === team.memberCreation) ? (
                  <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                    {zh.memberCreationUnknown(team.memberCreation)}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.members}</Text>
            {errors.members ? (
              <Text style={{ color: theme.colors.statusDanger }}>{errors.members}</Text>
            ) : null}
            {errors.form ? (
              <Text style={{ color: theme.colors.statusDanger }}>{errors.form}</Text>
            ) : null}
            {members.map((member, index) => {
              const memberRows = rowsByKey.get(draftRowKey(member, index)) ?? [];
              return (
                <MemberEditor
                  key={member.seatId ?? `legacy-${index}`}
                  theme={theme}
                  revision={`${formSeed}:${member.seatId ?? `legacy-${index}`}`}
                  member={member}
                  roles={roles}
                  coordinatorRoleId={coordinatorRoleId}
                  onChange={(next) => {
                    const copy = [...members];
                    copy[index] = next;
                    setMembers(copy);
                  }}
                  onMove={(direction) => {
                    const target = index + direction;
                    if (target < 0 || target >= members.length) return;
                    const copy = [...members];
                    const [item] = copy.splice(index, 1);
                    if (item) copy.splice(target, 0, item);
                    setMembers(copy);
                  }}
                  onDuplicate={() => {
                    const role = roles.find((entry) => entry.id === member.roleId);
                    const pair = duplicateMemberPair(member, role?.name ?? member.roleId, members);
                    const next = [...members];
                    next[index] = pair.original;
                    next.splice(index + 1, 0, pair.copy);
                    setMembers(next);
                  }}
                  onRemove={() => setMembers(members.filter((_, itemIndex) => itemIndex !== index))}
                  modelRows={memberRows.map((view) => (
                    <ModelRow key={view.key} theme={theme} view={view} onOpenRole={onOpenRole} />
                  ))}
                />
              );
            })}
            {(() => {
              const known = new Set(members.map((member, index) => draftRowKey(member, index)));
              const other = modelRows.filter(
                (view) => view.kind === "member" && !known.has(view.rowKey),
              );
              if (other.length === 0) return null;
              return (
                <View style={{ gap: 4 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    {teamPlanZh.otherSeats}
                  </Text>
                  {other.map((view) => (
                    <ModelRow key={view.key} theme={theme} view={view} onOpenRole={onOpenRole} />
                  ))}
                </View>
              );
            })()}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={zh.addMember}
              onPress={() =>
                setMembers([
                  ...members,
                  newTeamMember(roles, coordinatorRoleId, usedSeatIds(members)),
                ])
              }
              style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28 }}
            >
              <Icon name="Plus" size={14} color={theme.colors.accent} />
              <Text style={{ color: theme.colors.accent, fontWeight: "600", fontSize: 13 }}>
                {zh.addMember}
              </Text>
            </Pressable>
            <TextField
              theme={theme}
              label={zh.operatingRules}
              value={operatingRules}
              revision={formSeed}
              multiline
              onChange={setOperatingRules}
            />
            {saveError ? (
              <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{saveError}</Text>
            ) : null}
            <ModalActions
              theme={theme}
              confirmLabel={saving || savingHere ? zh.saving : zh.save}
              confirmDisabled={saving || savingHere || !snapshotReady}
              onCancel={onClose}
              onConfirm={() => void submit(false)}
            />
          </View>
        </Modal.Content>
      </Modal>
      <ConfirmDialog
        theme={theme}
        open={conflict !== null}
        title={zh.conflictTitle}
        body={
          conflict === "id-taken"
            ? zh.conflictTeamIdTaken
            : conflict === "deleted"
              ? zh.conflictTeamDeleted
              : zh.conflictTeamModified
        }
        confirmLabel={zh.overwrite}
        cancelLabel={conflict === "id-taken" ? zh.editAgain : zh.reload}
        confirmHidden={conflict === "id-taken"}
        danger
        onCancel={() => {
          if (conflict === "id-taken") {
            setConflict(null);
            return;
          }
          void reloadDraft();
        }}
        onConfirm={() => {
          setConflict(null);
          void submit(true);
        }}
      />
    </>
  );
}
