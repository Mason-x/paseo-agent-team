import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DaemonClient, type WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";

const url = process.env.PASEO_CANARY_URL ?? "ws://127.0.0.1:6768/ws";
const password = process.env.PASEO_CANARY_PASSWORD;
const cwd = process.env.PASEO_CANARY_CWD ?? "/workspace/paseo-plugins";
const provider = "omp-plugin";
const expectedOmpVersion = process.env.PASEO_CANARY_OMP_VERSION ?? "18.1.15";

if (!password) throw new Error("PASEO_CANARY_PASSWORD is required");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertFinished(result: WaitForFinishResult, expected: string): void {
  assert(
    result.status === "idle",
    `Expected idle result, received ${result.status}: ${result.error ?? result.lastMessage ?? "no detail"}`,
  );
  assert(result.error === null, `Agent failed: ${result.error ?? "unknown error"}`);
  assert(result.lastMessage === expected, `Expected ${expected}, received ${result.lastMessage}`);
}

async function connectCanaryClient(): Promise<DaemonClient> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const candidate = new DaemonClient({
      url,
      password,
      clientId: `paseo-omp-canary-${randomUUID()}`,
      clientType: "cli",
      appVersion: "0.8.0",
      reconnect: { enabled: false },
    });
    try {
      await candidate.connect();
      const catalog = await candidate.getPluginCatalog();
      if (catalog.some((plugin) => plugin.id === "paseo-omp")) return candidate;
      lastError = new Error("paseo-omp is not registered yet");
    } catch (error) {
      lastError = error;
    }
    await candidate.close().catch(() => undefined);
    await sleep(250);
  }
  throw new Error(`Paseo canary did not become ready: ${String(lastError)}`);
}

const client = await connectCanaryClient();
const createdAgentIds: string[] = [];
const summary: Record<string, unknown> = {};
const compatibilityFailures: string[] = [];

async function deleteTrackedAgent(agentId: string): Promise<void> {
  await client.deleteAgent(agentId);
  const index = createdAgentIds.indexOf(agentId);
  if (index >= 0) createdAgentIds.splice(index, 1);
}

async function allowPendingPermissions(
  agentId: string,
  result: WaitForFinishResult,
): Promise<{ result: WaitForFinishResult; rounds: number }> {
  let current = result;
  let rounds = 0;
  while (current.status === "permission" && rounds < 4) {
    const request = current.final?.pendingPermissions[0];
    assert(request, "Permission status did not include a pending request");
    const action = request.actions?.find((candidate) => candidate.behavior === "allow");
    await client.respondToPermission(agentId, request.id, {
      behavior: "allow",
      ...(action ? { selectedActionId: action.id } : {}),
    });
    rounds += 1;
    current = await client.waitForFinish(agentId, 120_000);
  }
  return { result: current, rounds };
}

try {
  const health = (await client.invokePluginRpc("paseo-omp", "paseo-omp.get-provider-health", {
    force: true,
  })) as {
    binary?: {
      version?: { major?: number; minor?: number; patch?: number } | null;
      versionStatus?: string;
    };
    rpcUi?: { supported?: boolean | null };
  };
  const actualOmpVersion = health.binary?.version
    ? `${health.binary.version.major}.${health.binary.version.minor}.${health.binary.version.patch}`
    : null;
  assert(health.binary?.versionStatus === "ok", "OMP version health probe did not pass");
  assert(
    actualOmpVersion === expectedOmpVersion,
    `Expected OMP ${expectedOmpVersion}, got ${actualOmpVersion}`,
  );
  assert(health.rpcUi?.supported === true, "OMP rpc-ui health probe did not pass");
  summary.runtime = { version: actualOmpVersion, rpcUi: true };
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

  const canaryMcpServers = {
    canary: {
      type: "stdio" as const,
      command: "node",
      args: ["/opt/paseo-omp/canary/mcp-server.ts"],
    },
  };
  const mcpAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    mcpServers: canaryMcpServers,
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
  const mcpSnapshot = await client.fetchAgent(mcpAgent.id);
  const mcpPersistence = mcpSnapshot?.agent.persistence;
  assert(mcpPersistence, "MCP agent persistence handle is missing");
  await deleteTrackedAgent(mcpAgent.id);
  const resumedMcpAgent = await client.resumeAgent(mcpPersistence, {
    cwd,
    model: mockModel.id,
    modeId: "full",
    mcpServers: canaryMcpServers,
  });
  createdAgentIds.push(resumedMcpAgent.id);
  await client.sendAgentMessage(resumedMcpAgent.id, "CANARY_MCP");
  assertFinished(await client.waitForFinish(resumedMcpAgent.id, 120_000), "CANARY_MCP_OK");
  summary.mcp = { initial: true, resumed: true };

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

  await deleteTrackedAgent(primary.id);
  const resumed = await client.resumeAgent(persistence, {
    cwd,
    model: mockModel.id,
    modeId: "full",
  });
  createdAgentIds.push(resumed.id);
  await client.sendAgentMessage(resumed.id, "RESUMED");
  assertFinished(await client.waitForFinish(resumed.id, 120_000), "CANARY_MOCK_OK");

  await deleteTrackedAgent(resumed.id);
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
  const allowed = await allowPendingPermissions(
    permissionAgent.id,
    await client.waitForFinish(permissionAgent.id, 120_000),
  );
  assert(allowed.rounds > 0, "Ask mode did not request permission");
  assertFinished(allowed.result, "CANARY_TOOL_OK");
  const permissionSnapshot = await client.fetchAgent(permissionAgent.id);
  const permissionPersistence = permissionSnapshot?.agent.persistence;
  assert(permissionPersistence, "Permission agent persistence handle is missing");
  await deleteTrackedAgent(permissionAgent.id);
  const resumedPermissionAgent = await client.resumeAgent(permissionPersistence, {
    cwd,
    model: mockModel.id,
    modeId: "ask",
  });
  createdAgentIds.push(resumedPermissionAgent.id);
  await client.sendAgentMessage(resumedPermissionAgent.id, "CANARY_TOOL");
  const resumedAllowed = await allowPendingPermissions(
    resumedPermissionAgent.id,
    await client.waitForFinish(resumedPermissionAgent.id, 120_000),
  );
  assert(resumedAllowed.rounds > 0, "Resumed ask-mode session did not request permission");
  assertFinished(resumedAllowed.result, "CANARY_TOOL_OK");
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
    allowRounds: allowed.rounds,
    resumedAllowRounds: resumedAllowed.rounds,
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

  const nestedAgent = await client.createAgent({
    provider,
    cwd,
    model: mockModel.id,
    modeId: "full",
    initialPrompt: "CANARY_NESTED_ROOT",
  });
  createdAgentIds.push(nestedAgent.id);
  const nestedResult = await client.waitForFinish(nestedAgent.id, 120_000);
  assert(
    nestedResult.status === "idle",
    `Nested subagent scenario ended as ${nestedResult.status}`,
  );
  assert(nestedResult.error === null, `Nested subagent scenario failed: ${nestedResult.error}`);
  const nestedTimeline = await client.fetchAgentTimeline(nestedAgent.id, {
    direction: "tail",
    limit: 500,
    projection: "projected",
  });
  assert(
    nestedTimeline.entries.some(
      (entry) => entry.item.type === "tool_call" && entry.item.name === "task",
    ),
    "Nested subagent task lifecycle is missing from the parent timeline",
  );
  assert(
    nestedTimeline.entries.some(
      (entry) =>
        entry.item.type === "assistant_message" &&
        entry.item.text.includes("CANARY_NESTED_ROOT_OK"),
    ),
    `Nested parent completion is missing: ${nestedResult.lastMessage ?? "no final message"}`,
  );
  const nestedSubagents = await client.listProviderSubagents(nestedAgent.id);
  assert(
    nestedSubagents.error === null,
    `Nested subagent listing failed: ${nestedSubagents.error}`,
  );
  const directChild = nestedSubagents.subagents.find(
    (candidate) => candidate.parentSubagentId == null,
  );
  assert(directChild, "Direct provider subagent is missing");
  const nestedChild = nestedSubagents.subagents.find(
    (candidate) => candidate.parentSubagentId === directChild.id,
  );
  if (!nestedChild) {
    compatibilityFailures.push(
      `nested subagent ancestry missing: ${JSON.stringify(nestedSubagents.subagents)}`,
    );
    summary.subagents = {
      passed: false,
      direct: directChild.id,
      observed: nestedSubagents.subagents,
    };
  } else {
    assert(directChild.status === "completed", `Direct subagent ended as ${directChild.status}`);
    assert(nestedChild.status === "completed", `Nested subagent ended as ${nestedChild.status}`);
    const directTimeline = await client.fetchProviderSubagentTimeline(
      nestedAgent.id,
      directChild.id,
      {
        direction: "tail",
        limit: 500,
      },
    );
    const nestedChildTimeline = await client.fetchProviderSubagentTimeline(
      nestedAgent.id,
      nestedChild.id,
      { direction: "tail", limit: 500 },
    );
    assert(
      directTimeline.error === null,
      `Direct subagent timeline failed: ${directTimeline.error}`,
    );
    assert(
      nestedChildTimeline.error === null,
      `Nested subagent timeline failed: ${nestedChildTimeline.error}`,
    );
    assert(
      nestedChildTimeline.rows.some(
        (row) =>
          row.item.type === "assistant_message" && row.item.text.includes("CANARY_NESTED_LEAF_OK"),
      ),
      "Nested subagent completion is missing from its timeline",
    );
    summary.subagents = {
      passed: true,
      direct: directChild.id,
      nested: nestedChild.id,
      nestedParent: nestedChild.parentSubagentId,
    };
  }
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
  const rewoundSnapshot = await client.fetchAgent(rewindAgent.id);
  const rewindPersistence = rewoundSnapshot?.agent.persistence;
  assert(rewindPersistence, "Rewound agent persistence handle is missing");
  await deleteTrackedAgent(rewindAgent.id);
  const resumedRewindAgent = await client.resumeAgent(rewindPersistence, {
    cwd,
    model: mockModel.id,
    modeId: "full",
  });
  createdAgentIds.push(resumedRewindAgent.id);
  await client.sendAgentMessage(resumedRewindAgent.id, "REWIND_DURABLE");
  assertFinished(await client.waitForFinish(resumedRewindAgent.id, 120_000), "CANARY_MOCK_OK");
  summary.rewind = { passed: true, resumed: true };

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

  const cleanupProcessName = hubProcess.name;
  while (createdAgentIds.length > 0) {
    const agentId = createdAgentIds.at(-1);
    assert(agentId, "Tracked agent cleanup lost its final ID");
    await deleteTrackedAgent(agentId);
  }
  const cleanupDeadline = Date.now() + 10_000;
  let lingeringHubProcess = true;
  while (lingeringHubProcess && Date.now() < cleanupDeadline) {
    const processes = (await client.invokePluginRpc("paseo-omp", "paseo-omp.list-processes", {
      cwd,
    })) as { processes?: Array<{ name?: string; state?: string }> };
    lingeringHubProcess =
      processes.processes?.some(
        (process) => process.name === cleanupProcessName && process.state === "running",
      ) ?? false;
    if (lingeringHubProcess) await sleep(100);
  }
  assert(!lingeringHubProcess, "Deleting the owning agent left its Hub process running");
  summary.cleanup = { agents: true, hubProcess: true };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (compatibilityFailures.length > 0) {
    throw new Error(`Canary compatibility failures: ${compatibilityFailures.join("; ")}`);
  }
} finally {
  for (const agentId of createdAgentIds.reverse()) {
    await client.deleteAgent(agentId).catch(() => undefined);
  }
  await client.close();
}
