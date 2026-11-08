import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { AUTO_EVIDENCE_ROOT } from "../../server/run-engine/repo";
import { RUN_ENGINE_ENV } from "../../server/run-engine/runtime";
import { LOST_TURN_HINT } from "../../shared/domain/run-engine/read-retry";
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

  test("it warns not to close or archive a member while a Run is live", () => {
    expect(section).toContain("Do not close or archive a member's Agent while a Run is live");
  });

  test("the page labels it points to exist", () => {
    expect(section).toContain("Engine 运行");
    expect(runEngineZh.list.title).toBe("Engine 运行");
    expect(section).toContain("Run 引擎");
    expect(runEngineZh.teamEditor.title).toBe("Run 引擎");
  });

  test("the way out of a turn the host lost is told in the README and in the alert the same way", () => {
    expect(section).toContain("incomplete:dispatch-not-found");
    expect(section).toContain("asks only for a reply\n  of OK");
    for (const word of ["立即检查并推进", "只要求回复 OK", "Paseo 里空闲"]) {
      expect(LOST_TURN_HINT).toContain(word);
    }
    expect(section).toContain("**立即检查并推进**");
    expect(section).toContain("cancelling the whole Run keeps waiting");
  });
});
