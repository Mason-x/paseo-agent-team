import { settingsRpc } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { JSONType } from "zod";
import { hasRetiredFields, omitRetired } from "../../shared/domain/retired-fields";
import { MAX_RUNTIME_MEMBERS } from "../../shared/domain/seat-plan";
import { toJsonValue } from "../../shared/json";
import { teamPlanRpc } from "../../shared/rpc/team-plan";
import { PreferencesSchema } from "../../shared/schemas/preferences";
import { preferencesSettings } from "../../shared/settings";
import { zh } from "../../shared/zh";
import { createRetirementProbe, shouldRetire } from "../catalog/retirement";
import { useRetirement, useRetirementProbe } from "../catalog/use-retirement";
import { ModalActions } from "../shared/buttons";
import { TextField } from "../shared/Field";
import type { PluginTheme } from "../shared/theme";

const preferencesRead = settingsRpc(preferencesSettings.id).read;
const preferencesWrite = settingsRpc(preferencesSettings.id).write;

type Snapshot = { revision: string; raw: Record<string, unknown>; maxMembers: number };
type LoadState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; snapshot: Snapshot };

/** Edit only maxMembers, retaining all other raw preference fields on a revision-guarded write. */
export function MaxMembersEditor({
  theme,
  open,
  onClose,
  onSaved,
}: {
  theme: PluginTheme;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const read = useRpc(preferencesRead);
  const write = useRpc(preferencesWrite);
  const sendTeamPlan = useRpc(teamPlanRpc);
  const probe = useRetirementProbe();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [value, setValue] = useState("");
  const [inputRevision, setInputRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const hasLegacy = state.kind === "ready" && hasRetiredFields("preferences", state.snapshot.raw);
  const hostRetires = useRetirement(probe, open && hasLegacy);

  const load = useCallback(
    async (currentGeneration: number) => {
      try {
        const reply = await read({});
        if (generation.current !== currentGeneration) return;
        if (
          reply.status !== "ready" ||
          !reply.values ||
          typeof reply.values !== "object" ||
          Array.isArray(reply.values)
        ) {
          setState({ kind: "error" });
          return;
        }
        const parsed = PreferencesSchema.safeParse(reply.values);
        if (!parsed.success) {
          setState({ kind: "error" });
          return;
        }
        setState({
          kind: "ready",
          snapshot: {
            raw: reply.values as Record<string, unknown>,
            revision: reply.revision,
            maxMembers: parsed.data.maxMembers,
          },
        });
        setValue(String(parsed.data.maxMembers));
        setInputRevision((revision) => revision + 1);
        setError(null);
      } catch {
        if (generation.current === currentGeneration) setState({ kind: "error" });
      }
    },
    [read],
  );

  useEffect(() => {
    generation.current += 1;
    if (!open) return;
    const currentGeneration = generation.current;
    setState({ kind: "loading" });
    setError(null);
    setSaving(false);
    void load(currentGeneration);
    return () => {
      generation.current += 1;
    };
  }, [open, load]);

  function close() {
    if (inFlight.current) return;
    generation.current += 1;
    onClose();
  }

  async function submit() {
    if (state.kind !== "ready" || inFlight.current) return;
    const trimmed = value.trim();
    const next = Number(trimmed);
    const baseline = state.snapshot;
    if (/^\d+$/.test(trimmed) && next === baseline.maxMembers) {
      close();
      return;
    }
    if (
      !/^\d+$/.test(trimmed) ||
      !Number.isSafeInteger(next) ||
      next < 1 ||
      next > MAX_RUNTIME_MEMBERS
    ) {
      setError(zh.maxMembersInvalid);
      return;
    }
    const currentGeneration = generation.current;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const retireLegacyFields = await shouldRetire(
        createRetirementProbe(sendTeamPlan),
        "preferences",
        baseline.raw,
      );
      if (generation.current !== currentGeneration) return;
      const updated = { ...baseline.raw, maxMembers: next };
      const values = retireLegacyFields ? omitRetired("preferences", updated) : updated;
      const result = await write({
        revision: baseline.revision,
        values: toJsonValue(values) as JSONType,
      });
      if (generation.current !== currentGeneration) return;
      if (result.status === "saved") {
        onSaved();
        onClose();
      } else {
        setError(result.status === "conflict" ? zh.maxMembersSaveConflict : zh.maxMembersSaveFail);
      }
    } catch {
      if (generation.current === currentGeneration) setError(zh.maxMembersSaveFail);
    } finally {
      inFlight.current = false;
      if (generation.current === currentGeneration) setSaving(false);
    }
  }

  const retirementLine = !hasLegacy
    ? null
    : hostRetires === null
      ? zh.retiredPreferencesProbePending
      : hostRetires
        ? zh.retiredPreferences
        : zh.retiredPreferencesKept;

  return (
    <Modal title={zh.maxMembersTitle} open={open} onOpenChange={(next) => !next && close()}>
      <Modal.Content>
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {zh.maxMembersIntro}
          </Text>
          {state.kind === "loading" ? (
            <Text style={{ color: theme.colors.foregroundMuted }}>{zh.maxMembersLoading}</Text>
          ) : null}
          {state.kind === "error" ? (
            <Text style={{ color: theme.colors.statusDanger }}>{zh.maxMembersLoadFail}</Text>
          ) : null}
          {state.kind === "ready" ? (
            <>
              <TextField
                theme={theme}
                label={zh.maxMembers}
                value={value}
                revision={inputRevision}
                onChange={setValue}
                error={error ?? undefined}
              />
              {error === zh.maxMembersSaveConflict ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                  {zh.maxMembersReloadHint}
                </Text>
              ) : null}
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {zh.maxMembersHint}
              </Text>
              {state.snapshot.maxMembers > MAX_RUNTIME_MEMBERS ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                  {zh.maxMembersLegacy(state.snapshot.maxMembers)}
                </Text>
              ) : null}
              {retirementLine ? (
                <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                  {retirementLine}
                </Text>
              ) : null}
            </>
          ) : null}
          {state.kind === "error" ? (
            <ModalActions
              theme={theme}
              confirmLabel={zh.maxMembersRetry}
              onCancel={close}
              onConfirm={() => {
                setState({ kind: "loading" });
                void load(generation.current);
              }}
            />
          ) : (
            <ModalActions
              theme={theme}
              confirmLabel={saving ? zh.saving : zh.save}
              confirmDisabled={saving || state.kind !== "ready"}
              onCancel={close}
              onConfirm={() => void submit()}
            />
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
}
