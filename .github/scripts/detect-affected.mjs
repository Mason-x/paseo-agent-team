import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ciPaths = [".github/workflows/ci.yml", ".github/scripts/"];
const workflowPaths = [".github/workflows/", ".github/actions/"];

export function discoverPlugins(root = process.cwd()) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const plugin = entry.name;
      if (!existsSync(join(root, plugin, "paseo-plugin.json"))) {
        return [];
      }

      const packagePath = join(root, plugin, "package.json");
      if (!existsSync(packagePath)) {
        throw new Error(`${plugin} has paseo-plugin.json but no package.json`);
      }

      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      const scripts = packageJson.scripts ?? {};
      const coverage = typeof scripts["test:coverage"] === "string";
      const testUnit = typeof scripts["test:unit"] === "string";
      const descriptor = {
        plugin,
        check: typeof scripts.check === "string",
        lint: typeof scripts.lint === "string",
        format_check: typeof scripts["format:check"] === "string",
        typecheck: typeof scripts.typecheck === "string",
        coverage,
        test_unit: !coverage && testUnit,
        test: !coverage && !testUnit && typeof scripts.test === "string",
        verify_package: typeof scripts["verify:package"] === "string",
      };

      if (
        !descriptor.typecheck ||
        !(descriptor.coverage || descriptor.test_unit || descriptor.test)
      ) {
        throw new Error(
          `${plugin} must define typecheck and a test, test:unit, or test:coverage script`,
        );
      }

      return [descriptor];
    })
    .sort(({ plugin: left }, { plugin: right }) => left.localeCompare(right));
}

export function detectAffected(files, plugins = discoverPlugins()) {
  const runAll = files.some((file) =>
    ciPaths.some((ciPath) =>
      ciPath.endsWith("/") ? file.startsWith(ciPath) : file === ciPath,
    ),
  );
  const workflowAffected = files.some((file) =>
    workflowPaths.some((workflowPath) => file.startsWith(workflowPath)),
  );
  const changedPlugins = new Set(files.map((file) => file.split("/", 1)[0]));
  const affectedPlugins = plugins.filter(
    ({ plugin }) => runAll || changedPlugins.has(plugin),
  );

  return {
    npmMatrix: { include: affectedPlugins },
    npmAffected: affectedPlugins.length > 0,
    workflowAffected,
    affected: affectedPlugins.map(({ plugin }) => plugin),
  };
}

function changedFiles(baseSha, headSha, diffMode) {
  if (!baseSha || !headSha) {
    throw new Error("BASE_SHA and HEAD_SHA are required");
  }

  if (/^0+$/.test(baseSha)) {
    return [".github/workflows/ci.yml"];
  }

  const separator = diffMode === "merge-base" ? "..." : "..";
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${baseSha}${separator}${headSha}`],
    { encoding: "utf8" },
  );

  return output.split("\0").filter(Boolean);
}

function writeOutputs(result, outputPath) {
  const outputs = {
    npm_matrix: JSON.stringify(result.npmMatrix),
    npm_affected: String(result.npmAffected),
    workflow_affected: String(result.workflowAffected),
  };

  appendFileSync(
    outputPath,
    `${Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
  );
  console.log(
    result.affected.length > 0
      ? `Affected plugins: ${result.affected.join(", ")}`
      : "No plugins affected",
  );
}

function main() {
  const files = changedFiles(
    process.env.BASE_SHA,
    process.env.HEAD_SHA,
    process.env.DIFF_MODE,
  );
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }

  writeOutputs(detectAffected(files), outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
