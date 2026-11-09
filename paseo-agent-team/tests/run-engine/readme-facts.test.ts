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
import { DEFAULT_ENGINE_LIMITS } from "../../shared/domain/run-engine/team-config-edit";
import {
  RUN_SCHEMA_VERSION,
  RunDevTargetSchema,
  RunPolicySnapshotSchema,
  RunRecordSchema,
} from "../../shared/schemas/run-engine/ledger";
import { RUN_ACTION_CONTROLS } from "../../shared/schemas/run-engine/rpc-actions";
import { runEngineZh } from "../../shared/zh/run-engine";

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

  test("what happens to a turn the host lost is told in the README and in the alert the same way, with the number the code uses", () => {
    expect(section).toContain("incomplete:dispatch-not-found");
    // The wait before the Engine settles it: the README names the number the code has.
    expect(LOST_TURN_SETTLE_DELAY_MS).toBe(30_000);
    expect(section).toContain(`at least ${LOST_TURN_SETTLE_DELAY_MS / 1000} seconds`);
    for (const word of [
      "立即检查并推进",
      `至少等 ${LOST_TURN_SETTLE_DELAY_MS / 1000} 秒`,
      "如果这是成员（生产者）的实现回合",
      "且该成员在 Paseo 里空闲",
      "引擎记录过这一回合的开始",
      "引擎没见到回合开始",
      "宿主丢失",
      "重试或取消",
      "判官、冒烟、补证或补报回合不会被引擎结算",
      "只要求回复 OK 的消息",
    ]) {
      expect(LOST_TURN_HINT).toContain(word);
    }
    // The way out applies to a turn the Engine never saw begin, not only to the other purposes.
    expect(LOST_TURN_HINT).toContain(
      "引擎没见到回合开始、或该成员之后又有更晚的回合记录的回合，也不会被结算，请向该成员发一条只要求回复 OK 的消息",
    );
    // T9b: the host said the turn ended and the reply cannot be read; the member may be idle, closed or archived.
    for (const word of [
      "如果宿主已经报告这一回合结束、回复却读不到",
      "成员空闲、已关闭或已归档",
      "成员已关闭或归档时只能取消",
    ]) {
      expect(LOST_TURN_HINT).toContain(word);
    }
    expect(section).toContain("**立即检查并推进**");
    expect(section).toContain("the Engine records the turn as lost by the host");
    expect(section).toContain("`host-lost`");
    expect(section).toContain("you answer with retry or cancel");
    expect(section).toContain("Nothing runs by timer");
    expect(section).toContain("make sure it has\n  stopped before you answer");
    // What is not settled, and the way out that stays for it. A v1 Run is not merely left with the
    // warning: it has no re-check record, so it shows no such warning at all.
    expect(section).toContain("a Run written as v1");
    expect(section).toContain(
      "There is no such warning for a Run written as v1: it has no record of the\n  re-checks and shows none at all",
    );
    expect(section).toContain("this description is the only place its way out is written down");
    // The alert and the README say the same: only a producer's own task turn is settled.
    expect(section).toContain("settles only the turn of a producer");
    expect(section).toContain("a judge, a smoke tester, a supplement or a re-report");
    expect(section).toContain("asks only for a reply of OK");
    // A Run cancelled while a settled turn waits is left with no decision nobody can answer.
    expect(section).toContain("no decision is opened");
    expect(section).toContain("cancelling the whole Run keeps waiting");
    expect(section).toContain("a host-lost decision is an ordinary");
    // T9b: the host said the turn ended and then lost the reply.
    expect(section).toContain("**A reply the host lost after it said the turn ended.**");
    expect(section).toContain("idle,\n  closed or archived with no turn running");
    expect(section).toContain("no receipt, no release, no message");
    expect(section).toContain("is never taken in, even if it can be read\n  later");
    expect(section).toContain(
      "A judge, a smoke tester or a supplement only ever gets\n  `member-lost`",
    );
    expect(section).toContain("Going back to 0.7.0");
    expect(section).toContain("no longer does anything");
  });
});
