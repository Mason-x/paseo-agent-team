import path from "node:path";
import type { z } from "zod";
import { checkLedgerInvariants } from "../../shared/domain/run-engine/invariants";
import {
  RUN_HARD_BYTES,
  RUN_SCHEMA_VERSION,
  RUN_SOFT_BYTES,
  type RunRecord,
  RunRecordSchema,
  type RunResourceClaimSchema,
} from "../../shared/schemas/run-engine/ledger";
import {
  type AtomicCommitResult,
  type AtomicJsonCodec,
  AtomicJsonError,
  type AtomicJsonFile,
  type AtomicRead,
  createAtomicJson,
  ensureLedgerDirs,
  type LedgerFs,
  type LedgerRoots,
  nodeLedgerFs,
  resolveLedgerRoots,
} from "../ledger/atomic-json";
import {
  acquireProcessLock,
  type ProcessLock,
  type ProcessLockOptions,
} from "../ledger/process-lock";

type RunResourceClaim = z.infer<typeof RunResourceClaimSchema>;

const RECORD_FILE = /^(run-[a-z0-9]+-[a-z0-9]+)\.json$/u;
const LOCK_NAME = "store.lock";

export type RunStoreErrorCode =
  | "not-initialized"
  | "closed"
  | "already-exists"
  | "not-found"
  | "unrecoverable-run"
  | "invalid-first-revision";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;
  constructor(code: RunStoreErrorCode, detail?: string) {
    super(detail ? `run store ${code}: ${detail}` : `run store ${code}`);
    this.name = "RunStoreError";
    this.code = code;
  }
}

/** Why a record file could not be trusted at startup or on a later read. */
export type RunUnrecoverableReason =
  | "corrupt"
  | "unknown-version"
  | "unreadable"
  | "oversize"
  | "invariant";

export type RunStoreEntry = {
  runId: string;
  lifecycle: RunRecord["lifecycle"];
  revision: number;
  digest: string;
  updatedAt: string;
  bytes: number;
  needsCompaction: boolean;
};

export type RunStoreBroken = {
  runId: string;
  reason: RunUnrecoverableReason;
};

/**
 * Resource claims held by every OTHER Run. When any record could not be read, the holders of that
 * record are unknown, so the view is untrusted and a grant must be refused or frozen: a missing
 * index entry is never evidence that a resource is free.
 */
export type OtherResources =
  | { trusted: true; claims: readonly RunResourceClaim[] }
  | { trusted: false; claims: readonly RunResourceClaim[]; broken: readonly RunStoreBroken[] };

export type RunUpdateContext = {
  readonly otherResources: OtherResources;
};

/** The mutator is synchronous on purpose: nothing may wait on Paseo or a model under the write lock. */
export type RunMutator = (current: RunRecord, context: RunUpdateContext) => RunRecord | null;

export type RunUpdateResult =
  | ({ status: "committed"; record: RunRecord } & AtomicCommitResult)
  | { status: "unchanged"; record: RunRecord; revision: number; digest: string };

export type RunStoreReadResult =
  | { status: "ok"; record: RunRecord; revision: number; digest: string; bytes: number }
  | { status: "missing" }
  | { status: "unknown-version"; schemaVersion: number; digest: string }
  | { status: "corrupt"; reason: string; digest: string | null; issuePath: string | null };

export type RunStoreOptions = {
  /** Explicit PASEO_HOME. Never defaulted: undefined leaves the store unavailable. */
  home: string | undefined;
  fs?: LedgerFs;
  lock?: Pick<
    ProcessLockOptions,
    "files" | "clock" | "ids" | "sleeper" | "processes" | "acquireTimeoutMs"
  >;
  clock?: { now(): string };
  ids?: { next(): string };
  limits?: { softBytes?: number; hardBytes?: number };
  log?: (message: string, detail?: unknown) => void;
};

function invariantStrings(record: RunRecord): string[] {
  const report = checkLedgerInvariants(record);
  if (report.ok) return [];
  return report.violations.map((violation) => `${violation.invariant}@${violation.path.join(".")}`);
}

export const runRecordCodec: AtomicJsonCodec<RunRecord> = {
  schemaVersion: RUN_SCHEMA_VERSION,
  parse(value) {
    return RunRecordSchema.parse(value);
  },
  readHeader(record) {
    return {
      schemaVersion: record.schemaVersion,
      revision: record.revision,
      previousDigest: record.previousDigest,
    };
  },
  withHeader(record, header) {
    return { ...record, revision: header.revision, previousDigest: header.previousDigest };
  },
  invariant: invariantStrings,
};

function agentsOf(record: RunRecord): Set<string> {
  const agents = new Set<string>();
  for (const seat of record.roster) if (seat.agentId) agents.add(seat.agentId);
  for (const entry of record.assignments) agents.add(entry.agentId);
  for (const entry of record.nonceRegistry) agents.add(entry.agentId);
  return agents;
}

type Slot = {
  file: AtomicJsonFile<RunRecord>;
  entry: RunStoreEntry | null;
  broken: RunUnrecoverableReason | null;
  claims: readonly RunResourceClaim[];
  /** Agents the record names (assignments, roster, nonce registry), for hook ownership lookups. */
  agents: ReadonlySet<string>;
};

/**
 * Single-writer Run ledger.
 *
 * One process lock on the ledger root makes this process the only writer. Every mutation of any Run
 * goes through one queue, so a cross-Run resource decision reads and commits against the same
 * authority and two Runs can never both see a file as free. The resource view is a derived index:
 * it is rebuilt from the Run records at `initialize()` and refreshed only after a successful
 * commit. A record that cannot be read leaves its holders unknown, which makes the view untrusted.
 *
 * What this does not provide: it does not stop another process that ignores the lock, and it gives
 * no exactly-once guarantee for anything outside the ledger. Outbox intents are recorded here;
 * executing them is a separate step that must reconcile with the host.
 */
export function createRunStore(options: RunStoreOptions) {
  const files = options.fs ?? nodeLedgerFs;
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const log = options.log ?? (() => undefined);
  const hardBytes = options.limits?.hardBytes ?? RUN_HARD_BYTES;
  const softBytes = options.limits?.softBytes ?? RUN_SOFT_BYTES;

  let roots: LedgerRoots | null = null;
  let lock: ProcessLock | null = null;
  let state: "new" | "ready" | "closed" = "new";
  let initializing: Promise<void> | null = null;
  const slots = new Map<string, Slot>();
  /** Files in the records directory we could not even attribute to a Run id. */
  const strays = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function requireReady(): LedgerRoots {
    if (state === "closed") throw new RunStoreError("closed");
    if (state !== "ready" || roots === null) throw new RunStoreError("not-initialized");
    return roots;
  }

  function slotFor(runId: string, layout: LedgerRoots): Slot {
    const existing = slots.get(runId);
    if (existing) return existing;
    const slot: Slot = {
      file: createAtomicJson({
        file: path.join(layout.records, `${runId}.json`),
        issuesDir: layout.issues,
        containmentRoot: layout.root,
        codec: runRecordCodec,
        fs: files,
        clock,
        ids: options.ids,
        limits: { softBytes, hardBytes },
        guard: () => lock?.assertHeld(),
        onIssueError: (error) => log("run ledger issue not recorded", error),
      }),
      entry: null,
      broken: null,
      claims: [],
      agents: new Set(),
    };
    slots.set(runId, slot);
    return slot;
  }

  function applyRead(runId: string, slot: Slot, read: AtomicRead<RunRecord>): void {
    if (read.status === "ok") {
      slot.broken = null;
      slot.claims = read.record.resources;
      slot.agents = agentsOf(read.record);
      slot.entry = {
        runId,
        lifecycle: read.record.lifecycle,
        revision: read.revision,
        digest: read.digest,
        updatedAt: read.record.updatedAt,
        bytes: read.bytes,
        needsCompaction: read.needsCompaction,
      };
      return;
    }
    slot.entry = null;
    slot.claims = [];
    slot.agents = new Set();
    if (read.status === "missing") {
      slot.broken = null;
      return;
    }
    if (read.status === "unknown-version") {
      slot.broken = "unknown-version";
      return;
    }
    slot.broken =
      read.reason === "oversize"
        ? "oversize"
        : read.reason === "invariant"
          ? "invariant"
          : "corrupt";
  }

  async function scan(layout: LedgerRoots): Promise<void> {
    let names: string[];
    try {
      names = await files.readdir(layout.records);
    } catch (error) {
      throw new AtomicJsonError(
        "unreadable",
        error instanceof Error ? error.message : String(error),
      );
    }
    strays.clear();
    for (const name of names.sort()) {
      if (name.startsWith(".") && name.endsWith(".tmp")) continue;
      const match = RECORD_FILE.exec(name);
      if (!match?.[1]) {
        // An unattributable file might be a record under a bad name; its holders are unknown.
        strays.add(name);
        continue;
      }
      const runId = match[1];
      const slot = slotFor(runId, layout);
      try {
        applyRead(runId, slot, await slot.file.read());
      } catch (error) {
        slot.entry = null;
        slot.claims = [];
        slot.agents = new Set();
        slot.broken = "unreadable";
        log(`run ${runId} could not be read`, error);
      }
    }
  }

  async function doInitialize(): Promise<void> {
    const layout = await resolveLedgerRoots(options.home, files);
    await ensureLedgerDirs(layout, files);
    const acquired = await acquireProcessLock({
      file: path.join(layout.root, LOCK_NAME),
      ...options.lock,
    });
    try {
      // The lock is held: no other process may be committing, so leftover temp files are dead.
      const names = await files.readdir(layout.records);
      for (const name of names) {
        const match = /^\.(run-[a-z0-9]+-[a-z0-9]+\.json)\..+\.tmp$/u.exec(name);
        if (match) await files.rm(path.join(layout.records, name)).catch(() => undefined);
      }
      roots = layout;
      lock = acquired;
      await scan(layout);
      state = "ready";
    } catch (error) {
      roots = null;
      lock = null;
      await acquired.release().catch(() => undefined);
      throw error;
    }
  }

  function otherResources(runId: string): OtherResources {
    const claims: RunResourceClaim[] = [];
    const broken: RunStoreBroken[] = [];
    for (const [id, slot] of slots) {
      if (slot.broken !== null) {
        broken.push({ runId: id, reason: slot.broken });
        continue;
      }
      if (id !== runId) claims.push(...slot.claims);
    }
    for (const name of strays) broken.push({ runId: name, reason: "corrupt" });
    return broken.length === 0 ? { trusted: true, claims } : { trusted: false, claims, broken };
  }

  function toReadResult(read: AtomicRead<RunRecord>): RunStoreReadResult {
    if (read.status === "ok") {
      return {
        status: "ok",
        record: read.record,
        revision: read.revision,
        digest: read.digest,
        bytes: read.bytes,
      };
    }
    if (read.status === "missing") return { status: "missing" };
    if (read.status === "unknown-version") {
      return {
        status: "unknown-version",
        schemaVersion: read.schemaVersion,
        digest: read.digest,
      };
    }
    return {
      status: "corrupt",
      reason: read.reason,
      digest: read.digest,
      issuePath: read.issuePath,
    };
  }

  function assertValid(next: RunRecord): void {
    const parsed = RunRecordSchema.safeParse(next);
    if (!parsed.success) {
      throw new AtomicJsonError(
        "invalid-record",
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    }
  }

  return {
    /** Idempotent. Failure leaves the store unusable; callers surface it and may retry. */
    initialize(): Promise<void> {
      if (state === "ready") return Promise.resolve();
      if (state === "closed") return Promise.reject(new RunStoreError("closed"));
      initializing ??= doInitialize().finally(() => {
        initializing = null;
      });
      return initializing;
    },

    get ready(): boolean {
      return state === "ready";
    },

    /** Re-reads every record from disk and rebuilds the derived index. Reads only. */
    reconcile(): Promise<void> {
      return enqueue(async () => {
        const layout = requireReady();
        for (const slot of slots.values()) {
          slot.entry = null;
          slot.claims = [];
          slot.agents = new Set();
          slot.broken = null;
        }
        await scan(layout);
      });
    },

    get(runId: string): Promise<RunStoreReadResult> {
      return enqueue(async () => {
        const layout = requireReady();
        const slot = slotFor(runId, layout);
        const read = await slot.file.read();
        applyRead(runId, slot, read);
        return toReadResult(read);
      });
    },

    list(): Promise<{ entries: RunStoreEntry[]; broken: RunStoreBroken[] }> {
      return enqueue(async () => {
        requireReady();
        const entries: RunStoreEntry[] = [];
        const broken: RunStoreBroken[] = [];
        for (const [runId, slot] of slots) {
          if (slot.entry) entries.push(slot.entry);
          else if (slot.broken) broken.push({ runId, reason: slot.broken });
        }
        for (const name of strays) broken.push({ runId: name, reason: "corrupt" });
        entries.sort((a, b) => a.runId.localeCompare(b.runId));
        return { entries, broken };
      });
    },

    /** Runs whose ledger names this agent. Answered from the index; unreadable runs are not guessed. */
    runsForAgent(agentId: string): Promise<string[]> {
      return enqueue(async () => {
        requireReady();
        return [...slots]
          .filter(([, slot]) => slot.agents.has(agentId))
          .map(([runId]) => runId)
          .sort();
      });
    },

    /** Resource view as another Run would see it. Mainly for diagnostics and tests. */
    resourcesExcluding(runId: string): Promise<OtherResources> {
      return enqueue(async () => {
        requireReady();
        return otherResources(runId);
      });
    },

    /** Writes revision 1. Refuses to overwrite anything already at that path. */
    create(record: RunRecord): Promise<RunUpdateResult> {
      return enqueue(async () => {
        const layout = requireReady();
        if (record.revision !== 1 || record.previousDigest !== "") {
          throw new RunStoreError("invalid-first-revision", "revision must be 1 with no digest");
        }
        assertValid(record);
        const slot = slotFor(record.runId, layout);
        const current = await slot.file.read();
        if (current.status !== "missing") {
          applyRead(record.runId, slot, current);
          throw new RunStoreError("already-exists", record.runId);
        }
        try {
          const committed = await slot.file.commit(record, { revision: 0, digest: "" });
          applyRead(record.runId, slot, {
            status: "ok",
            record,
            revision: committed.revision,
            digest: committed.digest,
            bytes: committed.bytes,
            needsCompaction: committed.needsCompaction,
          });
          return { status: "committed", record, ...committed };
        } catch (error) {
          // The outcome of a failed commit is unknown until re-read; never assume nothing landed.
          applyRead(
            record.runId,
            slot,
            await slot.file.read().catch(() => ({ status: "missing" }) as const),
          );
          throw error;
        }
      });
    },

    /**
     * Read, mutate, commit under CAS. The mutator sees the other Runs' claims so a grant is decided
     * against one authority. Returning null leaves the record untouched. The store owns the header
     * fields: whatever revision/previousDigest the mutator sets is overwritten.
     */
    update(runId: string, mutate: RunMutator): Promise<RunUpdateResult> {
      return enqueue(async () => {
        const layout = requireReady();
        const slot = slotFor(runId, layout);
        const read = await slot.file.read();
        applyRead(runId, slot, read);
        if (read.status === "missing") throw new RunStoreError("not-found", runId);
        if (read.status !== "ok") throw new RunStoreError("unrecoverable-run", runId);
        const proposed = mutate(structuredClone(read.record), {
          otherResources: otherResources(runId),
        });
        if (proposed === null) {
          return {
            status: "unchanged",
            record: read.record,
            revision: read.revision,
            digest: read.digest,
          };
        }
        const next: RunRecord = {
          ...proposed,
          runId: read.record.runId,
          schemaVersion: read.record.schemaVersion,
          revision: read.revision + 1,
          previousDigest: read.digest,
        };
        assertValid(next);
        try {
          const committed = await slot.file.commit(next, {
            revision: read.revision,
            digest: read.digest,
          });
          applyRead(runId, slot, {
            status: "ok",
            record: next,
            revision: committed.revision,
            digest: committed.digest,
            bytes: committed.bytes,
            needsCompaction: committed.needsCompaction,
          });
          return { status: "committed", record: next, ...committed };
        } catch (error) {
          applyRead(
            runId,
            slot,
            await slot.file.read().catch(() => ({ status: "missing" }) as const),
          );
          throw error;
        }
      });
    },

    async close(): Promise<void> {
      if (state === "closed") return;
      await initializing?.catch(() => undefined);
      await queue.catch(() => undefined);
      state = "closed";
      const held = lock;
      lock = null;
      if (held) await held.release();
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
