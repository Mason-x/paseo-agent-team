import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { Seat } from "../shared/run";
import type { Engine } from "./engine";
import { dirtyFiles, head, writerUntouched } from "./git";
import { saveReport } from "./roles";

export const WRITER_TOOLS = ["team_submit", "team_block"];
export const REVIEWER_TOOLS = ["team_verdict"];

export type ToolCtx = { runId: string; role: "writer" | "reviewer"; seat?: Seat; round?: number };
type Tool = ReturnType<typeof defineAgentTool>;

const ok = (text: string) => ({ text });
const fail = (text: string) => ({ text, isError: true });

/** The tools for one agent. They are bound to the Run and seat from the agent's labels, never from its input. */
export function createTools(engine: Engine, ctx: ToolCtx): Tool[] {
  if (ctx.role === "writer") {
    return [
      defineAgentTool({
        name: "team_submit",
        title: "Submit for review",
        description:
          "Submit your committed work. The working tree must be clean. The plugin runs the acceptance commands and then starts independent reviewers; their results come back as a new message. End your turn after calling this.",
        input: z.object({ summary: z.string().describe("What you changed, in a few sentences") }),
        async execute({ summary }, { agent }) {
          const run = await engine.get(ctx.runId);
          if (!run || run.writer.agentId !== agent.id)
            return fail("这个 Run 不存在，或你不是它的写手。");
          if (run.state !== "writing") return fail(`Run 当前状态是 ${run.state}，现在不能送审。`);
          const [dirty, sha] = await Promise.all([
            dirtyFiles(run.workspace.path),
            head(run.workspace.path),
          ]);
          const res = await engine.dispatch(run.id, { kind: "submit", sha, dirty, summary });
          if (dirty.length)
            return fail(
              `工作区有未提交的改动，先提交再送审：\n${dirty.map((f) => `- ${f}`).join("\n")}`,
            );
          // Only the call that actually started a gate counts; a concurrent second submit registered nothing.
          if (!res?.effects.some((e) => e.t === "run-gate")) {
            return fail(
              `没有登记：Run 现在是 ${res?.run.state}。如果已经有一次送审在进行，等它的结果。`,
            );
          }
          return ok(`已登记提交 ${sha.slice(0, 8)}。门禁结果稍后发给你，现在结束本回合。`);
        },
      }),
      defineAgentTool({
        name: "team_block",
        title: "Ask a human",
        description:
          "Stop and ask the human when you cannot continue. Say why and what you need answered.",
        input: z.object({ reason: z.string(), question: z.string().optional() }),
        async execute({ reason, question }, { agent }) {
          const run = await engine.get(ctx.runId);
          if (!run || run.writer.agentId !== agent.id)
            return fail("这个 Run 不存在，或你不是它的写手。");
          const res = await engine.dispatch(run.id, {
            kind: "block",
            question: question ? `${reason}\n问题：${question}` : reason,
          });
          if (res?.run.state !== "blocked") return fail(`Run 当前状态是 ${run.state}，不能求助。`);
          return ok("已通知人。现在结束本回合，等人回答后会收到新消息。");
        },
      }),
    ];
  }

  return [
    defineAgentTool({
      name: "team_verdict",
      title: "Give the review verdict",
      description:
        "Give your verdict after writing your report to the assigned path. approve requires blocking = 0. request-changes requires at least one blocking finding.",
      input: z.object({
        verdict: z.enum(["approve", "request-changes"]),
        blocking: z.number().int().min(0).describe("Number of blocking findings in your report"),
        reportFile: z.string().describe("The report path you were assigned"),
      }),
      async execute({ verdict, blocking, reportFile }, { agent }) {
        const run = await engine.get(ctx.runId);
        const review = run?.reviews.find(
          (r) =>
            r.seat === ctx.seat &&
            r.round === ctx.round &&
            r.reviewer.agentId === agent.id &&
            !r.void,
        );
        if (!run || !review) return fail("找不到分配给你的审查，可能这一轮已经作废。");
        if (run.state !== "reviewing") return fail(`Run 当前状态是 ${run.state}，不在审查中。`);
        if (review.verdict) return fail("你已经给过结论了。");
        if (verdict === "approve" && blocking !== 0) return fail("approve 时 blocking 必须为 0。");
        if (verdict === "request-changes" && blocking < 1) {
          return fail("request-changes 至少要有一条阻断意见；没有阻断项请用 approve。");
        }
        if (reportFile !== review.reportFile)
          return fail(`reportFile 必须是分配给你的路径：${review.reportFile}`);
        try {
          await saveReport(run, review, engine.store.archiveDir(run.id));
        } catch (e) {
          return fail(`${e instanceof Error ? e.message : String(e)}。先写好报告再调用。`);
        }
        const writerOk = (
          await writerUntouched(run.workspace.path, run.workspace.branch, review.sha)
        ).ok;
        const res = await engine.dispatch(run.id, {
          kind: "verdict",
          reviewId: review.id,
          verdict,
          blocking,
          writerOk,
        });
        const mine = res?.run.reviews.find((r) => r.id === review.id);
        if (mine?.void)
          return ok(
            "本轮审查已作废（写手的工作区在审查期间变动了），不需要你再做什么。现在结束本回合。",
          );
        if (!mine?.verdict) return fail("结论没有被记录，这一轮可能已经结束。");
        return ok("结论已记录。你的工作区会被删除，现在结束本回合。");
      },
    }),
  ];
}
