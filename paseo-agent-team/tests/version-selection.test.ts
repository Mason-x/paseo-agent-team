import { describe, expect, test } from "vitest";
import { decideUpdate } from "../server/version/decide";
import {
  ancestry,
  compareSemver,
  githubSlug,
  objectPresent,
  parseLsRemoteTags,
  parsePackage,
  parseSemver,
  parseSymrefHead,
  pluginPackagePath,
  readGithubPackage,
  selectReleaseTag,
  stripCredentials,
} from "../server/version/remote";
import { zh } from "../shared/zh";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("release selection", () => {
  test("prefers a peeled annotated tag and 0.2.10 over 0.2.9", () => {
    const refs = parseLsRemoteTags(
      [
        `${SHA_A} refs/tags/paseo-agent-team-v0.2.9`,
        `${"1".repeat(40)} refs/tags/paseo-agent-team-v0.2.10`,
        `${SHA_B} refs/tags/paseo-agent-team-v0.2.10^{}`,
        `${SHA_C} refs/tags/paseo-agent-team-v0.2.10-beta.1`,
        `${"2".repeat(40)} refs/tags/other-v9.0.0`,
      ].join("\n"),
    );
    const selected = selectReleaseTag(refs);
    expect(selected?.tag).toBe("paseo-agent-team-v0.2.10");
    expect(selected?.sha).toBe(SHA_B);
    expect(selected?.version.raw).toBe("0.2.10");
  });

  test("keeps a lightweight tag and excludes every prerelease", () => {
    const refs = parseLsRemoteTags(`${SHA_A} refs/tags/paseo-agent-team-v1.0.0-rc.1\n`);
    expect(selectReleaseTag(refs)).toBeNull();
    const stable = parseLsRemoteTags(`${SHA_C} refs/tags/paseo-agent-team-v0.2.3\n`);
    expect(selectReleaseTag(stable)?.sha).toBe(SHA_C);
    const left = parseSemver("0.2.10");
    const right = parseSemver("0.2.9");
    if (!left || !right) throw new Error("expected stable versions");
    expect(compareSemver(left, right)).toBeGreaterThan(0);
  });

  test("reads the default branch only from the symref", () => {
    expect(parseSymrefHead(`ref: refs/heads/trunk HEAD\n${SHA_A} HEAD\n`)?.ref).toBe(
      "refs/heads/trunk",
    );
    expect(parseSymrefHead(`${SHA_A} HEAD\n`)).toBeNull();
  });

  test("reads the plugin subdirectory package and rejects another name", () => {
    expect(pluginPackagePath("paseo-agent-team")).toBe("paseo-agent-team/package.json");
    expect(pluginPackagePath("../secrets")).toBeNull();
    expect(
      parsePackage(JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.2.4" })),
    ).toEqual({
      name: "@mason-x/paseo-agent-team",
      version: "0.2.4",
    });
    expect(parsePackage(JSON.stringify({ name: "other", version: "0.2.4" }))).toEqual({
      error: "mismatch",
    });
    expect(
      parsePackage(JSON.stringify({ name: "@mason-x/paseo-agent-team", version: "0.2.4-rc.1" })),
    ).toEqual({
      error: "invalid",
    });
  });

  test("treats the same package version at a different commit as an update", () => {
    expect(
      decideUpdate({
        source: "directory",
        registry: false,
        relation: "behind",
        sameCommit: false,
        blockers: [],
        cliAvailable: true,
      }),
    ).toEqual({ updateAvailable: true, canUpdate: true });
  });

  test("renders the remaining catalog and run copy", () => {
    expect(zh.defaultPresetsUnboundCount(2)).toContain("2");
    expect(zh.defaultPresetsRuntimeCount(1)).toContain("1");
    expect(zh.loading("Role")).toContain("Role");
    expect(zh.loadFail("Team")).toContain("Team");
    expect(zh.exceedMax(9, 8)).toContain("9");
    expect(zh.coordinatorProfileFail("missing")).toContain("missing");
    expect(zh.memberProfileFail("dev", "gone")).toContain("dev");
    expect(zh.profileMissing("codex")).toContain("codex");
    expect(zh.providerUnavailable("claude", "down")).toContain("down");
    expect(zh.providerUnavailable("claude")).toContain("claude");
    expect(zh.usingFallback("backup")).toContain("backup");
    expect(zh.createMemberFail(1, 3)).toContain("1");
    expect(zh.providerToolsDisabled("codex")).toContain("codex");
    expect(zh.delegationToolsDisabled("codex", "send")).toContain("send");
    expect(zh.settingsInvalid("Role")).toContain("Role");
    expect(zh.errorDetail("boom")).toContain("boom");
    expect(zh.todoProgress(1, 2)).toContain("1/2");
    expect(zh.memberProgress(1, 2)).toContain("1/2");
    expect(zh.showEarlierRuns(4)).toContain("4");
    expect(zh.spanMinutes(3)).toContain("3");
    expect(zh.spanHours(2)).toContain("2");
    expect(zh.spanDays(1)).toContain("1");
    expect(zh.runningFor("1 小时")).toContain("1 小时");
    expect(zh.agoOutcome("1 天", "完成")).toContain("完成");
    expect(zh.justNowOutcome("结束")).toContain("结束");
    expect(zh.followUpTitle("Team")).toContain("Team");
    expect(zh.archiveRunTitle("Team")).toContain("Team");
    expect(zh.pendingCount(2)).toContain("2");
    expect(zh.truncatedAgents(50)).toContain("50");
    expect(zh.openAgent("lead")).toContain("lead");
  });

  test("classifies ancestry and rejects unsafe package URLs", async () => {
    const result = (exitCode: number, stdout = "") => ({
      exitCode,
      stdout,
      stderr: "",
      timedOut: false,
      truncated: false,
    });
    const git = {
      async run(request: { args: readonly string[] }) {
        const joined = request.args.join(" ");
        if (joined.includes(`${"c".repeat(40)}...`)) return result(0, "0\t0");
        if (joined.includes(`${"d".repeat(40)}...`)) return result(0, "1\t1");
        if (request.args[2] === "b".repeat(40)) return result(1);
        if (request.args[3] === "b".repeat(40)) return result(0);
        return result(2);
      },
    };
    expect(await ancestry(git, "C:\\repo", "a".repeat(40), "a".repeat(40), 1000)).toBe("equal");
    expect(await ancestry(git, "C:\\repo", "b".repeat(40), "a".repeat(40), 1000)).toBe("ahead");
    expect(await ancestry(git, "C:\\repo", "e".repeat(40), "a".repeat(40), 1000)).toBe("unknown");
    expect(
      await objectPresent(
        {
          run: async () => {
            throw new Error("missing");
          },
        },
        "C:\\repo",
        "a".repeat(40),
        1000,
      ),
    ).toBe(false);
    expect(githubSlug("git@github.com:Mason-x/paseo-agent-team.git")).toBe(
      "Mason-x/paseo-agent-team",
    );
    expect(
      stripCredentials("https://user:token@github.com/Mason-x/paseo-agent-team.git"),
    ).not.toContain("token");
    const redirected = await readGithubPackage({
      remote: "https://github.com/Mason-x/paseo-agent-team.git",
      sha: "a".repeat(40),
      pluginPath: "paseo-agent-team",
      timeoutMs: 1000,
      fetch: async () => ({
        status: 302,
        headers: { get: () => "https://example.test/secret" },
        text: async () => "",
      }),
    });
    expect(redirected).toEqual({ error: "network" });
  });
});
