import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_ROLE_EXECUTION } from "../shared/domain/role-execution";
import { expectedBindings, expectedRoleContent, sourceProfiles } from "./default-presets.fixtures";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts/generate-default-catalog.mjs");
const revision = "defaults-2026-10-25.2";

function sourceFixture() {
  return {
    generatedAt: "ignored",
    note: "ignored host metadata",
    profiles: sourceProfiles.map(({ id, ...profile }) => ({ profileId: id, ...profile })),
    roles: expectedRoleContent.map(({ preferredHints, fallbackHints, ...content }, index) => ({
      ...content,
      privateHostMetadata: "do not ship",
      createdAt: "do not ship",
      preferredProfiles: preferredHints.map((hint, refIndex) => ({
        profileId: expectedBindings[index].preferred[refIndex],
        ...hint,
      })),
      fallbackProfiles: fallbackHints.map((hint, refIndex) => ({
        profileId: expectedBindings[index].fallback[refIndex],
        ...hint,
      })),
    })),
  };
}

test("generator requires an explicit source input", () => {
  expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" })).toThrow(
    "explicit --input",
  );
}, 30_000);

test("generator requires an explicit catalog revision", () => {
  expect(() =>
    execFileSync(process.execPath, [script, "--input", join(root, "missing.json")], {
      cwd: root,
      stdio: "pipe",
    }),
  ).toThrow("explicit --revision");
});

test("generator uses allowlists, preserves fixture content, and produces stable portable output without E: input", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-default-presets-"));
  try {
    const source = join(temporaryDirectory, "source.json");
    const output = join(temporaryDirectory, "default-catalog.ts");
    const fixtures = join(temporaryDirectory, "fixtures");
    await writeFile(source, JSON.stringify(sourceFixture()), "utf8");
    const args = [
      script,
      "--input",
      source,
      "--revision",
      revision,
      "--output",
      output,
      "--fixtures",
      fixtures,
    ];
    expect(execFileSync(process.execPath, args, { cwd: root, encoding: "utf8" })).toContain(
      "22 default Roles",
    );
    const first = await readFile(output, "utf8");
    expect(first).toBe(await readFile(join(root, "server/templates/default-catalog.ts"), "utf8"));
    expect(first).not.toMatch(/agent_profile_|profileId|notes|privateHostMetadata|do not ship/);
    const generated = JSON.parse(
      await readFile(join(fixtures, "expected-role-content.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(generated.map(({ executionPolicy: _executionPolicy, ...content }) => content)).toEqual(
      expectedRoleContent,
    );
    for (const role of generated) {
      expect(role.executionPolicy).toEqual(DEFAULT_ROLE_EXECUTION[role.id as string]);
    }
    expect(JSON.parse(await readFile(join(fixtures, "expected-bindings.json"), "utf8"))).toEqual(
      expectedBindings,
    );
    expect(JSON.parse(await readFile(join(fixtures, "source-profiles.json"), "utf8"))).toEqual(
      sourceProfiles,
    );
    execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
    expect(await readFile(output, "utf8")).toBe(first);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}, 30_000);

test("generator rejects unknown reference fields and inconsistent source runtime hints", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-default-presets-invalid-"));
  try {
    const source = join(temporaryDirectory, "source.json");
    const output = join(temporaryDirectory, "default-catalog.ts");
    const fixture = sourceFixture();
    const ref = fixture.roles[0].preferredProfiles[0];
    await writeFile(
      source,
      JSON.stringify({
        ...fixture,
        roles: [{ ...fixture.roles[0], preferredProfiles: [{ ...ref, unknown: true }] }],
      }),
      "utf8",
    );
    const args = [script, "--input", source, "--revision", revision, "--output", output];
    expect(() => execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" })).toThrow(
      "Unrecognized key",
    );
    fixture.roles[0].preferredProfiles[0].model = "different-model";
    await writeFile(source, JSON.stringify(fixture), "utf8");
    expect(() => execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" })).toThrow(
      "Inconsistent source reference",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}, 30_000);

test("generator treats URLs as text but still rejects absolute Windows paths", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "paseo-default-presets-paths-"));
  try {
    const source = join(temporaryDirectory, "source.json");
    const output = join(temporaryDirectory, "default-catalog.ts");
    const fixture = sourceFixture();
    const args = [script, "--input", source, "--revision", revision, "--output", output];
    fixture.roles[0].systemPrompt = "See http://example.com/docs and https://example.com/x.";
    await writeFile(source, JSON.stringify(fixture), "utf8");
    execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
    expect(await readFile(output, "utf8")).toContain("http://example.com/docs");
    fixture.roles[0].systemPrompt = "Read E:\\roles\\latest.json first.";
    await writeFile(source, JSON.stringify(fixture), "utf8");
    expect(() => execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" })).toThrow(
      "absolute Windows path",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}, 30_000);
