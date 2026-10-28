// Launches a Team from a terminal through the plugin's RPC, the same path as the Launch dialog:
// the host validates, plans, and creates the agents; this script only waits and reports.
//
//   node scripts/launch-team.mjs --host 127.0.0.1:6767 --team coding-team \
//     --workspace <workspaceId> "Add Stripe billing"
//   node scripts/launch-team.mjs --host 127.0.0.1:6767 --team coding-team \
//     --project <projectId> --title "Billing" "Add Stripe billing"
//
// --host is required and has no default, so a launch never lands on a daemon by accident.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHostClient } from "@getpaseo/client/node";

const PLUGIN_ID = "paseo-agent-team";
const POLL_MS = 1000;

/** Accepted `--mode` spellings. `standard` is the new name for the stored `economy` value. */
export const MODE_VALUES = ["sota", "standard", "economy", "economy-all", "collaborative"];

export const DEPRECATED_ECONOMY_NOTICE =
  "--mode economy is the old spelling of the standard mode; use --mode standard " +
  "(or --mode economy-all for the all-seats economy mode).";

export const usage = `Usage: node scripts/launch-team.mjs --host <host:port> --team <teamId> \\
         (--workspace <workspaceId> | --project <projectId> [--title <name>]) \\
         [--mode <mode>] [--no-wait] [--timeout <seconds>] [--json] "<task>"

The Team's saved mode is used unless --mode is passed. --mode is an advanced override for
scripts and tests only (never written back to the Team):
  sota          旗舰（SOTA）: keep every Role's original binding
  standard      standard: decision keeps its binding, execution uses the standard pool
  economy       legacy spelling of standard; a notice is printed and the mode stays standard
  economy-all   经济（全席位）: every seat uses only eligible cheap Profiles per route; a route
                without a qualified candidate blocks the launch
  collaborative 协作: execution seats fan out across families

Every request declares contractVersion 2 so a daemon with the new mode contract can accept
economy-all and its before-override access gate; older daemons ignore the field.`;

/**
 * Maps a CLI spelling to the wire value. `standard` and the legacy `economy` both mean the
 * stored `economy` mode (shown as 标准); only `economy-all` is the all-seats mode.
 */
export function resolveMode(raw) {
  if (raw === undefined) return { ok: true, mode: undefined, deprecated: false };
  if (raw === "standard") return { ok: true, mode: "economy", deprecated: false };
  if (raw === "economy") return { ok: true, mode: "economy", deprecated: true };
  if (raw === "sota" || raw === "economy-all" || raw === "collaborative") {
    return { ok: true, mode: raw, deprecated: false };
  }
  return { ok: false };
}

/** The preview/start payload. `contractVersion` appears exactly once and only as 2. */
export function buildLaunchRequest({ teamId, task, target, mode }) {
  return {
    teamId,
    task,
    target,
    ...(mode === undefined ? {} : { mode }),
    contractVersion: 2,
  };
}

/** Status polling also declares v2 so a new-mode job is not projected for a stale caller. */
export function buildStatusRequest(runId) {
  return { runId, contractVersion: 2 };
}

/** The notice printed for the legacy `--mode economy` spelling, or undefined. */
export function modeNotice(resolved) {
  return resolved.ok && resolved.deprecated ? DEPRECATED_ECONOMY_NOTICE : undefined;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      team: { type: "string" },
      workspace: { type: "string" },
      project: { type: "string" },
      title: { type: "string" },
      mode: { type: "string" },
      timeout: { type: "string", default: "300" },
      "no-wait": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

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
  const resolvedMode = resolveMode(values.mode);
  if (!resolvedMode.ok) {
    fail(`--mode must be one of ${MODE_VALUES.join(", ")}.\n${usage}`);
  }
  const notice = modeNotice(resolvedMode);
  if (notice !== undefined) console.error(notice);
  const mode = resolvedMode.mode;
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

  void (async () => {
    try {
      await client.connect();
      const request = buildLaunchRequest({
        teamId: values.team,
        task,
        target,
        mode,
      });
      const preview = await client.invokePluginRpc(PLUGIN_ID, "agent-team.launch.preview", request);
      if (!preview.ok) {
        if (values.json) console.log(JSON.stringify(preview, null, 2));
        else {
          console.error("Cannot preview:");
          for (const blocker of preview.blockers) console.error(`  - ${blocker}`);
          for (const issue of preview.issues) {
            if (issue.severity === "warning") console.error(`  warning: ${issue.code}`);
          }
        }
        process.exitCode = 2;
      } else {
        const plan = preview.preview;
        out(
          `mode ${plan.requestedMode}; seats ${plan.counts.physical} ` +
            `(${plan.counts.eager} eager, ${plan.counts.deferred} deferred, ` +
            `${plan.counts.escalation} standby); budget economy=${plan.budget.economy} ` +
            `sota=${plan.budget.sota} unknown=${plan.budget.unknown}`,
        );
        for (const issue of plan.issues) out(`  ${issue.severity}: ${issue.code}`);
        for (const warning of plan.warnings) out(`  warning: ${warning}`);
        out(`plan ${plan.planHash}`);
        const started = await client.invokePluginRpc(PLUGIN_ID, "agent-team.launch.start", {
          ...request,
          expectedPlanHash: plan.planHash,
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
                fail(
                  `Timed out after ${values.timeout}s; run ${job.runId} continues on the host.`,
                  3,
                );
              await new Promise((resolve) => setTimeout(resolve, POLL_MS));
              const status = await client.invokePluginRpc(
                PLUGIN_ID,
                "agent-team.launch.status",
                buildStatusRequest(job.runId),
              );
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
      }
    } catch (error) {
      fail(`Launch request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  })();
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (invokedDirectly) main();
