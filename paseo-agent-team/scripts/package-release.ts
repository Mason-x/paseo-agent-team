import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { zipSync } from "fflate";

const root = join(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
  files: string[];
};

// Ship exactly what `npm pack` ships, plus the lockfile that makes `npm ci` reproducible.
const entries = [...packageJson.files, "package-lock.json"];

async function collect(relative: string, into: string[]): Promise<void> {
  const absolute = join(root, relative);
  if ((await stat(absolute)).isDirectory()) {
    for (const name of (await readdir(absolute)).sort()) {
      await collect(posix.join(relative, name), into);
    }
  } else {
    into.push(relative);
  }
}

const output = process.argv[2] ?? `dist/paseo-agent-team-v${packageJson.version}.zip`;
const archiveRoot = "paseo-agent-team";
const releaseFiles: string[] = [];
for (const entry of entries) await collect(entry, releaseFiles);

const files: Record<string, Uint8Array> = {};
for (const path of releaseFiles) {
  files[posix.join(archiveRoot, path)] = await readFile(join(root, path));
}

await mkdir("dist", { recursive: true });
await rm(output, { force: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(output);
