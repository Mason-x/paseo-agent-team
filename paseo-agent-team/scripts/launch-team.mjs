// Launches a Team from a terminal through the plugin's RPC, the same path as the Launch dialog:
// the host validates, plans, and creates the agents; this script only waits and reports.
//
//   node scripts/launch-team.mjs --host 127.0.0.1:6767 --team coding-team \
//     --workspace <workspaceId> "Add Stripe billing"
//   node scripts/launch-team.mjs --host 127.0.0.1:6767 --team coding-team \
//     --project <projectId> --title "Billing" "Add Stripe billing"
//
// --host is required and has no default, so a launch never lands on a daemon by accident.
import { parseArgs } from "node:util";
import { createHostClient } from "@getpaseo/client/node";

const PLUGIN_ID = "paseo-agent-team";
const POLL_MS = 1000;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    team: { type: "string" },
    workspace: { type: "string" },
    project: { type: "string" },
    title: { type: "string" },
    timeout: { type: "string", default: "300" },
    "no-wait": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const usage = `Usage: node scripts/launch-team.mjs --host <host:port> --team <teamId> \\
         (--workspace <workspaceId> | --project <projectId> [--title <name>]) \\
         [--no-wait] [--timeout <seconds>] [--json] "<task>"`;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}
const task = positionals.join(" ").trim();
if (!values.host) fail(`--host is required.\n${usage}`);
if (!values.team) fail(`--team is required.\n${usage}`);
if (!task) fail(`A task is required.\n${usage}`);
if (Boolean(values.workspace) === Boolean(values.project)) {
  fail(`Pass exactly one of --workspace or --project.\n${usage}`);
}
const timeoutMs = Number(values.timeout) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number.");

const target = values.workspace
  ? { kind: "workspace", workspaceId: values.workspace }
  : {
      kind: "new-workspace",
      projectId: values.project,
      ...(values.title ? { title: values.title } : {}),
    };

const client = createHostClient(values.host, {
  clientId: `agent-team-launch-${process.pid}`,
  clientType: "cli",
  reconnect: { enabled: false },
});

const out = (line) => {
  if (!values.json) console.log(line);
};

try {
  await client.connect();
  const started = await client.invokePluginRpc(PLUGIN_ID, "agent-team.launch.start", {
    teamId: values.team,
    task,
    target,
  });
  if (!started.ok) {
    if (values.json) console.log(JSON.stringify(started, null, 2));
    else {
      console.error("Cannot launch:");
      for (const blocker of started.blockers) console.error(`  - ${blocker}`);
    }
    process.exitCode = 2;
  } else {
    let job = started.job;
    for (const warning of job.warnings) out(`warning: ${warning}`);
    out(`run ${job.runId}: ${job.teamName}, ${job.memberTotal} members`);
    if (!values["no-wait"]) {
      const deadline = Date.now() + timeoutMs;
      let lastStep = "";
      while (job.state === "running") {
        const step =
          job.step === "member" ? `member ${job.memberIndex}/${job.memberTotal}` : job.step;
        if (step !== lastStep) out(`  ${step}`);
        lastStep = step;
        if (Date.now() > deadline)
          fail(`Timed out after ${values.timeout}s; run ${job.runId} continues on the host.`, 3);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const status = await client.invokePluginRpc(PLUGIN_ID, "agent-team.launch.status", {
          runId: job.runId,
        });
        if (!status.job) fail(`The host no longer knows run ${job.runId}.`, 3);
        job = status.job;
      }
    }
    if (values.json) console.log(JSON.stringify(job, null, 2));
    else if (job.state === "succeeded") {
      out(`launched in workspace ${job.workspaceId}`);
      out(`  coordinator ${job.coordinatorId}`);
      for (const id of job.memberIds) out(`  member      ${id}`);
    } else if (job.state === "failed") {
      console.error(`Launch failed at ${job.error.step}: ${job.error.message}`);
      if (job.error.detail) console.error(`  ${job.error.detail}`);
      if (job.error.kickoffMessage)
        console.error(
          `\nKickoff message to send the coordinator by hand:\n${job.error.kickoffMessage}`,
        );
      process.exitCode = 1;
    }
  }
} catch (error) {
  fail(`Launch request failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close().catch(() => undefined);
}
