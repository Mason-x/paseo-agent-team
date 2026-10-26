import { settingsRpc } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONType } from "zod";
import { toJsonValue } from "../../shared/json";
import {
  designMarkSavedRpc,
  designPrepareSaveRpc,
  designSaveFailedRpc,
} from "../../shared/rpc/design";
import type {
  DesignMarkSavedInput,
  DesignMarkSavedOutput,
  DesignPrepareSaveInput,
  DesignPrepareSaveOutput,
  DesignSaveFailedInput,
  DesignSaveFailedOutput,
} from "../../shared/schemas/design";
import { preferencesSettings, rolesSettings, teamsSettings } from "../../shared/settings";
import {
  createDesignSaveGateway,
  type DesignSaveGateway,
  type SettingsReadReply,
  type SettingsWriteReply,
} from "./design-gateway";
import {
  compensateDesign,
  type DesignCompensationOutcome,
  type DesignSaveOutcome,
  type DesignUnknownWrites,
  saveDesign,
} from "./design-save-service";

const rolesReadRpc = settingsRpc(rolesSettings.id).read;
const rolesWriteRpc = settingsRpc(rolesSettings.id).write;
const teamsReadRpc = settingsRpc(teamsSettings.id).read;
const teamsWriteRpc = settingsRpc(teamsSettings.id).write;
const preferencesReadRpc = settingsRpc(preferencesSettings.id).read;

export type UseDesignSaveInput = {
  hostId: string;
  clientId: string;
  onOutcome?: (jobId: string, outcome: DesignSaveOutcome) => void;
  onCleanupOutcome?: (jobId: string, outcome: DesignCompensationOutcome) => void;
};

export type UseDesignSaveResult = {
  /** One save per host/job/result; repeated calls join the in-flight promise. */
  save(jobId: string, resultId: string): Promise<DesignSaveOutcome | null>;
  /** Compensate a canceled partial write; unknown writes block it inside the shared runner. */
  cleanup(jobId: string, resultId: string): Promise<DesignCompensationOutcome | null>;
  /** Abort this job's in-flight save before the user cancels it. */
  abort(jobId: string): void;
  pending: boolean;
  /** Unknown writes block compensation for the same job in this host session. */
  unknownWrites: DesignUnknownWrites;
};

export type DesignSaveHookRpcs = {
  readRoles(input: Record<string, never>): Promise<SettingsReadReply>;
  writeRoles(input: { revision: string; values: JSONType }): Promise<SettingsWriteReply>;
  readTeams(input: Record<string, never>): Promise<SettingsReadReply>;
  writeTeams(input: { revision: string; values: JSONType }): Promise<SettingsWriteReply>;
  readPreferences(input: Record<string, never>): Promise<SettingsReadReply>;
  prepareSave(input: DesignPrepareSaveInput): Promise<DesignPrepareSaveOutput>;
  markSaved(input: DesignMarkSavedInput): Promise<DesignMarkSavedOutput>;
  saveFailed(input: DesignSaveFailedInput): Promise<DesignSaveFailedOutput>;
  reloadRoles(): Promise<void>;
  reloadTeams(): Promise<void>;
};

/**
 * Map the hook's RPC functions onto the save gateway. The write payload is exactly
 * `{revision, values}` with `undefined` removed; reads and reloads keep their own identity.
 */
export function buildDesignSaveGateway(rpcs: DesignSaveHookRpcs): DesignSaveGateway {
  return createDesignSaveGateway({
    readRoles: () => rpcs.readRoles({}),
    readTeams: () => rpcs.readTeams({}),
    readPreferences: () => rpcs.readPreferences({}),
    roles: {
      write: (values, revision) =>
        rpcs.writeRoles({ revision, values: toJsonValue(values) as JSONType }),
      reload: rpcs.reloadRoles,
    },
    teams: {
      write: (values, revision) =>
        rpcs.writeTeams({ revision, values: toJsonValue(values) as JSONType }),
      reload: rpcs.reloadTeams,
    },
    prepareSave: rpcs.prepareSave,
    markSaved: rpcs.markSaved,
    saveFailed: rpcs.saveFailed,
  });
}

/** Abort every run and forget its promise; callers notify after this so no stale entry remains. */
export function clearDesignSaveRuns(
  controllers: Map<string, AbortController>,
  inFlight: Map<string, Promise<DesignSaveOutcome | null>>,
): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  inFlight.clear();
}

export type DesignSaveRunInput = {
  hostId: string;
  jobId: string;
  resultId: string;
  clientId: string;
  /** Built from the host that owns this run; never resolved from a later render. */
  gateway: DesignSaveGateway;
};

export type DesignSaveRunner = {
  run(input: DesignSaveRunInput): Promise<DesignSaveOutcome | null>;
  cleanup(input: DesignSaveRunInput): Promise<DesignCompensationOutcome | null>;
  abort(jobId: string): void;
  switchHost(hostId: string): void;
  dispose(): void;
  unknownWrites: DesignUnknownWrites;
};

/**
 * Host-scoped run bookkeeping without React. `run`/`cleanup` use the gateway captured in their
 * input for every RPC, so a host switch can never reroute an in-flight write. A stale render's
 * callback is rejected instead of switching the runner.
 */
export function createDesignSaveRunner(
  options: {
    initialHostId?: string;
    /** `hostId` is the host that ran the save, so the caller can drop a stale render's outcome. */
    onOutcome?: (outcome: DesignSaveOutcome, hostId: string) => void;
    onJobOutcome?: (jobId: string, outcome: DesignSaveOutcome, hostId: string) => void;
    onCleanupOutcome?: (outcome: DesignCompensationOutcome, hostId: string) => void;
    onJobCleanupOutcome?: (
      jobId: string,
      outcome: DesignCompensationOutcome,
      hostId: string,
    ) => void;
    onActiveChange?: (active: number) => void;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): DesignSaveRunner {
  let hostId = options.initialHostId ?? "";
  let generation = 0;
  const saves = new Map<string, Promise<DesignSaveOutcome | null>>();
  const cleanups = new Map<string, Promise<DesignCompensationOutcome | null>>();
  const controllers = new Map<string, AbortController>();
  const unknownJobIds = new Set<string>();
  const unknownWrites: DesignUnknownWrites = {
    mark: (jobId) => unknownJobIds.add(jobId),
    has: (jobId) => unknownJobIds.has(jobId),
  };

  function notify(): void {
    options.onActiveChange?.(saves.size + cleanups.size);
  }

  function clearAll(): void {
    clearDesignSaveRuns(controllers, saves);
    cleanups.clear();
    notify();
  }

  function keyFor(input: DesignSaveRunInput): string {
    return [input.hostId, input.jobId, input.resultId].join("\u0000");
  }

  return {
    unknownWrites,
    switchHost(next: string): void {
      if (next === hostId) return;
      hostId = next;
      generation += 1;
      clearAll();
    },
    dispose(): void {
      generation += 1;
      clearAll();
    },
    abort(jobId: string): void {
      const prefix = `${hostId}\u0000${jobId}\u0000`;
      for (const [key, controller] of controllers) {
        if (key.startsWith(prefix)) controller.abort();
      }
    },
    run(input: DesignSaveRunInput): Promise<DesignSaveOutcome | null> {
      // A stale render's save callback is a no-op, never a host switch or a write.
      if (input.hostId !== hostId) return Promise.resolve(null);
      const key = keyFor(input);
      const existing = saves.get(key);
      if (existing) return existing;
      // Compensation owns the document while it runs; never start a competing save.
      if (cleanups.has(key)) return Promise.resolve(null);

      const generationAtStart = generation;
      const controller = new AbortController();
      controllers.set(key, controller);
      const run = saveDesign(
        { jobId: input.jobId, resultId: input.resultId, clientId: input.clientId },
        {
          gateway: input.gateway,
          signal: controller.signal,
          now: options.now ?? Date.now,
          unknownWrites,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      )
        .then((outcome) => {
          if (input.hostId !== hostId || generation !== generationAtStart) return null;
          options.onOutcome?.(outcome, input.hostId);
          options.onJobOutcome?.(input.jobId, outcome, input.hostId);
          return outcome;
        })
        .finally(() => {
          if (generation !== generationAtStart) return;
          saves.delete(key);
          controllers.delete(key);
          notify();
        });
      saves.set(key, run);
      notify();
      return run;
    },
    cleanup(input: DesignSaveRunInput): Promise<DesignCompensationOutcome | null> {
      if (input.hostId !== hostId) return Promise.resolve(null);
      const key = keyFor(input);
      const existing = cleanups.get(key);
      if (existing) return existing;
      // A save still in flight must be aborted by the caller first; never race its writes.
      if (saves.has(key)) return Promise.resolve(null);

      const generationAtStart = generation;
      const controller = new AbortController();
      controllers.set(key, controller);
      const run = compensateDesign(
        { jobId: input.jobId, resultId: input.resultId, clientId: input.clientId },
        {
          gateway: input.gateway,
          signal: controller.signal,
          now: options.now ?? Date.now,
          unknownWrites,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      )
        .then((outcome) => {
          if (input.hostId !== hostId || generation !== generationAtStart) return null;
          options.onCleanupOutcome?.(outcome, input.hostId);
          options.onJobCleanupOutcome?.(input.jobId, outcome, input.hostId);
          return outcome;
        })
        .finally(() => {
          if (generation !== generationAtStart) return;
          cleanups.delete(key);
          controllers.delete(key);
          notify();
        });
      cleanups.set(key, run);
      notify();
      return run;
    },
  };
}

/**
 * React glue. The runner lives for the whole panel, not one job section, so a polling failure or
 * a section unmount cannot abort an in-flight write or forget unknown-write memory.
 */
export function useDesignSave(input: UseDesignSaveInput): UseDesignSaveResult {
  const readRoles = useRpc(rolesReadRpc);
  const writeRoles = useRpc(rolesWriteRpc);
  const readTeams = useRpc(teamsReadRpc);
  const writeTeams = useRpc(teamsWriteRpc);
  const readPreferences = useRpc(preferencesReadRpc);
  const prepareSave = useRpc(designPrepareSaveRpc);
  const markSaved = useRpc(designMarkSavedRpc);
  const saveFailed = useRpc(designSaveFailedRpc);
  const roles = useSettings(rolesSettings);
  const teams = useSettings(teamsSettings);

  const [active, setActive] = useState(0);
  const latest = useRef(input);
  latest.current = input;
  const runnerRef = useRef<DesignSaveRunner | null>(null);
  if (!runnerRef.current) {
    runnerRef.current = createDesignSaveRunner({
      initialHostId: input.hostId,
      onJobOutcome: (jobId, outcome, host) => {
        if (host !== latest.current.hostId) return;
        latest.current.onOutcome?.(jobId, outcome);
      },
      onJobCleanupOutcome: (jobId, outcome, host) => {
        if (host !== latest.current.hostId) return;
        latest.current.onCleanupOutcome?.(jobId, outcome);
      },
      onActiveChange: setActive,
    });
  }
  const runner = runnerRef.current;

  useEffect(() => {
    runner.switchHost(input.hostId);
  }, [runner, input.hostId]);

  useEffect(() => () => runner.dispose(), [runner]);

  const { hostId, clientId } = input;
  const makeGateway = useCallback(
    () =>
      buildDesignSaveGateway({
        readRoles,
        writeRoles,
        readTeams,
        writeTeams,
        readPreferences,
        prepareSave,
        markSaved,
        saveFailed,
        reloadRoles: () => roles.reload(),
        reloadTeams: () => teams.reload(),
      }),
    [
      readRoles,
      writeRoles,
      readTeams,
      writeTeams,
      readPreferences,
      prepareSave,
      markSaved,
      saveFailed,
      roles.reload,
      teams.reload,
    ],
  );

  const save = useCallback(
    (jobId: string, resultId: string): Promise<DesignSaveOutcome | null> =>
      runner.run({ hostId, jobId, resultId, clientId, gateway: makeGateway() }),
    [runner, hostId, clientId, makeGateway],
  );

  const cleanup = useCallback(
    (jobId: string, resultId: string): Promise<DesignCompensationOutcome | null> =>
      runner.cleanup({ hostId, jobId, resultId, clientId, gateway: makeGateway() }),
    [runner, hostId, clientId, makeGateway],
  );

  const abort = useCallback((jobId: string) => runner.abort(jobId), [runner]);

  return { save, cleanup, abort, pending: active > 0, unknownWrites: runner.unknownWrites };
}
