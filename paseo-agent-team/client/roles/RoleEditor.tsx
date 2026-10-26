import { settingsRpc } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { JSONType } from "zod";
import { createAutoSlug, slugify } from "../../shared/ids";
import { toJsonValue } from "../../shared/json";
import type { PaseoProfile } from "../../shared/paseo/adapter";
import type { ProfileRef } from "../../shared/schemas/profile-ref";
import {
  type McpServers,
  McpServersSchema,
  type Role,
  RoleSchema,
} from "../../shared/schemas/role";
import { RolesDocumentSchema, rolesSettings } from "../../shared/settings";
import { zh } from "../../shared/zh";
import {
  type EditorDocumentSnapshot,
  type EditorParsed,
  loadEditorSnapshot,
  saveEditorRow,
} from "../catalog/editor-save";
import { keepRoleMetadata, mergeRoleExecutionPolicy } from "../catalog/preset-metadata";
import { AppearanceField } from "../shared/AppearanceField";
import { resolveIdentityColor, storedIdentityColor, storedRoleIcon } from "../shared/appearance";
import { ModalActions } from "../shared/buttons";
import { CompactPicker } from "../shared/CompactPicker";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Field, TextField } from "../shared/Field";
import { RoleGlyph } from "../shared/RoleGlyph";
import { SlugInput } from "../shared/SlugInput";
import {
  applyRolePolicyChoice,
  ROLE_TIER_OPTIONS,
  TASK_KIND_OPTIONS,
} from "../shared/team-mode-options";
import type { PluginLayout, PluginTheme } from "../shared/theme";
import { ListEditor } from "./ListEditor";
import { ProfilePicker } from "./ProfilePicker";

const rolesRead = settingsRpc(rolesSettings.id).read;
const rolesWrite = settingsRpc(rolesSettings.id).write;

function parseRolesDocument(values: unknown): EditorParsed<Role> {
  const parsed = RolesDocumentSchema.safeParse(values);
  return parsed.success
    ? { ok: true, rows: parsed.data.roles }
    : { ok: false, error: parsed.error.issues.map((entry) => entry.message).join("\n") };
}

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
  executionTier: string;
  executionTaskKind: string;
  executionTierTouched: boolean;
  executionTaskKindTouched: boolean;
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
      executionTier: "",
      executionTaskKind: "",
      executionTierTouched: false,
      executionTaskKindTouched: false,
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
    executionTier: typeof role.executionPolicy?.tier === "string" ? role.executionPolicy.tier : "",
    executionTaskKind:
      typeof role.executionPolicy?.taskKind === "string" ? role.executionPolicy.taskKind : "",
    executionTierTouched: false,
    executionTaskKindTouched: false,
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
  const readRolesDoc = useRpc(rolesRead);
  const writeRolesDoc = useRpc(rolesWrite);
  const [draft, setDraft] = useState<RoleDraft>(() => toDraft(role));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [mcpError, setMcpError] = useState<string | undefined>();
  const [formSeed, setFormSeed] = useState(0);
  const [idSeed, setIdSeed] = useState(0);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingHere, setSavingHere] = useState(false);
  const opened = useRef<EditorDocumentSnapshot<Role> | null>(null);
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

  useEffect(() => {
    opened.current = null;
    setSnapshotReady(false);
    setSaveError(null);
    if (!open) return;
    let live = true;
    void loadEditorSnapshot(() => readRolesDoc({}), parseRolesDocument).then((result) => {
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
  }, [open, readRolesDoc]);

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
      executionPolicy: mergeRoleExecutionPolicy(role?.executionPolicy, {
        tier: draft.executionTier,
        taskKind: draft.executionTaskKind,
        tierTouched: draft.executionTierTouched,
        taskKindTouched: draft.executionTaskKindTouched,
      }),
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
    const snapshot = opened.current;
    if (!snapshot) {
      setSaveError(zh.saveFail);
      return;
    }
    setSaveError(null);
    setSavingHere(true);
    try {
      const result = await saveEditorRow({
        mode,
        key: "roles",
        row: keepRoleMetadata(role, parsed.data),
        opened: snapshot,
        forceOverwrite: overwrite,
        read: () => readRolesDoc({}),
        write: (document, revision) =>
          writeRolesDoc({ revision, values: toJsonValue(document) as JSONType }),
        parse: parseRolesDocument,
      });
      if (result === "saved") {
        onClose();
        return;
      }
      if (result === "conflict") {
        setConflict(true);
        return;
      }
      setSaveError(zh.saveFail);
    } finally {
      setSavingHere(false);
    }
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
            <CompactPicker
              theme={theme}
              label={zh.roleExecutionTier}
              items={[
                { id: "", name: zh.rolePolicyKeep },
                ...ROLE_TIER_OPTIONS.map((option) => ({ id: option.value, name: option.label })),
              ]}
              selectedId={draft.executionTier}
              placeholder={zh.rolePolicyKeep}
              searchPlaceholder={zh.searchOptions}
              emptyLabel={zh.noMatches}
              onChange={(executionTier) =>
                setDraft((current) => applyRolePolicyChoice(current, "tier", executionTier))
              }
            />
            <CompactPicker
              theme={theme}
              label={zh.roleExecutionTaskKind}
              items={[
                { id: "", name: zh.rolePolicyKeep },
                ...TASK_KIND_OPTIONS.map((option) => ({ id: option.value, name: option.label })),
              ]}
              selectedId={draft.executionTaskKind}
              placeholder={zh.rolePolicyKeep}
              searchPlaceholder={zh.searchOptions}
              emptyLabel={zh.noMatches}
              onChange={(executionTaskKind) =>
                setDraft((current) => applyRolePolicyChoice(current, "taskKind", executionTaskKind))
              }
            />
            {draft.executionTier === "" || draft.executionTaskKind === "" ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {zh.rolePolicyKeepHint}
              </Text>
            ) : null}
            {!draft.executionTierTouched &&
            role?.executionPolicy?.tier !== undefined &&
            (typeof role.executionPolicy.tier !== "string" ||
              !ROLE_TIER_OPTIONS.some((option) => option.value === role.executionPolicy?.tier)) ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                {zh.rolePolicyUnknown(String(role.executionPolicy.tier))}
              </Text>
            ) : null}
            {!draft.executionTaskKindTouched &&
            role?.executionPolicy?.taskKind !== undefined &&
            (typeof role.executionPolicy.taskKind !== "string" ||
              !TASK_KIND_OPTIONS.some(
                (option) => option.value === role.executionPolicy?.taskKind,
              )) ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                {zh.rolePolicyUnknown(String(role.executionPolicy.taskKind))}
              </Text>
            ) : null}
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
        open={conflict}
        title={zh.conflictTitle}
        body={zh.conflictRole}
        confirmLabel={zh.overwrite}
        cancelLabel={zh.reload}
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
