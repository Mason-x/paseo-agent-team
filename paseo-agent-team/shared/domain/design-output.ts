import type {
  DesignIssue,
  DesignOutputContractVersion,
  DesignProposal,
  DesignRoleGapProposal,
  DesignTeamProposalV2,
} from "../schemas/design";
import { DesignOutputV2Schema, DesignProposalSchema } from "../schemas/design";
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

type DesignJsonRead = { ok: true; raw: unknown } | { ok: false; issues: DesignIssue[] };

/** The one fenced `agent-team-design` block of one attempt, parsed but not shape-checked. */
function readDesignJson(text: string): DesignJsonRead {
  const designFences = scanFences(text).filter((fence) => fence.language === DESIGN_FENCE_LANGUAGE);

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

  try {
    return { ok: true, raw: JSON.parse(fence.body) };
  } catch {
    return {
      ok: false,
      issues: [outputIssue("DESIGN_OUTPUT_JSON", [], { reason: "invalid-json" })],
    };
  }
}

function schemaFailure(error: {
  issues: readonly { path: readonly PropertyKey[] }[];
}): DesignIssue[] {
  return error.issues.slice(0, MAX_SCHEMA_ISSUES).map((issue) =>
    outputIssue(
      "DESIGN_OUTPUT_SCHEMA",
      issue.path.map((part) => (typeof part === "number" ? part : String(part))),
      {
        path: issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join("."),
      },
    ),
  );
}

function identityFailure(
  value: { jobId: string; attempt: number; nonce: string },
  input: ExtractDesignProposalInput,
): DesignIssue[] {
  const issues: DesignIssue[] = [];
  if (value.jobId !== input.jobId) {
    issues.push(outputIssue("DESIGN_OUTPUT_IDENTITY", ["jobId"], { field: "jobId" }));
  }
  if (value.attempt !== input.attempt) {
    issues.push(outputIssue("DESIGN_OUTPUT_IDENTITY", ["attempt"], { field: "attempt" }));
  }
  if (value.nonce !== input.nonce) {
    issues.push(outputIssue("DESIGN_OUTPUT_IDENTITY", ["nonce"], { field: "nonce" }));
  }
  return issues;
}

export type ExtractDesignOutputInput = ExtractDesignProposalInput & {
  /** Chosen by the record, never by the current build: a legacy job keeps contract 1. */
  outputContractVersion: DesignOutputContractVersion;
};

export type ExtractedDesignOutput =
  | { ok: true; contract: 1; kind: "team"; proposal: DesignProposal }
  | { ok: true; contract: 2; kind: "team"; proposal: DesignTeamProposalV2 }
  | { ok: true; contract: 2; kind: "role-gap"; gap: DesignRoleGapProposal }
  | { ok: false; issues: DesignIssue[] };

/**
 * Contract-aware extraction: fence/JSON/32KiB/identity are shared, the shape is selected by the
 * record's output contract. Contract 2 is a discriminated `kind`, so a v2 job rejects a block
 * without one; contract 1 keeps reading the legacy shape even on a new build.
 */
export function extractDesignOutput(input: ExtractDesignOutputInput): ExtractedDesignOutput {
  const read = readDesignJson(input.text);
  if (!read.ok) return read;

  if (input.outputContractVersion === 1) {
    const parsed = DesignProposalSchema.safeParse(read.raw);
    if (!parsed.success) return { ok: false, issues: schemaFailure(parsed.error) };
    const identity = identityFailure(parsed.data, input);
    if (identity.length > 0) return { ok: false, issues: identity };
    return { ok: true, contract: 1, kind: "team", proposal: parsed.data };
  }

  const parsed = DesignOutputV2Schema.safeParse(read.raw);
  if (!parsed.success) return { ok: false, issues: schemaFailure(parsed.error) };
  const identity = identityFailure(parsed.data, input);
  if (identity.length > 0) return { ok: false, issues: identity };
  return parsed.data.kind === "team"
    ? { ok: true, contract: 2, kind: "team", proposal: parsed.data }
    : { ok: true, contract: 2, kind: "role-gap", gap: parsed.data };
}

/**
 * Legacy entry point: contract-1 extraction only. Kept for callers that read old records; a new
 * job must use `extractDesignOutput` with its record's contract version.
 */
export function extractDesignProposal(
  input: ExtractDesignProposalInput,
): ExtractDesignProposalResult {
  const result = extractDesignOutput({ ...input, outputContractVersion: 1 });
  if (!result.ok) return result;
  if (result.contract === 1) return { ok: true, proposal: result.proposal };
  return {
    ok: false,
    issues: [outputIssue("DESIGN_OUTPUT_SCHEMA", ["version"], { path: "version" })],
  };
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
