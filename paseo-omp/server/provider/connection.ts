import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  ProviderInputSchema,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { discoverOmpCatalog } from "./catalog";
import { normalizeOmpCatalogOptions } from "./config-normalization";
import type { OmpMcpConnector } from "./host-tools";
import type { OmpRuntime } from "./omp-rpc";
import {
  boundedJsonBytes,
  isOmpCleanupFailure,
  isOmpPublicError,
  OmpCleanupFailure,
  OmpPublicError,
  utf8Bytes,
} from "./security";
import { OmpProviderSession, ompPersistenceSessionId } from "./session";

type ProviderConfigurationCompat = {
  providerOptions?: Readonly<Record<string, unknown>>;
  settings?: Readonly<Record<string, unknown>>;
};

import type { OmpTimelineScheduler } from "./timeline-projector";

const SUPPORTED_CAPABILITIES: Readonly<Record<string, true>> = {
  "prompt.message": true,
  "prompt.command": true,
  "prompt.image": true,
  "prompt.steer": true,
  "session.configure": true,
  "session.list": true,
  "session.persistence": true,
  "session.subsession": true,
  "session.revert.conversation": true,
  permission: true,
};
const SUPPORTED_INPUTS: Readonly<Record<string, true>> = {
  catalog: true,
  sessions: true,
  "session.open": true,
  "session.prompt": true,
  "session.configure": true,
  "session.permission": true,
  "session.revert": true,
  "session.interrupt": true,
  "session.close": true,
};
const MAX_CONNECTION_SESSIONS = 32;
const MAX_ACTIVE_OPERATIONS = 128;
const MAX_PROVIDER_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_NESTED_OPTION_BYTES = 256 * 1024;
const MAX_NATIVE_SESSION_RESERVATIONS = 256;

function hasOwnEntries(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const key in value) {
    if (Object.hasOwn(value, key)) return true;
  }
  return false;
}

function preflightProviderInput(input: unknown): void {
  if (!input || typeof input !== "object") throw new OmpPublicError("Invalid provider request");
  const record = input as Record<string, unknown>;
  if (boundedJsonBytes(record, MAX_PROVIDER_INPUT_BYTES, 512) === Number.POSITIVE_INFINITY) {
    throw new OmpPublicError("Provider request is too large");
  }
  if (record.type === "session.open") {
    if (
      record.persistence !== undefined &&
      boundedJsonBytes(record.persistence, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("Session persistence input is too large");
    }
    const config = record.config as Record<string, unknown> | undefined;
    for (const value of [config?.mcpServers, config?.providerOptions, config?.settings]) {
      if (
        value !== undefined &&
        boundedJsonBytes(value, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
      ) {
        throw new OmpPublicError("Session configuration is too large");
      }
    }
    if (config?.deniedTools !== undefined) {
      if (
        !Array.isArray(config.deniedTools) ||
        config.deniedTools.length > 512 ||
        config.deniedTools.some(
          (tool) => typeof tool !== "string" || tool.trim().length === 0 || utf8Bytes(tool) > 256,
        )
      ) {
        throw new OmpPublicError("Invalid denied tool list");
      }
    }
    if (config?.toolPolicy !== undefined) {
      throw new OmpPublicError("OMP does not support host tool policies");
    }
    if (hasOwnEntries(config?.settings)) {
      throw new OmpPublicError("OMP does not expose live provider settings");
    }
  }
  if (record.type === "catalog" || record.type === "sessions") {
    for (const value of [record.providerOptions, record.settings]) {
      if (
        value !== undefined &&
        boundedJsonBytes(value, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
      ) {
        throw new OmpPublicError("Provider configuration is too large");
      }
    }
  }
  if (record.type === "session.prompt") {
    const prompt = record.prompt as Record<string, unknown> | undefined;
    if (
      prompt?.outputSchema !== undefined &&
      boundedJsonBytes(prompt.outputSchema, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("Prompt output schema is too large");
    }
    if (prompt?.outputSchema !== undefined || prompt?.clearPendingPermissions === true) {
      throw new OmpPublicError("OMP does not support structured output or permission controls");
    }
  }
  if (record.type === "session.permission") {
    const response = record.response as Record<string, unknown> | undefined;
    if (
      response !== undefined &&
      boundedJsonBytes(response, MAX_NESTED_OPTION_BYTES) === Number.POSITIVE_INFINITY
    ) {
      throw new OmpPublicError("Permission response is too large");
    }
  }
}
function parseProviderInputCompat(input: unknown): ProviderInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OmpPublicError("Invalid provider request");
  }
  const record = input as Record<string, unknown>;
  if (record.type === "catalog" || record.type === "sessions") {
    const { providerOptions, settings, scope: _scope, force: _force, ...legacyInput } = record;
    const parsed = ProviderInputSchema.safeParse(legacyInput);
    if (!parsed.success) throw new OmpPublicError("Invalid provider request");
    return { ...parsed.data, providerOptions, settings } as unknown as ProviderInput;
  }
  if (record.type === "session.open" && record.config && typeof record.config === "object") {
    const config = record.config as Record<string, unknown>;
    const { deniedTools, ...legacyConfig } = config;
    const parsed = ProviderInputSchema.safeParse({ ...record, config: legacyConfig });
    if (!parsed.success) throw new OmpPublicError("Invalid provider request");
    return {
      ...parsed.data,
      config: {
        ...(parsed.data as Extract<ProviderInput, { type: "session.open" }>).config,
        deniedTools,
      },
    } as unknown as ProviderInput;
  }
  const parsed = ProviderInputSchema.safeParse(input);
  if (!parsed.success) throw new OmpPublicError("Invalid provider request");
  return parsed.data;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function validateInputEnvelope(input: unknown): asserts input is ProviderInput {
  if (!input || typeof input !== "object") throw new OmpPublicError("Invalid provider request");
  const record = input as Record<string, unknown>;
  if (typeof record.type !== "string" || !SUPPORTED_INPUTS[record.type]) {
    throw new OmpPublicError("Unsupported provider request");
  }
  if (record.type === "catalog") {
    if (!isBoundedIdentifier(record.requestId))
      throw new OmpPublicError("Invalid provider request");
    if (
      record.cwd !== undefined &&
      (typeof record.cwd !== "string" || utf8Bytes(record.cwd) > 4_096 || record.cwd.includes("\0"))
    ) {
      throw new OmpPublicError("Invalid provider request");
    }
    return;
  }
  if (record.type === "sessions") {
    if (!isBoundedIdentifier(record.requestId))
      throw new OmpPublicError("Invalid provider request");
    if (
      record.cwd !== undefined &&
      (typeof record.cwd !== "string" ||
        record.cwd.length === 0 ||
        !isAbsolute(record.cwd) ||
        utf8Bytes(record.cwd) > 4_096 ||
        record.cwd.includes("\0"))
    ) {
      throw new OmpPublicError(
        "OMP session listing requires an absolute working directory when scoped",
      );
    }
    if (
      record.query !== undefined &&
      (typeof record.query !== "string" || utf8Bytes(record.query) > 512)
    ) {
      throw new OmpPublicError("Invalid provider request");
    }
    if (
      record.limit !== undefined &&
      (!Number.isInteger(record.limit) ||
        (record.limit as number) < 1 ||
        (record.limit as number) > 500)
    ) {
      throw new OmpPublicError("Invalid provider request");
    }
    return;
  }
  if (!isBoundedIdentifier(record.sessionId)) throw new OmpPublicError("Invalid provider request");
  if (record.type === "session.prompt") {
    if (!record.prompt || typeof record.prompt !== "object") {
      throw new OmpPublicError("Invalid provider request");
    }
    const prompt = record.prompt as Record<string, unknown>;
    if (!isBoundedIdentifier(prompt.clientMessageId)) {
      throw new OmpPublicError("Invalid provider request");
    }
    if (prompt.delivery !== "auto" && prompt.delivery !== "steer") {
      throw new OmpPublicError("Invalid provider request");
    }
    return;
  }
  if (record.type === "session.permission") {
    if (
      !isBoundedIdentifier(record.permissionId) ||
      !record.response ||
      typeof record.response !== "object"
    ) {
      throw new OmpPublicError("Invalid permission response");
    }
    const response = record.response as Record<string, unknown>;
    if (
      response.selectedActionId !== undefined &&
      !isBoundedIdentifier(response.selectedActionId)
    ) {
      throw new OmpPublicError("Invalid permission response");
    }
    if (Array.isArray(response.updatedPermissions) && response.updatedPermissions.length > 64) {
      throw new OmpPublicError("Invalid permission response");
    }
    return;
  }
  if (!isBoundedIdentifier(record.requestId)) throw new OmpPublicError("Invalid provider request");
  if (record.type === "session.open" && (!record.config || typeof record.config !== "object")) {
    throw new OmpPublicError("Invalid provider request");
  }
  if (
    record.type === "session.configure" &&
    (!record.changes || typeof record.changes !== "object")
  ) {
    throw new OmpPublicError("Invalid provider request");
  }
}

function errorDetails(error: unknown, fallback: string): { message: string } {
  return { message: isOmpPublicError(error) ? error.message : fallback };
}

type NativeReservation = { owner: symbol; quarantined: boolean };

type NativeReservationRequest =
  | { kind: "list" }
  | { kind: "unknown"; owner: symbol }
  | { kind: "known"; nativeSessionId: string; owner: symbol };

type NativeReservationWaiter = NativeReservationRequest & {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (reason?: unknown) => void;
  onAbort?: () => void;
};

export class OmpNativeSessionReservations {
  private readonly reservations = new Map<string, NativeReservation>();
  private readonly unknownQuarantines = new Set<symbol>();
  private readonly registrationQueue: NativeReservationWaiter[] = [];
  private openingOwner: symbol | null = null;
  private overflowQuarantines = 0;

  assertOpenable(): void {
    if (this.hasQuarantine()) {
      throw new OmpPublicError("OMP native session cleanup quarantine is active");
    }
  }

  waitUntilListable(signal?: AbortSignal): Promise<void> {
    return this.enqueue({ kind: "list" }, signal);
  }

  beginPersistentOpen(owner: symbol, signal?: AbortSignal): Promise<void> {
    return this.enqueue({ kind: "unknown", owner }, signal);
  }

  reserve(nativeSessionId: string, owner: symbol, signal?: AbortSignal): Promise<void> {
    return this.enqueue({ kind: "known", nativeSessionId, owner }, signal);
  }

  completePersistentOpen(nativeSessionId: string, owner: symbol): void {
    if (this.openingOwner !== owner) {
      throw new OmpPublicError("OMP persistent session registration was lost");
    }
    const existing = this.reservations.get(nativeSessionId);
    if (existing?.quarantined) {
      throw new OmpPublicError("OMP native session cleanup is unresolved");
    }
    if (existing && existing.owner !== owner) {
      throw new OmpPublicError("OMP native session is already open");
    }
    this.reservations.set(nativeSessionId, { owner, quarantined: false });
    this.openingOwner = null;
    this.drainRegistrationQueue();
  }

  transition(previousSessionId: string, nextSessionId: string, owner: symbol): void {
    if (previousSessionId === nextSessionId) return;
    const previous = this.reservations.get(previousSessionId);
    if (!previous || previous.owner !== owner || previous.quarantined) {
      throw new OmpPublicError("OMP native session ownership changed during rewind");
    }
    const next = this.reservations.get(nextSessionId);
    if (next && next.owner !== owner) {
      throw new OmpPublicError("OMP branched into a native session that is already open");
    }
    this.reservations.set(nextSessionId, { owner, quarantined: false });
    this.reservations.delete(previousSessionId);
  }

  cancelPersistentOpen(owner: symbol): void {
    if (this.openingOwner !== owner) return;
    this.openingOwner = null;
    this.drainRegistrationQueue();
  }

  quarantine(
    nativeSessionId: string | undefined,
    owner: symbol,
    cleanup?: Promise<void>,
    onReleased?: () => void,
  ): void {
    if (this.openingOwner === owner) this.openingOwner = null;
    let release: () => boolean;
    const existing = nativeSessionId ? this.reservations.get(nativeSessionId) : undefined;
    if (nativeSessionId && (!existing || existing.owner === owner)) {
      this.reservations.set(nativeSessionId, { owner, quarantined: true });
      release = () => {
        const current = this.reservations.get(nativeSessionId);
        if (!current?.quarantined || current.owner !== owner) return false;
        this.reservations.delete(nativeSessionId);
        return true;
      };
    } else if (this.size < MAX_NATIVE_SESSION_RESERVATIONS) {
      this.unknownQuarantines.add(owner);
      release = () => this.unknownQuarantines.delete(owner);
    } else {
      this.overflowQuarantines += 1;
      release = () => {
        if (this.overflowQuarantines === 0) return false;
        this.overflowQuarantines -= 1;
        return true;
      };
    }
    this.drainRegistrationQueue();
    if (cleanup) {
      void cleanup.then(
        () => {
          if (release()) onReleased?.();
        },
        () => undefined,
      );
    }
  }

  release(nativeSessionId: string | undefined, owner: symbol): void {
    const reservation = nativeSessionId ? this.reservations.get(nativeSessionId) : undefined;
    if (nativeSessionId && reservation?.owner === owner && !reservation.quarantined) {
      this.reservations.delete(nativeSessionId);
    }
    if (this.openingOwner === owner) this.openingOwner = null;
    this.drainRegistrationQueue();
  }

  private enqueue(request: NativeReservationRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: NativeReservationWaiter = { ...request, signal, resolve, reject };
    if (signal) {
      waiter.onAbort = () => {
        const index = this.registrationQueue.indexOf(waiter);
        if (index < 0) return;
        this.registrationQueue.splice(index, 1);
        this.detachAbort(waiter);
        reject(signal.reason);
        this.drainRegistrationQueue();
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    this.registrationQueue.push(waiter);
    this.drainRegistrationQueue();
    return promise;
  }

  private drainRegistrationQueue(): void {
    while (!this.openingOwner && this.registrationQueue.length > 0) {
      const waiter = this.registrationQueue.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        this.rejectWaiter(waiter, waiter.signal.reason);
        continue;
      }
      try {
        this.assertOpenable();
        if (waiter.kind === "list") {
          this.resolveWaiter(waiter);
          continue;
        }
        if (waiter.kind === "known") {
          const existing = this.reservations.get(waiter.nativeSessionId);
          if (existing) {
            if (existing.owner !== waiter.owner) {
              throw new OmpPublicError("OMP native session is already open");
            }
          } else {
            this.assertCapacity();
            this.reservations.set(waiter.nativeSessionId, {
              owner: waiter.owner,
              quarantined: false,
            });
          }
          this.resolveWaiter(waiter);
          continue;
        }
        this.assertCapacity();
        this.openingOwner = waiter.owner;
        this.resolveWaiter(waiter);
      } catch (error) {
        this.rejectWaiter(waiter, error);
      }
    }
  }

  private resolveWaiter(waiter: NativeReservationWaiter): void {
    this.detachAbort(waiter);
    waiter.resolve();
  }

  private rejectWaiter(waiter: NativeReservationWaiter, reason: unknown): void {
    this.detachAbort(waiter);
    waiter.reject(reason);
  }

  private detachAbort(waiter: NativeReservationWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private get size(): number {
    return this.reservations.size + this.unknownQuarantines.size + (this.openingOwner ? 1 : 0);
  }

  private hasQuarantine(): boolean {
    if (this.unknownQuarantines.size > 0 || this.overflowQuarantines > 0) return true;
    for (const reservation of this.reservations.values()) {
      if (reservation.quarantined) return true;
    }
    return false;
  }

  private assertCapacity(): void {
    if (this.size >= MAX_NATIVE_SESSION_RESERVATIONS) {
      throw new OmpPublicError("OMP persistent session registry limit reached");
    }
  }
}

export function createOmpConnection(
  runtime: OmpRuntime,
  capabilities: readonly string[],
  scheduler?: OmpTimelineScheduler,
  environment?: NodeJS.ProcessEnv,
  nativeReservations = new OmpNativeSessionReservations(),
  mcpConnector?: OmpMcpConnector,
  mcpInitializationTimeoutMs?: number,
  replayTimeoutMs?: number,
): ProviderConnection {
  const safeCapabilities = [...new Set(capabilities)].filter(
    (capability) =>
      SUPPORTED_CAPABILITIES[capability] &&
      ((capability !== "session.persistence" && capability !== "session.revert.conversation") ||
        runtime.supportsPersistence),
  );
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<
    string,
    { token: symbol; session: OmpProviderSession; nativeSessionId?: string }
  >();
  const opening = new Map<
    string,
    { token: symbol; controller: AbortController; settled: Promise<void> }
  >();
  const failedCleanup = new Map<
    string,
    { token: symbol; nativeSessionId?: string; cleanup?: Promise<void> }
  >();
  const shutdown = new AbortController();
  let catalogCleanup: Promise<void> | null = null;
  const activeOperations = new Set<Promise<void>>();
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  const requestFailure = (
    requestId: string,
    error: unknown,
    fallback = "OMP provider request failed",
  ) => {
    emit({ type: "request.failed", requestId, error: errorDetails(error, fallback) });
  };
  const quarantineFailedCleanup = (
    sessionId: string,
    token: symbol,
    error: unknown,
    nativeSessionId?: string,
  ) => {
    const cleanupFailure = isOmpCleanupFailure(error) ? error : undefined;
    const cleanup = cleanupFailure?.cleanup ?? Promise.reject(error);
    void cleanup.catch(() => undefined);
    const quarantinedNativeSessionId = nativeSessionId ?? cleanupFailure?.nativeSessionId;
    failedCleanup.set(sessionId, {
      token,
      cleanup,
      ...(quarantinedNativeSessionId ? { nativeSessionId: quarantinedNativeSessionId } : {}),
    });
    nativeReservations.quarantine(quarantinedNativeSessionId, token, cleanup, () => {
      if (failedCleanup.get(sessionId)?.token === token) failedCleanup.delete(sessionId);
    });
  };

  const dispatch = async (input: ProviderInput): Promise<void> => {
    switch (input.type) {
      case "catalog":
        if (catalogCleanup) {
          requestFailure(input.requestId, new OmpPublicError("OMP catalog cleanup is incomplete"));
          return;
        }
        try {
          const configuredInput = input as typeof input & ProviderConfigurationCompat;
          const catalogOptions = normalizeOmpCatalogOptions(
            {
              scope: input.cwd ? "workspace" : "global",
              ...(input.cwd ? { cwd: input.cwd } : {}),
              providerOptions: configuredInput.providerOptions,
              settings: configuredInput.settings,
            },
            input.cwd ?? homedir(),
          );
          const catalog = await discoverOmpCatalog(
            runtime,
            catalogOptions,
            shutdown.signal,
            environment,
          );
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: safeCapabilities.includes("permission")
              ? catalog
              : {
                  ...catalog,
                  modes: catalog.modes.filter((mode) => mode.id === "full"),
                  defaultMode: "full",
                },
          });
        } catch (error) {
          if (isOmpCleanupFailure(error)) catalogCleanup = error.cleanup;
          if (!closing) requestFailure(input.requestId, error, "OMP catalog discovery failed");
        }
        return;
      case "sessions":
        try {
          await nativeReservations.waitUntilListable(shutdown.signal);
          const configuredInput = input as typeof input & ProviderConfigurationCompat;
          const listingConfig = normalizeOmpCatalogOptions(
            {
              scope: input.cwd ? "workspace" : "global",
              ...(input.cwd ? { cwd: input.cwd } : {}),
              providerOptions: configuredInput.providerOptions,
              settings: configuredInput.settings,
            },
            input.cwd ?? homedir(),
          );
          emit({
            type: "sessions",
            requestId: input.requestId,
            sessions: (
              await runtime.listSessions({
                ...(input.cwd ? { cwd: input.cwd } : {}),
                query: input.query,
                limit: input.limit,
                sessionDir: listingConfig.sessionDir,
              })
            ).map((session) => ({
              persistence: { version: 1, data: { sessionId: session.id } },
              cwd: session.cwd,
              ...(session.title ? { title: session.title } : {}),
              ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
              ...(session.firstPromptPreview
                ? { firstPromptPreview: session.firstPromptPreview }
                : {}),
              ...(session.lastPromptPreview
                ? { lastPromptPreview: session.lastPromptPreview }
                : {}),
            })),
          });
        } catch (error) {
          requestFailure(input.requestId, error, "OMP session listing failed");
        }
        return;
      case "session.open": {
        if (
          sessions.has(input.sessionId) ||
          opening.has(input.sessionId) ||
          failedCleanup.has(input.sessionId)
        ) {
          requestFailure(input.requestId, new OmpPublicError("OMP session already exists"));
          return;
        }
        if (sessions.size + opening.size + failedCleanup.size >= MAX_CONNECTION_SESSIONS) {
          requestFailure(input.requestId, new OmpPublicError("OMP session limit reached"));
          return;
        }
        const token = Symbol(input.sessionId);
        const controller = new AbortController();
        const openingSettled = Promise.withResolvers<void>();
        opening.set(input.sessionId, { token, controller, settled: openingSettled.promise });
        let nativeSessionId: string | undefined;
        let persistentOpening = false;
        let session: OmpProviderSession | undefined;
        try {
          nativeSessionId = ompPersistenceSessionId(input);
          if (nativeSessionId) {
            await nativeReservations.reserve(nativeSessionId, token, controller.signal);
          } else if (input.config.persist) {
            await nativeReservations.beginPersistentOpen(token, controller.signal);
            persistentOpening = true;
          } else {
            nativeReservations.assertOpenable();
          }
          const sessionEmit = (event: ProviderEvent) => {
            if (
              opening.get(input.sessionId)?.token !== token &&
              sessions.get(input.sessionId)?.token !== token
            ) {
              return;
            }
            emit(event);
          };
          const transitionNativeSession = (previousSessionId: string, nextSessionId: string) => {
            if (input.config.persist) {
              if (nativeSessionId !== previousSessionId) {
                throw new OmpPublicError("OMP native session ownership changed during rewind");
              }
              nativeReservations.transition(previousSessionId, nextSessionId, token);
            }
            nativeSessionId = nextSessionId;
            const slot = sessions.get(input.sessionId);
            if (slot?.token === token) slot.nativeSessionId = nextSessionId;
          };
          const quarantineRewindCleanup = (cleanup: Promise<void>) => {
            quarantineFailedCleanup(
              input.sessionId,
              token,
              new OmpCleanupFailure(
                "OMP rewind left native session cleanup unresolved",
                cleanup,
                nativeSessionId,
              ),
              nativeSessionId,
            );
          };
          const retireRewindSession = () => {
            if (sessions.get(input.sessionId)?.token === token) sessions.delete(input.sessionId);
          };
          session = await OmpProviderSession.open(
            input,
            runtime,
            safeCapabilities,
            sessionEmit,
            transitionNativeSession,
            quarantineRewindCleanup,
            retireRewindSession,
            scheduler,
            replayTimeoutMs,
            controller.signal,
            environment,
            mcpConnector,
            mcpInitializationTimeoutMs,
          );
          const discoveredNativeSessionId = session.persistenceSessionId;
          if (discoveredNativeSessionId) nativeSessionId = discoveredNativeSessionId;
          if (persistentOpening) {
            if (!nativeSessionId)
              throw new OmpPublicError("OMP native session identity is missing");
            nativeReservations.completePersistentOpen(nativeSessionId, token);
            persistentOpening = false;
          } else if (
            discoveredNativeSessionId &&
            discoveredNativeSessionId !== ompPersistenceSessionId(input)
          ) {
            await nativeReservations.reserve(discoveredNativeSessionId, token, controller.signal);
          }
          if (
            closing ||
            controller.signal.aborted ||
            opening.get(input.sessionId)?.token !== token
          ) {
            await session.abortOpen();
            nativeReservations.release(nativeSessionId, token);
            return;
          }
          sessions.set(input.sessionId, { token, session, nativeSessionId });
          await session.publishOpened(input.requestId);
          if (
            closing ||
            controller.signal.aborted ||
            opening.get(input.sessionId)?.token !== token
          ) {
            if (sessions.get(input.sessionId)?.token === token) sessions.delete(input.sessionId);
            await session.close();
            nativeReservations.release(nativeSessionId, token);
          }
        } catch (error) {
          if (sessions.get(input.sessionId)?.token === token) sessions.delete(input.sessionId);
          let cleanupError: unknown;
          if (session) {
            try {
              await session.abortOpen();
            } catch (failure) {
              cleanupError = failure;
            }
          } else if (isOmpCleanupFailure(error)) {
            cleanupError = error;
            nativeSessionId ??= error.nativeSessionId;
          }
          if (cleanupError) {
            quarantineFailedCleanup(input.sessionId, token, cleanupError, nativeSessionId);
          } else {
            nativeReservations.release(nativeSessionId, token);
          }
          if (!closing && opening.get(input.sessionId)?.token === token) {
            const details = errorDetails(error, "OMP session failed to open");
            emit({ type: "request.failed", requestId: input.requestId, error: details });
            emit({ type: "session.closed", sessionId: input.sessionId, error: details });
          }
        } finally {
          if (opening.get(input.sessionId)?.token === token) opening.delete(input.sessionId);
          openingSettled.resolve();
        }
        return;
      }
      case "session.prompt": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: {
              type: "failed",
              error: { message: "Unknown OMP session" },
            },
          });
          return;
        }
        await session.prompt(input);
        return;
      }
      case "session.permission": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) throw new OmpPublicError("Unknown OMP session");
        await session.permission(input);
        return;
      }
      case "session.configure": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.configure(input);
        return;
      }
      case "session.revert": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.revert(input);
        return;
      }
      case "session.interrupt": {
        const session = sessions.get(input.sessionId)?.session;
        if (!session) {
          requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
          return;
        }
        await session.interrupt(input);
        return;
      }
      case "session.close": {
        const slot = sessions.get(input.sessionId);
        if (!slot) {
          const pending = opening.get(input.sessionId);
          if (!pending) {
            requestFailure(input.requestId, new OmpPublicError("Unknown OMP session"));
            return;
          }
          pending.controller.abort(new OmpPublicError("OMP session open was canceled"));
          await pending.settled;
          emit({ type: "request.completed", requestId: input.requestId });
          return;
        }
        try {
          await slot.session.close();
        } catch (error) {
          if (sessions.get(input.sessionId)?.token === slot.token) sessions.delete(input.sessionId);
          quarantineFailedCleanup(input.sessionId, slot.token, error, slot.nativeSessionId);
          throw new OmpPublicError("OMP session close failed");
        }
        if (sessions.get(input.sessionId)?.token === slot.token) sessions.delete(input.sessionId);
        nativeReservations.release(slot.nativeSessionId, slot.token);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default:
        if ("requestId" in input) {
          requestFailure(input.requestId, new OmpPublicError("Unsupported provider request"));
        }
    }
  };
  const disposeConnection = async (): Promise<void> => {
    closing = true;
    const shutdownReason = new Error("OMP provider connection closed");
    shutdown.abort(shutdownReason);
    for (const { controller } of opening.values()) controller.abort(shutdownReason);
    for (const { session } of sessions.values()) session.beginConnectionShutdown();
    const failures: unknown[] = [];
    const operationBatch = [...activeOperations];
    const operationResults = await Promise.allSettled(operationBatch);
    for (const operation of operationBatch) activeOperations.delete(operation);
    for (const result of operationResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    const seenSessions = new Set<OmpProviderSession>();
    const seenCleanups = new Set<Promise<void>>();
    const cleanupBatch: Promise<void>[] = [];
    for (const [sessionId, { session, nativeSessionId, token }] of sessions) {
      if (seenSessions.has(session)) continue;
      seenSessions.add(session);
      cleanupBatch.push(
        Promise.resolve().then(async () => {
          try {
            await session.close();
            nativeReservations.release(nativeSessionId, token);
          } catch (error) {
            quarantineFailedCleanup(sessionId, token, error, nativeSessionId);
            throw error;
          }
        }),
      );
    }
    for (const { cleanup } of failedCleanup.values()) {
      if (!cleanup || seenCleanups.has(cleanup)) continue;
      seenCleanups.add(cleanup);
      cleanupBatch.push(cleanup);
    }
    if (catalogCleanup && !seenCleanups.has(catalogCleanup)) {
      seenCleanups.add(catalogCleanup);
      cleanupBatch.push(catalogCleanup);
    }
    const results = await Promise.allSettled(cleanupBatch);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    listeners.clear();
    closed = true;
    if (failures.length > 0) {
      throw new AggregateError(failures, "OMP provider connection cleanup failed");
    }
    sessions.clear();
    opening.clear();
    failedCleanup.clear();
    catalogCleanup = null;
  };
  return {
    version: 1,
    capabilities: safeCapabilities,
    async send(input) {
      if (closing || closed) throw new Error("OMP provider connection is closed");
      if (activeOperations.size >= MAX_ACTIVE_OPERATIONS) {
        throw new OmpPublicError("OMP provider is busy");
      }
      try {
        preflightProviderInput(input);
        input = parseProviderInputCompat(input);
        validateInputEnvelope(input);
        requireProviderCapabilities(safeCapabilities, input);
      } catch (error) {
        const raw = input as unknown;
        if (raw && typeof raw === "object") {
          const record = raw as Record<string, unknown>;
          if (record.type === "session.prompt" && isBoundedIdentifier(record.sessionId)) {
            const prompt = record.prompt;
            if (prompt && typeof prompt === "object") {
              const clientMessageId = (prompt as Record<string, unknown>).clientMessageId;
              if (isBoundedIdentifier(clientMessageId)) {
                emit({
                  type: "session.prompt_result",
                  sessionId: record.sessionId,
                  clientMessageId,
                  result: { type: "failed", error: errorDetails(error, "OMP prompt failed") },
                });
                return;
              }
            }
          }
          if (isBoundedIdentifier(record.requestId)) {
            requestFailure(record.requestId, error, "OMP provider request failed");
            return;
          }
        }
        throw error;
      }
      const operation = Promise.resolve()
        .then(async () => {
          if (closing || closed) {
            if (input.type === "session.permission") {
              throw new Error("OMP provider connection is closed");
            }
            return;
          }
          await dispatch(input);
        })
        .catch((error) => {
          if (input.type === "session.prompt") {
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "failed", error: errorDetails(error, "OMP prompt failed") },
            });
          } else if (input.type === "session.permission") {
            throw error;
          } else if ("requestId" in input) {
            requestFailure(input.requestId, error, "OMP provider request failed");
          }
        });
      activeOperations.add(operation);
      void operation.then(
        () => activeOperations.delete(operation),
        () => activeOperations.delete(operation),
      );
      if (input.type === "session.permission") await operation;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closePromise ??= Promise.resolve().then(disposeConnection);
      return closePromise;
    },
  };
}
