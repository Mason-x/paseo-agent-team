import path from "node:path";
import { compileEngineIntent } from "../../shared/domain/run-engine/engine-prompts";
import { compileDispatch } from "../../shared/domain/run-engine/prompt-template";
import { readLaunchWorkspace, readSeatProfiles } from "../../shared/domain/run-engine/run-record";
import type { PaseoAdapter } from "../../shared/paseo/adapter";
import type { PaseoEnginePort, PaseoPort } from "../../shared/paseo/port";
import type { RunRecord } from "../../shared/schemas/run-engine/ledger";
import { type FilesPort, nodeFiles } from "../version/process";
import { readServerId } from "../version/service";
import { createCancelFinisher } from "./cancel";
import { createCompactor } from "./compact";
import { createRunControl } from "./control";
import { createDagIntake } from "./dag";
import { createEngineDriver, type EngineDriver } from "./driver";
import { createEffects } from "./effects";
import { createObserverHost } from "./host";
import { createIntake } from "./intake";
import { createMemberLostSettler } from "./member-lost";
import { createRunObserver, type ObserverHookEvent } from "./observer";
import { createReadRetry } from "./read-retry";
import { type CommitIdentity, commitIdentity } from "./repo";
import { createEngineService, type SeatSource } from "./service";
import {
  type EngineStartInput,
  type EngineStartResult,
  failInterruptedLaunches,
  startEngineRun,
} from "./start";
import type { RunStore } from "./store";

/**
 * The Run Engine's production wiring: one object that owns the observer, executor, service, intake,
 * DAG intake and driver, and the two things only the plugin entry knows (when a Paseo handle first
 * exists, and whether this daemon may start Engine Runs at all).
 *
 * The Paseo handle exists only inside an RPC or hook context, so everything is built against a
 * port that is bound the first time one is seen (like the designer's adapter). Until then a call
 * that needs the host throws and the callers' own guards turn that into a logged, skipped step.
 */

/** Engine Runs start only on a daemon that sets this to `1` (the DEV daemon), never by default. */
export const RUN_ENGINE_ENV = "PASEO_AGENT_TEAM_RUN_ENGINE";

export type EngineIdentity =
  | { ok: true; serverId: string; paseoHome: string }
  | { ok: false; reason: string };

/** What the launch service needs from the Engine; absent means "this build starts no Engine Run". */
export type EngineLaunchHost = {
  /** The `PASEO_AGENT_TEAM_RUN_ENGINE=1` switch. Enabled Teams are blocked while it is false. */
  supported: boolean;
  /** Where the ledger lives and which daemon it is bound to; unreadable means no Engine start. */
  identity(): Promise<EngineIdentity>;
  /** Whether git can name a committer in `directory` (members cannot commit without it). */
  commitIdentity(directory: string): Promise<CommitIdentity>;
  start(
    input: Omit<EngineStartInput, "serverId" | "paseoHome">,
    paseo: PaseoPort,
    adapter: Pick<PaseoAdapter, "createAgent" | "archiveAgent">,
  ): Promise<EngineStartResult>;
};

export type EngineRuntimeOptions = {
  store: RunStore;
  /** Initializes the ledger on demand; resolves with `store.ready` possibly still false. */
  ensureReady(): Promise<void>;
  env?: NodeJS.ProcessEnv;
  files?: FilesPort;
  /** Overrides the git committer check; tests use it so they do not depend on the machine's git config. */
  commitIdentity?: (directory: string) => Promise<CommitIdentity>;
  log?: (message: string, detail?: unknown) => void;
};

/** A roster seat's frozen Profile as the scheduler wants it. The coordinator is never a candidate. */
export function seatSourceOf(record: RunRecord, seatId: string): SeatSource | null {
  const profile = readSeatProfiles(record).get(seatId);
  if (!profile) return null;
  return {
    profile: {
      id: profile.profileId,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      family: profile.family,
    },
    // The Profile was usable when the Run started; the ledger's channel state and the live agent
    // snapshot decide the rest, so the host's Profile list is never read again.
    available: true,
    order: record.roster.findIndex((seat) => seat.seatId === seatId),
  };
}

export function createEngineRuntime(options: EngineRuntimeOptions) {
  const env = options.env ?? process.env;
  const files = options.files ?? nodeFiles();
  const log = options.log ?? (() => undefined);
  const { store } = options;
  const supported = env[RUN_ENGINE_ENV] === "1";

  let bound: PaseoEnginePort | null = null;
  const port: PaseoEnginePort = {
    agents: {
      ref(agentId) {
        if (!bound) throw new Error("the Run Engine has no Paseo handle yet");
        return bound.agents.ref(agentId);
      },
    },
  };

  // Reads a host that failed to answer again a few times. It is defined before what reads, because
  // they report to it; the timer behind it is created below.
  const onReadFailure = (runId: string, failure: Parameters<typeof readRetry.note>[1]) =>
    readRetry.note(runId, failure);
  const observer = createRunObserver({ store, log, onReadFailure });
  const host = createObserverHost(port);
  // Reads a host that failed to answer again a few times and says what came of it. It holds two
  // functions that read and nothing that sends, settles or dispatches.
  const readRetry = createReadRetry({
    store,
    readReply: (agentId, messageId) => host.replyWindow(agentId, messageId),
    readSeat: async (agentId) => {
      const refreshed = await port.agents.ref(agentId).refresh();
      if (!refreshed?.agent) throw new Error("the host returned no agent state");
    },
    // A read that works again moves the Run on, as a person's kick would.
    // Not waited for: the timer must not stand still while the Run is pushed on.
    onRecovered: (runId) => {
      driver
        .retryRun(runId, { afterWrite: true })
        .catch((error: unknown) => log(`could not push ${runId} on after a read recovered`, error));
    },
    log,
  });
  // Reconcile has no hook behind it, so it must not call a turn that is still running finished.
  const reconcileHost = createObserverHost(port, { requireIdle: true });
  const resolveWorkspace = (record: RunRecord) => {
    const workspace = readLaunchWorkspace(record);
    return workspace ? { workspaceId: workspace.id, directory: workspace.directory } : null;
  };
  const effects = createEffects({
    store,
    port,
    compile: compileEngineIntent,
    resolveWorkspace,
    onReadFailure,
    log,
  });
  const service = createEngineService({
    store,
    port,
    effects,
    resolveSeat: seatSourceOf,
    resolveWorkspace,
    compile: compileDispatch,
    onReadFailure,
    log,
  });
  const intake = createIntake({
    store,
    observer,
    host,
    repair: { send: (runId) => effects.runOutbox(runId) },
    onReadFailure,
    log,
  });
  const dagIntake = createDagIntake({
    store,
    host,
    seatFamily: (record, seatId) => readSeatProfiles(record).get(seatId)?.family ?? null,
    resolveWorkspace,
    repair: { send: (runId) => effects.runOutbox(runId) },
    log,
  });
  // What the host says an agent is doing now; null when it has no such agent. Read only.
  const readLiveSeat = async (agentId: string) => {
    const refreshed = await port.agents.ref(agentId).refresh();
    return refreshed?.agent
      ? { status: refreshed.agent.status, activeTurn: refreshed.agent.activeTurn != null }
      : null;
  };
  const driver: EngineDriver = createEngineDriver({
    store,
    observer,
    host,
    reconcileHost,
    intake,
    dagIntake,
    service,
    outbox: { run: (runId) => effects.runOutbox(runId) },
    onPassed: (runId) => readRetry.sweep(runId),
    compactor: createCompactor({ store, log }),
    memberLost: createMemberLostSettler({ store, readSeat: readLiveSeat, onReadFailure, log }),
    cancelFinisher: createCancelFinisher({ store, readSeat: readLiveSeat, onReadFailure, log }),
    log,
  });
  const control = createRunControl({
    store,
    ensureReady: options.ensureReady,
    driver,
    log,
  });

  async function readIdentity(): Promise<EngineIdentity> {
    const home = env.PASEO_HOME;
    if (!home || !path.isAbsolute(home)) return { ok: false, reason: "home-unavailable" };
    await options.ensureReady();
    if (!store.ready) return { ok: false, reason: "ledger-unavailable" };
    const serverId = await readServerId(files, home).catch(() => null);
    if (!serverId) return { ok: false, reason: "server-id-unavailable" };
    return { ok: true, serverId, paseoHome: home };
  }

  /** Counts concurrent starts, so a duplicate finishing cannot expose a launch still in progress. */
  const starting = new Map<string, number>();
  let recovering: Promise<void> | null = null;
  /** One recovery at a time: hooks that ask while it runs share it instead of starting another. */
  function recover(): Promise<void> {
    if (recovering) return recovering;
    const attempt = (async () => {
      await options.ensureReady();
      if (!store.ready) return;
      // A launch that a restart cut off will never go on: close it before anything looks at it.
      const closed = await failInterruptedLaunches({
        store,
        isStarting: (runId) => starting.has(runId),
        log,
      });
      if (closed > 0) log(`run engine closed ${closed} interrupted launch(es)`);
      const { runs } = await driver.recover();
      if (runs > 0) log(`run engine recovered ${runs} live run(s)`);
      // Works out from the ledger which reads are due again, so a restart does not lose them.
      await readRetry.start();
    })()
      .catch((error: unknown) => log("run engine recovery failed", error))
      .finally(() => {
        if (recovering === attempt) recovering = null;
      });
    recovering = attempt;
    return attempt;
  }

  let recoveredOnce = false;
  /**
   * Remembers the host handle the first time one is seen and, then, recovers once: a restart may
   * have lost hooks, and nothing else would look at a Run until the next event for it.
   */
  function bind(paseo: unknown): void {
    if (bound === null) bound = paseo as PaseoEnginePort;
    if (recoveredOnce) return;
    recoveredOnce = true;
    void recover();
  }

  return {
    supported,
    driver,
    observer,
    /** The writing RPCs: `replan`, `decide`, `kick`. They work on any Engine Run in the ledger. */
    control,
    bind,
    recover,
    /** Stops the timer of the read re-checks. Call it before the ledger is closed. */
    dispose: () => readRetry.dispose(),

    /**
     * One host hook, routed through the driver. Hooks that were held until the ledger or an owner
     * existed, and a reconcile the observer asked for, end in a full recovery: delivering a held
     * `turn_ended` records it but settles nothing by itself.
     */
    async onHook(event: ObserverHookEvent, paseo: unknown): Promise<void> {
      bind(paseo);
      await options.ensureReady();
      await driver.onHook(event);
      if (!store.ready) return;
      const flushed = observer.buffered > 0 ? await observer.flush() : null;
      if ((flushed?.delivered ?? 0) > 0 || observer.needsReconcile) await recover();
    },

    launchHost: {
      supported,
      identity: readIdentity,
      commitIdentity: options.commitIdentity ?? commitIdentity,
      async start(input, paseo, adapter): Promise<EngineStartResult> {
        bind(paseo);
        const found = await readIdentity();
        if (!found.ok) {
          return {
            ok: false,
            step: "preflight",
            message: "无法确定 Engine 运行记录的存放位置",
            detail: found.reason,
            archived: false,
            agentIdsKept: [],
          };
        }
        const runId = input.plan.runId;
        starting.set(runId, (starting.get(runId) ?? 0) + 1);
        try {
          return await startEngineRun(
            { store, adapter, effects, commitIdentity: options.commitIdentity, log },
            { ...input, serverId: found.serverId, paseoHome: found.paseoHome },
          );
        } finally {
          const left = (starting.get(runId) ?? 1) - 1;
          if (left === 0) starting.delete(runId);
          else starting.set(runId, left);
        }
      },
    } satisfies EngineLaunchHost,
  };
}

export type EngineRuntime = ReturnType<typeof createEngineRuntime>;
