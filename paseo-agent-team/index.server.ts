import { createHash, randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  createDesignHooks,
  DESIGN_AGENT_LABEL,
  DESIGN_AGENT_VERSION_LABEL,
  DESIGN_TURN_ENDED_EVENT,
  type DesignHookEvent,
} from "./server/designer/hooks";
import { createDesignPlanner } from "./server/designer/planning";
import { createDesignService } from "./server/designer/service";
import { createDesignJobStore, type DesignJobStore } from "./server/designer/store";
import { createLaunchService } from "./server/launch-service";
import { createTeamPlanService } from "./server/team-plan-service";
import { exampleCatalog, previewDefaultCatalog } from "./server/templates";
import { confirmPendingBoot } from "./server/version/boot";
import { createVersionService } from "./server/version/service";
import { LAUNCH_RUNTIME_CAPABILITIES } from "./shared/domain/launch-runtime";
import { createPaseoAdapter } from "./shared/paseo/adapter";
import { createDesignAdapter, type DesignAdapter, type DesignPaseoPort } from "./shared/paseo/port";
import {
  defaultCatalogPreviewRpc,
  designCancelRpc,
  designContinueRpc,
  designMarkSavedRpc,
  designPrepareSaveRpc,
  designResultRpc,
  designSaveFailedRpc,
  designStartRpc,
  designStatusRpc,
  exampleCatalogRpc,
  launchPreviewRpc,
  launchStartRpc,
  launchStatusRpc,
  projectLaunchJobForLegacyPeer,
  teamPlanRpc,
} from "./shared/rpc";
import { preferencesSettings, rolesSettings, teamsSettings } from "./shared/settings";
import {
  versionCheckRpc,
  versionGetRpc,
  versionRuntimeRpc,
  versionUpdateStartRpc,
  versionUpdateStatusRpc,
} from "./shared/version";

export type DesignTurnEndedHandlerDeps = {
  getRecord: DesignJobStore["get"];
  hooks: Pick<ReturnType<typeof createDesignHooks>, "onTurnEnded">;
  bindAdapter: (paseo: DesignPaseoPort) => DesignAdapter;
};

/**
 * Wraps the SDK turn-ended event, which does not carry agent labels. The ledger is the ownership
 * authority: an unknown agent exits after one lookup, and only a record whose agentId matches can
 * bind the adapter and reach the service. The labels handed to the service are rebuilt from the
 * matched jobId, because the service drops the stored create request once creation is confirmed.
 */
export function createDesignTurnEndedHandler(deps: DesignTurnEndedHandlerDeps) {
  return async (event: DesignHookEvent, context: { paseo: DesignPaseoPort }) => {
    const eventLabels = event.agent.labels;
    if (
      eventLabels &&
      (eventLabels[DESIGN_AGENT_VERSION_LABEL] !== "1" || !eventLabels[DESIGN_AGENT_LABEL])
    ) {
      return;
    }
    const record = await deps.getRecord(event.agent.id).catch(() => null);
    if (!record || record.job.agentId !== event.agent.id) return;
    // The G6 service clears creation.request once the agent or a terminal state is confirmed.
    // Ownership is already proven by the ledger record, so rebuild the two non-sensitive labels
    // from its jobId instead of depending on anything stored in the create request.
    const labels = {
      [DESIGN_AGENT_LABEL]: record.job.jobId,
      [DESIGN_AGENT_VERSION_LABEL]: "1",
    };
    deps.bindAdapter(context.paseo);
    await deps.hooks.onTurnEnded({
      agent: { id: event.agent.id, labels },
      turnId: event.turnId,
      outcome: event.outcome,
    });
  };
}

export default function contribute(server: PluginServerContext) {
  const settings = {
    roles: server.registerSettings(rolesSettings),
    teams: server.registerSettings(teamsSettings),
    preferences: server.registerSettings(preferencesSettings),
  };
  const launches = createLaunchService(settings);
  const bootId = randomUUID();
  const versions = createVersionService({ bootId });

  const log = (message: string, cause?: unknown) => {
    console.error(
      cause === undefined
        ? message
        : `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  };

  // Same settings handles as the launch service; team.plan is read-only and owns no cache.
  const teamPlans = createTeamPlanService({ readers: settings, log });

  // The ledger never falls back to the default home: a missing or relative PASEO_HOME leaves the
  // store uninitialized, and every design RPC answers DESIGN_STORAGE_UNAVAILABLE.
  const store = createDesignJobStore({ home: process.env.PASEO_HOME });
  let storeReady = false;
  let initializing: Promise<void> | null = null;
  let closing = false;
  const initializeStore = (): Promise<void> => {
    if (storeReady) return Promise.resolve();
    if (initializing) return initializing;
    if (closing || !process.env.PASEO_HOME) return Promise.resolve();
    const attempt = store
      .initialize()
      .then(() => {
        storeReady = true;
      })
      .catch((error: unknown) => {
        log("design ledger initialization failed", error);
      })
      .finally(() => {
        if (initializing === attempt) initializing = null;
      });
    initializing = attempt;
    return attempt;
  };
  void initializeStore();
  let designAdapter: DesignAdapter | null = null;
  const bindDesignAdapter = (paseo: Parameters<typeof createDesignAdapter>[0]) =>
    (designAdapter ??= createDesignAdapter(paseo));
  const handleDesign = async <Input, Output>(
    input: Input,
    bind: () => void,
    run: (value: Input) => Promise<Output>,
  ): Promise<Output> => {
    bind();
    await initializeStore();
    return run(input);
  };

  const designer = createDesignService({
    store,
    readers: {
      roles: { read: () => settings.roles.read() },
      teams: { read: () => settings.teams.read() },
      preferences: { read: () => settings.preferences.read() },
    },
    getAdapter: () => designAdapter,
    planner: createDesignPlanner(),
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => randomUUID() },
    hasher: (content) => createHash("sha256").update(content, "utf8").digest("hex"),
    capabilities: LAUNCH_RUNTIME_CAPABILITIES,
    log,
  });
  const designHooks = createDesignHooks({ service: designer, log });

  server.handle(launchPreviewRpc, (input, { paseo }) => launches.preview(input, paseo));
  server.handle(launchStartRpc, (input, { paseo }) => launches.start(input, paseo));
  server.handle(launchStatusRpc, ({ runId, contractVersion }) => ({
    job: projectLaunchJobForLegacyPeer(launches.status(runId), contractVersion),
  }));
  server.handle(teamPlanRpc, (input, { paseo }) => teamPlans.plan(input, paseo));
  server.handle(exampleCatalogRpc, async (_input, { paseo }) => {
    const profiles = await createPaseoAdapter(paseo).listProfiles();
    return exampleCatalog(profiles, new Date().toISOString());
  });
  server.handle(defaultCatalogPreviewRpc, (input, { paseo }) =>
    previewDefaultCatalog(input, {
      ...settings,
      listProfiles: () => createPaseoAdapter(paseo).listProfiles(),
    }),
  );
  server.handle(versionGetRpc, (_input, { paseo }) => versions.get(paseo));
  server.handle(versionCheckRpc, ({ requestId }, { paseo }) => versions.check(paseo, requestId));
  server.handle(versionUpdateStartRpc, ({ requestId, checkId }, { paseo }) =>
    versions.startUpdate(paseo, requestId, checkId),
  );
  server.handle(versionUpdateStatusRpc, ({ jobId }) => versions.status(jobId));
  server.handle(versionRuntimeRpc, (_input, { paseo }) => versions.runtime(paseo));

  server.handle(designStartRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.start(value),
    ),
  );
  server.handle(designStatusRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.status(value),
    ),
  );
  server.handle(designResultRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.result(value),
    ),
  );
  server.handle(designPrepareSaveRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.prepareSave(value),
    ),
  );
  server.handle(designMarkSavedRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.markSaved(value),
    ),
  );
  server.handle(designSaveFailedRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.saveFailed(value),
    ),
  );
  server.handle(designCancelRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.cancel(value),
    ),
  );
  server.handle(designContinueRpc, (input, { paseo }) =>
    handleDesign(
      input,
      () => bindDesignAdapter(paseo),
      (value) => designer.continue(value),
    ),
  );

  const stopDesignHook = server.on(
    DESIGN_TURN_ENDED_EVENT,
    createDesignTurnEndedHandler({
      getRecord: (jobId) => store.get(jobId),
      hooks: designHooks,
      bindAdapter: bindDesignAdapter,
    }),
  );

  void confirmPendingBoot({ bootId }).catch((error: unknown) => {
    console.error(
      `version boot confirmation skipped: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  });

  return async () => {
    closing = true;
    stopDesignHook();
    await initializing;
    await designer.dispose();
  };
}
