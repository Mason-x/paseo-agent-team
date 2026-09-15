import { build } from "esbuild";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const expectedVersion = "0.37.1";
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
const pluginDataRoot = join(paseoHome, "plugin-data", "shared-browser");
const runtimeRoot = join(pluginDataRoot, "runtime");
const stagingRoot = join(pluginDataRoot, `.runtime-${process.pid}`);
const runtimeModules = join(stagingRoot, "node_modules");
const packagedAgentBrowser = join(projectRoot, "node_modules", "agent-browser");
const runtimeEntry = join(runtimeModules, ".bin", "agent-browser");
const supervisorEntry = join(projectRoot, "server", "supervisor-entry.ts");
const mcpEntry = join(projectRoot, "server", "mcp-entry.ts");

async function requireExecutable(path, label) {
  const absolutePath = resolve(path);
  try {
    await access(absolutePath, constants.X_OK);
  } catch {
    throw new Error(`${label} is missing or not executable: ${absolutePath}`);
  }
  return absolutePath;
}

async function validateAgentBrowser(path) {
  const { stdout } = await execFileAsync(path, ["--version"], { encoding: "utf8" });
  const version = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (version !== expectedVersion) {
    throw new Error(`Expected agent-browser ${expectedVersion}, received ${version ?? "unknown"}`);
  }
}
async function bundleRuntimeEntries() {
  await build({
    entryPoints: {
      supervisor: supervisorEntry,
      "shared-browser-mcp": mcpEntry,
    },
    outdir: stagingRoot,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    logLevel: "silent",
  });
}

async function applyPrivatePermissions(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      await applyPrivatePermissions(join(path, entry));
    }
    return;
  }
  await chmod(path, metadata.mode & 0o111 ? 0o700 : 0o600);
}

async function stageChromiumExecutable(executable) {
  const chromiumRoot = join(stagingRoot, "chromium");
  await mkdir(chromiumRoot, { recursive: true, mode: 0o700 });
  await symlink(executable, join(chromiumRoot, "chrome"));
}

async function findLinuxArm64Chromium() {
  if (platform() !== "linux" || arch() !== "arm64") return null;

  const candidate = "/usr/bin/chromium";
  try {
    return await requireExecutable(candidate, "System Chromium executable");
  } catch {
    throw new Error(
      `Linux ARM64 requires native Chromium at ${candidate}. ` +
        "Install a non-Snap Chromium build or set " +
        "PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE to its absolute path.",
    );
  }
}

async function installChromium() {
  const override = process.env.PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE;
  if (override) {
    const executable = await requireExecutable(
      override,
      "PASEO_SHARED_BROWSER_CHROMIUM_EXECUTABLE",
    );
    await stageChromiumExecutable(executable);
    return;
  }

  const systemChromium = await findLinuxArm64Chromium();
  if (systemChromium) {
    await stageChromiumExecutable(systemChromium);
    console.log(`Using system Chromium at ${systemChromium}`);
    return;
  }

  const installHome = join(stagingRoot, "install-home");
  await mkdir(installHome, { recursive: true, mode: 0o700 });
  await execFileAsync(runtimeEntry, ["install"], {
    env: { ...process.env, HOME: installHome },
    timeout: 180_000,
  });

  const browsersRoot = join(installHome, ".agent-browser", "browsers");
  const releases = (await readdir(browsersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chrome-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const chrome = releases[0] && join(browsersRoot, releases[0], "chrome");
  if (!chrome) throw new Error("agent-browser install did not produce a Chromium release");
  await requireExecutable(chrome, "Installed Chromium executable");
  await cp(dirname(chrome), join(stagingRoot, "chromium"), { recursive: true, force: true });
  await rm(installHome, { recursive: true, force: true });
}

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(join(runtimeModules, ".bin"), { recursive: true, mode: 0o700 });
await chmod(pluginDataRoot, 0o700);
await cp(packagedAgentBrowser, join(runtimeModules, "agent-browser"), {
  recursive: true,
  force: true,
});
await symlink("../agent-browser/bin/agent-browser.js", runtimeEntry);
await chmod(runtimeEntry, 0o700);

const binaryOverride = process.env.PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY;
if (binaryOverride)
  await validateAgentBrowser(
    await requireExecutable(binaryOverride, "PASEO_SHARED_BROWSER_AGENT_BROWSER_BINARY"),
  );
await validateAgentBrowser(await requireExecutable(runtimeEntry, "Packaged agent-browser entry"));
await installChromium();
await bundleRuntimeEntries();

await writeFile(
  join(stagingRoot, "package.json"),
  `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
  { mode: 0o600 },
);
await applyPrivatePermissions(stagingRoot);
await rm(runtimeRoot, { recursive: true, force: true });
await rename(stagingRoot, runtimeRoot);

console.log(`Prepared immutable Shared Browser runtime assets in ${runtimeRoot}`);
