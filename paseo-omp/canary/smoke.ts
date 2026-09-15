import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const url = process.env.PASEO_CANARY_URL ?? "ws://127.0.0.1:6768/ws";
const password = process.env.PASEO_CANARY_PASSWORD;
const cwd = process.env.PASEO_CANARY_CWD ?? "/workspace/paseo-plugins";
const provider = "omp-plugin";

if (!password) throw new Error("PASEO_CANARY_PASSWORD is required");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertFinished(
  result: Awaited<ReturnType<DaemonClient["waitForFinish"]>>,
  expected: string,
): void {
  assert(
    result.status === "idle",
    `Expected idle result, received ${result.status}: ${result.error ?? result.lastMessage ?? "no detail"}`,
  );
  assert(result.error === null, `Agent failed: ${result.error ?? "unknown error"}`);
  assert(result.lastMessage === expected, `Expected ${expected}, received ${result.lastMessage}`);
}

const client = new DaemonClient({
  url,
  password,
  clientId: `paseo-omp-canary-${randomUUID()}`,
  clientType: "cli",
  appVersion: "0.8.0",
  reconnect: { enabled: false },
});
const createdAgentIds: string[] = [];
const summary: Record<string, unknown> = {};

try {
  await client.connect();
  const modelsPayload = await client.listProviderModels(provider, { cwd });
  assert(!modelsPayload.error, `Model discovery failed: ${modelsPayload.error}`);
  const models = modelsPayload.models ?? [];
  const mockModel = models.find((model) => model.label === "canary-mock/Deterministic Canary");
  const ollamaModel = models.find((model) => model.label === "canary-ollama/Qwen 2.5 0.5B");
  assert(mockModel, "Deterministic canary model is missing");
  assert(ollamaModel, "Ollama canary model is missing");

  const modesPayload = await client.listProviderModes(provider, { cwd });
  assert(!modesPayload.error, `Mode discovery failed: ${modesPayload.error}`);
  const modeIds = (modesPayload.modes ?? []).map((mode) => mode.id);
  for (const mode of ["full", "write", "ask"]) {
    assert(modeIds.includes(mode), `Provider mode ${mode} is missing`);
  }
  summary.catalog = { models: models.length, modes: modeIds };

  const primary = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "Reply normally for the deterministic canary.",
  });
  createdAgentIds.push(primary.id);
  const initial = await client.waitForFinish(primary.id, 120_000);
  assertFinished(initial, "CANARY_MOCK_OK");
  assert(initial.final?.capabilities.supportsStreaming, "Streaming capability is missing");
  assert(
    initial.final.capabilities.supportsSessionPersistence,
    "Persistence capability is missing",
  );
  assert(initial.final.capabilities.supportsDynamicModes, "Dynamic modes capability is missing");
  assert(initial.final.capabilities.supportsMcpServers, "MCP capability is missing");
  assert(initial.final.lastUsage?.inputTokens === 10, "Input usage was not propagated");
  assert(initial.final.lastUsage?.outputTokens === 2, "Output usage was not propagated");

  const commands = await client.listCommands(primary.id);
  assert(commands.error === null, `Command discovery failed: ${commands.error}`);
  const commandNames = new Set(commands.commands.map((command) => command.name));
  for (const command of ["compact", "autocompact", "handoff", "steer", "follow-up"]) {
    assert(commandNames.has(command), `Provider command ${command} is missing`);
  }

  await client.sendAgentMessage(primary.id, "/autocompact off");
  const autocompactResult = await client.waitForFinish(primary.id, 120_000);
  assertFinished(autocompactResult, "Auto-compaction disabled.");
  await client.sendAgentMessage(primary.id, "/follow-up CANARY_FOLLOWUP");
  assertFinished(await client.waitForFinish(primary.id, 120_000), "CANARY_MOCK_OK");
  await client.setAgentModel(primary.id, ollamaModel.id);
  assert(
    (await client.fetchAgent(primary.id))?.agent.model === ollamaModel.id,
    "Model switch did not commit",
  );
  await client.setAgentModel(primary.id, mockModel.id);
  assert(
    (await client.fetchAgent(primary.id))?.agent.model === mockModel.id,
    "Model reset did not commit",
  );
  summary.configuration = { modelSwitch: true };
  summary.commands = { listed: [...commandNames].sort(), executed: ["autocompact", "follow-up"] };

  const compactAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "COMPACT_SETUP",
  });
  createdAgentIds.push(compactAgent.id);
  assertFinished(await client.waitForFinish(compactAgent.id, 120_000), "CANARY_MOCK_OK");
  await client.sendAgentMessage(compactAgent.id, "/compact canary");
  const compactResult = await client.waitForFinish(compactAgent.id, 120_000);

  const handoffAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "HANDOFF_SETUP",
  });
  createdAgentIds.push(handoffAgent.id);
  assertFinished(await client.waitForFinish(handoffAgent.id, 120_000), "CANARY_MOCK_OK");
  let handoffError: string | null = null;
  try {
    await client.sendAgentMessage(handoffAgent.id, "/handoff CANARY_HANDOFF");
    const handoffResult = await client.waitForFinish(handoffAgent.id, 120_000);
    handoffError = handoffResult.error;
  } catch (error) {
    handoffError = error instanceof Error ? error.message : String(error);
  }
  summary.commandKnownIssues = {
    compact: compactResult.error,
    handoff: handoffError,
  };

  await client.sendAgentMessage(primary.id, "CANARY_TOOL");
  assertFinished(await client.waitForFinish(primary.id, 120_000), "CANARY_TOOL_OK");

  await client.sendAgentMessage(primary.id, "CANARY_IMAGE", {
    images: [
      {
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=",
      },
    ],
  });
  assertFinished(await client.waitForFinish(primary.id, 120_000), "CANARY_MOCK_OK");

  const mcpAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    mcpServers: {
      canary: {
        type: "stdio",
        command: "node",
        args: ["/opt/paseo-omp/canary/mcp-server.ts"],
      },
    },
    initialPrompt: "CANARY_MCP",
  });
  createdAgentIds.push(mcpAgent.id);
  assertFinished(await client.waitForFinish(mcpAgent.id, 120_000), "CANARY_MCP_OK");
  const mcpTimeline = await client.fetchAgentTimeline(mcpAgent.id, {
    direction: "tail",
    limit: 200,
    projection: "projected",
  });
  assert(
    mcpTimeline.entries.some(
      (entry) =>
        entry.item.type === "tool_call" &&
        entry.item.name === "Canary: Echo marker" &&
        entry.item.detail.type === "unknown" &&
        entry.item.status === "completed" &&
        JSON.stringify(entry.item).includes("xd://mcp__canary_echo_marker"),
    ),
    "Configured MCP tool did not complete",
  );
  summary.mcp = true;

  const refreshed = await client.fetchAgent(primary.id);
  const persistence = refreshed?.agent.persistence;
  assert(persistence, "Plugin persistence handle is missing");
  assert(persistence.provider === provider, "Persistence provider identity changed");
  const pluginPersistence = persistence.metadata?.pluginProviderPersistence;
  assert(
    pluginPersistence && typeof pluginPersistence === "object",
    "Opaque plugin persistence metadata is missing",
  );
  assert(
    "version" in pluginPersistence && pluginPersistence.version === 1,
    "Plugin persistence version is not 1",
  );
  const persistenceData = "data" in pluginPersistence ? pluginPersistence.data : null;
  const persistedSessionId =
    persistenceData &&
    typeof persistenceData === "object" &&
    "sessionId" in persistenceData &&
    typeof persistenceData.sessionId === "string"
      ? persistenceData.sessionId
      : null;
  assert(persistedSessionId, "Native persistence session ID is missing");

  await client.deleteAgent(primary.id);
  createdAgentIds.splice(createdAgentIds.indexOf(primary.id), 1);
  const resumed = await client.resumeAgent(persistence, {
    cwd,
    model: mockModel.id,
    modeId: "full",
  });
  createdAgentIds.push(resumed.id);
  await client.sendAgentMessage(resumed.id, "RESUMED");
  assertFinished(await client.waitForFinish(resumed.id, 120_000), "CANARY_MOCK_OK");

  await client.deleteAgent(resumed.id);
  createdAgentIds.splice(createdAgentIds.indexOf(resumed.id), 1);
  const hostRecentSessions = await client.fetchRecentProviderSessions({
    providers: [provider],
    limit: 50,
  });
  assert(
    hostRecentSessions.entries.some(
      (entry) =>
        entry.providerId === provider && entry.providerHandleId.includes(persistedSessionId),
    ),
    `Persisted OMP session is missing from host-wide listing: ${JSON.stringify(hostRecentSessions)}`,
  );
  const recentSessions = await client.fetchRecentProviderSessions({
    cwd,
    providers: [provider],
    limit: 50,
  });
  const importCandidate = recentSessions.entries.find(
    (entry) => entry.providerId === provider && entry.providerHandleId.includes(persistedSessionId),
  );
  assert(
    importCandidate,
    `Persisted OMP session is missing from provider session listing: ${JSON.stringify(recentSessions)}`,
  );
  const imported = await client.importAgent({
    providerId: provider,
    providerHandleId: importCandidate.providerHandleId,
    cwd,
  });
  createdAgentIds.push(imported.id);
  await client.sendAgentMessage(imported.id, "IMPORTED");
  assertFinished(await client.waitForFinish(imported.id, 120_000), "CANARY_MOCK_OK");
  summary.persistence = {
    nativeSessionId: persistedSessionId,
    resumedAgentId: resumed.id,
    importedAgentId: imported.id,
  };

  const permissionAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "ask",
    initialPrompt: "CANARY_TOOL",
  });
  createdAgentIds.push(permissionAgent.id);
  let permissionResult = await client.waitForFinish(permissionAgent.id, 120_000);
  let permissionRounds = 0;
  while (permissionResult.status === "permission" && permissionRounds < 4) {
    const request = permissionResult.final?.pendingPermissions[0];
    assert(request, "Permission status did not include a pending request");
    const action = request.actions?.find((candidate) => candidate.behavior === "allow");
    await client.respondToPermission(permissionAgent.id, request.id, {
      behavior: "allow",
      ...(action ? { selectedActionId: action.id } : {}),
    });
    permissionRounds += 1;
    permissionResult = await client.waitForFinish(permissionAgent.id, 120_000);
  }
  assert(permissionRounds > 0, "Ask mode did not request permission");
  assertFinished(permissionResult, "CANARY_TOOL_OK");
  const deniedAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "ask",
    initialPrompt: "CANARY_TOOL",
  });
  createdAgentIds.push(deniedAgent.id);
  let deniedResult = await client.waitForFinish(deniedAgent.id, 120_000);
  let denyRounds = 0;
  while (deniedResult.status === "permission" && denyRounds < 4) {
    const deniedRequest = deniedResult.final?.pendingPermissions[0];
    assert(deniedRequest, "Deny scenario has no pending permission");
    const denyAction = deniedRequest.actions?.find((candidate) => candidate.behavior === "deny");
    await client.respondToPermission(deniedAgent.id, deniedRequest.id, {
      behavior: "deny",
      ...(denyAction ? { selectedActionId: denyAction.id } : {}),
    });
    denyRounds += 1;
    deniedResult = await client.waitForFinish(deniedAgent.id, 120_000);
  }
  assert(denyRounds > 0, "Deny scenario did not request permission");
  assert(deniedResult.status === "idle", `Denied permission ended as ${deniedResult.status}`);
  const deniedTimeline = await client.fetchAgentTimeline(deniedAgent.id, {
    direction: "tail",
    limit: 200,
    projection: "projected",
  });
  assert(
    !deniedTimeline.entries.some(
      (entry) =>
        entry.item.type === "tool_call" &&
        entry.item.name === "bash" &&
        entry.item.status === "completed",
    ),
    "Denied Bash tool unexpectedly completed",
  );

  const canceledPermissionAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "ask",
    initialPrompt: "CANARY_TOOL",
  });
  createdAgentIds.push(canceledPermissionAgent.id);
  const cancelPending = await client.waitForFinish(canceledPermissionAgent.id, 120_000);
  assert(cancelPending.status === "permission", "Cancel scenario did not request permission");
  let cancelIssue: string | null = null;
  try {
    await client.cancelAgent(canceledPermissionAgent.id);
  } catch (error) {
    cancelIssue = error instanceof Error ? error.message : String(error);
  }
  let canceledPermission = await client.waitForFinish(canceledPermissionAgent.id, 30_000);
  let cancelCleanupRounds = 0;
  while (canceledPermission.status === "permission" && cancelCleanupRounds < 4) {
    const request = canceledPermission.final?.pendingPermissions[0];
    assert(request, "Canceled permission status had no request");
    const denyAction = request.actions?.find((candidate) => candidate.behavior === "deny");
    await client.respondToPermission(canceledPermissionAgent.id, request.id, {
      behavior: "deny",
      interrupt: true,
      ...(denyAction ? { selectedActionId: denyAction.id } : {}),
    });
    cancelCleanupRounds += 1;
    canceledPermission = await client.waitForFinish(canceledPermissionAgent.id, 30_000);
  }
  assert(canceledPermission.status === "idle", "Canceled permission agent did not become idle");
  assert(
    canceledPermission.final?.pendingPermissions.length === 0,
    "Canceled permission remained pending",
  );
  summary.permissions = {
    allowRounds: permissionRounds,
    denyRounds,
    cancel: cancelIssue ? { passed: false, knownIssue: cancelIssue } : { passed: true },
  };

  const steered = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "CANARY_DELAY",
  });
  createdAgentIds.push(steered.id);
  await sleep(500);
  await client.sendAgentMessage(steered.id, "STEERED", { activeTurnBehavior: "steer" });
  assertFinished(await client.waitForFinish(steered.id, 120_000), "CANARY_MOCK_OK");
  summary.steer = true;

  const interrupted = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "CANARY_DELAY",
  });
  createdAgentIds.push(interrupted.id);
  await sleep(500);
  await client.cancelAgent(interrupted.id);
  const interruptedResult = await client.waitForFinish(interrupted.id, 30_000);
  assert(interruptedResult.status === "idle", "Interrupted agent did not return to idle");
  summary.interrupt = true;

  const subagent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "CANARY_SUBAGENT",
  });
  createdAgentIds.push(subagent.id);
  const subagentResult = await client.waitForFinish(subagent.id, 120_000);
  assert(subagentResult.status === "idle", `Subagent scenario ended as ${subagentResult.status}`);
  assert(subagentResult.error === null, `Subagent scenario failed: ${subagentResult.error}`);
  const subagentTimeline = await client.fetchAgentTimeline(subagent.id, {
    direction: "tail",
    limit: 500,
    projection: "projected",
  });
  assert(
    subagentTimeline.entries.some(
      (entry) => entry.item.type === "tool_call" && entry.item.name === "task",
    ),
    "Subagent task lifecycle is missing from the timeline",
  );
  assert(
    subagentTimeline.entries.some(
      (entry) =>
        entry.item.type === "assistant_message" && entry.item.text.includes("CANARY_SUBAGENT_OK"),
    ),
    "Subagent parent completion is missing from the timeline",
  );
  summary.subagent = true;

  const hubAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "CANARY_HUB_START",
  });
  createdAgentIds.push(hubAgent.id);
  assertFinished(await client.waitForFinish(hubAgent.id, 120_000), "CANARY_HUB_OK");
  const hubResult = (await client.invokePluginRpc("paseo-omp", "paseo-omp.list-processes", {
    cwd,
  })) as { processes?: Array<{ name?: string; state?: string; owner?: string | null }> };
  const hubProcess = hubResult.processes?.find((process) =>
    process.name?.startsWith("canary-sleeper-"),
  );
  assert(hubProcess?.state === "running", "Hub canary process is missing or not running");
  assert(hubProcess.name, "Hub canary process has no name");
  const hubLog = (await client.invokePluginRpc("paseo-omp", "paseo-omp.tail-log", {
    cwd,
    name: hubProcess.name,
  })) as { content?: string; truncated?: boolean };
  assert(typeof hubLog.content === "string", "Hub log content is missing");
  assert(typeof hubLog.truncated === "boolean", "Hub log truncation state is missing");
  summary.hub = { owner: hubProcess.owner ?? null };

  const rewindAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "REWIND_ANCHOR",
  });
  createdAgentIds.push(rewindAgent.id);
  assertFinished(await client.waitForFinish(rewindAgent.id, 120_000), "CANARY_MOCK_OK");
  const rewindTimeline = await client.fetchAgentTimeline(rewindAgent.id, {
    direction: "tail",
    limit: 500,
    projection: "canonical",
  });
  const rewindMessage = rewindTimeline.entries.find(
    (entry) => entry.item.type === "user_message" && entry.item.text === "REWIND_ANCHOR",
  );
  assert(rewindMessage?.item.type === "user_message", "Rewind anchor message is missing");
  assert(rewindMessage.item.messageId, "Rewind anchor has no message ID");
  await client.sendAgentMessage(rewindAgent.id, "REWIND_AFTER");
  assertFinished(await client.waitForFinish(rewindAgent.id, 120_000), "CANARY_MOCK_OK");
  await client.rewindAgent(rewindAgent.id, rewindMessage.item.messageId, "conversation");
  await client.sendAgentMessage(rewindAgent.id, "REWIND_RESUMED");
  const rewindResult = await client.waitForFinish(rewindAgent.id, 120_000);
  assertFinished(rewindResult, "CANARY_MOCK_OK");
  summary.rewind = { passed: true };

  const pluginCatalog = await client.getPluginCatalog();
  assert(
    pluginCatalog.some((plugin) => plugin.id === "paseo-omp"),
    "Plugin catalog entry is missing",
  );
  const rpcResults = await Promise.all([
    client.invokePluginRpc("paseo-omp", "paseo-omp.list-processes", { cwd }),
    client.invokePluginRpc("paseo-omp", "paseo-omp.list-memory", { cwd }),
    client.invokePluginRpc("paseo-omp", "paseo-omp.list-sessions", { cwd }),
    client.invokePluginRpc("paseo-omp", "paseo-omp.list-config", {}),
    client.invokePluginRpc("paseo-omp", "paseo-omp.list-quotas", {}),
    client.invokePluginRpc("paseo-omp", "paseo-omp.get-provider-health", { force: true }),
  ]);
  summary.pluginRpcs = rpcResults.map((result) => Object.keys(result as Record<string, unknown>));

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  for (const agentId of createdAgentIds.reverse()) {
    await client.deleteAgent(agentId).catch(() => undefined);
  }
  await client.close();
}
