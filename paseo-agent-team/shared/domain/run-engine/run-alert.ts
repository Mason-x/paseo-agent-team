import type { RunRecord } from "../../schemas/run-engine/ledger";

/**
 * Raises a Run-level alert (something a person should see that belongs to no single task) and an
 * audit event. The caller derives `alertId` from the text, so the same problem observed again finds
 * its own alert: an open one is left alone, a resolved or acknowledged one is opened again. The
 * record is copied; the caller's value is never mutated.
 */
export type RaisedAlert = { changed: boolean; next: RunRecord };

export function raiseAlert(
  record: RunRecord,
  alert: { alertId: string; severity: "info" | "warning" | "critical"; summary: string },
  now: string,
): RaisedAlert {
  const summary = alert.summary.slice(0, 1000);
  const { alertId } = alert;
  const existing = record.alerts.find((entry) => entry.alertId === alertId);
  if (existing?.state === "open") return { changed: false, next: record };

  const next = structuredClone(record);
  const fresh = {
    alertId,
    state: "open" as const,
    severity: alert.severity,
    summary,
    createdAt: now,
    acknowledgedAt: null,
    resolvedAt: null,
  };
  const index = next.alerts.findIndex((entry) => entry.alertId === alertId);
  if (index >= 0) next.alerts[index] = { ...next.alerts[index], ...fresh };
  else next.alerts.push(fresh);

  const seq = next.counters.eventsThroughSeq + 1;
  next.counters.eventsThroughSeq = seq;
  next.events.push({
    seq,
    kind: "alert-raised",
    at: now,
    payload: { alertId, severity: alert.severity },
  });
  next.updatedAt = now;
  return { changed: true, next };
}
