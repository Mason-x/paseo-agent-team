import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createEffects, payloadHash } from "../../server/run-engine/effects";
import { inspectRepo } from "../../server/run-engine/repo";
import { createEngineService, type EngineServiceOptions } from "../../server/run-engine/service";
import { createRunStore, type RunStore } from "../../server/run-engine/store";
import { REPO_EXCLUSIVE_RESOURCE } from "../../shared/domain/run-engine/dispatch-builder";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import type { PaseoEnginePort, PortAgentSnapshot, PortTimelinePage } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import {
  assignmentsForRun,
  claim,
  noncesForRun,
  PROFILE_HAIKU,
  withLedger,
} from "../fixtures/run-engine/base";
import { readyRun } from "./support/ready-run";
import {
  JUDGE_SEAT_REVIEW,
  JUDGE_SEAT_SMOKE,
  type ReviewRunOptions,
  reviewRun,
} from "./support/review-run";

/**
 * Failure modes this file guards, end to end with a real store and a real git repository:
 *  - a dispatch that is committed but never sent, or sent without being committed;
 *  - a dirty tree, a busy seat, an unbuildable prompt or a held repository still sending something;
 *  - the prompt in the ledger's hash not being the prompt that was sent;
 *  - two concurrent calls minting two assignments for one task;
 *  - a send that fails being retried instead of left `outcome-unknown`.
 */

const RUN_ID = "run-svc001-a1";
const WORKSPACE_ID = "ws-start";

let home: string;
let repoDir: string;
let repoId: string;
let evidenceRoot: string;
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
  home = await realpath(await mkdtemp(path.join(tmpdir(), "run-service-")));
  repoDir = path.join(home, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  await writeFile(path.join(repoDir, "src", "t1.ts"), "export {};\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base");
  const inspected = await inspectRepo(repoDir);
  if (!inspected.ok) throw new Error("fixture repository is not readable");
  repoId = inspected.repo.repoId;

  evidenceRoot = path.join(home, "evidence").replaceAll("\\", "/");
  await mkdir(path.join(home, "paseo"));
  store = createRunStore({ home: path.join(home, "paseo"), lock: { acquireTimeoutMs: 300 } });
  await store.initialize();
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const emptyPage: PortTimelinePage = {
  entries: [],
  epoch: "e1",
  startCursor: null,
  hasOlder: false,
  hasNewer: false,
  gap: false,
  staleCursor: false,
  reset: false,
};

type Sent = { agentId: string; text: string; options: unknown };

function fakeHost(options: { snapshot?: PortAgentSnapshot; send?: () => Promise<void> } = {}) {
  const sent: Sent[] = [];
  const snapshot: PortAgentSnapshot = options.snapshot ?? { status: "idle", activeTurn: null };
  const port: PaseoEnginePort = {
    agents: {
      ref: (agentId) => ({
        send: async (text, sendOptions) => {
          sent.push({ agentId, text, options: sendOptions });
          await options.send?.();
        },
        archive: async () => undefined,
        timeline: { refetch: async () => emptyPage },
        current: () => snapshot,
        refresh: async () => ({ agent: snapshot }),
      }),
    },
  };
  return { port, sent };
}

/** A stand-in for the real template: tests that care about the text pass `compileDispatch`. */
const PLACEHOLDER_COMPILE: EngineServiceOptions["compile"] = (intent, record) =>
  `PLACEHOLDER ${record.runId} ${intent.assignmentId} ${intent.messageId}`;

function makeService(
  host: ReturnType<typeof fakeHost>,
  overrides: Partial<EngineServiceOptions> = {},
) {
  const effects = createEffects({
    store,
    port: host.port,
    compile: overrides.compile ?? PLACEHOLDER_COMPILE,
  });
  return createEngineService({
    store,
    port: host.port,
    effects,
    resolveSeat: (_record, seatId) => {
      if (seatId === "seat-b1") {
        return {
          profile: {
            id: PROFILE_HAIKU.id,
            name: PROFILE_HAIKU.name,
            provider: PROFILE_HAIKU.provider,
            model: PROFILE_HAIKU.model,
            family: PROFILE_HAIKU.family,
          },
          available: true,
          order: 0,
        };
      }
      // The judges: another provider and family than the producer's.
      if (seatId === JUDGE_SEAT_REVIEW || seatId === JUDGE_SEAT_SMOKE) {
        return {
          profile: {
            id: "profile-dev-luna",
            name: "DEV Luna",
            provider: "codex",
            model: "gpt-6-luna",
            family: "luna",
          },
          available: true,
          order: seatId === JUDGE_SEAT_REVIEW ? 1 : 2,
        };
      }
      return null;
    },
    resolveWorkspace: () => ({ workspaceId: WORKSPACE_ID, directory: repoDir }),
    compile: PLACEHOLDER_COMPILE,
    ...overrides,
  });
}

async function seed(mutate: (record: RunRecord) => void = () => undefined): Promise<RunRecord> {
  // Evidence lives outside the repository; the fixture's relative "evidence" would not be allowed.
  const record = readyRun({ runId: RUN_ID, repoId, evidenceRoot });
  mutate(record);
  await store.create(record);
  return record;
}

async function stored(runId = RUN_ID): Promise<RunRecord> {
  const read = await store.get(runId);
  if (read.status !== "ok") throw new Error(`run ${runId} unreadable: ${read.status}`);
  return read.record;
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync(
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
    { cwd, windowsHide: true, encoding: "utf8" },
  ).trim();
}

/** Commits `files` as the producer's delivery and returns the base it started from and the new head. */
async function deliver(
  files: Record<string, string> = { "src/t1.ts": "export const t1 = 1;\n" },
): Promise<{ baseSha: string; headSha: string }> {
  const baseSha = gitOut(repoDir, "rev-parse", "HEAD");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
    await writeFile(path.join(repoDir, file), content);
    git(repoDir, "add", "--", file);
  }
  git(repoDir, "commit", "-q", "-m", "deliver t1");
  return { baseSha, headSha: gitOut(repoDir, "rev-parse", "HEAD") };
}

async function seedReview(
  delivery: { baseSha: string; headSha: string },
  options: ReviewRunOptions = {},
  mutate: (record: RunRecord) => void = () => undefined,
): Promise<RunRecord> {
  const record = reviewRun({ runId: RUN_ID, repoId, evidenceRoot, ...delivery, ...options });
  mutate(record);
  await store.create(record);
  return record;
}

describe("dispatchNext: reviewer and smoker", () => {
  test("a delivered task goes to an independent reviewer, who is told what was really delivered", async () => {
    const delivery = await deliver();
    await seedReview(delivery);
    const host = fakeHost();
    const result = await makeService(host, { compile: compileDispatch }).dispatchNext(RUN_ID);

    expect(result).toMatchObject({
      status: "dispatched",
      taskId: "t1",
      purpose: "reviewer",
      seatId: JUDGE_SEAT_REVIEW,
    });
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]?.agentId).toBe("agent-b2");
    const text = host.sent[0]?.text ?? "";
    expect(text).toContain(delivery.headSha);
    expect(text).toContain(delivery.baseSha);

    const record = await stored();
    const reviewer = record.assignments.find(
      (entry) =>
        entry.purpose === "reviewer" && entry.taskId === "t1" && entry.state === "assigned",
    );
    expect(reviewer).toMatchObject({
      delivery: { producerAssignmentId: "assignment-t1-a1" },
      workspace: { branch: "main", baseRef: delivery.headSha },
    });
    const intent = record.outbox.find((entry) => entry.assignmentId === reviewer?.assignmentId);
    expect(intent).toMatchObject({ state: "confirmed", recipient: "agent-b2" });
    expect(intent?.payloadHash).toBe(payloadHash(text));
    // The judge takes no new claims, and one reservation lands on its seat.
    expect(record.resources.map((entry) => entry.claimId).sort()).toEqual([
      "claim-t1-file",
      "claim-t1-repo",
    ]);
    expect(
      record.budgets.entries.find((entry) => entry.subjectId === JUDGE_SEAT_REVIEW)?.reserved,
    ).toBe(1);
    // Judging did not touch the working tree.
    const after = await inspectRepo(repoDir);
    expect(after.ok && after.repo.clean).toBe(true);
  });

  test("while a delivered task is being judged the next task does not start", async () => {
    const delivery = await deliver();
    await seedReview(delivery);
    const host = fakeHost();
    const service = makeService(host, { compile: compileDispatch });
    expect((await service.dispatchNext(RUN_ID)).status).toBe("dispatched");

    // t2 is ready, but t1 still holds the repository.
    const next = await service.dispatchNext(RUN_ID);
    expect(next).toMatchObject({ status: "blocked", taskId: "t2", reason: "lock-conflict" });
    expect(host.sent).toHaveLength(1);
  });

  test("a delivered task whose judge is already out is not sent a second one", async () => {
    const delivery = await deliver();
    await seedReview(delivery, {}, (record) => {
      // t2 waits for t1; a pending task with no open dependency would be made ready again.
      const t2 = record.tasks.find((task) => task.spec.id === "t2");
      if (t2) {
        t2.state = "pending";
        t2.spec.deps = ["t1"];
      }
    });
    const host = fakeHost();
    const service = makeService(host, { compile: compileDispatch });
    expect((await service.dispatchNext(RUN_ID)).status).toBe("dispatched");
    expect(await service.dispatchNext(RUN_ID)).toEqual({ status: "idle" });
    expect(host.sent).toHaveLength(1);
  });

  test("with every judge busy the task waits, and the producer's own seat is never offered", async () => {
    const delivery = await deliver();
    await seedReview(delivery);
    const host = fakeHost({ snapshot: { status: "running", activeTurn: { id: "t" } } });
    const result = await makeService(host).dispatchNext(RUN_ID);

    expect(result).toMatchObject({ status: "waiting", taskId: "t1", reason: "no-seat" });
    if (result.status === "waiting") {
      expect(result.denials).toContainEqual({ seatId: "seat-b1", reason: "same-as-producer" });
      expect(result.denials).toContainEqual({ seatId: JUDGE_SEAT_REVIEW, reason: "busy" });
    }
    expect(host.sent).toHaveLength(0);
  });

  test.each([
    [
      "a commit on top of the delivery",
      async () => {
        await writeFile(path.join(repoDir, "src", "late.ts"), "x");
        git(repoDir, "add", "--", "src/late.ts");
        git(repoDir, "commit", "-q", "-m", "late");
      },
      "delivery-not-at-head",
    ],
    [
      "a switched branch",
      async () => {
        git(repoDir, "checkout", "-q", "-b", "elsewhere");
      },
      "delivery-branch-changed",
    ],
    [
      "an untracked file",
      async () => {
        await writeFile(path.join(repoDir, "stray.txt"), "x");
      },
      "workspace-dirty",
    ],
    [
      "a rewound branch",
      async () => {
        git(repoDir, "reset", "-q", "--hard", "HEAD~1");
      },
      "delivery-not-at-head",
    ],
  ])(
    "%s blocks the review and leaves ledger and host untouched",
    async (_name, disturb, reason) => {
      const delivery = await deliver();
      const before = await seedReview(delivery);
      await disturb();
      const host = fakeHost();
      const result = await makeService(host, { compile: compileDispatch }).dispatchNext(RUN_ID);

      expect(result).toMatchObject({ status: "blocked", taskId: "t1", reason });
      expect(host.sent).toHaveLength(0);
      expect((await stored()).revision).toBe(before.revision);
    },
  );

  test("a delivery whose real diff is not what the report claimed is not reviewed", async () => {
    const delivery = await deliver({
      "src/t1.ts": "export const t1 = 1;\n",
      "src/extra.ts": "export const extra = 1;\n",
    });
    // The report claims only src/t1.ts.
    await seedReview(delivery);
    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);

    expect(result).toMatchObject({
      status: "blocked",
      taskId: "t1",
      reason: "delivery-diff-mismatch",
    });
    if (result.status === "blocked") {
      expect(result.detail).toEqual({
        claimed: ["src/t1.ts"],
        actual: expect.arrayContaining(["src/t1.ts", "src/extra.ts"]),
      });
    }
    expect(host.sent).toHaveLength(0);
  });

  test("a reviewed task with a smoke goes to the smoker, on the registered DEV target", async () => {
    const delivery = await deliver();
    await seedReview(delivery, { devSmoke: true, reviewed: true });
    const host = fakeHost();
    const result = await makeService(host, { compile: compileDispatch }).dispatchNext(RUN_ID);

    expect(result).toMatchObject({
      status: "dispatched",
      taskId: "t1",
      purpose: "smoker",
      seatId: JUDGE_SEAT_SMOKE,
    });
    expect(host.sent[0]?.agentId).toBe("agent-m1");
    const text = host.sent[0]?.text ?? "";
    expect(text).toContain("127.0.0.1:6799");
    expect(text).toContain(delivery.headSha);
    expect(text).toContain("smoke-report");
  });

  test("a smoke is not started before the review has passed", async () => {
    const delivery = await deliver();
    // A smoke task whose only reviewer has not reported: the reviewer is the next work, not a smoker.
    await seedReview(delivery, { devSmoke: true });
    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);
    expect(result).toMatchObject({ status: "dispatched", purpose: "reviewer" });
  });
});

describe("dispatchNext", () => {
  test("commits a dispatch, sends exactly its prompt, and the ledger hash is that prompt's", async () => {
    await seed();
    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);

    expect(result).toMatchObject({ status: "dispatched", taskId: "t2", seatId: "seat-b1" });
    expect(host.sent).toHaveLength(1);
    const record = await stored();
    const intent = record.outbox.find(
      (entry) => entry.kind === "dispatch" && entry.taskId === "t2",
    );
    expect(intent).toMatchObject({ state: "confirmed", recipient: "agent-b1" });
    expect(intent?.payloadHash).toBe(payloadHash(host.sent[0]?.text ?? ""));
    expect(host.sent[0]?.options).toMatchObject({ messageId: intent?.messageId });

    const t2 = record.tasks.find((task) => task.spec.id === "t2");
    expect(t2?.state).toBe("assigned");
    const assignment = record.assignments.find((entry) => entry.taskId === "t2");
    expect(assignment?.workspace).toMatchObject({ id: WORKSPACE_ID, branch: "main" });
    expect(assignment?.workspace?.baseRef).toMatch(/^[0-9a-f]{40}$/u);
    expect(record.resources.some((entry) => entry.path === REPO_EXCLUSIVE_RESOURCE)).toBe(true);
    // seat-b1 started at reserved 1.
    expect(record.budgets.entries.find((entry) => entry.subjectId === "seat-b1")?.reserved).toBe(2);
  });

  test("a dirty working tree blocks the dispatch and leaves the ledger and the host untouched", async () => {
    await seed();
    await writeFile(path.join(repoDir, "stray.txt"), "left behind");
    const before = await stored();
    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);

    expect(result).toEqual({ status: "blocked", taskId: "t2", reason: "workspace-dirty" });
    expect(host.sent).toHaveLength(0);
    expect((await stored()).revision).toBe(before.revision);
  });

  test("a busy seat waits instead of queueing a second message on it", async () => {
    await seed();
    const host = fakeHost({ snapshot: { status: "running", activeTurn: { id: "t" } } });
    const result = await makeService(host).dispatchNext(RUN_ID);

    expect(result).toMatchObject({ status: "waiting", taskId: "t2", reason: "no-seat" });
    if (result.status === "waiting") {
      expect(result.denials).toContainEqual({ seatId: "seat-b1", reason: "busy" });
    }
    expect(host.sent).toHaveLength(0);
  });

  test("a seat waiting on a permission or reporting an error is not used", async () => {
    await seed();
    const permission = fakeHost({
      snapshot: { status: "idle", activeTurn: null, pendingPermissions: [{ id: "p" }] },
    });
    expect(await makeService(permission).dispatchNext(RUN_ID)).toMatchObject({
      status: "waiting",
    });
    const failed = fakeHost({ snapshot: { status: "idle", activeTurn: null, lastError: "boom" } });
    expect(await makeService(failed).dispatchNext(RUN_ID)).toMatchObject({ status: "waiting" });
    expect(permission.sent).toHaveLength(0);
    expect(failed.sent).toHaveLength(0);
  });

  test("with no ready task there is nothing to do", async () => {
    await seed((record) => {
      const t2 = record.tasks.find((task) => task.spec.id === "t2");
      if (t2) t2.state = "pending";
    });
    const host = fakeHost();
    expect(await makeService(host).dispatchNext(RUN_ID)).toEqual({ status: "idle" });
    expect(host.sent).toHaveLength(0);
  });

  test("an unknown Run is reported, not created", async () => {
    expect(await makeService(fakeHost()).dispatchNext("run-nope00-a1")).toEqual({
      status: "run-unavailable",
    });
  });

  test("a prompt that cannot be built commits nothing: no assignment, no reservation", async () => {
    await seed();
    const before = await stored();
    const host = fakeHost();
    const result = await makeService(host, { compile: () => null }).dispatchNext(RUN_ID);

    expect(result).toEqual({ status: "blocked", taskId: "t2", reason: "payload-unbuilt" });
    expect(host.sent).toHaveLength(0);
    const after = await stored();
    expect(after.revision).toBe(before.revision);
    expect(after.budgets.entries.find((entry) => entry.subjectId === "seat-b1")?.reserved).toBe(1);
  });

  test("a scope outside the repository blocks the dispatch before anything is committed", async () => {
    await seed((record) => {
      const t2 = record.tasks.find((task) => task.spec.id === "t2");
      if (t2) t2.spec.scopes[0] = { ...t2.spec.scopes[0], path: ".git/config" } as never;
    });
    const before = await stored();
    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);

    expect(result).toMatchObject({ status: "blocked", taskId: "t2", reason: "scope-rejected" });
    expect(host.sent).toHaveLength(0);
    expect((await stored()).revision).toBe(before.revision);
  });

  test("another Run holding the repository blocks the dispatch even when it also has a t2", async () => {
    await seed();
    // A second Run whose t2 is in progress and holds this repository: the shared normal ledger,
    // whose t2 already has its assignment and claim, with the claim turned into the repo resource.
    // Same task id as ours on purpose.
    const otherId = "run-other0-a1";
    const other = withLedger({
      runId: otherId,
      revision: 1,
      previousDigest: "",
      assignments: assignmentsForRun(otherId),
      nonceRegistry: noncesForRun(otherId),
      resources: [
        claim({ claimId: "claim-other-hot", repoId, kind: "hot", path: REPO_EXCLUSIVE_RESOURCE }),
      ],
    });
    await store.create(other);

    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);
    expect(result).toMatchObject({ status: "blocked", taskId: "t2", reason: "lock-conflict" });
    expect(host.sent).toHaveLength(0);
    expect((await stored()).assignments.some((entry) => entry.taskId === "t2")).toBe(false);
  });

  test("the evidence directory is created outside the repository before the dispatch", async () => {
    await seed();
    const host = fakeHost();
    const result = await makeService(host).dispatchNext(RUN_ID);
    if (result.status !== "dispatched") throw new Error("expected a dispatch");
    const intent = (await stored()).outbox.find(
      (entry) => entry.kind === "dispatch" && entry.taskId === "t2",
    );
    const dir = (intent?.semanticArgs as { evidenceDir?: string } | undefined)?.evidenceDir;
    expect(dir).toBe(`${evidenceRoot}/${result.assignmentId}`);
    // The directory exists, and creating it did not dirty the working tree.
    await expect(stat(dir ?? "")).resolves.toBeTruthy();
    const after = await inspectRepo(repoDir);
    expect(after.ok && after.repo.clean).toBe(true);
  });

  test("an evidence root that is relative or inside the repository blocks the dispatch", async () => {
    // No evidenceRoot override: the fixture's own root is the relative "evidence".
    await store.create(readyRun({ runId: RUN_ID, repoId }));
    const relative = fakeHost();
    expect(await makeService(relative).dispatchNext(RUN_ID)).toEqual({
      status: "blocked",
      taskId: "t2",
      reason: "evidence-root-not-absolute",
    });

    await store.create(
      readyRun({
        runId: "run-inside-a1",
        repoId,
        evidenceRoot: path.join(repoDir, "evidence").replaceAll("\\", "/"),
      }),
    );
    const host = fakeHost();
    expect(await makeService(host).dispatchNext("run-inside-a1")).toEqual({
      status: "blocked",
      taskId: "t2",
      reason: "evidence-root-inside-repo",
    });
    expect(relative.sent).toHaveLength(0);
    expect(host.sent).toHaveLength(0);
  });

  test("with the real producer template the sent prompt carries this assignment's identity", async () => {
    await seed();
    const host = fakeHost();
    const service = makeService(host, { compile: compileDispatch });
    const result = await service.dispatchNext(RUN_ID);
    expect(result).toMatchObject({ status: "dispatched" });

    const record = await stored();
    const assignment = record.assignments.find((entry) => entry.taskId === "t2");
    const text = host.sent[0]?.text ?? "";
    expect(text).toContain(assignment?.nonce);
    expect(text).toContain(assignment?.assignmentId);
    expect(text).toContain(assignment?.workspace?.baseRef);
    const intent = record.outbox.find(
      (entry) => entry.kind === "dispatch" && entry.taskId === "t2",
    );
    // The ledger's hash is the hash of what a fresh compile of the stored record produces.
    expect(intent?.payloadHash).toBe(payloadHash(compileDispatch(intent as never, record) ?? ""));
  });

  test("two concurrent calls mint one assignment and send one message", async () => {
    await seed();
    const host = fakeHost();
    const service = makeService(host);
    const results = await Promise.all([service.dispatchNext(RUN_ID), service.dispatchNext(RUN_ID)]);

    expect(results.filter((entry) => entry.status === "dispatched")).toHaveLength(1);
    expect(host.sent).toHaveLength(1);
    expect((await stored()).assignments.filter((entry) => entry.taskId === "t2")).toHaveLength(1);
  });

  test("a send that fails leaves the intent outcome-unknown, and a later call does not resend", async () => {
    await seed();
    const host = fakeHost({
      send: async () => {
        throw new Error("connection reset");
      },
    });
    const service = makeService(host);
    const result = await service.dispatchNext(RUN_ID);

    expect(result.status).toBe("dispatched");
    const record = await stored();
    const intent = record.outbox.find(
      (entry) => entry.kind === "dispatch" && entry.taskId === "t2",
    );
    expect(intent?.state).toBe("outcome-unknown");
    expect(host.sent).toHaveLength(1);

    // The task is assigned now, so there is nothing ready and nothing more to send.
    expect(await service.dispatchNext(RUN_ID)).toEqual({ status: "idle" });
    expect(host.sent).toHaveLength(1);
  });
});
