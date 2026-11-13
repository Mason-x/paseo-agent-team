import { describe, expect, it } from "vitest";
import {
  buildStartInput,
  type Draft,
  draftProblems,
  durationLabel,
  emptyDraft,
  gateFromLines,
  matchProfile,
  matchReviewers,
  type Profile,
  profileSpec,
  profilesFromConfig,
  projectsFromHost,
  seedFromPrompt,
  splitLines,
  TASK_TEMPLATE,
  withVerification,
} from "../../v2/client/start-input";
import { StartInputSchema } from "../../v2/shared/rpc";

const claude: Profile = {
  id: "p1",
  name: "writer",
  provider: "claude",
  model: "sonnet",
  modeId: "auto",
};
const codex: Profile = {
  id: "p2",
  name: "rev",
  provider: "codex",
  model: "gpt-6-luna",
  modeId: "full-access",
};

const ready = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft("/repo"),
  title: "t",
  gate: "npm test\n\n  npm run lint  ",
  writer: claude,
  reviewers: [codex],
  ...over,
});

describe("profilesFromConfig", () => {
  it("reads agentProfiles and skips malformed entries", () => {
    const config = {
      agentProfiles: [
        { id: "a", name: "A", provider: "claude", model: "opus", modeId: "auto", notes: "x" },
        { id: "b", name: "B" },
        "junk",
        null,
      ],
    };
    expect(profilesFromConfig(config)).toEqual([
      { id: "a", name: "A", provider: "claude", model: "opus", modeId: "auto" },
    ]);
  });

  it("returns nothing for an unfamiliar config shape", () => {
    expect(profilesFromConfig(undefined)).toEqual([]);
    expect(profilesFromConfig({ agentProfiles: {} })).toEqual([]);
  });
});

describe("profileSpec", () => {
  it("joins provider and model, and leaves a bare provider alone", () => {
    expect(profileSpec(claude).provider).toBe("claude/sonnet");
    expect(profileSpec({ id: "x", name: "x", provider: "pi" }).provider).toBe("pi");
  });
});

describe("gate commands", () => {
  it("drops blank lines, trims, and keeps a per-command timeout", () => {
    expect(splitLines(" a \n\n b\n")).toEqual(["a", "b"]);
    const gate = gateFromLines("npm test\nnpm run lint", { "npm run lint": 60 });
    expect(gate.map((g) => [g.command, g.timeoutSec])).toEqual([
      ["npm test", 600],
      ["npm run lint", 60],
    ]);
    expect(new Set(gate.map((g) => g.name)).size).toBe(2);
  });

  it("adds the verification section unless the task already has one", () => {
    expect(withVerification("# t\n", ["npm test"])).toContain("## 怎么验证\n- `npm test`");
    const own = "# t\n\n## 怎么验证\nrun it\n";
    expect(withVerification(own, ["npm test"])).toBe(own);
  });
});

describe("draftProblems", () => {
  it("is empty for a launchable draft", () => {
    expect(draftProblems(ready())).toEqual([]);
  });

  it("lists what is missing, in order", () => {
    expect(draftProblems(emptyDraft())).toEqual([
      "填写标题",
      "填写仓库路径",
      "至少一条验收命令",
      "选择写手 Profile",
      "选择审查者 r1 的 Profile",
    ]);
  });

  it("refuses a reviewer whose mode would stop to ask (Spec 7.2.3)", () => {
    const asking = { ...codex, modeId: "auto" };
    expect(draftProblems(ready({ reviewers: [asking] }))[0]).toContain("modeId 必须是 full-access");
    expect(draftProblems(ready({ reviewers: [{ ...claude, modeId: undefined }] }))[0]).toContain(
      "未设置",
    );
    expect(draftProblems(ready({ reviewers: [{ ...claude, provider: "pi" }] }))[0]).toContain(
      "没有实测过",
    );
  });
});

describe("buildStartInput", () => {
  it("produces something the server schema accepts", () => {
    const input = buildStartInput(
      ready({ reviewers: [codex, { ...claude, id: "p3", name: "r2", modeId: "auto" }] }),
    );
    expect(StartInputSchema.safeParse(input).success).toBe(true);
    expect(input.reviewers).toHaveLength(2);
    expect(input.protectedPaths).toContain("tests/**");
    expect(input.taskMarkdown).toContain("## 怎么验证");
  });

  it("passes env through and validates with StartInputSchema", () => {
    const input = buildStartInput(ready({ env: { DB: "app_{runId}_{seat}" } }));
    expect(input.env).toEqual({ DB: "app_{runId}_{seat}" });
    expect(StartInputSchema.safeParse(input).success).toBe(true);
  });

  it("refuses to build while a profile is unchosen", () => {
    expect(() => buildStartInput(ready({ reviewers: [undefined] }))).toThrow();
  });
});

describe("host picker, prompt seeding & defaults", () => {
  it("extracts unique host projects and filters temp team workspaces", () => {
    const out = projectsFromHost(
      { projects: [{ rootPath: "/repos/alpha", displayName: "Alpha" }] },
      {
        emptyProjects: [{ projectRootPath: "/repos/beta" }, { path: "/repos/alpha" }],
        entries: [
          {
            name: "main",
            projectRootPath: "/repos/gamma",
            projectDisplayName: "Gamma",
          },
          {
            name: "team-r-20261113-abcd-writer",
            workspaceDirectory: "/tmp/team-r-20261113-abcd/writer",
            projectRootPath: "/repos/temp",
          },
        ],
      },
    );
    expect(out).toEqual([
      { path: "/repos/alpha", name: "Alpha" },
      { path: "/repos/beta", name: "beta" },
      { path: "/repos/gamma", name: "Gamma" },
    ]);
  });

  it("seeds title and body appropriately from short vs detailed slash prompts", () => {
    expect(seedFromPrompt("")).toEqual({ title: "", task: TASK_TEMPLATE });
    const shortSeed = seedFromPrompt("Fix flaky gate timer");
    expect(shortSeed.title).toBe("Fix flaky gate timer");
    expect(shortSeed.task).toContain("# Fix flaky gate timer");

    const multi = seedFromPrompt("Add artifact RPC\nAlso support archived runs");
    expect(multi.title).toBe("Add artifact RPC");
    expect(multi.task).toContain("## 要什么结果\n\nAdd artifact RPC\nAlso support archived runs");
  });

  it("matches saved profiles and formats run duration labels", () => {
    const claudeAuto2: Profile = { ...claude, id: "p1b", modeId: "plan" };
    expect(matchProfile([claudeAuto2, claude], profileSpec(claude))?.id).toBe("p1");
    expect(matchReviewers([claude, codex], [])).toEqual([undefined]);
    expect(matchReviewers([claude, codex], [profileSpec(codex)]).map((p) => p?.id)).toEqual(["p2"]);

    const t0 = "2026-11-13T00:00:00.000Z";
    expect(durationLabel(t0, "2026-11-13T00:00:42.000Z")).toBe("耗时 42 秒");
    expect(durationLabel(t0, "2026-11-13T00:06:00.000Z")).toBe("耗时 6 分钟");
    expect(durationLabel(t0, "2026-11-13T01:30:00.000Z")).toBe("耗时 1 小时 30 分钟");
  });
});
