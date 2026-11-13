import type { Run, Seat } from "../shared/run";
import type { Engine } from "./engine";
import { fromPaseo, type PaseoPort } from "./host";
import { createTools, REVIEWER_TOOLS, WRITER_TOOLS } from "./tools";

/** The part of `PluginServerContext` this module uses. Payload shapes differ a little between SDK versions. */
export type HookRegistry = {
  // biome-ignore lint/suspicious/noExplicitAny: payloads are narrowed per hook below
  addHook(name: string, handler: (payload: any, ctx: { paseo: PaseoPort }) => unknown): () => void;
};

type Outcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string } }
  | { kind: "canceled" };
type PermissionRequest = {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
};
type OpenRequest = {
  agentId: string;
  labels: Readonly<Record<string, string>>;
  tools: unknown[];
  env: Record<string, string>;
};

/**
 * Whether a permission request is for one of the plugin's own tools of this role (Spec 3.3).
 * Claude names the tool in `name`; Codex sends CodexMcpElicitation and names it in `description`.
 * Anything else, including a same-named tool from another MCP server, is left to the human.
 */
export function isOwnToolRequest(allowed: string[], req: PermissionRequest): boolean {
  if (allowed.some((t) => req.name === `mcp__paseo__${t}`)) return true;
  if (req.name === "CodexMcpElicitation" && req.metadata?.serverName === "paseo") {
    const tool = /tool "([a-z_]+)"/.exec(req.description ?? "")?.[1];
    return tool !== undefined && allowed.includes(tool);
  }
  return false;
}

export const expandEnv = (run: Run, seat: Seat | "writer") =>
  Object.fromEntries(
    Object.entries(run.task.env).map(([k, v]) => [
      k,
      v.replaceAll("{runId}", run.id).replaceAll("{seat}", seat),
    ]),
  );

export function registerHooks(
  registry: HookRegistry,
  engine: Engine,
  onContext: (paseo: PaseoPort) => void,
  log: (message: string, error?: unknown) => void = () => undefined,
): () => void {
  const safe =
    <P, C extends { paseo: PaseoPort }>(
      name: string,
      fn: (payload: P, ctx: C) => Promise<unknown>,
    ) =>
    async (payload: P, ctx: C) => {
      onContext(ctx.paseo);
      try {
        return await fn(payload, ctx);
      } catch (e) {
        log(`hook ${name} failed`, e);
        return undefined;
      }
    };

  return [
    registry.addHook(
      "agent.open.before",
      safe(
        "agent.open.before",
        async (payload: { request?: OpenRequest } & Partial<OpenRequest>) => {
          const req = (payload.request ?? payload) as OpenRequest;
          const role = req.labels["agent-team.role"];
          const runId = req.labels["agent-team.run"];
          if (!runId || (role !== "writer" && role !== "reviewer")) return undefined;
          const run = await engine.get(runId);
          if (!run) return undefined;
          const seat = (role === "writer" ? "writer" : req.labels["agent-team.seat"]) as
            | Seat
            | "writer";
          const round = Number(req.labels["agent-team.round"]);
          const tools = createTools(engine, {
            runId,
            role,
            seat: seat === "writer" ? undefined : seat,
            round: Number.isFinite(round) ? round : undefined,
          });
          return {
            ...req,
            tools: [...req.tools, ...tools],
            env: { ...req.env, ...expandEnv(run, seat) },
          };
        },
      ),
    ),

    registry.addHook(
      "agent.turn.after",
      safe(
        "agent.turn.after",
        async ({ agent, outcome }: { agent: { id: string }; outcome: Outcome }) => {
          if (outcome.kind === "canceled") return; // a human or our own interrupt; reconcile covers real stalls
          const found = await engine.findByAgent(agent.id);
          if (!found) return;
          const failed = outcome.kind === "failed" ? outcome.error.message : undefined;
          if (found.role === "writer") {
            await engine.dispatch(found.run.id, { kind: "writer-turn-ended", failed });
          } else {
            await engine.dispatch(found.run.id, {
              kind: "reviewer-turn-ended",
              reviewId: found.review.id,
              failed,
            });
          }
        },
      ),
    ),

    registry.addHook(
      "agent.permission.before",
      safe(
        "agent.permission.before",
        async (
          { agent, request }: { agent: { id: string }; request: PermissionRequest },
          { paseo },
        ) => {
          const found = await engine.findByAgent(agent.id);
          if (!found) return;
          const allowed = found.role === "writer" ? WRITER_TOOLS : REVIEWER_TOOLS;
          if (!isOwnToolRequest(allowed, request)) return; // left for the human; the panel shows it
          await fromPaseo(paseo).respondToPermission(agent.id, request.id);
        },
      ),
    ),

    registry.addHook(
      "agent.archive.after",
      safe("agent.archive.after", async ({ agent }: { agent: { id: string } }) => {
        const found = await engine.findByAgent(agent.id);
        if (found) await engine.reconcile(found.run.id);
      }),
    ),
  ].reduce(
    (all, stop) => () => {
      all();
      stop();
    },
    () => undefined,
  );
}
