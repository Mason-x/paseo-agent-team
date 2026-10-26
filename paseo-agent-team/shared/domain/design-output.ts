import type { DesignIssue, DesignProposal } from "../schemas/design";
import { DesignProposalSchema } from "../schemas/design";
import { DESIGN_ISSUE_KEY_BY_CODE, designZh } from "../zh/design";

/** The model's complete fenced block may not exceed 32 KiB of UTF-8. */
export const DESIGN_OUTPUT_MAX_BYTES = 32 * 1024;

const DESIGN_FENCE_LANGUAGE = "agent-team-design";
const MAX_SCHEMA_ISSUES = 20;

type Fence = {
  language: string;
  body: string;
  closed: boolean;
};

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Line-based CommonMark-ish fence scanner. It never uses a greedy regex over the whole text:
 * only fences whose info string starts with `agent-team-design` are candidates, a closing fence
 * must use the same marker and be at least as long, and an unclosed fence keeps every later line
 * in its body. This is what makes "do not pick the last JSON block" testable.
 */
function scanFences(text: string): Fence[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fences: Fence[] = [];
  let open: { marker: string; length: number; language: string; body: string[] } | null = null;

  for (const line of lines) {
    if (open) {
      const closing = CLOSING_FENCE.exec(line);
      if (closing && closing[1][0] === open.marker[0] && closing[1].length >= open.length) {
        fences.push({ language: open.language, body: open.body.join("\n"), closed: true });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }

    const opening = OPENING_FENCE.exec(line);
    if (!opening) continue;
    const marker = opening[1];
    const info = opening[2].trim();
    // CommonMark forbids backticks in the info string of a backtick fence.
    if (marker[0] === "`" && info.includes("`")) continue;
    const language = info.split(/[ \t]+/)[0] ?? "";
    open = { marker, length: marker.length, language, body: [] };
  }

  if (open) {
    fences.push({ language: open.language, body: open.body.join("\n"), closed: false });
  }
  return fences;
}

/** UTF-8 byte length without depending on Node's Buffer or a DOM TextEncoder. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function outputIssue(
  code: DesignIssue["code"],
  path: DesignIssue["path"],
  params: DesignIssue["params"],
): DesignIssue {
  return { code, severity: "error", path, params, action: "repair" };
}

export type ExtractDesignProposalInput = {
  /** Assistant text already bounded by the caller's timeline read budget. */
  text: string;
  jobId: string;
  attempt: number;
  nonce: string;
};

export type ExtractDesignProposalResult =
  | { ok: true; proposal: DesignProposal }
  | { ok: false; issues: DesignIssue[] };

/**
 * Extracts the single `agent-team-design` fenced JSON block from one attempt's assistant text and
 * verifies its identity. Semantic checks (member keys, reuse set, placement, mode planning) belong
 * to design-validation; this function only owns fence/JSON/schema/identity failures.
 */
export function extractDesignProposal(
  input: ExtractDesignProposalInput,
): ExtractDesignProposalResult {
  const designFences = scanFences(input.text).filter(
    (fence) => fence.language === DESIGN_FENCE_LANGUAGE,
  );

  if (designFences.length === 0) {
    return { ok: false, issues: [outputIssue("DESIGN_OUTPUT_MISSING", [], {})] };
  }
  if (designFences.length > 1) {
    return {
      ok: false,
      issues: [outputIssue("DESIGN_OUTPUT_MULTIPLE", [], { count: designFences.length })],
    };
  }

  const [fence] = designFences;
  if (!fence.closed) {
    return {
      ok: false,
      issues: [outputIssue("DESIGN_OUTPUT_JSON", [], { reason: "truncated" })],
    };
  }

  const bytes = utf8ByteLength(fence.body);
  if (bytes > DESIGN_OUTPUT_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        outputIssue("DESIGN_OUTPUT_TOO_LARGE", [], {
          bytes,
          limit: DESIGN_OUTPUT_MAX_BYTES,
        }),
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fence.body);
  } catch {
    return {
      ok: false,
      issues: [outputIssue("DESIGN_OUTPUT_JSON", [], { reason: "invalid-json" })],
    };
  }

  const parsed = DesignProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, MAX_SCHEMA_ISSUES).map((issue) =>
        outputIssue(
          "DESIGN_OUTPUT_SCHEMA",
          issue.path.map((part) => (typeof part === "number" ? part : String(part))),
          {
            path:
              issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join("."),
          },
        ),
      ),
    };
  }

  const proposal = parsed.data;
  const identityIssues: DesignIssue[] = [];
  if (proposal.jobId !== input.jobId) {
    identityIssues.push(outputIssue("DESIGN_OUTPUT_IDENTITY", ["jobId"], { field: "jobId" }));
  }
  if (proposal.attempt !== input.attempt) {
    identityIssues.push(outputIssue("DESIGN_OUTPUT_IDENTITY", ["attempt"], { field: "attempt" }));
  }
  if (proposal.nonce !== input.nonce) {
    identityIssues.push(outputIssue("DESIGN_OUTPUT_IDENTITY", ["nonce"], { field: "nonce" }));
  }
  if (identityIssues.length > 0) return { ok: false, issues: identityIssues };

  return { ok: true, proposal };
}

/**
 * The single localizer used by both the repair message and the UI. Missing params are removed
 * rather than leaking raw `{placeholder}` text; producers still supply every documented param.
 */
export function formatDesignIssue(issue: DesignIssue): string {
  const template = designZh[DESIGN_ISSUE_KEY_BY_CODE[issue.code]];
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_placeholder, key: string) => {
    const value = issue.params[key];
    return value === undefined ? "" : String(value);
  });
}
