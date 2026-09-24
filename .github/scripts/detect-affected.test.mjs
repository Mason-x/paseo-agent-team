import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectAffected, discoverPlugins } from "./detect-affected.mjs";

test("discovers new plugins and derives their checks from package scripts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paseo-plugins-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const pluginRoot = join(root, "new-plugin");
  mkdirSync(pluginRoot);
  writeFileSync(join(pluginRoot, "paseo-plugin.json"), '{"id":"new-plugin"}');
  writeFileSync(
    join(pluginRoot, "package.json"),
    JSON.stringify({
      scripts: {
        check: "biome check .",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        "test:coverage": "vitest run --coverage",
        "verify:package": "node verify.mjs",
      },
    }),
  );

  assert.deepEqual(discoverPlugins(root), [
    {
      plugin: "new-plugin",
      check: true,
      lint: false,
      format_check: false,
      typecheck: true,
      coverage: true,
      test_unit: false,
      test: false,
      verify_package: true,
    },
  ]);
});

test("discovers only paseo-agent-team in this repository", () => {
  assert.deepEqual(
    discoverPlugins().map(({ plugin }) => plugin),
    ["paseo-agent-team"],
  );
});

test("selects only changed plugins", () => {
  const plugins = [
    {
      plugin: "paseo-agent-team",
      check: true,
      lint: false,
      format_check: false,
      typecheck: true,
      coverage: true,
      test_unit: false,
      test: false,
      verify_package: false,
    },
    {
      plugin: "other",
      check: false,
      lint: false,
      format_check: false,
      typecheck: true,
      coverage: false,
      test_unit: false,
      test: true,
      verify_package: false,
    },
  ];
  const result = detectAffected(
    ["paseo-agent-team/index.server.ts", "docs/note.md"],
    plugins,
  );

  assert.deepEqual(
    result.npmMatrix.include.map(({ plugin }) => plugin),
    ["paseo-agent-team"],
  );
  assert.equal(result.npmAffected, true);
  assert.deepEqual(result.affected, ["paseo-agent-team"]);
});

test("ignores changes outside plugin and CI paths", () => {
  const result = detectAffected(["SECURITY.md"]);

  assert.deepEqual(result.affected, []);
  assert.deepEqual(result.npmMatrix, { include: [] });
  assert.equal(result.workflowAffected, false);
});

test("workflow changes enable security analysis", () => {
  const result = detectAffected([".github/workflows/release-please.yml"]);

  assert.equal(result.workflowAffected, true);
  assert.deepEqual(result.affected, []);
});

test("CI implementation changes select every discovered plugin", () => {
  const plugins = discoverPlugins();

  for (const file of [
    ".github/workflows/ci.yml",
    ".github/scripts/detect-affected.mjs",
  ]) {
    const result = detectAffected([file], plugins);

    assert.equal(result.npmMatrix.include.length, plugins.length);
    assert.equal(result.npmAffected, plugins.length > 0);
    assert.equal(result.affected.length, plugins.length);
  }
});
