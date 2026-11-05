import { randomUUID } from "node:crypto";
import {
  COORDINATOR_SEAT_ID,
  checkDag,
  describeIssues,
  readDagControl,
  withDagControl,
} from "../../shared/domain/run-engine/dag-admission";
import { reduceRun } from "../../shared/domain/run-engine/reducer";
import { raiseAlert } from "../../shared/domain/run-engine/run-alert";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import type { RunTaskDagBlock } from "../../shared/schemas/run-engine/protocol";
import { alertIdFor, sha256Hex } from "./digest";
import type { ObserverHost } from "./observer";
import { extractProtocolBlock, type UnverifiableReason } from "./protocol";
import { inspectRepo, verifyScopes } from "./repo";
import type { RunStore } from "./store";

/**
 * Initial DAG intake. After the coordinator's turn ends, reads its reply to the plan request, and
 * either admits the task graph or says, on the Run, why not. Admitting means the reducer's
 * `dag-accepted` and the use-up of the control nonce in one commit, so a DAG can be accepted once.
 *
 * A refusal changes nothing about tasks (there are none yet): it raises an alert naming the reasons
 * and leaves the Run waiting for a DAG. The coordinator is not asked to try again from here; a person
 * asks for a re-plan (plan 11.5, decision 5).
 */

export type DagIntakeResult =
  | { status: "no-pending-plan" }
  | { status: "host-error" }
  | { status: "unverifiable"; reason: UnverifiableReason }
  /** The reply is complete but the host's turn_ended receipt is not recorded yet. */
  | { status: "turn-not-ended" }
  | { status: "refused"; reasons: string }
  | { status: "admitted"; tasks: number };

export type DagIntakeOptions = {
  store: Pick<RunStore, "get" | "update" | "runsForAgent">;
  host: ObserverHost;
  /** The model family of a roster seat's Profile, for the weakest review level. */
  seatFamily(record: RunRecord, seatId: string): string | null;
  /** The shared start Workspace of the Run. `null` refuses the plan: its paths cannot be checked. */
  resolveWorkspace(record: RunRecord): { workspaceId: string; directory: string } | null;
  clock?: { now(): string };
  ids?: { uuid(): string };
  /** Called after a DAG was admitted, so the first task can be dispatched. */
  onAdmitted?: (runId: string) => void;
  log?: (message: string, detail?: unknown) => void;
};

const SENT_STATES = ["sending", "confirmed", "outcome-unknown"];

/** The newest plan request that went out to this agent: a `wake` intent. */
function latestPlanRequest(record: RunRecord, agentId: string) {
  const sent = record.outbox.filter(
    (intent) =>
      intent.kind === "wake" && intent.recipient === agentId && SENT_STATES.includes(intent.state),
  );
  return sent.at(-1);
}

export function createDagIntake(options: DagIntakeOptions) {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const uuid = options.ids?.uuid ?? (() => randomUUID());
  const log = options.log ?? (() => undefined);
  const chains = new Map<string, Promise<unknown>>();

  function pending(record: RunRecord, agentId: string): boolean {
    if (record.lifecycle !== "bootstrapping" && record.lifecycle !== "awaiting-dag") return false;
    const seat = record.roster.find((entry) => entry.seatId === COORDINATOR_SEAT_ID);
    if (!seat || seat.agentId !== agentId) return false;
    const control = readDagControl(record);
    return control !== null && control.acceptedAt === null;
  }

  /** Says why no DAG was admitted, once per distinct reason; the Run waits for a DAG. */
  async function refuse(runId: string, agentId: string, reasons: string): Promise<DagIntakeResult> {
    await options.store.update(runId, (current) => {
      if (!pending(current, agentId)) return null;
      const now = clock.now();
      const raised = raiseAlert(
        current,
        { alertId: alertIdFor(reasons), severity: "warning", summary: reasons },
        now,
      );
      const waiting =
        current.lifecycle === "bootstrapping"
          ? { ...raised.next, lifecycle: "awaiting-dag" as const }
          : raised.next;
      return raised.changed || waiting.lifecycle !== current.lifecycle ? waiting : null;
    });
    return { status: "refused", reasons };
  }

  async function settleRun(runId: string, agentId: string): Promise<DagIntakeResult> {
    const read = await options.store.get(runId);
    if (read.status !== "ok" || !pending(read.record, agentId))
      return { status: "no-pending-plan" };
    const record = read.record;
    const request = latestPlanRequest(record, agentId);
    if (!request) return { status: "no-pending-plan" };

    let window: Awaited<ReturnType<ObserverHost["replyWindow"]>>;
    try {
      window = await options.host.replyWindow(agentId, request.messageId);
    } catch (error) {
      log(`cannot read the plan reply of ${agentId}`, error);
      return { status: "host-error" };
    }
    if (!window.complete) return { status: "unverifiable", reason: window.reason };

    const extracted = extractProtocolBlock(window.text, { expected: "task-dag" });
    if (extracted.status === "unverifiable") {
      return { status: "unverifiable", reason: extracted.reason };
    }
    if (
      !record.eventReceipts.some(
        (receipt) =>
          receipt.kind === "turn_ended" &&
          receipt.agentId === agentId &&
          receipt.turnId === window.turnId,
      )
    ) {
      return { status: "turn-not-ended" };
    }
    if (extracted.status === "none") {
      return refuse(runId, agentId, "DAG 缺失：协调者的回复里没有 task-dag 块");
    }
    if (extracted.status === "rejected") {
      const issues = (extracted.issues ?? []).map((issue) => issue.path).join(",");
      return refuse(
        runId,
        agentId,
        `DAG 块被拒：${extracted.reason}${issues ? `（${issues}）` : ""}`,
      );
    }
    if (extracted.kind !== "task-dag") return refuse(runId, agentId, "DAG 块被拒：unexpected-kind");
    const block = extracted.block as RunTaskDagBlock;

    // The real repository is what the plan's repository id and paths are judged against.
    const location = options.resolveWorkspace(record);
    if (!location) return refuse(runId, agentId, "DAG 被拒：找不到启动 Workspace 的目录");
    const inspected = await inspectRepo(location.directory);
    if (!inspected.ok) return refuse(runId, agentId, `DAG 被拒：仓库不可读（${inspected.reason}）`);
    const repo = inspected.repo;

    const families = new Map<string, string | null>(
      record.roster.map((seat) => [seat.seatId, options.seatFamily(record, seat.seatId)]),
    );
    const checkInput = {
      agentId,
      canonicalRepoId: repo.repoId,
      nonceDigest: sha256Hex(block.nonce),
      seatFamilies: families,
    };
    const checked = checkDag(record, block, checkInput);
    if (!checked.ok) return refuse(runId, agentId, describeIssues(checked.issues));

    const verified = await verifyScopes(
      repo,
      checked.block.tasks.flatMap((task) => task.scopes),
    );
    if (!verified.ok) {
      return refuse(
        runId,
        agentId,
        describeIssues(
          verified.rejected.map((entry) => ({
            code: "scope-rejected",
            detail: `${entry.reason}:${entry.path}`,
          })),
        ),
      );
    }

    const holder: { result: DagIntakeResult } = { result: { status: "no-pending-plan" } };
    await options.store.update(runId, (current) => {
      if (!pending(current, agentId)) return null;
      // Judge again on what is stored now: the reads above may be stale.
      const again = checkDag(current, block, checkInput);
      if (!again.ok) {
        holder.result = { status: "refused", reasons: describeIssues(again.issues) };
        return null;
      }
      const now = clock.now();
      const control = readDagControl(current);
      if (!control) return null;
      const accepted = withDagControl(current, { ...control, acceptedAt: now });
      const reduced = reduceRun(
        accepted,
        { kind: "dag-accepted", block: again.block },
        { now, newId: () => uuid() },
      );
      if (!reduced.ok) {
        holder.result = {
          status: "refused",
          reasons: `DAG 被拒：${reduced.code}:${String(reduced.params.reason ?? "")}`,
        };
        return null;
      }
      holder.result = { status: "admitted", tasks: again.block.tasks.length };
      return reduced.next;
    });

    // A refusal found only inside the commit is shown the same way as one found before it.
    if (holder.result.status === "refused") return refuse(runId, agentId, holder.result.reasons);
    if (holder.result.status === "admitted") options.onAdmitted?.(runId);
    return holder.result;
  }

  return {
    /**
     * Call after a `turn_ended` was recorded for `agentId`. Safe to call any number of times: a
     * DAG that was admitted, or a Run that is not waiting for one, reports `no-pending-plan`.
     */
    async settleCoordinator(agentId: string): Promise<DagIntakeResult[]> {
      const owners = await options.store.runsForAgent(agentId);
      const results: DagIntakeResult[] = [];
      for (const runId of owners) {
        const previous = chains.get(runId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => settleRun(runId, agentId));
        chains.set(
          runId,
          run.catch(() => undefined),
        );
        results.push(await run);
      }
      return results.length === 0 ? [{ status: "no-pending-plan" }] : results;
    },
  };
}

export type DagIntake = ReturnType<typeof createDagIntake>;
