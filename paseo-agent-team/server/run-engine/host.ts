import type { ObserverHost } from "./observer";
import {
  buildReplyWindow,
  PROTOCOL_MAX_PAGES,
  type ReplyWindow,
  type TimelinePageLike,
} from "./protocol";

/**
 * The slice of the Paseo agent handle the observer reads. Structural on purpose: shared modules
 * cannot import client types, and this keeps a host upgrade pointing at exactly these calls.
 * Nothing here sends, creates, cancels or archives.
 */
export type TimelineCursor = { epoch: string; seq: number };

export type TimelineRefetchPage = TimelinePageLike & {
  startCursor: TimelineCursor | null;
};

export interface ObservedAgentPort {
  timeline: {
    refetch(options: {
      direction: "tail" | "before" | "after";
      cursor?: TimelineCursor;
      limit?: number;
      projection?: "canonical" | "projected";
    }): Promise<TimelineRefetchPage>;
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
