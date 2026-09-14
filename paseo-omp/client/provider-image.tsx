import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { type OmpImageTimelineData, visibleOmpImageText } from "../shared/provider-image";

export function OmpImageTimeline({ item, theme }: PluginTimelineItemProps<OmpImageTimelineData>) {
  const styles = useMemo(
    () => ({
      root: { gap: 8 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      text: { color: theme.colors.foreground, fontSize: 13 },
      image: {
        width: "100%" as const,
        minHeight: 220,
        aspectRatio: 16 / 9,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
      imageFallback: {
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      imageFallbackText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        textAlign: "center" as const,
      },
    }),
    [theme],
  );
  const [failedImageIds, setFailedImageIds] = useState<ReadonlySet<string>>(() => new Set());
  const visibleText = useMemo(() => visibleOmpImageText(item.data.text), [item.data.text]);
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{item.data.label}</Text>
      {visibleText ? <Text style={styles.text}>{visibleText}</Text> : null}
      {item.data.images.map((image, index) =>
        failedImageIds.has(image.id) ? (
          <View key={image.id} style={[styles.image, styles.imageFallback]}>
            <Text style={styles.imageFallbackText}>
              {image.mimeType.replace("image/", "").toUpperCase()} image could not be rendered on
              this Paseo client.
            </Text>
          </View>
        ) : (
          <Image
            key={image.id}
            source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
            resizeMode="contain"
            accessibilityLabel={`${item.data.label} image ${index + 1}`}
            onError={() =>
              setFailedImageIds((current) => {
                if (current.has(image.id)) return current;
                return new Set([...current, image.id]);
              })
            }
            style={styles.image}
          />
        ),
      )}
    </View>
  );
}
