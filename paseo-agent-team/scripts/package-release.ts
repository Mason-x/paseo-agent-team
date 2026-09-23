import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { zipSync } from "fflate";

const packageJson = JSON.parse(
  await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

const releaseFiles = [
  "package-lock.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "client/crew.ts",
  "client/main.tsx",
  "docs/images/agent-crew-overview.png",
  "docs/images/agent-crew-action.png",
  "index.client.tsx",
  "index.server.ts",
  "package.json",
  "paseo-plugin.json",
  "tsconfig.json",
] as const;

const output = process.argv[2] ?? `dist/paseo-agent-team-v${packageJson.version}.zip`;
const root = "paseo-agent-team";
const files: Record<string, Uint8Array> = {};

for (const path of releaseFiles) {
  files[posix.join(root, path)] = await readFile(path);
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
