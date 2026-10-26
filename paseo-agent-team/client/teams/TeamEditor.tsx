import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { createAutoSlug, slugify } from "../../shared/ids";
import type { Role } from "../../shared/schemas/role";
import type { Team, TeamMember } from "../../shared/schemas/team";
import { TeamSchema } from "../../shared/schemas/team";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { zh } from "../../shared/zh";
import { keepTeamMetadata } from "../catalog/preset-metadata";
import { ModalActions } from "../shared/buttons";
import { CompactPicker } from "../shared/CompactPicker";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TextField } from "../shared/Field";
import { RolePicker } from "../shared/RolePicker";
import { SlugInput } from "../shared/SlugInput";
import { TeamModePicker } from "../shared/TeamModePicker";
import { MEMBER_CREATION_OPTIONS, type MemberCreation } from "../shared/team-mode-options";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { MemberEditor } from "./MemberEditor";
import {
  buildTeamModeFields,
  type CollaborationDraft,
  type CollaborationTouched,
  duplicateMemberPair,
  newTeamMember,
  readCollaboration,
  readMemberCreation,
  readStoredTeamMode,
  usedSeatIds,
} from "./team-mode-edit";

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
  onSave,
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
  onSave: (team: Team, overwrite: boolean) => Promise<boolean | "conflict">;
}) {
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
  const [teamMode, setTeamMode] = useState<TeamMode>("sota");
  const [modeUnknown, setModeUnknown] = useState<string | null>(null);
  const [memberCreation, setMemberCreation] = useState<MemberCreation>("");
  const [collaboration, setCollaboration] = useState<CollaborationDraft>({
    replicas: 2,
    judgeRoleId: "",
    escalationRoleId: "",
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modeTouched, setModeTouched] = useState(false);
  const [memberCreationTouched, setMemberCreationTouched] = useState(false);
  const [collaborationTouched, setCollaborationTouched] = useState<CollaborationTouched>({
    replicas: false,
    judgeRoleId: false,
    escalationRoleId: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [formSeed, setFormSeed] = useState(0);
  const [idSeed, setIdSeed] = useState(0);
  const idLocked = mode === "edit";
  const autoSlug = useRef(createAutoSlug("team")).current;
  const nameRef = useRef(name);

  useEffect(() => {
    if (!open) return;
    const nextName = team?.name ?? "";
    const nextId = team?.id ?? slugify(nextName, "team");
    autoSlug.reset(mode === "edit", nextId, nextName);
    nameRef.current = nextName;
    setName(nextName);
    setId(nextId);
    setDescription(team?.description ?? "");
    setCoordinatorRoleId(team?.coordinatorRoleId ?? defaultCoordinatorId);
    const nextCoordinator = team?.coordinatorRoleId ?? defaultCoordinatorId;
    setMembers(team?.members ?? [newTeamMember(roles, nextCoordinator, new Set())]);
    setOperatingRules(team?.operatingRules ?? "");
    const storedMode = readStoredTeamMode(team?.mode);
    setTeamMode(storedMode.mode);
    setModeUnknown(storedMode.unknown);
    setMemberCreation(readMemberCreation(team?.memberCreation));
    const storedCollaboration = readCollaboration(team?.collaboration);
    setCollaboration(storedCollaboration);
    setAdvancedOpen(storedMode.mode === "collaborative" || Boolean(team?.collaboration));
    setModeTouched(false);
    setMemberCreationTouched(false);
    setCollaborationTouched({
      replicas: false,
      judgeRoleId: false,
      escalationRoleId: false,
    });
    setErrors({});
    setConflict(false);
    setFormSeed((seed) => seed + 1);
    setIdSeed((seed) => seed + 1);
  }, [autoSlug, defaultCoordinatorId, mode, open, roles, team]);

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
      ...buildTeamModeFields({
        original: team,
        mode: teamMode,
        modeTouched,
        memberCreation,
        memberCreationTouched,
        collaboration,
        collaborationTouched,
      }),
      operatingRules: operatingRules.trim() || undefined,
      enabled: true,
      createdAt: team?.createdAt ?? now,
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
    const result = await onSave(keepTeamMetadata(team, parsed.data), overwrite);
    if (result === "conflict") {
      setConflict(true);
      return;
    }
    if (result) onClose();
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
            <TeamModePicker
              theme={theme}
              layout={layout}
              value={teamMode}
              onChange={(next) => {
                setTeamMode(next);
                setModeTouched(true);
                setModeUnknown(null);
              }}
            />
            {modeUnknown ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {zh.teamModeUnknown(modeUnknown)}
              </Text>
            ) : null}
            <RolePicker
              theme={theme}
              label={zh.coordinator}
              roles={roles}
              selectedId={coordinatorRoleId}
              error={errors.coordinatorRoleId}
              onChange={setCoordinatorRoleId}
            />
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
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {zh.collaborationReplicas}
                </Text>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {([2, 3] as const).map((replicas) => {
                    const selected = collaboration.replicas === replicas;
                    return (
                      <Pressable
                        key={replicas}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={
                          replicas === 2 ? zh.collaborationTwo : zh.collaborationThree
                        }
                        onPress={() => setCollaboration((current) => ({ ...current, replicas }))}
                        style={{
                          minHeight: 34,
                          paddingHorizontal: 12,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: selected ? theme.colors.accent : theme.colors.border,
                          backgroundColor: selected ? theme.colors.surface1 : theme.colors.surface2,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          style={{
                            color: selected ? theme.colors.accent : theme.colors.foreground,
                            fontSize: 13,
                            fontWeight: "600",
                          }}
                        >
                          {replicas === 2 ? zh.collaborationTwo : zh.collaborationThree}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {zh.collaborationHint}
                </Text>
                {team?.collaboration &&
                ((!collaborationTouched.replicas &&
                  team.collaboration.replicas !== undefined &&
                  team.collaboration.replicas !== 2 &&
                  team.collaboration.replicas !== 3) ||
                  (!collaborationTouched.judgeRoleId &&
                    team.collaboration.judgeRoleId !== undefined &&
                    typeof team.collaboration.judgeRoleId !== "string") ||
                  (!collaborationTouched.escalationRoleId &&
                    team.collaboration.escalationRoleId !== undefined &&
                    typeof team.collaboration.escalationRoleId !== "string")) ? (
                  <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                    {zh.collaborationUnknown}
                  </Text>
                ) : null}
                <CompactPicker
                  theme={theme}
                  label={zh.judgeRole}
                  items={[
                    { id: "", name: zh.roleAuto },
                    ...roles.map((role) => ({ id: role.id, name: role.name })),
                  ]}
                  selectedId={collaboration.judgeRoleId}
                  placeholder={zh.roleAuto}
                  searchPlaceholder={zh.searchRoles}
                  emptyLabel={zh.noMatchingRoles}
                  onChange={(judgeRoleId) => {
                    setCollaboration((current) => ({ ...current, judgeRoleId }));
                    setCollaborationTouched((current) => ({ ...current, judgeRoleId: true }));
                  }}
                />
                <CompactPicker
                  theme={theme}
                  label={zh.escalationRole}
                  items={[
                    { id: "", name: zh.roleAuto },
                    ...roles.map((role) => ({ id: role.id, name: role.name })),
                  ]}
                  selectedId={collaboration.escalationRoleId}
                  placeholder={zh.roleAuto}
                  searchPlaceholder={zh.searchRoles}
                  emptyLabel={zh.noMatchingRoles}
                  onChange={(escalationRoleId) => {
                    setCollaboration((current) => ({ ...current, escalationRoleId }));
                    setCollaborationTouched((current) => ({
                      ...current,
                      escalationRoleId: true,
                    }));
                  }}
                />
              </View>
            ) : null}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.members}</Text>
            {errors.members ? (
              <Text style={{ color: theme.colors.statusDanger }}>{errors.members}</Text>
            ) : null}
            {errors.form ? (
              <Text style={{ color: theme.colors.statusDanger }}>{errors.form}</Text>
            ) : null}
            {members.map((member, index) => (
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
              />
            ))}
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
            <ModalActions
              theme={theme}
              confirmLabel={saving ? zh.saving : zh.save}
              confirmDisabled={saving}
              onCancel={onClose}
              onConfirm={() => void submit(false)}
            />
          </View>
        </Modal.Content>
      </Modal>
      <ConfirmDialog
        theme={theme}
        open={conflict}
        title={zh.conflictTitle}
        body={zh.conflictTeam}
        confirmLabel={zh.overwrite}
        danger
        onCancel={() => {
          setConflict(false);
          onClose();
        }}
        onConfirm={() => {
          setConflict(false);
          void submit(true);
        }}
      />
    </>
  );
}
