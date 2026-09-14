import { setTimeout as sleep } from "node:timers/promises";
import { OmpHostToolsBridge } from "../../server/provider/host-tools";
import type {
  OmpHostToolDefinition,
  OmpHostToolResult,
  OmpHostToolUpdate,
  OmpRuntimeSession,
} from "../../server/provider/omp-rpc";

const url = process.env.MCP_HOST_URL;
const expectedHostCwd = process.env.EXPECTED_HOST_CWD;
const expectedHostPid = Number(process.env.EXPECTED_HOST_PID);
const callerAgentId = process.env.PASEO_AGENT_ID;
const workspaceId = process.env.PASEO_WORKSPACE_ID;
const expectedOwnerMarker = process.env.EXPECTED_OWNER_MARKER ?? "host-daemon";
if (
  !url ||
  !expectedHostCwd ||
  !Number.isInteger(expectedHostPid) ||
  !callerAgentId ||
  !workspaceId
) {
  throw new Error(
    "MCP_HOST_URL, EXPECTED_HOST_CWD, EXPECTED_HOST_PID, PASEO_AGENT_ID, and PASEO_WORKSPACE_ID are required",
  );
}

const results: OmpHostToolResult[] = [];
let definitions: readonly OmpHostToolDefinition[] = [];
const runtime = {
  async setHostTools(tools: readonly OmpHostToolDefinition[]) {
    definitions = tools;
    return tools.map(({ name }) => name);
  },
  sendHostToolResult(result: OmpHostToolResult) {
    results.push(result);
  },
  sendHostToolUpdate(_update: OmpHostToolUpdate) {},
} as Pick<OmpRuntimeSession, "setHostTools" | "sendHostToolResult" | "sendHostToolUpdate">;

const bridge = await OmpHostToolsBridge.open({
  cwd: process.cwd(),
  env: { PASEO_AGENT_ID: callerAgentId, PASEO_WORKSPACE_ID: workspaceId },
  mcpServers: { bridge: { type: "http", url } },
  settings: {},
  persist: false,
});
try {
  await bridge.bind(runtime as OmpRuntimeSession);
  if (definitions[0]?.name !== "workspace_probe") {
    throw new Error(`Unexpected Docker host tool catalog: ${JSON.stringify(definitions)}`);
  }
  bridge.handle({
    type: "host_tool_call",
    id: "docker-call",
    toolCallId: "docker-tool-call",
    toolName: "workspace_probe",
    arguments: {},
  });
  const deadline = Date.now() + 5_000;
  while (results.length === 0 && Date.now() < deadline) {
    await sleep(10);
  }
  const text = results[0]?.result.content[0]?.text;
  if (!text) throw new Error("Docker host tool did not return a result");
  const evidence = JSON.parse(text) as {
    callerAgentId?: string;
    workspaceId?: string;
    ownerMarker?: string;
    ownerPid?: number;
    ownerCwd?: string;
  };
  if (
    evidence.callerAgentId !== callerAgentId ||
    typeof evidence.workspaceId !== "string" ||
    evidence.ownerMarker !== expectedOwnerMarker ||
    evidence.ownerPid !== expectedHostPid ||
    evidence.ownerPid === process.pid ||
    evidence.ownerCwd !== expectedHostCwd
  ) {
    throw new Error(`Host/container ownership mismatch: ${JSON.stringify(evidence)}`);
  }
  console.log(JSON.stringify(evidence));
} finally {
  await bridge.close();
}
