import type {
  PortTimelineCursor,
  PortTimelinePage,
  PortTimelineRefetchOptions,
} from "../../shared/paseo/port";
import type { ObserverHost } from "./observer";
import {
  buildReplyWindow,
  PROTOCOL_MAX_PAGES,
  type ReplyWindow,
  type TimelinePageLike,
} from "./protocol";

/**
 * The slice of the Paseo agent handle the observer reads. The page and option types come from the
 * shared port (one place a host upgrade has to be checked); the handle is cut down to the
 * read-only timeline so the observer cannot send, create, cancel or archive.
 */
export type TimelineCursor = PortTimelineCursor;

export type TimelineRefetchPage = TimelinePageLike & PortTimelinePage;

export interface ObservedAgentPort {
  timeline: {
    refetch(
      options: PortTimelineRefetchOptions & { direction: "tail" | "before" | "after" },
    ): Promise<TimelineRefetchPage>;
  };
  /** Live snapshot; only read when the host is asked to `requireIdle`. */
  refresh?(): Promise<{ agent: { status: string; activeTurn?: unknown } } | null>;
}

export type ObservedHostPort = {
  agents: { ref(agentId: string): ObservedAgentPort };
};

const PAGE_LIMIT = 100;

function holdsDispatch(page: TimelinePageLike, messageId: string): boolean {
  return page.entries.some(
    (entry) =>
      entry.item.type === "user_message" &&
      (entry.item.messageId === messageId || entry.item.clientMessageId === messageId),
  );
}

export type DispatchEcho =
  /** The host timeline carries a user_message with this id: it was delivered. */
  | { status: "found"; turnId: string | null }
  /** The whole timeline was read, consistently, and the id is not in it. */
  | { status: "absent" }
  /** The read was partial or inconsistent (pages, gap, stale cursor, reset, epoch change). */
  | { status: "unverifiable"; reason: "too-many-pages" | "inconsistent-read" };

/**
 * Looks for the echo of a sent message id, newest page first. Read-only. A timeline the host
 * reports as incomplete is `unverifiable`, never `absent`: not finding the message in part of the
 * history says nothing about whether it was delivered. Even `absent` only means "not there now" —
 * the caller must not turn it into a blind resend.
 */
export async function findDispatchEcho(
  port: ObservedHostPort,
  agentId: string,
  messageId: string,
  options: { maxPages?: number; pageLimit?: number } = {},
): Promise<DispatchEcho> {
  const maxPages = options.maxPages ?? PROTOCOL_MAX_PAGES;
  const limit = options.pageLimit ?? PAGE_LIMIT;
  const handle = port.agents.ref(agentId);
  let epoch: string | null = null;
  let page = await handle.timeline.refetch({ direction: "tail", limit, projection: "canonical" });
  for (let pages = 1; ; pages += 1) {
    if (page.gap || page.staleCursor || page.reset || (epoch !== null && page.epoch !== epoch)) {
      return { status: "unverifiable", reason: "inconsistent-read" };
    }
    epoch = page.epoch;
    const hit = page.entries.find(
      (entry) =>
        entry.item.type === "user_message" &&
        (entry.item.messageId === messageId || entry.item.clientMessageId === messageId),
    );
    if (hit) return { status: "found", turnId: hit.turnId ?? null };
    if (!page.hasOlder) return { status: "absent" };
    if (pages >= maxPages || page.startCursor === null) {
      return { status: "unverifiable", reason: "too-many-pages" };
    }
    page = await handle.timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit,
      projection: "canonical",
    });
  }
}

/**
 * Reads the canonical timeline backwards from the tail until the dispatch message is on a page,
 * then asks `buildReplyWindow` whether that is a complete reply. Running out of pages before the
 * dispatch turns up is "unverifiable", never "no reply".
 *
 * `requireIdle` is for readers that act without a hook telling them a turn ended (the restart
 * reconcile). `buildReplyWindow` calls the newest turn complete when the read reached the end of the
 * timeline, which is also true while that turn is still being written; so the agent must be seen
 * idle first, and a turn that may still be running is `turn-open`, not an empty reply. The snapshot
 * is read before the timeline: idle at that moment means the turn was over before the read began.
 */
export function createObserverHost(
  port: ObservedHostPort,
  options: { maxPages?: number; pageLimit?: number; requireIdle?: boolean } = {},
): ObserverHost {
  const maxPages = options.maxPages ?? PROTOCOL_MAX_PAGES;
  const limit = options.pageLimit ?? PAGE_LIMIT;
  return {
    async replyWindow(agentId, dispatchMessageId): Promise<ReplyWindow> {
      const handle = port.agents.ref(agentId);
      if (options.requireIdle && handle.refresh) {
        const snapshot = await handle.refresh();
        const agent = snapshot?.agent;
        if (
          !agent ||
          agent.status === "running" ||
          agent.status === "initializing" ||
          agent.activeTurn
        ) {
          return { complete: false, reason: "turn-open" };
        }
      }
      const pages: TimelineRefetchPage[] = [];
      let page = await handle.timeline.refetch({
        direction: "tail",
        limit,
        projection: "canonical",
      });
      pages.push(page);
      while (!holdsDispatch(page, dispatchMessageId) && page.hasOlder) {
        if (pages.length >= maxPages || page.startCursor === null) {
          return { complete: false, reason: "too-many-pages" };
        }
        page = await handle.timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit,
          projection: "canonical",
        });
        pages.push(page);
      }
      return buildReplyWindow({ pages, dispatchMessageId, maxPages });
    },
  };
}
