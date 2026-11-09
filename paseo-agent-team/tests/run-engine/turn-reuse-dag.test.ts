import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDagIntake } from "../../server/run-engine/dag";
import { createRunObserver, type ObserverHost } from "../../server/run-engine/observer";
import type { ReplyWindow } from "../../server/run-engine/protocol";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_ALIAS } from "../../shared/domain/run-engine/dag-admission";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  bootstrapRun,
  COORDINATOR_AGENT,
  dagBlock,
  PLAN_MESSAGE_ID,
  planTasks,
} from "./support/bootstrap-run";

/**
 * T9a: after a restart the coordinator is asked to plan again and its new turn carries the id of an
 * earlier turn (the first plan was not a turn it ever answered, or it was cut off). The plan request
 * was made after that earlier turn, so the turn it ran in is the new appearance: the earlier end is
 * not its end, and the plan is admitted on the new one. Real store, real observer, real git repository.
 */

const RUN_ID = "run-trdg01-a1";
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

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe.each([
  ["v1 ledger, host counts from 1", 1 as const, "foreground-turn-1"],
  ["v1 ledger, host counts from 0", 1 as const, "codex-turn-0"],
  ["v2 ledger, host counts from 1", 2 as const, "foreground-turn-1"],
  ["v2 ledger, host counts from 0", 2 as const, "codex-turn-0"],
])("%s", (_label, schemaVersion, turn) => {
  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), "run-dag-reuse-")));
    repoDir = path.join(home, "repo");
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    git(repoDir, "init", "-q", "-b", "main");
    await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "base");
    await mkdir(path.join(home, "paseo"));
    store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
    await store.initialize();
    const record = bootstrapRun({ runId: RUN_ID, planRequest: true });
    (record as { schemaVersion: number }).schemaVersion = schemaVersion;
    await store.create(record);
  });

  const stored = async (): Promise<RunRecord> => {
    const read = await store.get(RUN_ID);
    if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
    return read.record;
  };
  const window = (text: string): ReplyWindow => ({
    complete: true,
    turnId: turn,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
  });

  test("a re-plan after a restart is read on the new appearance and admitted on its end", async () => {
    // Before the plan request (made 2026-10-27T12:00) the coordinator had run a turn with this id.
    const old = createRunObserver({ store, clock: { now: () => "2026-10-27T11:00:00.000Z" } });
    await old.ingest({ name: "agent.turn_started", agentId: COORDINATOR_AGENT, turnId: turn });
    await old.ingest({ name: "agent.turn_ended", agentId: COORDINATOR_AGENT, turnId: turn });

    let reply = "I will think about it.";
    const asked: string[] = [];
    const host: ObserverHost = {
      replyWindow: async (agentId, messageId) => {
        asked.push(`${agentId}:${messageId}`);
        return window(reply);
      },
    };
    const live = createRunObserver({ store });
    const intake = createDagIntake({
      store,
      host,
      seatFamily: () => null,
      resolveWorkspace: () => ({ workspaceId: "ws-start", directory: repoDir }),
    });
    await live.ingest({ name: "agent.turn_started", agentId: COORDINATOR_AGENT, turnId: turn });

    // The new turn has begun and not ended: the old end is not its end.
    const before = await stored();
    expect(await intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "turn-not-ended" },
    ]);
    expect((await stored()).revision).toBe(before.revision);
    expect(asked).toEqual([`${COORDINATOR_AGENT}:${PLAN_MESSAGE_ID}`]);

    await live.ingest({ name: "agent.turn_ended", agentId: COORDINATOR_AGENT, turnId: turn });
    expect((await stored()).eventReceipts.at(-1)?.eventKey).toBe(
      `turn_ended:${COORDINATOR_AGENT}:${turn}#2`,
    );
    // Its end is in: a reply with no plan is refused for what it is, not held back.
    expect((await intake.settleCoordinator(COORDINATOR_AGENT))[0]).toMatchObject({
      status: "refused",
    });
    reply = `Here is the plan.\n\`\`\`task-dag\n${JSON.stringify(dagBlock(RUN_ID, planTasks(REPO_ALIAS)))}\n\`\`\`\n`;
    expect(await intake.settleCoordinator(COORDINATOR_AGENT)).toEqual([
      { status: "admitted", tasks: 2 },
    ]);
    expect((await stored()).lifecycle).toBe("active");
  });
});
