import { describe, expect, test } from "vitest";
import { historyPage, projectDetail } from "../../server/run-engine/projection";
import {
  applyOlder,
  applyRefresh,
  EMPTY_SESSION,
  type EngineSession,
} from "../../shared/domain/run-engine/get-session";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { assignmentsForRun, noncesForRun, withLedger } from "../fixtures/run-engine/base";

const RUN = "run-ses001-a1";

function record(revision: number, events = 120): RunRecord {
  const base = withLedger({
    runId: RUN,
    revision,
    previousDigest: revision === 1 ? "" : `sha256:${"a".repeat(64)}`,
    resources: [],
    assignments: assignmentsForRun(RUN),
    nonceRegistry: noncesForRun(RUN),
  });
  base.events = Array.from({ length: events }, (_, index) => ({
    seq: index + 1,
    kind: "task-report",
    at: "2026-11-05T00:00:00.000Z",
    payload: {},
  }));
  return base;
}

function output(rec: RunRecord, cursor?: string) {
  const detail = projectDetail(rec);
  if (!detail.ok) throw new Error("fixture must project");
  const history = historyPage(rec, cursor);
  return {
    runContractVersion: 1,
    status: "ready",
    run: detail.view,
    history: history.page,
    issues: history.issues,
  };
}
const unchanged = (revision: number) => ({ runContractVersion: 1, status: "unchanged", revision });
const failure = (status: "corrupt" | "missing" | "unknown-version", code: string) => ({
  runContractVersion: 1,
  status,
  run: null,
  issues: [{ code, severity: "error", path: [], params: {}, action: "inspect" }],
});

function loaded(rec: RunRecord): EngineSession {
  return applyRefresh(EMPTY_SESSION, output(rec)).session;
}

describe("applyRefresh", () => {
  test("the first answer becomes the shown state", () => {
    const step = applyRefresh(EMPTY_SESSION, output(record(1)));
    expect(step.needFull).toBe(false);
    expect(step.session.state?.kind).toBe("ready");
  });

  test("unchanged for the held revision keeps the same session object, so nothing flashes empty", () => {
    const session = loaded(record(3));
    const step = applyRefresh(session, unchanged(3));
    expect(step.session).toBe(session);
    expect(step.needFull).toBe(false);
  });

  test("unchanged with nothing held, or for another revision, asks for the full view", () => {
    expect(applyRefresh(EMPTY_SESSION, unchanged(1))).toEqual({
      session: EMPTY_SESSION,
      needFull: true,
    });
    const session = loaded(record(3));
    expect(applyRefresh(session, unchanged(7)).needFull).toBe(true);
    expect(applyRefresh(session, unchanged(7)).session).toBe(session);
  });

  test("a new revision replaces the state and drops older pages that no longer line up", () => {
    const rec = record(2);
    let session = loaded(rec);
    const cursor = historyPage(rec, undefined).page.nextCursor ?? "";
    session = applyOlder(session, output(rec, cursor)).session;
    expect(session.older).toHaveLength(1);

    const same = applyRefresh(session, output(rec));
    expect(same.session.older).toHaveLength(1);

    const moved = applyRefresh(session, output(record(3, 130)));
    expect(moved.session.older).toEqual([]);
    expect(moved.session.state?.kind === "ready" && moved.session.state.run.revision).toBe(3);
  });

  test("an unreadable run replaces the last good view instead of presenting it as current", () => {
    const session = loaded(record(2));
    for (const [status, code, expected] of [
      ["corrupt", "run-corrupt", "corrupt"],
      ["missing", "run-missing", "missing"],
      ["unknown-version", "run-unknown-version", "unknown-version"],
    ] as const) {
      const step = applyRefresh(session, failure(status, code));
      expect(step.session.state).toMatchObject({ kind: "failure", failure: expected });
      expect(step.session.older).toEqual([]);
    }
  });

  test("an answer this build cannot parse asks the user to refresh the plugin, never a fake view", () => {
    const step = applyRefresh(loaded(record(1)), { status: "from-the-future" });
    expect(step.session.state).toEqual({ kind: "refresh-plugin" });
  });
});

describe("applyOlder", () => {
  test("appends pages newest first and walks toward older events", () => {
    const rec = record(2);
    let session = loaded(rec);
    const first = historyPage(rec, undefined).page;
    const second = historyPage(rec, first.nextCursor ?? undefined).page;
    session = applyOlder(session, output(rec, first.nextCursor ?? undefined)).session;
    session = applyOlder(session, output(rec, second.nextCursor ?? undefined)).session;
    expect(session.older.map((page) => page.events[0]?.seq)).toEqual([21, 1]);
  });

  test("an expired cursor restarts at the newest page and discards the loaded older pages", () => {
    const rec = record(2);
    let session = loaded(rec);
    const cursor = historyPage(rec, undefined).page.nextCursor ?? "";
    session = applyOlder(session, output(rec, cursor)).session;
    const compacted = {
      ...rec,
      checkpoint: { ...(rec.checkpoint ?? ({} as never)), throughSeq: 5 },
    };
    const step = applyOlder(session, output(compacted as RunRecord, cursor));
    expect(step.session.older).toEqual([]);
    expect(step.session.state?.kind).toBe("ready");
    expect(step.needFull).toBe(false);
  });

  test("a page for a run that moved while paging asks for the full view and is not appended", () => {
    const rec = record(2);
    const session = loaded(rec);
    const cursor = historyPage(rec, undefined).page.nextCursor ?? "";
    const step = applyOlder(session, output(record(3), cursor));
    expect(step.needFull).toBe(true);
    expect(step.session.older).toEqual([]);
  });

  test("a failed older read keeps what is shown", () => {
    const session = loaded(record(2));
    expect(applyOlder(session, failure("corrupt", "run-corrupt")).session).toBe(session);
    expect(applyOlder(session, { nonsense: true }).session).toBe(session);
  });
});
