import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { checkDesignRequest } from "../../shared/domain/design-request";
import type { TeamMode } from "../../shared/schemas/team-mode";
import { designZh } from "../../shared/zh/design";
import { AGENT_TEAMS_SCREEN } from "../app/tabs";

export const DESIGN_PREFILL_TTL_MS = 5 * 60 * 1000;
export const DESIGN_PREFILL_CAPACITY = 20;

export type DesignPrefillEvent = {
  token: string;
  scopeId: string;
  request: string;
  workspaceId: string | null;
  mode?: TeamMode;
  createdAt: number;
};

type Listener = (event: DesignPrefillEvent) => boolean;
type ListenerEntry = { scopeId: string; listener: Listener };

// Memory only: a cold reload loses both queued text and tokens, which is the documented contract.
const pending = new Map<string, DesignPrefillEvent>();
const listeners = new Map<string, Set<ListenerEntry>>();

function sweep(now: number): void {
  for (const [token, event] of pending) {
    if (now - event.createdAt > DESIGN_PREFILL_TTL_MS) pending.delete(token);
  }
}

function notify(event: DesignPrefillEvent, now: number): void {
  if (now - event.createdAt > DESIGN_PREFILL_TTL_MS) {
    pending.delete(event.token);
    return;
  }
  const entries = listeners.get(event.token);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.scopeId !== event.scopeId) continue;
    if (entry.listener(event)) {
      pending.delete(event.token);
      return;
    }
  }
}

/** Replaces the oldest entry when full so a single screen can never grow without bound. */
function evictToCapacity(): void {
  while (pending.size >= DESIGN_PREFILL_CAPACITY) {
    let oldestToken: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [token, event] of pending) {
      if (event.createdAt < oldestAt) {
        oldestAt = event.createdAt;
        oldestToken = token;
      }
    }
    if (oldestToken === null) return;
    pending.delete(oldestToken);
  }
}

export function queueDesignPrefill(event: DesignPrefillEvent): void {
  sweep(event.createdAt);
  pending.delete(event.token);
  evictToCapacity();
  pending.set(event.token, event);
  notify(event, event.createdAt);
}

/** Wrong scopes neither read nor consume the text; a matching take removes it exactly once. */
export function takeDesignPrefill(input: {
  token: string;
  scopeId: string;
  now: number;
}): DesignPrefillEvent | null {
  sweep(input.now);
  const event = pending.get(input.token);
  if (!event || event.scopeId !== input.scopeId) return null;
  pending.delete(input.token);
  return event;
}

/**
 * The first listener that returns true consumes the event. Other listeners (including another
 * client on a different scope) never receive the body.
 */
export function subscribeDesignPrefills(
  input: { scopeId: string; token: string; now?: number },
  listener: Listener,
): () => void {
  const now = input.now ?? Date.now();
  sweep(now);
  const entry: ListenerEntry = { scopeId: input.scopeId, listener };
  const event = pending.get(input.token);
  if (event && event.scopeId === input.scopeId && listener(event)) {
    pending.delete(input.token);
    return () => {};
  }
  const entries = listeners.get(input.token) ?? new Set<ListenerEntry>();
  entries.add(entry);
  listeners.set(input.token, entries);
  return () => {
    entries.delete(entry);
    if (entries.size === 0) listeners.delete(input.token);
  };
}

/** Tests and a plugin reload treat this as a fresh process: every queued token is gone. */
export function resetDesignPrefills(): void {
  pending.clear();
  listeners.clear();
}

export function createDesignPrefillToken(): string {
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** Screen params carry the short token only: never the request, a path, or Profile notes. */
export function buildDesignPrefillScreenParams(token: string): {
  tab: string;
  designToken: string;
} {
  return { tab: "teams", designToken: token };
}

export type DesignSlashCommandInput = {
  args: string;
  workspaceId: string | null;
  mode?: TeamMode;
  now: number;
  /** Reads `design.status({}).scopeId`; the caller maps the RPC failures to null. */
  readScopeId: () => Promise<string | null | undefined>;
  openScreen: (input: PluginOpenScreenInput) => void;
  createToken?: () => string;
};

export type DesignSlashCommandResult =
  | { kind: "queued"; token: string; request: string; message: string }
  | { kind: "invalid"; reason: "too-long"; message: string }
  | { kind: "scope-unavailable"; message: string };

/**
 * `/team-design` only prefills. It never starts a job, so executing the command cannot spend a
 * model turn; the user still has to press "start design" in the card.
 */
export async function handleDesignSlashCommand(
  input: DesignSlashCommandInput,
): Promise<DesignSlashCommandResult> {
  const check = checkDesignRequest(input.args);
  if (!check.ok && check.reason === "too-long") {
    return { kind: "invalid", reason: "too-long", message: designZh.prefillTooLong };
  }
  // A blank command is allowed: it opens an empty, focused card.
  const request = check.ok ? check.request : "";

  let scopeId: string | null | undefined;
  try {
    scopeId = await input.readScopeId();
  } catch {
    scopeId = null;
  }
  if (!scopeId) {
    input.openScreen({ screenId: AGENT_TEAMS_SCREEN, params: { tab: "teams" } });
    return { kind: "scope-unavailable", message: designZh.prefillScopeUnavailable };
  }

  const token = (input.createToken ?? createDesignPrefillToken)();
  queueDesignPrefill({
    token,
    scopeId,
    request,
    workspaceId: input.workspaceId,
    ...(input.mode ? { mode: input.mode } : {}),
    createdAt: input.now,
  });
  input.openScreen({
    screenId: AGENT_TEAMS_SCREEN,
    params: buildDesignPrefillScreenParams(token),
  });
  return { kind: "queued", token, request, message: designZh.prefillQueued };
}
