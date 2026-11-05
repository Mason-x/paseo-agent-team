import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDagIntake } from "../../server/run-engine/dag";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { inspectRepo } from "../../server/run-engine/repo";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS, readDagControl } from "../../shared/domain/run-engine/dag-admission";
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

function harness(reply: () => ReplyWindow) {
  const asked: string[] = [];
  const host: ObserverHost = {
    replyWindow: async (agentId, messageId) => {
      asked.push(`${agentId}:${messageId}`);
      return reply();
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
    const escaping = planTasks(REPO_ALIAS);
    const scope = escaping[0]?.scopes[0];
    if (scope) scope.path = ".git/config";
    const h = harness(() => window(fence(dagBlock(RUN_ID, escaping))));
    await turnEnded(h);
    const [result] = await h.intake.settleCoordinator(COORDINATOR_AGENT);
    expect(result).toMatchObject({ status: "refused" });
    expect(result?.status === "refused" && result.reasons).toContain(
      "scope-rejected:git-internal:.git/config",
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
    expect(after.alerts).toHaveLength(2);
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
    // The earlier alert stays as history.
    expect(after.alerts).toHaveLength(1);
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
