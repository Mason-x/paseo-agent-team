import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PortEngineAgentHandle } from "../../shared/paseo/port";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(location);
    return entry.isFile() && entry.name.endsWith(".ts") ? [location] : [];
  });
}

describe("permission handling belongs to the person", () => {
  test("the Engine port and server have no permission-answering method", () => {
    // This assignment must also pass tsc: adding that method to the port makes it fail.
    const portCanAnswer: "respondToPermission" extends keyof PortEngineAgentHandle ? true : false =
      false;
    expect(portCanAnswer).toBe(false);
    const files = [
      ...sourceFiles(path.join(root, "server/run-engine")),
      path.join(root, "shared/paseo/port.ts"),
    ];
    const offenders = files.filter((file) =>
      /\brespondToPermission\b/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
