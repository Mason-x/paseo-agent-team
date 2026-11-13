import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createEngine } from "./server/engine";
import { type HookRegistry, registerHooks } from "./server/hooks";
import { fromPaseo, type Host, type PaseoPort } from "./server/host";
import { createRpc } from "./server/rpc";
import { createRunStore } from "./server/store";
import {
  projectConfigRpc,
  runArtifactRpc,
  runCloseRpc,
  runGetRpc,
  runListRpc,
  runResolveRpc,
  runStartRpc,
  teamSettings,
} from "./shared/rpc";

const log = (message: string, error?: unknown) =>
  console.error(
    `[agent-team] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`,
  );

export default function contribute(server: PluginServerContext) {
  // Never fall back to ~/.paseo: a development daemon must not write into the real instance.
  const home = process.env.PASEO_HOME;
  if (!home) throw new Error("PASEO_HOME is not set; refusing to pick a data directory");
  const store = createRunStore(path.join(home, "agent-team-v2"), (id, why) =>
    log(`run ${id} skipped`, why),
  );

  // Hooks and RPC handlers receive the Paseo client; the timer has none of its own, so it uses the latest one.
  let host: Host | null = null;
  let started = false;
  const settings = server.registerSettings(teamSettings);
  const engine = createEngine({
    store,
    host: () => host,
    log,
    maxActive: async () => {
      const s = await settings.read();
      return s.status === "ready" ? s.values.maxActiveRuns : 3;
    },
  });
  const onContext = (paseo: PaseoPort) => {
    host = fromPaseo(paseo);
    if (!started) {
      started = true;
      void engine
        .reconcileAll({ sweepFinished: true })
        .catch((e) => log("startup reconcile failed", e));
    }
  };

  const rpc = createRpc(engine);
  const seen = <T>(ctx: { paseo: PaseoPort }, run: () => Promise<T>) => {
    onContext(ctx.paseo);
    return run();
  };
  server.handle(runListRpc, (_input, ctx) => seen(ctx, () => rpc.list()));
  server.handle(runGetRpc, ({ id }, ctx) => seen(ctx, () => rpc.get(id)));
  server.handle(runArtifactRpc, ({ id, file }, ctx) => seen(ctx, () => rpc.artifact(id, file)));
  server.handle(runStartRpc, (input, ctx) => seen(ctx, () => rpc.start(input)));
  server.handle(runResolveRpc, ({ id, choice }, ctx) => seen(ctx, () => rpc.resolve(id, choice)));
  server.handle(runCloseRpc, ({ id, outcome }, ctx) => seen(ctx, () => rpc.close(id, outcome)));
  server.handle(projectConfigRpc, ({ path: dir }) => rpc.projectConfig(dir));

  const stopHooks = registerHooks(server as unknown as HookRegistry, engine, onContext, log);
  engine.startTimer();
  return async () => {
    stopHooks();
    await engine.dispose();
  };
}
