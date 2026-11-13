import { afterEach, describe, expect, it, vi } from "vitest";
import { type HookRegistry, isOwnToolRequest, registerHooks } from "../../v2/server/hooks";
import { REVIEWER_TOOLS, WRITER_TOOLS } from "../../v2/server/tools";
import { harness } from "./harness";
import { write } from "./repo";

const open: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  while (open.length) {
    const h = open.pop();
    await h?.engine.dispose();
    h?.cleanup();
  }
});

function wire(opts?: Parameters<typeof harness>[0]) {
  const h = harness(opts);
  open.push(h);
  const handlers = new Map<string, (p: unknown, c: unknown) => Promise<unknown>>();
  const registry: HookRegistry = {
    addHook(name, fn) {
      handlers.set(name, fn as never);
      return () => handlers.delete(name);
    },
  };
  const allowed: { agentId: string; requestId: string }[] = [];
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        respondToPermission: async ({ requestId }: { requestId: string }) =>
          void allowed.push({ agentId, requestId }),
      }),
    },
  };
  const log = vi.fn();
  const onContext = vi.fn();
  const stop = registerHooks(registry, h.engine, onContext, log);
  const fire = (name: string, payload: unknown) =>
    handlers.get(name)?.(payload, { paseo }) as Promise<never>;
  return { h, handlers, allowed, fire, log, onContext, stop };
}

describe("isOwnToolRequest (Spec 3.3)", () => {
  it("accepts the Claude form and the Codex elicitation form for the plugin's own tools only", () => {
    expect(isOwnToolRequest(WRITER_TOOLS, { id: "1", name: "mcp__paseo__team_submit" })).toBe(true);
    expect(isOwnToolRequest(WRITER_TOOLS, { id: "1", name: "mcp__other__team_submit" })).toBe(
      false,
    );
    expect(isOwnToolRequest(WRITER_TOOLS, { id: "1", name: "mcp__paseo__team_verdict" })).toBe(
      false,
    );
    expect(isOwnToolRequest(WRITER_TOOLS, { id: "1", name: "mcp__paseo__create_agent" })).toBe(
      false,
    );
    const codex = (server: string, tool: string) => ({
      id: "1",
      name: "CodexMcpElicitation",
      metadata: { serverName: server },
      description: `Allow the ${server} MCP server to run tool "${tool}"?`,
    });
    expect(isOwnToolRequest(REVIEWER_TOOLS, codex("paseo", "team_verdict"))).toBe(true);
    expect(isOwnToolRequest(REVIEWER_TOOLS, codex("other", "team_verdict"))).toBe(false);
    expect(isOwnToolRequest(REVIEWER_TOOLS, codex("paseo", "create_agent"))).toBe(false);
    expect(
      isOwnToolRequest(REVIEWER_TOOLS, {
        id: "1",
        name: "CodexMcpElicitation",
        metadata: { serverName: "paseo" },
      }),
    ).toBe(false);
  });
});

describe("agent.open.before", () => {
  it("attaches the writer tools and the expanded env to a labelled writer", async () => {
    const { h, fire } = wire();
    const run = await h.start({ env: { DB: "app_{runId}_{seat}" } });
    const req = {
      agentId: run.writer.agentId,
      labels: { "agent-team.run": run.id, "agent-team.role": "writer" },
      tools: [],
      env: { KEEP: "1" },
    };
    const out = (await fire("agent.open.before", { request: req })) as {
      tools: { name: string }[];
      env: Record<string, string>;
    };
    expect(out.tools.map((t) => t.name)).toEqual(["team_submit", "team_block"]);
    expect(out.env).toEqual({ KEEP: "1", DB: `app_${run.id}_writer` });
  });

  it("also accepts the 0.16 shape where the payload is the request itself", async () => {
    const { h, fire } = wire();
    const run = await h.start();
    const req = {
      agentId: "x",
      labels: { "agent-team.run": run.id, "agent-team.role": "writer" },
      tools: [],
      env: {},
    };
    const out = (await fire("agent.open.before", req)) as { tools: unknown[] };
    expect(out.tools).toHaveLength(2);
  });

  it("gives a reviewer only team_verdict, with its own seat in the env", async () => {
    const { h, fire } = wire();
    const run = await h.start({ env: { DB: "app_{runId}_{seat}" } });
    const labels = {
      "agent-team.run": run.id,
      "agent-team.role": "reviewer",
      "agent-team.seat": "r2",
      "agent-team.round": "1",
    };
    const out = (await fire("agent.open.before", {
      request: { agentId: "x", labels, tools: [], env: {} },
    })) as {
      tools: { name: string }[];
      env: Record<string, string>;
    };
    expect(out.tools.map((t) => t.name)).toEqual(["team_verdict"]);
    expect(out.env.DB).toBe(`app_${run.id}_r2`);
  });

  it("leaves agents without team labels, or of unknown Runs, alone", async () => {
    const { fire } = wire();
    expect(
      await fire("agent.open.before", {
        request: { agentId: "x", labels: {}, tools: [], env: {} },
      }),
    ).toBeUndefined();
    const labels = { "agent-team.run": "r-20261112-ffff", "agent-team.role": "writer" };
    expect(
      await fire("agent.open.before", { request: { agentId: "x", labels, tools: [], env: {} } }),
    ).toBeUndefined();
  });

  it("never throws into the host: failures are logged and the agent opens without tools", async () => {
    const { h, fire, log } = wire();
    const run = await h.start();
    h.engine.get = async () => {
      throw new Error("disk gone");
    };
    const labels = { "agent-team.run": run.id, "agent-team.role": "writer" };
    expect(
      await fire("agent.open.before", { request: { agentId: "x", labels, tools: [], env: {} } }),
    ).toBeUndefined();
    expect(log).toHaveBeenCalledWith("hook agent.open.before failed", expect.any(Error));
  });
});

describe("agent.permission.before", () => {
  it("auto-allows the writer's own tools and nothing else", async () => {
    const { h, fire, allowed } = wire();
    const run = await h.start();
    const id = run.writer.agentId;
    await fire("agent.permission.before", {
      agent: { id },
      request: { id: "p1", name: "mcp__paseo__team_submit" },
    });
    await fire("agent.permission.before", {
      agent: { id },
      request: { id: "p2", name: "mcp__paseo__team_verdict" },
    });
    await fire("agent.permission.before", { agent: { id }, request: { id: "p3", name: "Bash" } });
    await fire("agent.permission.before", {
      agent: { id: "stranger" },
      request: { id: "p4", name: "mcp__paseo__team_submit" },
    });
    expect(allowed).toEqual([{ agentId: id, requestId: "p1" }]);
  });

  it("allows a reviewer's team_verdict through the Codex form", async () => {
    const { h, fire, allowed } = wire();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    await fire("agent.permission.before", {
      agent: { id: rv?.reviewer.agentId },
      request: {
        id: "p9",
        name: "CodexMcpElicitation",
        metadata: { serverName: "paseo" },
        description: 'Allow the paseo MCP server to run tool "team_verdict"?',
      },
    });
    expect(allowed).toEqual([{ agentId: rv?.reviewer.agentId, requestId: "p9" }]);
  });
});

describe("agent.turn.after and agent.archive.after", () => {
  it("drives the writer nudge and block from turn ends, and hands the Paseo client to the engine", async () => {
    const { h, fire, onContext } = wire();
    const run = await h.start();
    const agent = { id: run.writer.agentId };
    await fire("agent.turn.after", { agent, outcome: { kind: "canceled" } });
    expect((await h.get(run.id)).nudges).toBe(0);
    await fire("agent.turn.after", { agent, outcome: { kind: "completed" } });
    expect((await h.get(run.id)).nudges).toBe(1);
    await fire("agent.turn.after", { agent, outcome: { kind: "completed" } });
    expect(await h.get(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "writer-stopped-without-submit",
    });
    expect(onContext).toHaveBeenCalled();
  });

  it("a failed writer turn blocks with the error message", async () => {
    const { h, fire } = wire();
    const run = await h.start();
    await fire("agent.turn.after", {
      agent: { id: run.writer.agentId },
      outcome: { kind: "failed", error: { message: "provider down" } },
    });
    expect(await h.get(run.id)).toMatchObject({
      state: "blocked",
      blockedReason: "agent-failed",
      blockedNote: "provider down",
    });
  });

  it("a turn that ended after team_submit changes nothing", async () => {
    const { h, fire } = wire();
    const run = await h.start();
    await h.submit(run);
    await fire("agent.turn.after", {
      agent: { id: run.writer.agentId },
      outcome: { kind: "completed" },
    });
    await h.engine.idle();
    expect((await h.get(run.id)).state).toBe("reviewing");
  });

  it("ignores agents that belong to no Run", async () => {
    const { fire } = wire();
    expect(
      await fire("agent.turn.after", { agent: { id: "nobody" }, outcome: { kind: "completed" } }),
    ).toBeUndefined();
  });

  it("a reviewer turn end without a verdict is reminded once", async () => {
    const { h, fire } = wire();
    const run = await h.start();
    const r = await h.toReviewing(run);
    const rv = r.reviews[0];
    await fire("agent.turn.after", {
      agent: { id: rv?.reviewer.agentId },
      outcome: { kind: "completed" },
    });
    await h.engine.idle();
    expect(h.host.reviewerAgents()[0]?.sent[0]).toContain("team_verdict");
  });

  it("archiving the writer triggers a reconcile that blocks the Run", async () => {
    const { h, fire } = wire();
    const run = await h.start();
    const writer = h.host.writerAgent();
    if (writer) writer.archived = true;
    await fire("agent.archive.after", { agent: { id: run.writer.agentId } });
    expect(await h.get(run.id)).toMatchObject({ state: "blocked", blockedReason: "agent-failed" });
  });

  it("the returned function unregisters every hook", () => {
    const { handlers, stop } = wire();
    expect(handlers.size).toBe(4);
    stop();
    expect(handlers.size).toBe(0);
  });
});

it("write helper stays used", () => {
  expect(typeof write).toBe("function");
});
