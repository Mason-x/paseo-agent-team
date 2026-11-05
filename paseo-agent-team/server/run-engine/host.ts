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

/**
 * Reads the canonical timeline backwards from the tail until the dispatch message is on a page,
 * then asks `buildReplyWindow` whether that is a complete reply. Running out of pages before the
 * dispatch turns up is "unverifiable", never "no reply".
 */
export function createObserverHost(
  port: ObservedHostPort,
  options: { maxPages?: number; pageLimit?: number } = {},
): ObserverHost {
  const maxPages = options.maxPages ?? PROTOCOL_MAX_PAGES;
  const limit = options.pageLimit ?? PAGE_LIMIT;
  return {
    async replyWindow(agentId, dispatchMessageId): Promise<ReplyWindow> {
      const handle = port.agents.ref(agentId);
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
