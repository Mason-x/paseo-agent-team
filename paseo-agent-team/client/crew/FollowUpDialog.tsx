import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { zh } from "../../shared/zh";
import { ModalActions } from "../shared/buttons";
import { TextField } from "../shared/Field";
import type { PluginTheme } from "../shared/theme";

export type FollowUpTarget = { coordinatorId: string; teamName: string };

/**
 * Sends new work to a run's coordinator. A busy coordinator gets the message steered into its
 * current turn instead of losing that turn, so its in-flight delegation keeps going.
 */
export function FollowUpDialog({
  theme,
  target,
  onClose,
}: {
  theme: PluginTheme;
  target: FollowUpTarget | null;
  onClose: () => void;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const [text, setText] = useState("");
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    setText("");
    setBusy(false);
    setSeed((value) => value + 1);
  }, [target]);

  async function send() {
    const message = text.trim();
    if (!target || !message || busy) return;
    setBusy(true);
    try {
      await paseo.agents.ref(target.coordinatorId).send(message, { activeTurnBehavior: "steer" });
      toast.show(zh.followUpSent, { variant: "success" });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : zh.agentActionFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={target ? zh.followUpTitle(target.teamName) : zh.followUp}
      icon={<Icon name="MessageSquarePlus" size={18} color={theme.colors.foreground} />}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Modal.Content>
        <View style={{ gap: 12 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
            {zh.followUpCopy}
          </Text>
          <TextField
            theme={theme}
            label=""
            accessibilityLabel={zh.followUp}
            value={text}
            revision={seed}
            multiline
            placeholder={zh.followUpPlaceholder}
            onChange={setText}
          />
          <ModalActions
            theme={theme}
            confirmLabel={busy ? zh.workingEllipsis : zh.followUp}
            confirmDisabled={busy || !text.trim()}
            onCancel={onClose}
            onConfirm={() => void send()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
