import { describe, expect, test } from "vitest";
import {
  DESIGN_OUTPUT_MAX_BYTES,
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
