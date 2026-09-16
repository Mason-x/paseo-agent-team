import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.env.PORT ?? "8080");
const model = "deterministic";
let lastPayload: Record<string, unknown> | null = null;

function stream(frames: readonly object[]): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  });
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function toolName(tool: unknown): string | undefined {
  if (
    !tool ||
    typeof tool !== "object" ||
    !("function" in tool) ||
    !tool.function ||
    typeof tool.function !== "object" ||
    !("name" in tool.function) ||
    typeof tool.function.name !== "string"
  ) {
    return;
  }
  return tool.function.name;
}

function hasTool(tools: readonly unknown[], name: string): boolean {
  return tools.some((tool) => toolName(tool) === name);
}

function toolCallResponse(
  base: { id: string; object: string; created: number; model: string },
  id: string,
  name: string,
  args: object,
): Response {
  return stream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
}

async function chatResponse(payload: Record<string, unknown>): Promise<Response> {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && "role" in message && message.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : undefined;
  const hasToolResult = messages
    .slice(latestUserIndex + 1)
    .some(
      (message) =>
        message && typeof message === "object" && "role" in message && message.role === "tool",
    );
  const prompt =
    latestUser && typeof latestUser === "object" && "content" in latestUser
      ? textFromContent(latestUser.content)
      : "";
  if (prompt.includes("CANARY_DELAY")) await sleep(30_000);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const base = {
    id: `chatcmpl-canary-${Date.now()}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
  };

  if (!hasToolResult && hasTool(tools, "write") && prompt.includes("CANARY_MCP")) {
    return toolCallResponse(base, "call_canary_mcp", "write", {
      i: "Calling canary MCP echo",
      path: "xd://mcp__canary_echo_marker",
      content: JSON.stringify({ value: "CANARY_MCP_OK" }),
    });
  }

  if (!hasToolResult && hasTool(tools, "hub") && prompt.includes("CANARY_HUB_START")) {
    return toolCallResponse(base, "call_canary_hub", "hub", {
      i: "Starting canary sleeper",
      op: "start",
      name: `canary-sleeper-${Date.now()}`,
      application: "sleep",
      args: ["3600"],
      cwd: "/workspace/paseo-plugins",
      pty: false,
    });
  }

  if (!hasToolResult && hasTool(tools, "task") && prompt.includes("CANARY_NESTED_ROOT")) {
    return toolCallResponse(base, "call_canary_nested_root", "task", {
      context:
        "# Goal\nExercise nested Docker canary subagents.\n# Constraints\nDo not edit files.\n# Contract\nReturn CANARY_NESTED_CHILD_OK.",
      tasks: [
        {
          name: "CanaryNestedChild",
          task: "# Target\nNo files.\n# Change\nRun a task whose prompt contains CANARY_NESTED_LEAF, then return CANARY_NESTED_CHILD_OK.\n# Acceptance\nThe response contains CANARY_NESTED_CHILD_OK.",
        },
      ],
    });
  }

  if (!hasToolResult && hasTool(tools, "task") && prompt.includes("CANARY_NESTED_CHILD")) {
    return toolCallResponse(base, "call_canary_nested_child", "task", {
      context:
        "# Goal\nComplete the nested Docker canary leaf.\n# Constraints\nDo not edit files.\n# Contract\nReturn CANARY_NESTED_LEAF_OK.",
      tasks: [
        {
          name: "CanaryNestedLeaf",
          task: "# Target\nNo files.\n# Change\nReturn CANARY_NESTED_LEAF_OK.\n# Acceptance\nThe response contains CANARY_NESTED_LEAF_OK.",
        },
      ],
    });
  }

  if (!hasToolResult && hasTool(tools, "task") && prompt.includes("CANARY_SUBAGENT")) {
    return toolCallResponse(base, "call_canary_task", "task", {
      context:
        "# Goal\nExercise the Docker canary subagent path.\n# Constraints\nDo not edit files.\n# Contract\nReturn a short result.",
      tasks: [
        {
          name: "CanaryChild",
          task: "# Target\nNo files.\n# Change\nReturn CANARY_CHILD_OK.\n# Acceptance\nThe response contains CANARY_CHILD_OK.",
        },
      ],
    });
  }

  if (!hasToolResult && hasTool(tools, "bash") && prompt.includes("CANARY_TOOL")) {
    return toolCallResponse(base, "call_canary_bash", "bash", {
      command: "printf CANARY_TOOL_OK",
    });
  }

  const content = hasToolResult
    ? prompt.includes("CANARY_NESTED_ROOT")
      ? "CANARY_NESTED_ROOT_OK"
      : prompt.includes("CANARY_NESTED_CHILD")
        ? "CANARY_NESTED_CHILD_OK"
        : prompt.includes("CANARY_SUBAGENT")
          ? "CANARY_SUBAGENT_OK"
          : prompt.includes("CANARY_HUB_START")
            ? "CANARY_HUB_OK"
            : prompt.includes("CANARY_MCP")
              ? "CANARY_MCP_OK"
              : "CANARY_TOOL_OK"
    : prompt.includes("CANARY_NESTED_LEAF")
      ? "CANARY_NESTED_LEAF_OK"
      : "CANARY_MOCK_OK";
  return stream([
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ]);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/health") response = new Response("ok");
    else if (request.method === "GET" && url.pathname === "/last-request") {
      response = Response.json(lastPayload ?? {});
    } else if (request.method === "GET" && url.pathname === "/tools") {
      const tools =
        lastPayload && Array.isArray(lastPayload.tools)
          ? lastPayload.tools.flatMap((tool) => {
              const name = toolName(tool);
              return name ? [name] : [];
            })
          : [];
      response = Response.json({ tools });
    } else if (request.method === "GET" && url.pathname === "/v1/models") {
      response = Response.json({ object: "list", data: [{ id: model, object: "model" }] });
    } else if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      lastPayload = (await request.json()) as Record<string, unknown>;
      response = await chatResponse(lastPayload);
    } else response = Response.json({ error: "not found" }, { status: 404 });
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, "0.0.0.0");

process.stdout.write(`mock LLM listening on 0.0.0.0:${port}\n`);
