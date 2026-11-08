import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { projectDetail, projectSummary } from "../../server/run-engine/projection";
import { createReadRetry } from "../../server/run-engine/read-retry";
import { failInterruptedLaunches } from "../../server/run-engine/start";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { emptyReadRetries } from "../../shared/domain/run-engine/read-retry";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { bootstrapRun } from "./support/bootstrap-run";

/**
 * Closing a launch that a restart cut off (the loops with a real runtime are in runtime.test.ts).
 * Failure modes this file guards:
 *  - a Run the process is starting right now being failed;
 *  - the alert not saying who is on the record and which seat may have an agent the record never learned of;
 *  - a Run that is not in the middle of a launch, or is over, being touched;
 *  - a second look writing again, or the host being called at all.
 */

const RUN_ID = "run-intr01-a1";
let home: string;
let store: RunStore;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "run-intr-"));
  store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function seed(change: (record: RunRecord) => void): Promise<void> {
  const record = bootstrapRun({ runId: RUN_ID });
  change(record);
  await store.create(record);
}

async function stored(): Promise<RunRecord> {
  const read = await store.get(RUN_ID);
  if (read.status !== "ok") throw new Error(`run unreadable: ${read.status}`);
  return read.record;
}

const look = (starting = false) => failInterruptedLaunches({ store, isStarting: () => starting });

describe("failInterruptedLaunches", () => {
  test("names the agents on the record and the next seat that has none", async () => {
    await seed((record) => {
      record.launch.state = "creating";
      const seat = record.roster.find((entry) => entry.seatId === "seat-b2");
      if (seat) seat.agentId = null;
    });
    expect(await look()).toBe(1);
    const after = await stored();
    expect(after.launch.state).toBe("failed");
    const alert = after.alerts.find((entry) => entry.summary.startsWith("启动在创建成员时中断"));
    expect(alert).toMatchObject({ severity: "critical", state: "open" });
    expect(alert?.summary).toContain("seat-b1=agent-b1");
    expect(alert?.summary).toContain("coordinator=agent-coord");
    expect(alert?.summary).toContain("已创建但未登记的 Agent（席位 seat-b2）");
    expect(alert?.summary).toContain("重新启动");
    expect(alert?.summary.length).toBeLessThanOrEqual(1000);
    expect(after.events.at(-1)?.kind).toBe("alert-raised");
  });

  test("names the coordinator as the possible unregistered agent when its creation was interrupted", async () => {
    await seed((record) => {
      record.launch.state = "creating";
      for (const seat of record.roster) seat.agentId = null;
    });
    await look();
    const alert = (await stored()).alerts.find((entry) => entry.summary.startsWith("启动在"));
    expect(alert?.summary).toContain("已创建但未登记的 Agent（席位 coordinator）");
  });

  test("long seat and agent identifiers leave room for the missing agent and cleanup instructions", async () => {
    await seed((record) => {
      record.launch.state = "creating";
      const seat = record.roster[0];
      if (!seat) throw new Error("fixture lost its seat");
      for (let i = 0; i < 8; i += 1) {
        record.roster.push({
          ...seat,
          seatId: `long-seat-${i}-${"s".repeat(105)}`,
          agentId: `long-agent-${i}-${"a".repeat(105)}`,
        });
      }
      const missing = record.roster.find((entry) => entry.seatId === "seat-b2");
      if (!missing) throw new Error("fixture lost seat-b2");
      missing.agentId = null;
    });
    await look();
    const alert = (await stored()).alerts.find((entry) => entry.summary.startsWith("启动在"));
    expect(alert?.summary.length).toBeLessThanOrEqual(1000);
    expect(alert?.summary).toContain("已创建但未登记的 Agent（席位 seat-b2）");
    expect(alert?.summary).toContain("这个 Run 不会继续，请重新启动");
    expect(alert?.summary).toContain("归档不再需要的成员");
    expect(alert?.summary).toContain("等共 11 个");
  });

  test("a Run still being created by this process is left alone", async () => {
    await seed((record) => {
      record.launch.state = "creating";
    });
    const before = await stored();
    expect(await look(true)).toBe(0);
    expect(await stored()).toEqual(before);
  });

  test("the launch and lifecycle are checked again inside the write", async () => {
    await seed((record) => {
      record.launch.state = "creating";
    });
    let checks = 0;
    expect(await failInterruptedLaunches({ store, isStarting: () => ++checks > 1 })).toBe(0);
    expect((await stored()).launch.state).toBe("creating");

    const withStaleList: Pick<RunStore, "list" | "get" | "update"> = {
      list: () => store.list(),
      get: (runId) => store.get(runId),
      update: async (runId, mutate) => {
        await store.update(runId, (current) => {
          current.lifecycle = "cancelled";
          return current;
        });
        return store.update(runId, mutate);
      },
    };
    expect(await failInterruptedLaunches({ store: withStaleList, isStarting: () => false })).toBe(
      0,
    );
    const after = await stored();
    expect(after.lifecycle).toBe("cancelled");
    expect(after.launch.state).toBe("creating");
    expect(after.alerts).toEqual([]);
  });

  test.each([1, 2] as const)(
    "keeps schema v%i and unrelated fields when it closes the launch",
    async (version) => {
      await seed((record) => {
        record.schemaVersion = version;
        record.launch.state = "preparing";
        (record as Record<string, unknown>).externalExtension = { nested: [1, "kept"] };
      });
      const before = await stored();
      expect(await look()).toBe(1);
      const after = await stored();
      expect(after.schemaVersion).toBe(version);
      expect(after.roster).toEqual(before.roster);
      expect(after.policy).toEqual(before.policy);
      expect(after.outbox).toEqual(before.outbox);
      expect(after.externalExtension).toEqual(before.externalExtension);
    },
  );

  test("an interrupted launch is visible as needing attention and its critical alert is in the detail", async () => {
    await seed((record) => {
      record.launch.state = "creating";
    });
    await look();
    const after = await stored();
    expect(projectSummary(after)?.needsAttention).toBe(true);
    const detail = projectDetail(after);
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("detail projection failed");
    expect(detail.view.alerts).toContainEqual(
      expect.objectContaining({ severity: "critical", summary: expect.stringContaining("启动在") }),
    );
  });

  test("a failed interrupted launch no longer keeps a read retry timer", async () => {
    await seed((record) => {
      record.launch.state = "creating";
      record.schemaVersion = 2;
      (record as Record<string, unknown>).readRetries = emptyReadRetries();
    });
    let scheduled = 0;
    const retry = createReadRetry({
      store,
      readReply: async () => {
        throw new Error("unexpected host read");
      },
      readSeat: async () => {
        throw new Error("unexpected host read");
      },
      schedule: () => {
        scheduled += 1;
        return () => {
          scheduled -= 1;
        };
      },
    });
    try {
      await retry.note(RUN_ID, { type: "seat", agentId: "agent-b1" });
      expect(retry.armed).toBe(true);
      await look();
      await retry.start();
      expect(retry.armed).toBe(false);
      expect(retry.pendingRuns).toBe(0);
      expect(scheduled).toBe(0);
    } finally {
      await retry.dispose();
    }
  });

  test("a launch that reached the plan request, or is over, or a Run that is over, is left alone", async () => {
    for (const state of ["kickoff-pending", "running", "failed", "cancelled"] as const) {
      await seed((record) => {
        record.launch.state = state;
      });
      const before = await stored();
      expect(await look()).toBe(0);
      expect(await stored()).toEqual(before);
      await store.close();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      home = await mkdtemp(path.join(tmpdir(), "run-intr-"));
      store = createRunStore({ home, lock: { acquireTimeoutMs: 300 } });
      await store.initialize();
    }
    await seed((record) => {
      record.launch.state = "creating";
      record.lifecycle = "cancelled";
    });
    expect(await look()).toBe(0);
  });

  test("a second look finds nothing and writes nothing", async () => {
    await seed((record) => {
      record.launch.state = "preparing";
    });
    expect(await look()).toBe(1);
    const once = await stored();
    expect(await look()).toBe(0);
    expect(await stored()).toEqual(once);
    expect(
      once.alerts.filter((entry) => entry.summary.startsWith("启动在创建记录时中断")),
    ).toHaveLength(1);
  });

  test("the Run does not become starting again by being failed: it is shown as a failed launch", async () => {
    await seed((record) => {
      record.launch.state = "creating";
    });
    await look();
    const after = await stored();
    const moved = after.events.filter((entry) => entry.kind === "launch-state").at(-1);
    expect(moved?.payload).toMatchObject({ from: "creating", to: "failed" });
    expect(String(moved?.payload.reason)).toBe("interrupted-while-creating");
  });
});
