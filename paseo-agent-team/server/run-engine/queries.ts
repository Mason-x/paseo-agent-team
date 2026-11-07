import type { z } from "zod";
import type {
  RunGetInputSchema,
  RunGetOutputSchema,
  RunIssueView,
  RunListInputSchema,
  RunListOutputSchema,
} from "../../shared/schemas/run-engine/rpc";
import { RUN_CONTRACT_VERSION } from "../../shared/schemas/run-engine/rpc";
import { RUN_ACTION_CONTROLS } from "../../shared/schemas/run-engine/rpc-actions";
import {
  HISTORY_PAGE_SIZE,
  historyPage,
  OBSERVATION_CAPABILITIES,
  projectDetail,
  projectSummary,
} from "./projection";
import type { RunStore, RunStoreBroken } from "./store";

type ListInput = z.input<typeof RunListInputSchema>;
type ListOutput = z.input<typeof RunListOutputSchema>;
type GetInput = z.input<typeof RunGetInputSchema>;
type GetOutput = z.input<typeof RunGetOutputSchema>;
type Health = ListOutput["health"][number];

const RUN_ID = /^run-[a-z0-9]+-[a-z0-9]+$/u;
const LIST_DEFAULT = 20;

const FAILURE_ISSUE = {
  missing: "run-missing",
  corrupt: "run-corrupt",
  "unknown-version": "run-unknown-version",
} as const;

function failureIssue(code: string): RunIssueView {
  return { code, severity: "error", path: [], params: {}, action: "inspect" };
}

function encodeListCursor(updatedAt: string, runId: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt, r: runId }), "utf8").toString("base64url");
}

function decodeListCursor(cursor: string): { u: string; r: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { u, r } = value as Record<string, unknown>;
    return typeof u === "string" && typeof r === "string" ? { u, r } : null;
  } catch {
    return null;
  }
}

function healthOf(broken: RunStoreBroken): Health {
  const runId = RUN_ID.test(broken.runId) ? broken.runId : null;
  if (broken.reason === "unknown-version") {
    return {
      runId,
      status: "unknown-version",
      summary: "written by a newer version; left untouched",
    };
  }
  if (broken.reason === "unreadable") {
    return { runId, status: "unavailable", summary: "record could not be read" };
  }
  return {
    runId,
    status: "corrupt",
    summary: `record is damaged (${broken.reason}); left untouched`,
  };
}

/**
 * Read-only queries. No method here sends, creates, cancels or advances anything. The only disk
 * write a read can cause is the store's own quarantine note for a record it finds damaged.
 */
export function createRunQueries(deps: { store: RunStore; ensureReady: () => Promise<void> }) {
  const { store } = deps;
  return {
    async list(input: ListInput): Promise<ListOutput> {
      await deps.ensureReady();
      // The list is not about one Run: it names the controls this build has. A Run's own detail says
      // which of them it can use.
      const capabilities = {
        ...OBSERVATION_CAPABILITIES,
        supportedControls: [...RUN_ACTION_CONTROLS],
      };
      if (!store.ready) {
        return {
          runContractVersion: RUN_CONTRACT_VERSION,
          capabilities,
          runs: [],
          nextCursor: null,
          health: [{ runId: null, status: "unavailable", summary: "run store is not available" }],
        };
      }
      const { entries, broken } = await store.list();
      const ordered = [...entries].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId),
      );
      const after = input.cursor === undefined ? null : decodeListCursor(input.cursor);
      const start = after
        ? ordered.findIndex(
            (entry) =>
              entry.updatedAt.localeCompare(after.u) < 0 ||
              (entry.updatedAt === after.u && entry.runId.localeCompare(after.r) > 0),
          )
        : 0;
      const rest = start < 0 ? [] : ordered.slice(start);
      const limit = input.limit ?? LIST_DEFAULT;
      const page = rest.slice(0, limit);
      const runs: ListOutput["runs"] = [];
      const health: Health[] = broken.map(healthOf);
      for (const entry of page) {
        const read = await store.get(entry.runId);
        if (read.status !== "ok") {
          health.push(
            read.status === "unknown-version"
              ? { runId: entry.runId, status: "unknown-version", summary: "left untouched" }
              : { runId: entry.runId, status: "corrupt", summary: "left untouched" },
          );
          continue;
        }
        const summary = projectSummary(read.record);
        if (summary) runs.push(summary);
        else {
          health.push({
            runId: entry.runId,
            status: "corrupt",
            summary: "summary is not projectable",
          });
        }
      }
      const last = page.at(-1);
      return {
        runContractVersion: RUN_CONTRACT_VERSION,
        capabilities,
        runs,
        nextCursor:
          rest.length > page.length && last ? encodeListCursor(last.updatedAt, last.runId) : null,
        health: health.slice(0, 50),
      };
    },

    async get(input: GetInput): Promise<GetOutput> {
      await deps.ensureReady();
      const base = { runContractVersion: RUN_CONTRACT_VERSION } as const;
      if (!store.ready) {
        return { ...base, status: "missing", run: null, issues: [failureIssue("run-missing")] };
      }
      const read = await store.get(input.runId);
      if (read.status === "missing") {
        return {
          ...base,
          status: "missing",
          run: null,
          issues: [failureIssue(FAILURE_ISSUE.missing)],
        };
      }
      if (read.status === "unknown-version") {
        return {
          ...base,
          status: "unknown-version",
          run: null,
          issues: [failureIssue(FAILURE_ISSUE["unknown-version"])],
        };
      }
      if (read.status === "corrupt") {
        return {
          ...base,
          status: "corrupt",
          run: null,
          issues: [failureIssue(FAILURE_ISSUE.corrupt)],
        };
      }
      if (input.knownRevision !== undefined && input.knownRevision === read.revision) {
        return { ...base, status: "unchanged", revision: read.revision };
      }
      const detail = projectDetail(read.record);
      if (!detail.ok) {
        return { ...base, status: "corrupt", run: null, issues: detail.issues };
      }
      const history = historyPage(
        read.record,
        input.historyCursor,
        input.limit ?? HISTORY_PAGE_SIZE,
      );
      return {
        ...base,
        status: "ready",
        run: detail.view,
        history: history.page,
        issues: history.issues,
      };
    },
  };
}

export type RunQueries = ReturnType<typeof createRunQueries>;
