// M1a probe: observes the Paseo 0.15.x behaviours listed in docs/v2/spec.md 3.3. Not product code.
import { appendFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";

// Daemon env is inherited by the plugin process. PROBE_DIR holds out.jsonl and the trigger file run.json.
const DIR = process.env.PROBE_DIR ?? "/tmp/paseo-team-probe";
const OUT = `${DIR}/out.jsonl`;
const log = (ev: string, data: Record<string, unknown> = {}) =>
  appendFileSync(OUT, `${JSON.stringify({ t: new Date().toISOString(), ev, ...data })}\n`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

const ping = defineAgentTool({
  name: "team_probe_ping",
  description: "Probe tool. Call it once with a short note, then report the exact tool name you saw.",
  input: z.object({ note: z.string() }),
  execute: async (input, { agent }) => {
    log("tool.called", { input, agentId: agent.id, provider: agent.provider });
    return { text: "pong from plugin process" };
  },
});

type Cfg = { repo: string; sha: string; tag: string; mode?: "setup"; failSha?: string };

// Point 3/4/5: create worktrees from a commit hash, time setup, create a background workspace.
async function runWorkspaceProbes(paseo: PaseoApi, cfg: Cfg) {
  const made: string[] = [];
  const attempt = async (name: string, background: boolean, base: string) => {
    const t0 = Date.now();
    try {
      const ws = await paseo.workspaces.create({
        background,
        source: {
          kind: "worktree",
          cwd: cfg.repo,
          action: "branch-off",
          baseBranch: base,
          branchName: `probe/${cfg.tag}-${name}`,
        },
      });
      made.push(ws.id);
      let metadata = "ok";
      try {
        const set = (ws as unknown as { setMetadata?: (m: object) => Promise<void> }).setMetadata;
        if (typeof set !== "function") throw new Error("workspace handle has no setMetadata");
        await set.call(ws, { "agent-team.probe": { name } });
      } catch (e) {
        metadata = msg(e);
      }
      const dir = ws.directory;
      log("ws.created", {
        name,
        base,
        ms: Date.now() - t0,
        id: ws.id,
        dir,
        head: dir ? git(dir, "rev-parse", "HEAD") : null,
        branch: dir ? git(dir, "rev-parse", "--abbrev-ref", "HEAD") : null,
        setMetadata: metadata,
        setupMarker: dir ? existsSync(`${dir}/.setup-done`) : null,
      });
    } catch (e) {
      log("ws.failed", { name, base, ms: Date.now() - t0, error: msg(e) });
    }
  };
  await attempt("by-sha", false, cfg.sha);
  await attempt("by-sha-bg", true, cfg.sha);
  await attempt("by-branch", false, git(cfg.repo, "rev-parse", "--abbrev-ref", "HEAD"));
  for (const includeBackground of [false, true]) {
    try {
      const l = await paseo.workspaces.list({ includeBackground });
      const mine = l.entries.filter((w) => made.includes(w.id));
      log("ws.list", { includeBackground, visible: mine.map((w) => w.id), made });
    } catch (e) {
      log("ws.list.failed", { includeBackground, error: msg(e) });
    }
  }
  for (const id of made) {
    try {
      await paseo.workspaces.archive(id);
      log("ws.archived", { id });
    } catch (e) {
      log("ws.archive.failed", { id, error: msg(e) });
    }
  }
}

// Point 4: how does a caller learn that setup finished? Poll the descriptor and the marker file.
async function runSetupProbe(paseo: PaseoApi, cfg: Cfg) {
  for (const [name, base] of [["ok", cfg.sha], ["fail", cfg.failSha ?? cfg.sha]] as const) {
    const t0 = Date.now();
    const ws = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: cfg.repo, action: "branch-off", baseBranch: base, branchName: `probe/${cfg.tag}-setup-${name}` },
    });
    log("setup.created", { name, ms: Date.now() - t0, id: ws.id });
    let last = "";
    while (Date.now() - t0 < 40_000) {
      const w = (await paseo.workspaces.list()).entries.find((e) => e.id === ws.id);
      const marker = ws.directory ? existsSync(`${ws.directory}/.setup-done`) : null;
      const cur = `${(w as { setupStatus?: string } | undefined)?.setupStatus ?? "none"}|marker=${marker}`;
      if (cur !== last) log("setup.state", { name, ms: Date.now() - t0, state: cur });
      last = cur;
      if (/^(completed|failed|blocked)/.test(cur)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await paseo.workspaces.archive(ws.id);
  }
}

export default function contribute(server: PluginServerContext) {
  const stops = [
    server.addHook("agent.open.before", async ({ request: req }) => {
      log("open.before", {
        agentId: req.agentId,
        provider: req.provider,
        reason: req.reason,
        purpose: req.purpose,
        labels: req.labels,
        toolsBefore: req.tools.length,
        mcpServers: Object.keys(req.mcpServers ?? {}),
      });
      // Attach only to agents carrying the role label, the way the product will.
      if (!req.labels["agent-team.role"]) return;
      return { ...req, tools: [...req.tools, ping], env: { ...req.env, PROBE_ENV: "1" } };
    }),
    // Point: can the plugin auto-approve its own team_* tools so default-mode agents do not stall?
    server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
      // Claude names the tool in `name`; Codex sends CodexMcpElicitation and names it in `description`.
      const codex = request.metadata?.serverName === "paseo" && /tool "team_[a-z_]+"/.test(request.description ?? "");
      const mine = /(^|__)team_[a-z_]+$/.test(request.name) || codex;
      log("permission.before", { agentId: agent.id, name: request.name, kind: request.kind, mine, request: JSON.stringify(request).slice(0, 1500) });
      if (!mine) return;
      try {
        await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
        log("permission.allowed", { agentId: agent.id, id: request.id });
      } catch (e) {
        log("permission.allow.failed", { agentId: agent.id, error: msg(e) });
      }
    }),
    server.addHook("agent.turn.after", async ({ agent, outcome, turnId }) =>
      log("turn.after", { agentId: agent.id, turnId, outcome: outcome.kind }),
    ),
    // Trigger: any new workspace fires this once; the first one consumes run.json.
    server.addHook("workspace.create.after", async (_e, { paseo }) => {
      const trigger = `${DIR}/run.json`;
      if (!existsSync(trigger)) return;
      const cfg = JSON.parse(readFileSync(trigger, "utf8")) as Cfg;
      renameSync(trigger, `${trigger}.consumed`);
      log("probe.start", { cfg });
      await (cfg.mode === "setup" ? runSetupProbe(paseo, cfg) : runWorkspaceProbes(paseo, cfg)).catch((e) => log("probe.failed", { error: msg(e) }));
      log("probe.done");
    }),
  ];
  log("plugin.loaded", { pid: process.pid });
  return () => {
    for (const stop of stops) stop();
  };
}
