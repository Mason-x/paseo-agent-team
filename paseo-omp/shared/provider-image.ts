import { z } from "zod";

const MAX_IMAGE_ENCODED_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DECODED_BYTES = 6 * 1024 * 1024;
const MAX_CUMULATIVE_ENCODED_BYTES = 12 * 1024 * 1024;
const MAX_CUMULATIVE_DECODED_BYTES = 9 * 1024 * 1024;
const MAX_IMAGE_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_DETAILS_BYTES = 256 * 1024;
const OMP_IMAGE_CALL_ID =
  /^omp:(?:tool:\d+|assistant:\d+:[A-Za-z0-9_-]+:content:\d+:image|custom:[A-Za-z0-9_-]+):images$/u;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const OMP_IMAGE_DIMENSION_NOTE =
  /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/u;

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function boundedString(maxBytes: number) {
  return z.string().refine((value) => utf8Bytes(value) <= maxBytes);
}
function decodedBase64Length(data: string): number | undefined {
  if (
    data.length === 0 ||
    data.length % 4 !== 0 ||
    data.length > MAX_IMAGE_ENCODED_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)
  ) {
    return undefined;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decoded = (data.length / 4) * 3 - padding;
  return decoded <= MAX_IMAGE_DECODED_BYTES ? decoded : undefined;
}

function decodedPrefix(data: string): number[] {
  const bytes: number[] = [];
  for (let offset = 0; offset < data.length && bytes.length < 12; offset += 4) {
    const a = BASE64.indexOf(data[offset] ?? "");
    const b = BASE64.indexOf(data[offset + 1] ?? "");
    const c = data[offset + 2] === "=" ? 0 : BASE64.indexOf(data[offset + 2] ?? "");
    const d = data[offset + 3] === "=" ? 0 : BASE64.indexOf(data[offset + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) return [];
    bytes.push((a << 2) | (b >> 4));
    if (data[offset + 2] !== "=") bytes.push(((b & 15) << 4) | (c >> 2));
    if (data[offset + 3] !== "=") bytes.push(((c & 3) << 6) | d);
  }
  return bytes;
}

function hasExpectedHeader(mimeType: string, bytes: readonly number[]): boolean {
  if (mimeType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  return (
    bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) in { GIF87a: true, GIF89a: true }
  );
}

const ompImageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  data: z.string().max(MAX_IMAGE_ENCODED_BYTES),
  mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
});

export const ompImageTimelineSchema = z
  .object({
    label: boundedString(256),
    images: z.array(ompImageSchema).min(1).max(64),
    text: boundedString(MAX_IMAGE_TEXT_BYTES).optional(),
    details: z.json().optional(),
  })
  .superRefine((value, context) => {
    let encodedBytes = 0;
    let decodedBytes = 0;
    for (const [index, image] of value.images.entries()) {
      const decoded = decodedBase64Length(image.data);
      if (decoded === undefined || !hasExpectedHeader(image.mimeType, decodedPrefix(image.data))) {
        context.addIssue({
          code: "custom",
          path: ["images", index, "data"],
          message: "invalid image payload",
        });
        continue;
      }
      encodedBytes += image.data.length;
      decodedBytes += decoded;
    }
    if (
      encodedBytes > MAX_CUMULATIVE_ENCODED_BYTES ||
      decodedBytes > MAX_CUMULATIVE_DECODED_BYTES
    ) {
      context.addIssue({ code: "custom", path: ["images"], message: "image payload too large" });
    }
    if (
      value.details !== undefined &&
      utf8Bytes(JSON.stringify(value.details)) > MAX_IMAGE_DETAILS_BYTES
    ) {
      context.addIssue({ code: "custom", path: ["details"], message: "image details too large" });
    }
  });

export function visibleOmpImageText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const visible = text
    .split("\n")
    .filter((line) => !OMP_IMAGE_DIMENSION_NOTE.test(line.trim()))
    .join("\n")
    .trim();
  return visible || undefined;
}

export const ompImageToolMetadataSchema = z.object({
  ompImageOwner: z.literal("omp"),
  ompImage: ompImageTimelineSchema,
});

export function transformOmpImageToolItem(item: { callId: string; metadata?: unknown }) {
  if (!OMP_IMAGE_CALL_ID.test(item.callId)) return undefined;
  const metadata = ompImageToolMetadataSchema.safeParse(item.metadata);
  if (!metadata.success) return undefined;
  return {
    items: [
      {
        type: "plugin" as const,
        kind: "omp-images",
        id: item.callId,
        version: 1,
        data: metadata.data.ompImage,
      },
    ],
  };
}

export type OmpImageTimelineData = z.infer<typeof ompImageTimelineSchema>;
