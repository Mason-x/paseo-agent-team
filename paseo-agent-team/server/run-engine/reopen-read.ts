import type { PaseoEnginePort } from "../../shared/paseo/port";

/** Reading a closed member's history took longer than allowed. It says nothing about whether the Agent can be opened. */
export class ReopenTimeout extends Error {
  constructor() {
    super("reading the history timed out");
  }
}

/**
 * Reads the tail of the member's timeline, which is what makes the host load a closed Agent again
 * (reading a snapshot does not), then looks at it once more. It sends nothing and calls no model.
 *  - "idle": reopened, it reads idle and has no turn running;
 *  - "busy": it is loaded and has a turn running (a person wrote to it, say): nothing to reopen or to rebuild;
 *  - "closed": the read worked and the Agent is still closed;
 * a read that throws is thrown on, and one that takes too long throws `ReopenTimeout`: neither says that the
 * Agent cannot be opened (a slow read may still succeed).
 */
export async function reopenByReading(
  port: PaseoEnginePort,
  agentId: string,
  timeoutMs: number,
): Promise<"idle" | "busy" | "closed"> {
  const handle = port.agents.ref(agentId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReopenTimeout()), timeoutMs);
  });
  const reading = (async () => {
    await handle.timeline.refetch({ direction: "tail", limit: 1, projection: "canonical" });
    return handle.refresh();
  })();
  // If the timeout wins, the read may still fail later: nobody waits for it, so say nothing.
  reading.catch(() => undefined);
  try {
    const refreshed = await Promise.race([reading, timeout]);
    const snapshot = refreshed?.agent;
    if (snapshot === undefined) return "closed";
    if (snapshot.status === "idle" && !snapshot.activeTurn) return "idle";
    return snapshot.status === "running" || snapshot.activeTurn ? "busy" : "closed";
  } finally {
    clearTimeout(timer);
  }
}
