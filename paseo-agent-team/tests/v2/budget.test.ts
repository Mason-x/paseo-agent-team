import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const v2Dir = path.resolve(import.meta.dirname, "../../v2");

function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  if (!text.length) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function sumDir(dir: string, ext: (name: string) => boolean): number {
  return readdirSync(dir)
    .filter(ext)
    .reduce((n, f) => n + lineCount(path.join(dir, f)), 0);
}

describe("v2 source line budget (AC12)", () => {
  it("stays within server/shared <= 2580, client <= 920, total <= 3500", () => {
    const serverAndShared =
      lineCount(path.join(v2Dir, "index.server.ts")) +
      sumDir(path.join(v2Dir, "shared"), (f) => f.endsWith(".ts")) +
      sumDir(path.join(v2Dir, "server"), (f) => f.endsWith(".ts"));
    const client =
      lineCount(path.join(v2Dir, "index.client.tsx")) +
      sumDir(path.join(v2Dir, "client"), (f) => f.endsWith(".ts") || f.endsWith(".tsx"));

    expect(serverAndShared).toBeLessThanOrEqual(2580);
    expect(client).toBeLessThanOrEqual(920);
    expect(serverAndShared + client).toBeLessThanOrEqual(3500);
  });
});
