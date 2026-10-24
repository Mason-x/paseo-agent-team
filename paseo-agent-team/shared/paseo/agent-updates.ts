/** Which agents an update stream covers. An empty filter covers every agent. */
export type AgentUpdateFilter = { labels?: Record<string, string> };

type AgentUpdateObserver = {
  snapshot(snapshot: unknown): void;
  update(message: unknown): void;
  error?(error: unknown): void;
};

/** The slice of `paseo.agents` needed to ask the host to stream agent changes. */
export interface AgentUpdatesPort {
  readonly agents: {
    list(options: {
      page: { limit: number };
      filter?: AgentUpdateFilter;
      subscribe: Record<string, never>;
    }): Promise<{
      subscription: {
        subscribe(observer: AgentUpdateObserver): () => void;
        release(): Promise<void>;
      };
    }>;
  };
}

const ignore = () => undefined;

/**
 * Calls `onChange` whenever an agent matching one of `filters` changes.
 *
 * The host streams agent updates only to clients that hold a subscription, which an agent list
 * request with `subscribe` opens. `paseo.agents.subscribe(handler)` alone just listens locally
 * and hears nothing without one. Callers should keep a slow periodic refresh as a backstop: a
 * failed subscription is not reported, it just leaves that refresh as the only update.
 *
 * Returns a cleanup that is safe to call before the subscriptions have been established.
 */
export function subscribeToAgentUpdates(
  paseo: AgentUpdatesPort,
  onChange: () => void,
  filters: readonly AgentUpdateFilter[] = [{}],
): () => void {
  let disposed = false;
  const stops: Array<() => void> = [];

  for (const filter of filters) {
    paseo.agents
      .list({
        page: { limit: 1 },
        ...(filter.labels ? { filter } : {}),
        subscribe: {},
      })
      .then(({ subscription }) => {
        const release = () => void subscription.release().catch(ignore);
        if (disposed) {
          release();
          return;
        }
        let replayed = false;
        try {
          const stop = subscription.subscribe({
            snapshot() {
              // The first snapshot replays the list we just fetched. Later ones follow a
              // reconnect, when updates may have been missed.
              if (replayed) onChange();
              replayed = true;
            },
            update: () => onChange(),
            error: ignore,
          });
          stops.push(() => {
            stop();
            release();
          });
        } catch {
          // The subscription ended before we could attach, for example as the client closed.
          release();
        }
      })
      .catch(ignore);
  }

  return () => {
    disposed = true;
    for (const stop of stops.splice(0)) stop();
  };
}
