import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { AUTO_EVIDENCE_ROOT } from "../../server/run-engine/repo";
import { RUN_ENGINE_ENV } from "../../server/run-engine/runtime";
import {
  LOST_TURN_HINT,
  LOST_TURN_SETTLE_DELAY_MS,
} from "../../shared/domain/run-engine/read-retry";
import { SEAT_CLOSED_ALERT_PREFIX } from "../../shared/domain/run-engine/seat-closed";
import { DEFAULT_ENGINE_LIMITS } from "../../shared/domain/run-engine/team-config-edit";
import {
  RUN_SCHEMA_VERSION,
  RunDevTargetSchema,
  RunPolicySnapshotSchema,
  RunRecordSchema,
} from "../../shared/schemas/run-engine/ledger";
import { RUN_ACTION_CONTROLS } from "../../shared/schemas/run-engine/rpc-actions";
import { runEngineZh } from "../../shared/zh/run-engine";
import { SEAT_DENIAL_ZH } from "../../shared/zh/run-engine-waiting";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const section = readme.slice(
  readme.indexOf("## Run Engine (opt-in)"),
  readme.indexOf("\n## Limits"),
);

/**
 * The README makes a few statements about numbers and names that live in code. They are checked
 * here so a change in the code that the README does not follow fails a test instead of misleading
 * a person who turns the Engine on.
 */
describe("the Run Engine section of the README agrees with the code", () => {
  test("the section exists and sits between Follow progress and Limits", () => {
    expect(section.length).toBeGreaterThan(500);
    expect(readme.indexOf("## Follow progress")).toBeLessThan(readme.indexOf("## Run Engine"));
  });

  test("the daemon switch is the one the runtime reads, and it must be 1", () => {
    expect(RUN_ENGINE_ENV).toBe("PASEO_AGENT_TEAM_RUN_ENGINE");
    expect(section).toContain(`${RUN_ENGINE_ENV}=1`);
  });

  test("the ledger path and the evidence root are the ones the code uses", () => {
    expect(section).toContain("agent-team-runs/v1/runs/<runId>.json");
    expect(section).toContain("agent-team-evidence/<runId>");
    const repo = readFileSync(path.join(ROOT, "server/run-engine/repo.ts"), "utf8");
    expect(repo).toContain("agent-team-evidence/$" + "{runId}");
    const atomic = readFileSync(path.join(ROOT, "server/ledger/atomic-json.ts"), "utf8");
    expect(atomic).toContain('"agent-team-runs", "v1"');
    expect(atomic).toContain('"runs"');
  });

  test("the event capacity it quotes is the schema's", () => {
    const events = RunRecordSchema.shape.events;
    // zod exposes the maximum of an array through its definition.
    const max = (
      events as unknown as { _zod: { def: { checks?: { _zod: { def: { maximum?: number } } }[] } } }
    )._zod.def.checks
      ?.map((check) => check._zod.def.maximum)
      .find((value) => value !== undefined);
    expect(max).toBe(8192);
    expect(section).toContain("8192");
  });

  test("it says the ledger is schema v2 and reads v1 and v2", () => {
    expect(RUN_SCHEMA_VERSION).toBe(2);
    expect(section).toContain("schema v2");
    expect(section).toContain("v1 and v2");
  });

  test("the controls it names are the ones the server ships, under the page's own labels", () => {
    expect([...RUN_ACTION_CONTROLS].sort()).toEqual([
      "budget",
      "cancel",
      "decide",
      "kick",
      "pause",
      "replan",
      "resume",
    ]);
    expect(section).toContain("重新规划");
    expect(section).toContain("重试");
    expect(section).toContain(runEngineZh.controls.kick.button);
    expect(section).toContain(runEngineZh.controls.pause.button);
    expect(section).toContain(runEngineZh.controls.cancelTask.button);
    expect(section).toContain(runEngineZh.controls.cancelRun.submit);
    expect(section).toContain(runEngineZh.controls.budget.title);
    expect(section).toContain(runEngineZh.controls.resume.button);
  });

  test("the advanced fields it shows are written in the shape the schema reads", () => {
    const fence = /```json\n([\s\S]*?)\n```/u.exec(section);
    expect(fence, "the advanced-fields example is missing").not.toBeNull();
    const example = JSON.parse((fence as RegExpExecArray)[1] as string) as {
      runEngine: { policy: { devTargets: unknown[]; evidenceRoot: string } };
    };
    const { devTargets, evidenceRoot } = example.runEngine.policy;
    expect(devTargets.length).toBeGreaterThan(0);
    for (const target of devTargets)
      expect(RunDevTargetSchema.safeParse(target).success).toBe(true);
    expect(Object.keys(RunDevTargetSchema.shape).sort()).toEqual(["home", "host", "serverId"]);
    expect(Object.keys(RunPolicySnapshotSchema.shape)).toEqual(
      expect.arrayContaining(["devTargets", "evidenceRoot"]),
    );
    expect(evidenceRoot).toBe(AUTO_EVIDENCE_ROOT);
    // "at most 16 entries" is the schema's.
    const max = (
      RunPolicySnapshotSchema.shape.devTargets as unknown as {
        _zod: { def: { checks?: { _zod: { def: { maximum?: number } } }[] } };
      }
    )._zod.def.checks
      ?.map((check) => check._zod.def.maximum)
      .find((value) => value !== undefined);
    expect(max).toBe(16);
    expect(section).toContain("at most 16 entries");
    expect(section).toContain("agent-team-teams");
  });

  test("the defaults it quotes for the failed-task and coordinator-turn limits are the editor's", () => {
    expect(DEFAULT_ENGINE_LIMITS.run.failedTasks).toBe(3);
    expect(DEFAULT_ENGINE_LIMITS.run.strategicTurns).toBe(12);
    expect(section).toContain(runEngineZh.teamEditor.numbers.failedTasks.split("（")[0] as string);
    expect(section).toContain(
      runEngineZh.teamEditor.numbers.strategicTurns.split("（")[0] as string,
    );
    expect(section).toContain("3 by default");
    expect(section).toContain("12 by default");
  });

  test("it says what happens when a member is closed or archived mid-turn, and not to archive the coordinator", () => {
    expect(section).toContain("Closing or archiving a member's Agent while a Run is live");
    expect(section).toContain("decision that can only be answered with cancel");
    const closing = section
      .slice(section.indexOf("**Closing or archiving"), section.indexOf("**Advanced fields."))
      .replace(/\s+/gu, " ");
    expect(closing).toMatch(/`archived` receipt gives a cancel-only decision/u);
    expect(closing).toMatch(
      /producer or reviewer.*only a `closed` receipt.*`host-lost`.*retry or cancel/u,
    );
    expect(section).toContain("An archived\nmember's seat takes no more work in this Run");
    expect(section).toContain(
      "a task that needs that seat can only wait or be\ncancelled with the whole Run",
    );
    expect(section).toContain("Do not archive the coordinator while a Run is live");
    expect(section).toContain("archiving it archives the members it created");
    expect(section).toContain("Going back to 0.6.x");
    expect(section).not.toContain("Do not close or archive a member's Agent");
  });

  test("the page labels it points to exist", () => {
    expect(section).toContain("Engine 运行");
    expect(runEngineZh.list.title).toBe("Engine 运行");
    expect(section).toContain("Run 引擎");
    expect(runEngineZh.teamEditor.title).toBe("Run 引擎");
  });

  test("lost-turn guidance agrees on eligibility, recovery, cancellation, and rollback", () => {
    const start = section.indexOf("**Recover and roll back.**");
    expect(start).toBeGreaterThanOrEqual(0);
    const recovery = section.slice(start).replace(/\s+/gu, " ");
    const delaySeconds = LOST_TURN_SETTLE_DELAY_MS / 1000;
    expect(delaySeconds).toBe(30);
    const facts: [string, RegExp][] = [
      ["dispatch missing", /incomplete:dispatch-not-found/u],
      ["kick button", /\*\*立即检查并推进\*\*/u],
      ["delay", new RegExp(`at least ${delaySeconds} seconds`, "u")],
      ["eligible turns", /producer's own task turn or a reviewer's turn/u],
      ["idle seat", /member is idle in Paseo/u],
      ["dispatch is still missing", /dispatch is still not in its history/u],
      ["engine records the lost turn", /Engine records the turn as lost by the host/u],
      ["retry or cancel", /you answer with retry or cancel/u],
      ["producer retry", /Retrying a producer starts a new attempt/u],
      [
        "review retry",
        /Retrying a reviewer closes that review and sends one new review.*budget reservation/u,
      ],
      ["no timer", /Nothing runs by timer/u],
      ["confirm process stopped", /make sure it has stopped before you answer/u],
      ["eligible purposes", /Engine settles only a producer's or reviewer's turn/u],
      ["excluded purposes", /does not settle a smoke tester, a supplement or a re-report/u],
      ["unknown turn", /turn it never saw begin/u],
      [
        "v1 has no warning or retries",
        /There is no such warning for a Run written as v1: it has no record of the re-checks and shows none at all/u,
      ],
      ["v1 documented way out", /this description is the only place its way out is written down/u],
      ["manual OK", /asks only for a reply of OK/u],
      ["cancellation may wait", /cancelling the whole Run keeps waiting/u],
      ["no decision after run cancellation", /no decision is opened/u],
      ["0.6 host-lost decision", /host-lost decision is an ordinary retry-or-cancel decision/u],
      ["lost reply", /\*\*A reply the host lost after it said the turn ended\.\*\*/u],
      ["seat is at rest", /shows it idle or closed with no turn running/u],
      [
        "cancellation accepts absent",
        /cancellation also counts a member the host says it has no Agent for as quiet/u,
      ],
      ["no receipt, release, or send", /no receipt, no release, no message/u],
      ["0.7.0 source-only evidence", /\(not rehearsed; from its source\)/u],
      ["late reply gated", /is never taken in, even if it can be read later/u],
      ["smoke and supplement", /smoke tester or supplement only ever gets `member-lost`/u],
      ["0.7.0 rollback", /Going back to 0\.7\.0/u],
      ["old late reply", /no longer does anything/u],
      [
        "closed read or archive",
        /read of the member says closed now, or when the host archived it after the task was sent \(an `archived` receipt\)/u,
      ],
      ["closed receipt is insufficient", /A `closed` receipt alone does not count/u],
      ["graceful stop writes closed", /writes one for every agent/u],
      [
        "reviewer host-lost",
        /producer's own task turn or a reviewer's turn gets `host-lost` \(retry or cancel\) whatever closed receipts there are/u,
      ],
      [
        "archive cuts host-lost",
        /host-lost decision is cut to cancel only when the member is archived/u,
      ],
      ["smoke and supplement stop", /read says closed now, and no decision otherwise/u],
      ["check archive before retry", /before you retry, make sure the member was not archived/u],
      ["0.7.1 rollback", /Answer such decisions before rolling back to 0\.7\.1/u],
    ];
    for (const [fact, pattern] of facts) expect(recovery, fact).toMatch(pattern);
    expect(recovery).not.toMatch(/when a closed or archived receipt of the member came after the/u);

    const hintFacts: [string, RegExp][] = [
      ["kick control", /立即检查并推进/u],
      ["delay", new RegExp(`至少等 ${delaySeconds} 秒`, "u")],
      ["producer", /成员（生产者）的实现回合/u],
      ["reviewer", /或审查者的评审回合/u],
      ["idle seat", /成员在 Paseo 里空闲/u],
      ["known start", /引擎记录过这一回合的开始/u],
      ["host-lost", /宿主丢失/u],
      ["retry or cancel", /重试或取消/u],
      ["excluded purposes", /冒烟、补证或补报回合不会被引擎结算/u],
      ["unknown turn and manual OK", /引擎没见到回合开始.*更晚的回合记录.*只要求回复 OK 的消息/u],
      ["lost reply", /宿主已经报告这一回合结束、回复却读不到/u],
      ["seat statuses", /成员空闲、已关闭或已归档/u],
      ["closed or archived cancel only", /成员已关闭或归档时只能取消/u],
    ];
    for (const [fact, pattern] of hintFacts) expect(LOST_TURN_HINT, fact).toMatch(pattern);
  });

  test("it describes the closed seat after a restart: the reason, the warning and the way out (T9f)", () => {
    expect(section).toContain("**A host restart leaves members closed.**");
    expect(section).toContain((SEAT_DENIAL_ZH["seat-closed"] as string).split("，")[0] as string);
    expect(section).toContain(SEAT_CLOSED_ALERT_PREFIX);
    expect(section).toContain("It is still a wait:\n  no decision is opened and nothing is sent");
    expect(section).toContain("**立即检查并推进**");
    expect(section).toContain("should not message the member to wake it while the Run is live");
    expect(section).toContain("no rollout found");
    expect(section).toContain("it does not\n  start them");
    // The lost plan reply warning names the button the page really has, and the one way out left.
    expect(section).toContain("write a reason under 控制 and press **请求重新规划**");
    expect(section).toContain(runEngineZh.controls.replan.submit);
    expect(section).toContain("只能取消这个 Run 后重新启动");
    expect(section).not.toContain("请点重新规划");
  });
});
