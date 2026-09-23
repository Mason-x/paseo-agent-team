import { Modal } from "@getpaseo/plugin/client/react-native";
import { Text } from "react-native";
import { ModalActions } from "./buttons";
import type { PluginTheme } from "./theme";

export function ConfirmDialog({
  theme,
  open,
  title,
  body,
  confirmLabel,
  danger,
  onCancel,
  onConfirm,
}: {
  theme: PluginTheme;
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} open={open} onOpenChange={(next) => !next && onCancel()}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{body}</Text>
        <ModalActions
          theme={theme}
          confirmLabel={confirmLabel}
          danger={danger}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </Modal.Content>
    </Modal>
  );
}
