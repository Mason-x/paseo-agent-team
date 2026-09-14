import { existsSync, statSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { OmpImageMaterializer } from "../server/provider/image";
import {
  ompImageTimelineSchema,
  transformOmpImageToolItem,
  visibleOmpImageText,
} from "../shared/provider-image";

const PNG = "iVBORw0KGgo=";

function imageMetadata(data = PNG) {
  return {
    ompImageOwner: "omp",
    ompImage: {
      label: "Screenshot",
      images: [{ id: "abcdefghijklmnop", data, mimeType: "image/png" as const }],
    },
  };
}

describe("OMP image timeline transformer", () => {
  test("ignores foreign and unowned tool calls", () => {
    expect(
      transformOmpImageToolItem({ callId: "foreign:tool:1", metadata: imageMetadata() }),
    ).toBeUndefined();
    expect(
      transformOmpImageToolItem({
        callId: "omp:tool:1:images",
        metadata: { ompImage: imageMetadata().ompImage },
      }),
    ).toBeUndefined();
  });

  test("rejects oversized cumulative and malformed image payloads", () => {
    const oversized = "A".repeat(8 * 1024 * 1024 + 4);
    expect(
      transformOmpImageToolItem({
        callId: "omp:tool:1:images",
        metadata: imageMetadata(oversized),
      }),
    ).toBeUndefined();

    const largePng = (fill: number) =>
      Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        Buffer.alloc(5 * 1024 * 1024 - 8, fill),
      ]).toString("base64");
    expect(
      transformOmpImageToolItem({
        callId: "omp:assistant:1:abcdefghijkl:content:0:image:images",
        metadata: {
          ompImageOwner: "omp",
          ompImage: {
            label: "Gallery",
            images: [
              { id: "abcdefghijklmnop", data: largePng(1), mimeType: "image/png" },
              { id: "ponmlkjihgfedcba", data: largePng(2), mimeType: "image/png" },
            ],
          },
        },
      }),
    ).toBeUndefined();

    for (const data of ["not base64", Buffer.from("not an image").toString("base64")]) {
      expect(
        transformOmpImageToolItem({
          callId: "omp:custom:abcdefghijkl:images",
          metadata: imageMetadata(data),
        }),
      ).toBeUndefined();
    }
  });

  test("renders a valid bounded OMP image carrier", () => {
    const transformed = transformOmpImageToolItem({
      callId: "omp:tool:7:images",
      metadata: imageMetadata(),
    });
    expect(transformed?.items).toEqual([
      {
        type: "plugin",
        kind: "omp-images",
        id: "omp:tool:7:images",
        version: 1,
        data: imageMetadata().ompImage,
      },
    ]);
    expect(ompImageTimelineSchema.parse(transformed?.items[0]?.data).images[0]).toEqual({
      id: "abcdefghijklmnop",
      data: PNG,
      mimeType: "image/png",
    });
  });

  test("hides machine-facing coordinate notes from the image caption", () => {
    const note =
      "[Image: original 320x180, displayed at 356x200. Multiply coordinates by 0.90 to map to original image.]";
    expect(visibleOmpImageText(`Screenshot captured\n${note}\nReleased managed tab`)).toBe(
      "Screenshot captured\nReleased managed tab",
    );
    expect(visibleOmpImageText(note)).toBeUndefined();
    expect(visibleOmpImageText("[Image: user-authored caption]")).toBe(
      "[Image: user-authored caption]",
    );
  });

  test("accepts PNG, JPEG, GIF, and WebP headers with multibyte labels", () => {
    for (const [mimeType, data] of [
      ["image/png", Buffer.from("89504e470d0a1a0a", "hex").toString("base64")],
      ["image/jpeg", Buffer.from("ffd8ff", "hex").toString("base64")],
      ["image/gif", Buffer.from("GIF89a").toString("base64")],
      ["image/webp", Buffer.from("RIFF\0\0\0\0WEBP", "binary").toString("base64")],
    ] as const) {
      expect(
        ompImageTimelineSchema.safeParse({
          label: "é🙂\ud800",
          images: [{ id: "abcdefghijklmnop", data, mimeType }],
        }).success,
      ).toBe(true);
    }
  });

  test("rejects oversized structured image details", () => {
    expect(
      ompImageTimelineSchema.safeParse({
        ...imageMetadata().ompImage,
        details: { text: "x".repeat(256 * 1024 + 1) },
      }).success,
    ).toBe(false);
  });

  test("unlinks materialized images when their session scope ends", () => {
    const materializer = new OmpImageMaterializer();
    const path = materializer.materialize(PNG, "image/png");
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

    materializer.clear();

    expect(existsSync(path)).toBe(false);
  });

  test("caps aggregate materialized image bytes and releases retained files", () => {
    const materializer = new OmpImageMaterializer(12);
    const first = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const second = Buffer.from("89504e470d0a1a0aff", "hex").toString("base64");
    const path = materializer.materialize(first, "image/png");

    expect(() => materializer.materialize(second, "image/png")).toThrow(
      "OMP materialized image budget exceeded",
    );
    materializer.release([path]);
    expect(existsSync(path)).toBe(false);
  });
});
