import { describe, expect, test } from "vitest";
import {
  DESIGN_OUTPUT_MAX_BYTES,
  extractDesignOutput,
  extractDesignProposal,
  formatDesignIssue,
  utf8ByteLength,
} from "../shared/domain/design-output";
import {
  DESIGN_ISSUE_CODES,
  DesignIssueActionSchema,
  DesignStateSchema,
} from "../shared/schemas/design";
import { DESIGN_ISSUE_KEY_BY_CODE, designZh } from "../shared/zh/design";
import { DESIGN_JOB_ID, DESIGN_NONCE, designProposal } from "./design-fixtures";

const BODY = JSON.stringify(designProposal(), null, 2);

function fence(body: string, info = "agent-team-design", marker = "```"): string {
  return `${marker}${info}\n${body}\n${marker}`;
}

function extract(text: string, identity = {}) {
  return extractDesignProposal({
    text,
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: DESIGN_NONCE,
    ...identity,
  });
}

function codes(text: string): string[] {
  const result = extract(text);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("fence extraction", () => {
  test("accepts exactly one complete agent-team-design block", () => {
    const result = extract(fence(BODY));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.summary).toBe(designProposal().summary);
  });

  test("accepts tilde fences and up to three leading spaces", () => {
    expect(extract(`   ${fence(BODY, "agent-team-design", "~~~")}`).ok).toBe(true);
    expect(extract(`   \`\`\`agent-team-design\n${BODY}\n\`\`\`   `).ok).toBe(true);
  });

  test("normalizes CRLF and ignores other languages or bare JSON", () => {
    expect(extract(fence(BODY).replace(/\n/g, "\r\n")).ok).toBe(true);
    expect(codes("```json\n{}\n```")).toEqual(["DESIGN_OUTPUT_MISSING"]);
    expect(codes(BODY)).toEqual(["DESIGN_OUTPUT_MISSING"]);
  });

  test("ignores unrelated fences when the design block is present", () => {
    const text = `\`\`\`json\n{"note":"ignored"}\n\`\`\`\n\n${fence(BODY)}`;
    expect(extract(text).ok).toBe(true);
  });

  test("does not treat backticks inside a JSON string as a closing fence", () => {
    const proposal = designProposal({ summary: "使用 ``` 包住示例，再继续说明。" });
    expect(extract(fence(JSON.stringify(proposal))).ok).toBe(true);
  });

  test("reports zero and multiple design blocks", () => {
    expect(codes("没有代码块")).toEqual(["DESIGN_OUTPUT_MISSING"]);
    const multiple = `${fence(BODY)}\n\n${fence(BODY)}`;
    const result = extract(multiple);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues[0]).toMatchObject({
        code: "DESIGN_OUTPUT_MULTIPLE",
        params: { count: 2 },
      });
  });

  test("never falls back to the last block when an earlier design block exists", () => {
    const old = JSON.stringify({
      ...designProposal(),
      jobId: "99999999-9999-4999-8999-999999999999",
    });
    expect(codes(`${fence(old)}\n${fence(BODY)}`)).toEqual(["DESIGN_OUTPUT_MULTIPLE"]);
  });

  test("an unclosed design fence is a truncated JSON error, not a missing block", () => {
    expect(codes(`\`\`\`agent-team-design\n${BODY}`)).toEqual(["DESIGN_OUTPUT_JSON"]);
    const result = extract(`\`\`\`agent-team-design\n${BODY}`);
    if (!result.ok) expect(result.issues[0].params.reason).toBe("truncated");
  });

  test("rejects invalid JSON without evaluating it", () => {
    const result = extract(fence("{ not json }"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        code: "DESIGN_OUTPUT_JSON",
        params: { reason: "invalid-json" },
      });
    }
  });

  test("enforces the 32 KiB UTF-8 block limit before parsing", () => {
    const oversized = `${BODY}\n${" ".repeat(DESIGN_OUTPUT_MAX_BYTES)}`;
    const result = extract(fence(oversized));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].code).toBe("DESIGN_OUTPUT_TOO_LARGE");
      expect(result.issues[0].params.limit).toBe(DESIGN_OUTPUT_MAX_BYTES);
      expect(result.issues[0].params.bytes).toBeGreaterThan(DESIGN_OUTPUT_MAX_BYTES);
    }
  });

  test("counts UTF-8 bytes rather than UTF-16 units", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("字")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });
});

describe("identity and schema checks", () => {
  test("rejects a different job, attempt, or nonce", () => {
    for (const [identity, field] of [
      [{ jobId: "99999999-9999-4999-8999-999999999999" }, "jobId"],
      [{ attempt: 2 }, "attempt"],
      [{ nonce: "d".repeat(32) }, "nonce"],
    ] as const) {
      const result = extract(fence(BODY), identity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
          code: "DESIGN_OUTPUT_IDENTITY",
          path: [field],
          params: { field },
        });
      }
    }
  });

  test("reports every identity mismatch without leaking the actual nonce", () => {
    const result = extract(fence(BODY), {
      jobId: "99999999-9999-4999-8999-999999999999",
      attempt: 2,
      nonce: "d".repeat(32),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.params.field)).toEqual([
        "jobId",
        "attempt",
        "nonce",
      ]);
      expect(JSON.stringify(result.issues)).not.toContain(DESIGN_NONCE);
    }
  });

  test("maps a schema failure to a path without echoing the received value", () => {
    const bad = JSON.stringify({ ...designProposal(), summary: 42 });
    const result = extract(fence(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        code: "DESIGN_OUTPUT_SCHEMA",
        path: ["summary"],
        params: { path: "summary" },
      });
      expect(JSON.stringify(result.issues)).not.toContain('"received"');
    }
  });
});

describe("formatDesignIssue", () => {
  const issue = (
    code: (typeof DESIGN_ISSUE_CODES)[number],
    params: Record<string, string | number | boolean> = {},
  ) => ({ code, severity: "error" as const, path: [], params, action: "repair" as const });

  test("has one Chinese message for every stable code", () => {
    expect(Object.keys(DESIGN_ISSUE_KEY_BY_CODE)).toHaveLength(DESIGN_ISSUE_CODES.length);
    for (const code of DESIGN_ISSUE_CODES) {
      const message = formatDesignIssue(issue(code));
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("{");
    }
  });

  test("fills documented placeholders and removes missing ones", () => {
    expect(formatDesignIssue(issue("DESIGN_OUTPUT_SCHEMA", { path: "team.id" }))).toContain(
      "team.id",
    );
    expect(formatDesignIssue(issue("DESIGN_MEMBER_LIMIT", { count: 4, limit: 3 }))).toContain("4");
    expect(formatDesignIssue(issue("DESIGN_ROLE_NAMING"))).not.toContain("{");
  });

  test("covers every UI phase and action key", () => {
    expect(Object.keys(designZh.phases).sort()).toEqual([...DesignStateSchema.options].sort());
    expect(Object.keys(designZh.actions).sort()).toEqual(
      [...DesignIssueActionSchema.options].sort(),
    );
  });
});

describe("contract-aware extraction", () => {
  const teamV2 = { ...designProposal(), version: 2 as const, kind: "team" as const };
  const gapV2 = {
    version: 2 as const,
    kind: "role-gap" as const,
    jobId: DESIGN_JOB_ID,
    attempt: 1,
    nonce: DESIGN_NONCE,
    summary: "现有 Role 覆盖不了迁移评审。",
    gaps: [
      {
        kind: "unavailable-role" as string,
      },
    ],
  };
  const realGap = {
    ...gapV2,
    gaps: [
      {
        kind: "unlaunchable-role" as const,
        roleId: "architect",
        responsibility: "架构决定需要人拍板",
        reason: "架构 Role 在当前 host 无可启动绑定。",
        use: "member" as const,
        profiles: { kind: "existing" as const, profileIds: ["codex-xhigh"] },
      },
    ],
  };

  function extractOutput(body: unknown, outputContractVersion: 1 | 2, identity = {}) {
    return extractDesignOutput({
      text: fence(JSON.stringify(body)),
      jobId: DESIGN_JOB_ID,
      attempt: 1,
      nonce: DESIGN_NONCE,
      outputContractVersion,
      ...identity,
    });
  }

  test("contract 2 decodes a team block and reports its kind", () => {
    const result = extractOutput(teamV2, 2);
    expect(result.ok).toBe(true);
    if (result.ok && result.contract === 2 && result.kind === "team") {
      expect(result.proposal.kind).toBe("team");
      expect(result.proposal.version).toBe(2);
    }
  });

  test("contract 2 decodes a gap block without touching the team branch", () => {
    const result = extractOutput(realGap, 2);
    expect(result.ok).toBe(true);
    if (result.ok && result.contract === 2 && result.kind === "role-gap") {
      expect(result.gap.gaps[0]?.kind).toBe("unlaunchable-role");
    }
    expect(extractOutput(gapV2, 2)).toMatchObject({ ok: false });
  });

  test("contract selection is strict in both directions", () => {
    const legacy = extractOutput(designProposal(), 1);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.contract).toBe(1);

    // A v2 job does not accept a v1 body: `kind` is part of the contract.
    expect(codes(fence(JSON.stringify(designProposal())))).toEqual([]);
    const missingKind = extractOutput(designProposal(), 2);
    expect(missingKind.ok).toBe(false);
    if (!missingKind.ok) {
      expect(missingKind.issues.every((entry) => entry.code === "DESIGN_OUTPUT_SCHEMA")).toBe(true);
      expect(missingKind.issues.some((entry) => entry.params.path === "kind")).toBe(true);
    }
    // A v1 record does not accept a v2 body, even with matching identity.
    const wrongVersion = extractOutput(teamV2, 1);
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) {
      expect(wrongVersion.issues.every((entry) => entry.code === "DESIGN_OUTPUT_SCHEMA")).toBe(
        true,
      );
      expect(wrongVersion.issues.some((entry) => entry.params.path === "version")).toBe(true);
    }
  });

  test("the gap branch shares identity, single-fence, and size checks", () => {
    const wrongJob = extractOutput(
      { ...realGap, jobId: "99999999-9999-4999-8999-999999999999" },
      2,
    );
    expect(wrongJob.ok).toBe(false);
    if (!wrongJob.ok) {
      expect(wrongJob.issues.map((i) => i.code)).toContain("DESIGN_OUTPUT_IDENTITY");
      expect(wrongJob.issues.map((i) => i.params.field)).toContain("jobId");
    }
    const wrongNonce = extractOutput({ ...realGap, nonce: "c".repeat(32) }, 2);
    expect(wrongNonce.ok).toBe(false);
    if (!wrongNonce.ok) expect(wrongNonce.issues[0]?.params.field).toBe("nonce");
    expect(
      extractDesignOutput({
        text: `${fence(JSON.stringify(realGap))}\n${fence(JSON.stringify(realGap))}`,
        jobId: DESIGN_JOB_ID,
        attempt: 1,
        nonce: DESIGN_NONCE,
        outputContractVersion: 2,
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_OUTPUT_MULTIPLE" }] });
    const oversized = fence(
      JSON.stringify({ ...realGap, summary: "x".repeat(DESIGN_OUTPUT_MAX_BYTES) }),
    );
    expect(
      extractDesignOutput({
        text: oversized,
        jobId: DESIGN_JOB_ID,
        attempt: 1,
        nonce: DESIGN_NONCE,
        outputContractVersion: 2,
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "DESIGN_OUTPUT_TOO_LARGE" }] });
  });

  test("a gap cannot smuggle team fields past the strict schema", () => {
    const result = extractOutput({ ...realGap, team: designProposal().team }, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["DESIGN_OUTPUT_SCHEMA"]);
      expect(result.issues[0]?.params.path).toBe("(root)");
    }
  });
});
