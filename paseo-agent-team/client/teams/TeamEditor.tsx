import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { createAutoSlug, slugify } from "../../shared/ids";
import type { Role } from "../../shared/schemas/role";
import type { Team, TeamMember } from "../../shared/schemas/team";
import { TeamSchema } from "../../shared/schemas/team";
import { zh } from "../../shared/zh";
import { ModalActions } from "../shared/buttons";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TextField } from "../shared/Field";
import { RolePicker } from "../shared/RolePicker";
import { SlugInput } from "../shared/SlugInput";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { MemberEditor } from "./MemberEditor";

function emptyMember(roles: readonly Role[]): TeamMember {
  return { roleId: roles[0]?.id ?? "member", enabled: true };
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
  const [members, setMembers] = useState<TeamMember[]>(team?.members ?? [emptyMember(roles)]);
  const [operatingRules, setOperatingRules] = useState(team?.operatingRules ?? "");
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
    setMembers(team?.members ?? [emptyMember(roles)]);
    setOperatingRules(team?.operatingRules ?? "");
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
    const result = await onSave(parsed.data, overwrite);
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
            <RolePicker
              theme={theme}
              label={zh.coordinator}
              roles={roles}
              selectedId={coordinatorRoleId}
              error={errors.coordinatorRoleId}
              onChange={setCoordinatorRoleId}
            />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{zh.members}</Text>
            {errors.members ? (
              <Text style={{ color: theme.colors.statusDanger }}>{errors.members}</Text>
            ) : null}
            {errors.form ? (
              <Text style={{ color: theme.colors.statusDanger }}>{errors.form}</Text>
            ) : null}
            {members.map((member, index) => (
              <MemberEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: members can repeat a role
                key={index}
                theme={theme}
                revision={`${formSeed}:${index}`}
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
                onRemove={() => setMembers(members.filter((_, itemIndex) => itemIndex !== index))}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={zh.addMember}
              onPress={() =>
                setMembers([
                  ...members,
                  emptyMember(roles.filter((role) => role.id !== coordinatorRoleId)),
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
