import { DESIGN_LABEL_KEYS } from "../../shared/paseo/design-port";
import type { DesignService, DesignTurnEndedEvent } from "./service";

/** Host event name; I1 registers this once with the plugin server context. */
export const DESIGN_TURN_ENDED_EVENT = "agent.turn_ended";
export const DESIGN_AGENT_LABEL = DESIGN_LABEL_KEYS.job;
export const DESIGN_AGENT_VERSION_LABEL = DESIGN_LABEL_KEYS.version;

export type DesignHookEvent = {
  agent: { id: string; labels?: Record<string, string> };
  turnId?: string | null;
  outcome?: { kind: "completed" | "failed" | "canceled"; error?: unknown; reason?: unknown };
};

/**
 * Server hook surface. Only an agent carrying this plugin's design label reaches the service;
 * every unrelated hook exits with a single label lookup. The service still re-checks ownership
 * against the ledger and agentId before touching a job.
 */
export function createDesignHooks(deps: {
  service: Pick<DesignService, "onTurnEnded">;
  log?: (message: string, cause?: unknown) => void;
}) {
  const log = deps.log ?? (() => {});
  return {
    async onTurnEnded(event: DesignHookEvent): Promise<void> {
      const labels = event.agent.labels;
      if (labels?.[DESIGN_AGENT_VERSION_LABEL] !== "1" || !labels[DESIGN_AGENT_LABEL]) {
        return;
      }
      try {
        await deps.service.onTurnEnded(event as DesignTurnEndedEvent);
      } catch (cause) {
        log("design turn-ended hook failed", cause);
      }
    },
  };
}
