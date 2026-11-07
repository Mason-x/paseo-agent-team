import type { RunDetailView, RunIssueView } from "../../schemas/run-engine/rpc";
import type {
  RunDecideOutput,
  RunKickOutput,
  RunReplanOutput,
} from "../../schemas/run-engine/rpc-actions";
import { runEngineZh as zh } from "../../zh/run-engine";
import { isDecisionPending } from "./decision-state";
import { displayText } from "./view";

/**
 * What a person can do to one Run from the Runs page, and what to say about the answer.
 *
 * Pure and deterministic. Nothing is guessed: a control is offered only when the server named it in
 * `capabilities.supportedControls` (and, for a retry, in the decision's own `actions`), so the page
 * can never show a button the server would refuse for a reason it already knows. The refusal codes
 * the server can answer with are listed in `RUN_ACTION_CODES`; every one has copy in `zh.controls.codes`
 * (a test fails when one is added without copy), and a code this client does not know is still shown.
 */

export type RetryOffer = {
  decisionId: string;
  /** `D1`, `D3`, `D4`, as the server sent it. */
  category: string;
  categoryLabel: string;
  subject: string | null;
  summary: string;
  /** What the retry will do, for the confirmation. */
  explain: string;
  /** The reason sent with the request. */
  reason: string;
};

export type ControlsView = {
  /** The revision the page last read; the write is refused as `revision-conflict` if the Run moved on. */
  revision: number;
  replan: boolean;
  kick: boolean;
  retries: RetryOffer[];
  /** False when there is nothing to offer at all (a finished Run, nothing waiting for a person). */
  any: boolean;
};

export function controlsOf(
  run: Pick<RunDetailView, "revision" | "capabilities" | "decisions" | "tasks">,
): ControlsView {
  const named = new Set(run.capabilities.supportedControls);
  const titleOf = new Map(run.tasks.map((task) => [task.taskId, task.title]));
  const retries: RetryOffer[] = named.has("decide")
    ? run.decisions
        .filter((decision) => isDecisionPending(decision) && decision.actions?.includes("retry"))
        .map((decision) => ({
          decisionId: decision.decisionId,
          category: decision.category,
          categoryLabel:
            zh.decisions.category[decision.category] ?? displayText(decision.category, 8),
          subject:
            decision.subjectId === null
              ? null
              : displayText(titleOf.get(decision.subjectId) ?? decision.subjectId, 120),
          summary: displayText(decision.summary, 400, "—"),
          explain: retryExplanation(decision.category),
          reason: zh.controls.retry.reason(displayText(decision.category, 8)),
        }))
    : [];
  const replan = named.has("replan");
  const kick = named.has("kick");
  return {
    revision: run.revision,
    replan,
    kick,
    retries,
    any: replan || kick || retries.length > 0,
  };
}

/** What a retry does depends on what stopped the task; the category tells which of the three it was. */
export function retryExplanation(category: string): string {
  const table = zh.controls.retry.explain;
  return Object.hasOwn(table, category)
    ? (table[category] as string)
    : zh.controls.retry.explainOther;
}

// --- what to say about an answer ----------------------------------------------------------------

export type NoticeTone = "success" | "neutral" | "warning" | "danger";

export type ActionNotice = {
  tone: NoticeTone;
  text: string;
  /** Read the Run again: the server answered, so what the page shows may be out of date. */
  refresh: boolean;
};

type IssueLike = Pick<RunIssueView, "code" | "params"> & { severity?: RunIssueView["severity"] };
type Params = Record<string, string | number | boolean>;

/** The sentence for one refusal. A code with no copy is still said, by its code. */
export function issueText(issue: IssueLike): string {
  const table = zh.controls.codes as Record<string, (params: Params) => string>;
  if (Object.hasOwn(table, issue.code)) {
    return (table[issue.code] as (params: Params) => string)(issue.params);
  }
  return zh.controls.result.unknownCode(displayText(issue.code, 64, "?"));
}

function firstIssue(issues: readonly IssueLike[]): IssueLike | undefined {
  return issues.find((issue) => issue.severity === "error") ?? issues[0];
}

function rejected(issues: readonly IssueLike[]): ActionNotice {
  const issue = firstIssue(issues);
  const conflict = issue?.code === "revision-conflict";
  return {
    tone: conflict ? "warning" : "danger",
    text: issue === undefined ? zh.controls.result.unknownCode("none") : issueText(issue),
    refresh: true,
  };
}

type Settled = { status: "applied" | "replayed" | "rejected"; issues: readonly IssueLike[] };

function settled(output: Settled, applied: string): ActionNotice {
  if (output.status === "rejected") return rejected(output.issues);
  if (output.status === "replayed") {
    return { tone: "neutral", text: zh.controls.result.replayed, refresh: true };
  }
  return { tone: "success", text: applied, refresh: true };
}

export function replanNotice(output: RunReplanOutput): ActionNotice {
  return settled(output, zh.controls.result.applied);
}

export function decideNotice(output: RunDecideOutput): ActionNotice {
  return settled(output, zh.controls.result.applied);
}

export function kickNotice(output: RunKickOutput): ActionNotice {
  if (output.status === "rejected") return rejected(output.issues);
  const result = zh.controls.result.kick;
  switch (output.outcome) {
    case "dispatched":
      return { tone: "success", text: result.dispatched(output.dispatched), refresh: true };
    case "finished":
      return { tone: "success", text: result.finished, refresh: true };
    case "blocked":
      return {
        tone: "warning",
        text: result.blocked(output.reason === null ? null : displayText(output.reason, 200)),
        refresh: true,
      };
    case "waiting":
      return { tone: "neutral", text: result.waiting, refresh: true };
    case "not-active":
      return { tone: "warning", text: result.notActive, refresh: true };
    default:
      return { tone: "neutral", text: result.idle, refresh: true };
  }
}

/** The request never got an answer; the same request id is kept so asking again cannot act twice. */
export function transportNotice(): ActionNotice {
  return { tone: "warning", text: zh.controls.result.transport, refresh: false };
}
