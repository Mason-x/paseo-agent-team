// Exercises the version RPCs against one explicit development daemon.
// Both selectors are required; this script has no default home or host.
//
//   node scripts/version-drill.mjs --home "$PWD/.paseo-dev" --host "$DEV_HOST" check
//   node scripts/version-drill.mjs --home "$PWD/.paseo-dev" --host "$DEV_HOST" update
//   node scripts/version-drill.mjs --home "$PWD/.paseo-dev" --host "$DEV_HOST" status
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHostClient } from "@getpaseo/client/node";

const PLUGIN_ID = "paseo-agent-team";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: "string" },
    host: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const usage = `Usage: node scripts/version-drill.mjs --home <paseo-home> --host <host:port> <check|update|status>`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.home) fail(`--home is required and has no default.\n${usage}`);
if (!values.host) fail(`--host is required and has no default.\n${usage}`);
const devHome = path.resolve(import.meta.dirname, "..", ".paseo-dev");
if (path.resolve(values.home) !== devHome) fail(`--home must be ${devHome}`);
if (/(?:^|:)6767$/.test(values.host)) fail("--host must not be the default daemon port 6767");
const action = positionals[0];
if (action !== "check" && action !== "update" && action !== "status") fail(usage);
process.env.PASEO_HOME = devHome;

const client = createHostClient(values.host, {
  clientId: `agent-team-version-${process.pid}`,
  clientType: "cli",
  reconnect: { enabled: false },
});

try {
  await client.connect();
  const pid = JSON.parse(await readFile(path.join(devHome, "paseo.pid"), "utf8"));
  const serverId = (await readFile(path.join(devHome, "server-id"), "utf8")).trim();
  if (!pid.serverId || pid.serverId !== serverId)
    fail("daemon serverId does not match this development home");
  if (
    pid.listen &&
    values.host !== pid.listen &&
    !values.host.endsWith(String(pid.listen).replace(/^.*:/, ":"))
  ) {
    fail(`--host does not match ${pid.listen} in ${path.join(devHome, "paseo.pid")}`);
  }
  if (action === "status") {
    console.log(
      JSON.stringify(
        await client.invokePluginRpc(PLUGIN_ID, "agent-team.version.update.status", {}),
        null,
        2,
      ),
    );
  } else if (action === "check") {
    const started = await client.invokePluginRpc(PLUGIN_ID, "agent-team.version.check", {
      requestId: randomUUID(),
    });
    console.log(JSON.stringify(started, null, 2));
    if (!started.ok) process.exitCode = 1;
  } else {
    const checked = await client.invokePluginRpc(PLUGIN_ID, "agent-team.version.check", {
      requestId: randomUUID(),
    });
    const checkId = checked.job?.result?.checkId;
    if (!checked.ok || !checkId) fail("check did not produce an actionable checkId");
    const started = await client.invokePluginRpc(PLUGIN_ID, "agent-team.version.update.start", {
      requestId: randomUUID(),
      checkId,
    });
    console.log(JSON.stringify(started, null, 2));
    if (!started.ok) process.exitCode = 1;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "version drill failed");
} finally {
  await client.close?.();
}
