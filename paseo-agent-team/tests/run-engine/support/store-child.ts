// Child process entry for the real-process store tests. Bundled by the test (no TS runner needed).
// It exists so a crash is a real process exit at a chosen file-system step, not a thrown error.
import { nodeLedgerFs } from "../../../server/ledger/atomic-json";
import { createRunStore } from "../../../server/run-engine/store";

type Args = {
  home: string;
  runId?: string;
  point?: "after-tmp" | "before-rename" | "after-rename";
  holdMs?: number;
  acquireTimeoutMs?: number;
};

const [mode, raw] = process.argv.slice(2);
const args = JSON.parse(raw ?? "{}") as Args;

function report(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

const crashingFs = {
  ...nodeLedgerFs,
  async writeFileExclusive(target: string, content: string) {
    await nodeLedgerFs.writeFileExclusive(target, content);
    if (args.point === "after-tmp" && target.endsWith(".tmp")) process.exit(41);
  },
  async rename(from: string, to: string) {
    if (args.point === "before-rename") process.exit(41);
    await nodeLedgerFs.rename(from, to);
    if (args.point === "after-rename") process.exit(41);
  },
};

try {
  const store = createRunStore({
    home: args.home,
    fs: mode === "update-crash" ? crashingFs : nodeLedgerFs,
    lock: { acquireTimeoutMs: args.acquireTimeoutMs ?? 2000 },
  });
  await store.initialize();
  if (mode === "update-crash" && args.runId) {
    // Reaching the report means the crash point was never hit; the test treats that as a failure.
    await store.update(args.runId, (record) => ({
      ...record,
      dagRevision: record.dagRevision + 1,
    }));
    report({ ok: true, crashed: false });
    await store.close();
    process.exit(0);
  }
  if (mode === "hold") {
    report({ ok: true, pid: process.pid });
    await new Promise((resolve) => setTimeout(resolve, args.holdMs ?? 60_000));
    await store.close();
    process.exit(0);
  }
  report({ ok: false, error: `unknown mode ${mode}` });
  process.exit(2);
} catch (error) {
  report({ ok: false, code: (error as { code?: string }).code ?? "unknown" });
  process.exit(3);
}
