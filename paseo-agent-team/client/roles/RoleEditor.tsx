import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { createAutoSlug, slugify } from "../../shared/ids";
import type { ProfileRef } from "../../shared/schemas/profile-ref";
import {
  type McpServers,
  McpServersSchema,
  type Role,
  RoleSchema,
} from "../../shared/schemas/role";
import { zh } from "../../shared/zh";
import type { PaseoProfile } from "../paseo/adapter";
import { AppearanceField } from "../shared/AppearanceField";
import { resolveIdentityColor, storedIdentityColor, storedRoleIcon } from "../shared/appearance";
import { ModalActions } from "../shared/buttons";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Field, TextField } from "../shared/Field";
import { RoleGlyph } from "../shared/RoleGlyph";
import { SlugInput } from "../shared/SlugInput";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { ListEditor } from "./ListEditor";
import { ProfilePicker } from "./ProfilePicker";

export type RoleDraft = {
  id: string;
  name: string;
  description: string;
  mission: string;
  responsibilities: string[];
  restrictions: string[];
  systemPrompt: string;
  outputContract: string[];
  preferredProfiles: ProfileRef[];
  fallbackProfiles: ProfileRef[];
  mcpServersText: string;
  color: string;
  icon: string;
  enabled: boolean;
};

function toDraft(role: Role | null, nameSeed = ""): RoleDraft {
  if (!role) {
    return {
      id: slugify(nameSeed, "role"),
      name: nameSeed,
      description: "",
      mission: "",
      responsibilities: [""],
      restrictions: [],
      systemPrompt: "",
      outputContract: [],
      preferredProfiles: [],
      fallbackProfiles: [],
      mcpServersText: "",
      color: "",
      icon: "",
      enabled: true,
    };
  }
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? "",
    mission: role.mission,
    responsibilities: role.responsibilities.length > 0 ? role.responsibilities : [""],
    restrictions: role.restrictions,
    systemPrompt: role.systemPrompt,
    outputContract: role.outputContract,
    preferredProfiles: role.preferredProfiles,
    fallbackProfiles: role.fallbackProfiles,
    mcpServersText: role.mcpServers ? JSON.stringify(role.mcpServers, null, 2) : "",
    color: role.color ?? "",
    icon: role.icon ?? "",
    enabled: role.enabled,
  };
}

function fieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

export function RoleEditor({
  theme,
  layout,
  open,
  mode,
  role,
  existingIds,
  profiles,
  profilesLoading,
  profilesError,
  saving,
  onRefreshProfiles,
  onClose,
  onSave,
}: {
  theme: PluginTheme;
  layout: PluginLayout;
  open: boolean;
  mode: "create" | "edit";
  role: Role | null;
  existingIds: ReadonlySet<string>;
  profiles: readonly PaseoProfile[];
  profilesLoading: boolean;
  profilesError?: string;
  saving: boolean;
  onRefreshProfiles: () => void;
  onClose: () => void;
  onSave: (role: Role, overwrite: boolean) => Promise<boolean | "conflict">;
}) {
  const [draft, setDraft] = useState<RoleDraft>(() => toDraft(role));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [mcpError, setMcpError] = useState<string | undefined>();
  const [formSeed, setFormSeed] = useState(0);
  const [idSeed, setIdSeed] = useState(0);
  const idLocked = mode === "edit";
  const overwriteRef = useRef(false);
  const autoSlug = useRef(createAutoSlug("role")).current;
  const nameRef = useRef(draft.name);
  const createdAt = role?.createdAt;

  useEffect(() => {
    if (open) {
      const next = toDraft(role);
      autoSlug.reset(mode === "edit", next.id, next.name);
      nameRef.current = next.name;
      setDraft(next);
      setErrors({});
      setConflict(false);
      setMcpError(undefined);
      overwriteRef.current = false;
      setFormSeed((seed) => seed + 1);
      setIdSeed((seed) => seed + 1);
    }
  }, [autoSlug, mode, open, role]);

  function parseMcp(): McpServers | undefined | "invalid" {
    const text = draft.mcpServersText.trim();
    if (!text) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      const result = McpServersSchema.safeParse(parsed);
      if (!result.success) return "invalid";
      if (Object.keys(result.data).length === 0) return undefined;
      return result.data;
    } catch {
      return "invalid";
    }
  }

  async function submit(overwrite = false) {
    const mcp = parseMcp();
    if (mcp === "invalid") {
      setMcpError(zh.mcpInvalid);
      return;
    }
    setMcpError(undefined);
    const name = nameRef.current;
    const id = autoSlug.resolve(idLocked, name, draft.id);
    if (mode === "create" && existingIds.has(id)) {
      setErrors({ id: zh.idUsed(zh.roleKind, id) });
      return;
    }
    const now = new Date().toISOString();
    const description = draft.description.trim() || undefined;
    const color = storedIdentityColor(resolveIdentityColor(draft.color));
    const icon = storedRoleIcon(draft.icon);
    const candidate = {
      id,
      name,
      ...(description ? { description } : {}),
      mission: draft.mission,
      responsibilities: draft.responsibilities.map((item) => item.trim()).filter(Boolean),
      restrictions: draft.restrictions.map((item) => item.trim()).filter(Boolean),
      systemPrompt: draft.systemPrompt,
      outputContract: draft.outputContract.map((item) => item.trim()).filter(Boolean),
      preferredProfiles: draft.preferredProfiles,
      fallbackProfiles: draft.fallbackProfiles,
      ...(mcp ? { mcpServers: mcp } : {}),
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      enabled: true,
      createdAt: createdAt ?? now,
      updatedAt: now,
    };
    const parsed = RoleSchema.safeParse(candidate);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
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
        title={mode === "create" ? zh.newRole : zh.editRole}
        icon={<RoleGlyph theme={theme} icon={draft.icon} color={draft.color} size={18} />}
        open={open}
        onOpenChange={(next) => !next && onClose()}
      >
        <Modal.Content>
          <View style={{ gap: layout.compact ? 12 : 16 }}>
            <AppearanceField
              theme={theme}
              label={zh.icon}
              icon={draft.icon}
              color={draft.color}
              onChange={({ icon, color }) => setDraft((current) => ({ ...current, icon, color }))}
            >
              <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch" }}>
                <TextField
                  theme={theme}
                  label={zh.name}
                  value={draft.name}
                  revision={formSeed}
                  error={errors.name}
                  placeholder={zh.placeholderRoleName}
                  onChange={(name) => {
                    nameRef.current = name;
                    setDraft((current) => ({ ...current, name }));
                  }}
                  onBlur={() => {
                    const id = autoSlug.nextFromName(idLocked, nameRef.current);
                    if (id === null) return;
                    setDraft((current) => (current.id === id ? current : { ...current, id }));
                    setIdSeed((seed) => seed + 1);
                  }}
                />
              </View>
            </AppearanceField>
            <SlugInput
              theme={theme}
              value={draft.id}
              revision={`${formSeed}:${idSeed}`}
              locked={idLocked}
              error={errors.id}
              onChange={(id) => {
                autoSlug.markManual();
                setDraft((current) => ({ ...current, id }));
              }}
            />
            <TextField
              theme={theme}
              label={zh.description}
              value={draft.description}
              revision={formSeed}
              error={errors.description}
              placeholder={zh.placeholderRoleDesc}
              onChange={(description) => setDraft((current) => ({ ...current, description }))}
            />
            <TextField
              theme={theme}
              label={zh.mission}
              value={draft.mission}
              revision={formSeed}
              error={errors.mission}
              multiline
              placeholder={zh.placeholderMission}
              onChange={(mission) => setDraft((current) => ({ ...current, mission }))}
            />
            <ListEditor
              theme={theme}
              label={zh.responsibilities}
              values={draft.responsibilities}
              revision={formSeed}
              error={errors.responsibilities}
              onChange={(responsibilities) =>
                setDraft((current) => ({ ...current, responsibilities }))
              }
            />
            <ListEditor
              theme={theme}
              label={zh.restrictions}
              values={draft.restrictions}
              revision={formSeed}
              onChange={(restrictions) => setDraft((current) => ({ ...current, restrictions }))}
            />
            <TextField
              theme={theme}
              label={zh.systemPrompt}
              value={draft.systemPrompt}
              revision={formSeed}
              error={errors.systemPrompt}
              multiline
              mono
              onChange={(systemPrompt) => setDraft((current) => ({ ...current, systemPrompt }))}
            />
            <ListEditor
              theme={theme}
              label={zh.outputContract}
              values={draft.outputContract}
              revision={formSeed}
              onChange={(outputContract) => setDraft((current) => ({ ...current, outputContract }))}
            />
            <ProfilePicker
              theme={theme}
              label={zh.preferredProfiles}
              selected={draft.preferredProfiles}
              profiles={profiles}
              loading={profilesLoading}
              error={errors.preferredProfiles ?? profilesError}
              onChange={(preferredProfiles) =>
                setDraft((current) => ({ ...current, preferredProfiles }))
              }
              onRefresh={onRefreshProfiles}
            />
            <ProfilePicker
              theme={theme}
              label={zh.fallbackProfiles}
              selected={draft.fallbackProfiles}
              profiles={profiles}
              loading={profilesLoading}
              error={profilesError}
              onChange={(fallbackProfiles) =>
                setDraft((current) => ({ ...current, fallbackProfiles }))
              }
              onRefresh={onRefreshProfiles}
            />
            <Field theme={theme} label={zh.mcpServers} error={mcpError}>
              <TextField
                theme={theme}
                label=""
                value={draft.mcpServersText}
                revision={formSeed}
                multiline
                mono
                onChange={(mcpServersText) => {
                  setDraft((current) => ({ ...current, mcpServersText }));
                  setMcpError(undefined);
                }}
              />
            </Field>
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
        body={zh.conflictRole}
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
