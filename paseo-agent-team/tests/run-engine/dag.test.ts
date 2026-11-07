import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDagIntake, type DagIntakeOptions } from "../../server/run-engine/dag";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { inspectRepo } from "../../server/run-engine/repo";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS, readDagControl } from "../../shared/domain/run-engine/dag-admission";
import { transitionIntent } from "../../shared/domain/run-engine/effect-state";
import { compilePlanRepair } from "../../shared/domain/run-engine/engine-prompts";
import { planRepairWakes } from "../../shared/domain/run-engine/plan-repair";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";

/**
 * Failure modes this file guards, with a real store, the real observer and a real git repository:
 *  - a DAG admitted before the host showed the coordinator's turn end, admitted twice, or admitted
 *    from anyone but the coordinator;
 *  - a plan with a path that leaves the repository or a repository it should not name being
 *    admitted instead of refused with its reason on the Run;
 *  - a refusal that freezes the Run for good, or that grows the ledger every time it is seen again.
 */

const RUN_ID = "run-dagsv1-a1";
const TURN = "turn-plan-1";

let home: string;
let repoDir: string;
let store: RunStore;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=probe",
      "-c",
      "user.email=probe@example.invalid",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, windowsHide: true, stdio: "ignore" },
  );
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-dag-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
  await store.create(bootstrapRun({ runId: RUN_ID, planRequest: true }));
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

function fence(body: unknown): string {
  return `Here is the plan.\n\`\`\`task-dag\n${JSON.stringify(body)}\n\`\`\`\n`;
}

function window(text: string): ReplyWindow {
  return { complete: true, turnId: TURN, text, bytes: Buffer.byteLength(text, "utf8") };
}

function harness(reply: (messageId: string) => ReplyWindow, extra: Partial<DagIntakeOptions> = {}) {
  const asked: string[] = [];
  const host: ObserverHost = {
    replyWindow: async (agentId, messageId) => {
      asked.push(`${agentId}:${messageId}`);
      return reply(messageId);
    },
  };
  const observer = createRunObserver({ store });
  const onAdmitted = vi.fn();
  const intake = createDagIntake({
    store,
    host,
    seatFamily: () => null,
    resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    onAdmitted,
    ...extra,
  });
  return { intake, observer, onAdmitted, asked };
}

type Harness = ReturnType<typeof harness>;

async function turnEnded(h: Harness) {
  await h.observer.ingest({ name: "agent.turn_ended", agentId: COORDINATOR_AGENT, turnId: TURN });
}

const plan = () => fence(dagBlock(RUN_ID, planTasks(REPO_ALIAS)));

describe("settleCoordinator", () => {
  test("a valid plan is admitted once: the Run is active, the first task is ready, the nonce is spent", async () => {
    const h = harness(() => window(plan()));
    await turnEnded(h);
    const results = await h.intake.settleCoordinator(COORDINATOR_AGENT);

    expect(results).toEqual([{ status: "admitted", tasks: 2 }]);
    // The reply that was read is the reply to the plan request.
    expect(h.asked).toEqual([`${COORDINATOR_AGENT}:${PLAN_MESSAGE_ID}`]);
    const after = await stored();
    expect(after.lifecycle).toBe("active");
    expect(after.dagRevision).toBe(1);
    expect(after.tasks.map((task) => `${task.spec.id}:${task.state}`)).toEqual([
      "t1:ready",
      "t2:pending",
    ]);
    // The alias was replaced by the real repository id before anything was stored.
    const inspected = await inspectRepo(repoDir);
    if (!inspected.ok) throw new Error("fixture repository is not readable");
    expect(after.tasks.flatMap((task) => task.spec.scopes.map((scope) => scope.repoId))).toEqual([
      inspected.repo.repoId,
      inspected.repo.repoId,
    ]);
    expect(readDagControl(after)?.acceptedAt).not.toBeNull();
    // The plan request is answered: it leaves the outbox (an orphan wake would keep the Run from
    // ever finishing) and the audit trail says so.
    expect(after.outbox.some((intent) => intent.kind === "wake")).toBe(false);
    expect(after.events.at(-1)).toMatchObject({
      kind: "plan-request-settled",
      payload: { intentIds: ["intent-plan-1"] },
    });
    expect(h.onAdmitted).toHaveBeenCalledWith(RUN_ID);

    // The same reply again changes nothing.
    expect(await h.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "no-pending-plan" },
    ]);
    expect((await stored()).revision).toBe(after.revision);
    expect(h.onAdmitted).toHaveBeenCalledTimes(1);
  });

  test("nothing is admitted before the host's turn_ended is recorded", async () => {
    const h = harness(() => window(plan()));
    const before = await stored();
    expect(await h.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "turn-not-ended" },
    ]);
    expect((await stored()).revision).toBe(before.revision);
    await turnEnded(h);
    expect((await h.intake.settleCoordinator(COORDINATOR_AGENT))[0]?.status).toBe("admitted");
  });

  test("only the coordinator's reply is a plan", async () => {
    const h = harness(() => window(plan()));
    await h.observer.ingest({ name: "agent.turn_ended", agentId: "agent-b1", turnId: TURN });
    expect(await h.intake.settleCoordinator("agent-b1")).toEqual([{ status: "no-pending-plan" }]);
    expect(await h.intake.settleCoordinator("agent-nobody")).toEqual([
      { status: "no-pending-plan" },
    ]);
    expect((await stored()).lifecycle).toBe("bootstrapping");
  });

  test("a reply with no plan is shown on the Run as an alert, once, and the Run waits for a DAG", async () => {
    const h = harness(() => window("I will think about it."));
    await turnEnded(h);
    const first = await h.intake.settleCoordinator(COORDINATOR_AGENT);

    expect(first).toEqual([
      { status: "refused", reasons: "DAG 缺失：协调者的回复里没有 task-dag 块" },
    ]);
    const after = await stored();
    expect(after.lifecycle).toBe("awaiting-dag");
    expect(after.tasks).toEqual([]);
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0]).toMatchObject({ state: "open", severity: "warning" });

    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect((await stored()).revision).toBe(after.revision);
    expect(h.onAdmitted).not.toHaveBeenCalled();
  });

  test("a malformed plan is refused with its reason", async () => {
    const h = harness(() => window("```task-dag\n{ nope\n```\n"));
    await turnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(result).toEqual({ status: "refused", reasons: "DAG 块被拒：non-json" });
  });

  test("a plan that leaves the repository, or names another one, is refused with the paths", async () => {
    // A path the pure checks cannot see through: a junction inside the repository that points out.
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(repoDir, "escape"), "junction");
    const escaping = planTasks(REPO_ALIAS);
    const scope = escaping[0]?.scopes[0];
    if (scope) scope.path = "escape/payload.ts";
    const h = harness(() => window(fence(dagBlock(RUN_ID, escaping))));
    await turnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(result).toMatchObject({ status: "refused" });
    expect(result?.status === "refused" && result.reasons).toContain(
      "scope-rejected:escapes-repo:escape/payload.ts",
    );

    // The git directory and `..` are refused before the repository is looked at.
    const gitDir = planTasks(REPO_ALIAS);
    const gitScope = gitDir[0]?.scopes[0];
    if (gitScope) gitScope.path = ".git/config";
    const direct = harness(() => window(fence(dagBlock(RUN_ID, gitDir))));
    const [refusedGit] = await direct.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(refusedGit?.status === "refused" && refusedGit.reasons).toContain(
      "invalid-scope-path:t1:.git/config",
    );

    const stranger = harness(() => window(fence(dagBlock(RUN_ID, planTasks("repo-someone-else")))));
    const [other] = await stranger.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(other?.status === "refused" && other.reasons).toContain(
      "unknown-repository:t1:repo-someone-else",
    );
    const after = await stored();
    expect(after.lifecycle).toBe("awaiting-dag");
    expect(after.tasks).toEqual([]);
    expect(readDagControl(after)?.acceptedAt).toBeNull();
    expect(after.alerts).toHaveLength(3);
  });

  test("after a refusal a corrected plan is admitted: the nonce was not spent", async () => {
    let reply = "no plan yet";
    const h = harness(() => window(reply));
    await turnEnded(h);
    expect((await h.intake.settleCoordinator(COORDINATOR_AGENT))[0]?.status).toBe("refused");
    expect((await stored()).lifecycle).toBe("awaiting-dag");

    reply = plan();
    expect((await h.intake.settleCoordinator(COORDINATOR_AGENT))[0]).toEqual({
      status: "admitted",
      tasks: 2,
    });
    const after = await stored();
    expect(after.lifecycle).toBe("active");
    // The earlier alert stays as history, but it no longer asks for attention.
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0]).toMatchObject({ state: "resolved" });
    expect(after.alerts[0]?.resolvedAt).not.toBeNull();
    expect(after.events.filter((event) => event.kind === "alert-resolved")).toHaveLength(1);
  });

  test("an incomplete read is left for later and an unreadable host is reported, writing nothing", async () => {
    const before = await stored();
    const partial = harness(() => ({ complete: false, reason: "too-many-pages" }));
    await turnEnded(partial);
    expect(await partial.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "unverifiable", reason: "too-many-pages" },
    ]);
    const broken = harness(() => {
      throw new Error("host down");
    });
    expect(await broken.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "host-error" },
    ]);
    const after = await stored();
    expect(after.lifecycle).toBe(before.lifecycle);
    expect(after.alerts).toEqual([]);
  });

  test("without a plan request that went out there is nothing to read", async () => {
    await store.close();
    store = createRunStore({ home: path.join(home, "paseo2"), lock: { acquireTimeoutMs: 300 } });
    await mkdir(path.join(home, "paseo2"));
    await store.initialize();
    await store.create(bootstrapRun({ runId: RUN_ID }));
    const h = harness(() => window(plan()));
    await turnEnded(h);
    expect(await h.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "no-pending-plan" },
    ]);
    expect(h.asked).toEqual([]);
  });
});

// --- a plan the parser refuses is sent back once -------------------------------------------------

describe("a plan the strict parser refuses is asked for again, once", () => {
  const REPAIR_TURN = "turn-repair-1";
  const PLAN_ID = "intent-plan-1";

  /** The plan as DEV's haiku wrote it: no task has a `group`. */
  const brokenPlan = () =>
    fence(
      dagBlock(RUN_ID, planTasks(REPO_ALIAS).map(({ group: _group, ...rest }) => rest) as never),
    );

  /** Stands in for the outbox executor: what is prepared goes through sending to confirmed. */
  function sender() {
    const sends: string[] = [];
    return {
      sends,
      repair: {
        send: async (runId: string) => {
          sends.push(runId);
          await store.update(runId, (current) => {
            let next = current;
            for (const intent of current.outbox) {
              if (intent.state !== "prepared") continue;
              const at = { now: current.updatedAt };
              const sending = transitionIntent(next, intent.id, "sending", at);
              if (!sending.ok) continue;
              const done = transitionIntent(sending.next, intent.id, "confirmed", at);
              if (done.ok) next = done.next;
            }
            return next === current ? null : next;
          });
        },
      },
    };
  }

  /** Never sends: the process stopped between the commit and the send. */
  const crashed = () => {
    const sends: string[] = [];
    return { sends, repair: { send: async (runId: string) => void sends.push(runId) } };
  };

  /** A coordinator that answers each message with its own text; the turn follows the message. */
  function answers(byMessage: Map<string, string>) {
    return (messageId: string): ReplyWindow => {
      const text = byMessage.get(messageId) ?? "";
      const turnId = messageId === PLAN_MESSAGE_ID ? TURN : REPAIR_TURN;
      return { complete: true, turnId, text, bytes: Buffer.byteLength(text, "utf8") };
    };
  }

  const repairs = (record: RunRecord) => planRepairWakes(record, PLAN_ID);
  const repairTurnEnded = (h: Harness) =>
    h.observer.ingest({
      name: "agent.turn_ended",
      agentId: COORDINATOR_AGENT,
      turnId: REPAIR_TURN,
    });

  test("the refusal is shown as before, the nonce stays unspent, and one re-send is prepared and sent", async () => {
    const { sends, repair } = sender();
    const h = harness(answers(new Map([[PLAN_MESSAGE_ID, brokenPlan()]])), { repair });
    await turnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);

    expect(result?.status).toBe("refused");
    expect(result?.status === "refused" && result.reasons).toContain("schema-invalid");
    expect(result?.status === "refused" && result.reasons).toContain("tasks.0.group");
    const after = await stored();
    expect(after.lifecycle).toBe("awaiting-dag");
    expect(after.alerts).toHaveLength(1);
    expect(readDagControl(after)?.acceptedAt).toBeNull();
    const [wake] = repairs(after);
    expect(wake).toMatchObject({
      recipient: COORDINATOR_AGENT,
      state: "confirmed",
      assignmentId: null,
      semanticArgs: { reason: "plan-rejected:schema-invalid", ordinal: 1, limit: 1 },
    });
    expect(JSON.stringify(wake?.semanticArgs.issues)).toContain("tasks.0.group");
    // The re-send also learns what type the missing key should have.
    expect(wake?.semanticArgs.issues).toContainEqual({
      path: "tasks.0.group",
      message: "invalid_type",
      expected: "string",
    });
    expect(sends).toEqual([RUN_ID]);
    expect(h.onAdmitted).not.toHaveBeenCalled();
  });

  test("the reply to the re-send is the plan read next: a corrected one is admitted, and both messages leave the outbox", async () => {
    const { repair } = sender();
    const replies = new Map([[PLAN_MESSAGE_ID, brokenPlan()]]);
    const h = harness(answers(replies), { repair });
    await turnEnded(h);
    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    const wake = repairs(await stored())[0];
    if (!wake) throw new Error("no re-send was prepared");

    // Until the coordinator's next turn has ended there is nothing to read.
    replies.set(wake.messageId, plan());
    expect(await h.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "turn-not-ended" },
    ]);
    await repairTurnEnded(h);
    expect(await h.intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "admitted", tasks: 2 },
    ]);

    expect(h.asked.at(-1)).toBe(`${COORDINATOR_AGENT}:${wake.messageId}`);
    const after = await stored();
    expect(after.lifecycle).toBe("active");
    expect(after.tasks.map((task) => `${task.spec.id}:${task.state}`)).toEqual([
      "t1:ready",
      "t2:pending",
    ]);
    expect(readDagControl(after)?.acceptedAt).not.toBeNull();
    expect(after.outbox.some((intent) => intent.kind === "wake")).toBe(false);
    expect(after.events.find((event) => event.kind === "plan-request-settled")).toMatchObject({
      payload: { intentIds: [PLAN_ID, wake.id] },
    });
    // The refusal that started the repair no longer asks for attention.
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0]).toMatchObject({ state: "resolved" });
    expect(after.events.at(-1)).toMatchObject({ kind: "alert-resolved" });
    expect(h.onAdmitted).toHaveBeenCalledTimes(1);
  });

  test("the same refusal seen again asks for nothing more: a re-send already waiting is only sent", async () => {
    const { sends, repair } = crashed();
    const h = harness(answers(new Map([[PLAN_MESSAGE_ID, brokenPlan()]])), { repair });
    await turnEnded(h);
    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    const first = await stored();
    expect(repairs(first)).toHaveLength(1);
    expect(repairs(first)[0]?.state).toBe("prepared");

    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    const second = await stored();
    expect(repairs(second)).toHaveLength(1);
    expect(second.revision).toBe(first.revision);
    // The first call stopped before it sent, so the second one sends it.
    expect(sends).toEqual([RUN_ID, RUN_ID]);
  });

  test("a re-send is sent once whatever the number of hooks: after it went out an older read is stale", async () => {
    const { sends, repair } = sender();
    const h = harness(answers(new Map([[PLAN_MESSAGE_ID, brokenPlan()]])), { repair });
    await turnEnded(h);
    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(sends).toHaveLength(1);
    // The hook for the first turn arrives again while the coordinator works on the re-send: the
    // reply being read is now the re-send's, and its turn has not ended.
    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(repairs(await stored())).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  test("one re-send at most: a re-send that is refused again leaves the Run waiting with its reason", async () => {
    const { sends, repair } = sender();
    const replies = new Map([[PLAN_MESSAGE_ID, brokenPlan()]]);
    const h = harness(answers(replies), { repair });
    await turnEnded(h);
    await h.intake.settleCoordinator(COORDINATOR_AGENT);
    const wake = repairs(await stored())[0];
    if (!wake) throw new Error("no re-send was prepared");
    replies.set(wake.messageId, "```task-dag\n{ nope\n```\n");
    await repairTurnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);

    expect(result).toEqual({ status: "refused", reasons: "DAG 块被拒：non-json" });
    const after = await stored();
    expect(repairs(after)).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(after.lifecycle).toBe("awaiting-dag");
    expect(after.alerts.map((alert) => alert.summary)).toEqual([
      expect.stringContaining("tasks.0.group"),
      "DAG 块被拒：non-json",
    ]);
    expect(h.onAdmitted).not.toHaveBeenCalled();
  });

  test("a refusal of what the plan says is not asked about: that is for a person to re-plan", async () => {
    const { sends, repair } = sender();
    const gitPath = planTasks(REPO_ALIAS).map((task, index) =>
      index === 0 ? { ...task, scopes: [{ ...task.scopes[0], path: ".git/config" }] } : task,
    );
    const cycle = planTasks(REPO_ALIAS).map((task) => ({
      ...task,
      deps: task.id === "t1" ? ["t2"] : ["t1"],
    }));
    const cases: [string, unknown[]][] = [
      ["another repository", planTasks("repo-someone-else")],
      ["a path in .git", gitPath],
      ["a dependency cycle", cycle],
    ];
    for (const [name, tasks] of cases) {
      const h = harness(() => window(fence(dagBlock(RUN_ID, tasks as never))), { repair });
      await turnEnded(h);
      const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);
      expect(result?.status, name).toBe("refused");
      expect(result?.status === "refused" && result.reasons, name).not.toContain("schema-invalid");
    }
    expect(repairs(await stored())).toHaveLength(0);
    expect(sends).toEqual([]);
  });

  test("a reply with no block is not asked about either: the request lets the coordinator say it cannot plan", async () => {
    const { sends, repair } = sender();
    const h = harness(() => window("I cannot form a plan: there is no reviewer seat."), { repair });
    await turnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(result).toEqual({
      status: "refused",
      reasons: "DAG 缺失：协调者的回复里没有 task-dag 块",
    });
    expect(repairs(await stored())).toHaveLength(0);
    expect(sends).toEqual([]);
  });

  test("an unreadable or partial reply is not a refusal, so nothing is asked", async () => {
    const { sends, repair } = sender();
    const partial = harness(() => ({ complete: false, reason: "too-many-pages" }), { repair });
    await turnEnded(partial);
    await partial.intake.settleCoordinator(COORDINATOR_AGENT);
    const broken = harness(
      () => {
        throw new Error("host down");
      },
      { repair },
    );
    await broken.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(repairs(await stored())).toHaveLength(0);
    expect(sends).toEqual([]);
  });

  test("without the option, or with the policy at 0 re-sends, a refused block only leaves its reason", async () => {
    const off = harness(() => window(brokenPlan()));
    await turnEnded(off);
    expect((await off.intake.settleCoordinator(COORDINATOR_AGENT))[0]?.status).toBe("refused");
    expect(repairs(await stored())).toHaveLength(0);

    await store.update(RUN_ID, (current) => ({
      ...current,
      policy: { ...current.policy, perTask: { ...current.policy.perTask, protocolResends: 0 } },
    }));
    const { sends, repair } = sender();
    const zero = harness(() => window(brokenPlan()), { repair });
    expect((await zero.intake.settleCoordinator(COORDINATOR_AGENT))[0]?.status).toBe("refused");
    expect(repairs(await stored())).toHaveLength(0);
    expect(sends).toEqual([]);
  });

  test("a re-send that cannot be sent is logged and the refusal is still reported", async () => {
    const log = vi.fn();
    const h = harness(answers(new Map([[PLAN_MESSAGE_ID, brokenPlan()]])), {
      repair: {
        send: async () => {
          throw new Error("outbox down");
        },
      },
      log,
    });
    await turnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(result?.status).toBe("refused");
    expect(log).toHaveBeenCalled();
    // The request stays prepared in the ledger, and its text can be rebuilt for the next outbox run.
    const record = await stored();
    const [wake] = repairs(record);
    expect(wake?.state).toBe("prepared");
    expect(wake && compilePlanRepair(wake, record)).not.toBeNull();
  });
});
