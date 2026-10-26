import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef } from "react";
import { Platform, type TextInputProps } from "react-native";
import { finishComposition } from "./ime-composition";

export type ImeTextInputProps = Omit<TextInputProps, "value" | "defaultValue"> & {
  /** Seed shown on mount and whenever `revision` changes. Never replayed as a controlled `value`. */
  initialValue?: string;
  /** Bump to remount and apply `initialValue` (open a dialog, clear a draft). */
  revision?: string | number;
  /** Web composition notifications; native callers rely on their own debounce. */
  onCompositionChange?: (composing: boolean) => void;
};

/**
 * Uncontrolled input that keeps CJK IME composition on the native surface.
 * Passing `value` back into TextInput on every keystroke cancels pinyin/zhuyin/kana on mobile.
 */
export function ImeTextInput({
  initialValue = "",
  revision = 0,
  onChangeText,
  onBlur,
  onCompositionChange,
  ...rest
}: ImeTextInputProps) {
  const composing = useRef(false);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    void revision;
    composing.current = false;
    pending.current = null;
  }, [revision]);

  const publish = useCallback(
    (text: string) => {
      pending.current = null;
      onChangeText?.(text);
    },
    [onChangeText],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      if (composing.current) {
        pending.current = text;
        return;
      }
      publish(text);
    },
    [publish],
  );

  const flushPending = useCallback(() => {
    composing.current = false;
    if (pending.current !== null) publish(pending.current);
  }, [publish]);

  const handleBlur = useCallback<NonNullable<TextInputProps["onBlur"]>>(
    (event) => {
      finishComposition(flushPending, onCompositionChange);
      onBlur?.(event);
    },
    [flushPending, onBlur, onCompositionChange],
  );

  const webComposition =
    Platform.OS === "web"
      ? {
          onCompositionStart: () => {
            composing.current = true;
            onCompositionChange?.(true);
          },
          onCompositionEnd: () => {
            finishComposition(flushPending, onCompositionChange);
          },
        }
      : undefined;

  return (
    <TextInput
      key={String(revision)}
      {...rest}
      defaultValue={initialValue}
      onChangeText={handleChangeText}
      onBlur={handleBlur}
      {...webComposition}
    />
  );
}
