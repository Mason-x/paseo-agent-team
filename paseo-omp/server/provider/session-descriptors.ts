import { createHash } from "node:crypto";
import { constants, type Dir } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ompSessionDir } from "../paths";

const MAX_DESCRIPTOR_PREFIX_BYTES = 64 * 1024;
const MAX_DESCRIPTOR_SUFFIX_BYTES = 64 * 1024;
const MAX_PROMPT_PREVIEW_CHARS = 160;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_SCAN_DIRECTORIES = 1_024;
const MAX_SCAN_FILES = 10_000;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_MS = 1_000;
const SCAN_YIELD_INTERVAL = 128;
const MAX_LIST_RESULTS = 500;
const MAX_CHILD_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_CHILD_TRANSCRIPT_MESSAGES = 100_000;
const MAX_SESSION_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_TRANSCRIPT_ENTRIES = 200_000;
const MAX_SESSION_TRANSCRIPT_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_IMAGE_BLOB_BYTES = 6 * 1024 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const BLOB_REFERENCE = /^blob:sha256:([a-f0-9]{64})$/u;
const CHILD_TRANSCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export interface OmpSessionDescriptor {
  id: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  transcriptFile?: string;
  firstPromptPreview?: string;
  lastPromptPreview?: string;
}

export interface OmpPersistedSubagentTranscript {
  sessionFile: string;
  nativeSessionId: string;
  byteLength: number;
  messages: unknown[];
}

export interface OmpPersistedSessionTranscript {
  sessionFile: string;
  nativeSessionId: string;
  byteLength: number;
  messages: unknown[];
}
export interface OmpSessionListOptions {
  cwd?: string;
  query?: string;
  limit?: number;
  sessionId?: string;
  sessionDir?: string;
}

interface ScanBudget {
  startedAt: number;
  directories: number;
  files: number;
  bytes: number;
  entries: number;
  exhausted: boolean;
}

export function validateNativeSessionId(value: unknown): string {
  if (typeof value !== "string" || !NATIVE_SESSION_ID.test(value)) {
    throw new Error("Invalid OMP session identifier");
  }
  return value;
}

function safeText(value: unknown, maxBytes: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  )
    return;
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint < 32 || codePoint === 127 ? " " : character;
  }
  return sanitized.trim() || undefined;
}

function validatedCwd(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    !isAbsolute(value)
  ) {
    return;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return;
  }
  return value;
}

function completePrefixLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    const end = index > start && buffer[index - 1] === 13 ? index - 1 : index;
    lines.push(buffer.subarray(start, end));
    start = index + 1;
  }
  return lines;
}
function completeSuffixLines(buffer: Buffer): Buffer[] {
  const firstNewline = buffer.indexOf(10);
  if (firstNewline < 0) return [];
  return completePrefixLines(buffer.subarray(firstNewline + 1));
}

function promptPreview(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .slice(0, 64)
            .flatMap((part) =>
              part && typeof part === "object" && typeof part.text === "string" ? [part.text] : [],
            )
            .join("\n")
        : "";
  const sanitized = safeText(text, MAX_DESCRIPTOR_PREFIX_BYTES)?.replace(/\s+/gu, " ").trim();
  if (!sanitized) return;
  const characters = Array.from(sanitized);
  if (characters.length <= MAX_PROMPT_PREVIEW_CHARS) return sanitized;
  return `${characters.slice(0, MAX_PROMPT_PREVIEW_CHARS - 1).join("")}…`;
}

function budgetExceeded(budget: ScanBudget): boolean {
  return (
    budget.exhausted ||
    budget.directories >= MAX_SCAN_DIRECTORIES ||
    budget.files >= MAX_SCAN_FILES ||
    budget.bytes >= MAX_SCAN_BYTES ||
    Date.now() - budget.startedAt >= MAX_SCAN_MS
  );
}

async function yieldToEventLoop(): Promise<void> {
  const result = Promise.withResolvers<void>();
  setImmediate(result.resolve);
  await result.promise;
}
async function readStableFile(
  handle: FileHandle,
  byteLength: number,
  signal: AbortSignal | undefined,
  changedMessage: string,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      Math.min(FILE_READ_CHUNK_BYTES, byteLength - offset),
      offset,
    );
    if (bytesRead === 0) throw new Error(changedMessage);
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, byteLength)).bytesRead !== 0) throw new Error(changedMessage);
  return bytes;
}

async function hydrateBlobImageData(
  data: string,
  blobDirectory: string,
  budget: { bytes: number },
  signal?: AbortSignal,
): Promise<string> {
  const match = BLOB_REFERENCE.exec(data);
  if (!match) return data;
  const hash = match[1];
  const blobFile = join(blobDirectory, hash);
  let handle: FileHandle;
  try {
    handle = await open(
      blobFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("OMP transcript image blob could not be opened");
  }
  try {
    const [stat, pathStat] = await Promise.all([handle.stat(), lstat(blobFile)]);
    if (
      !stat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      stat.size > MAX_SESSION_IMAGE_BLOB_BYTES ||
      budget.bytes + stat.size > MAX_SESSION_TRANSCRIPT_BLOB_BYTES
    ) {
      throw new Error("OMP transcript image blob failed ownership or size validation");
    }
    const bytes = await readStableFile(
      handle,
      stat.size,
      signal,
      "OMP transcript image blob changed while reading",
    );
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw new Error("OMP transcript image blob failed integrity validation");
    }
    budget.bytes += bytes.byteLength;
    return bytes.toString("base64");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hydrateImageParts(
  value: unknown,
  blobDirectory: string,
  budget: { bytes: number },
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Array.isArray(value)) return value;
  let hydrated: unknown[] | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const part = value[index];
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      !("type" in part) ||
      part.type !== "image" ||
      !("data" in part) ||
      typeof part.data !== "string" ||
      !BLOB_REFERENCE.test(part.data)
    ) {
      continue;
    }
    const data = await hydrateBlobImageData(part.data, blobDirectory, budget, signal);
    hydrated ??= [...value];
    hydrated[index] = { ...part, data };
  }
  return hydrated ?? value;
}

async function hydratePersistedMessageImages(
  message: unknown,
  blobDirectory: string | undefined,
  budget: { bytes: number },
  signal?: AbortSignal,
): Promise<unknown> {
  if (!blobDirectory || !message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  let content = await hydrateImageParts(record.content, blobDirectory, budget, signal);
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const contentRecord = content as Record<string, unknown>;
    const nested = await hydrateImageParts(contentRecord.content, blobDirectory, budget, signal);
    if (nested !== contentRecord.content) content = { ...contentRecord, content: nested };
  }
  const images = await hydrateImageParts(record.images, blobDirectory, budget, signal);
  if (content === record.content && images === record.images) return message;
  return { ...record, content, images };
}

async function parseDescriptor(
  file: string,
  budget: ScanBudget,
): Promise<OmpSessionDescriptor | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return;
    const prefixBytes = Math.min(MAX_DESCRIPTOR_PREFIX_BYTES, stat.size);
    const suffixBytes = Math.min(MAX_DESCRIPTOR_SUFFIX_BYTES, Math.max(0, stat.size - prefixBytes));
    if (budget.bytes + prefixBytes + suffixBytes > MAX_SCAN_BYTES) {
      budget.exhausted = true;
      return;
    }
    budget.bytes += prefixBytes + suffixBytes;
    const prefix = Buffer.allocUnsafe(prefixBytes);
    const { bytesRead: prefixRead } = await handle.read(prefix, 0, prefix.length, 0);
    const suffix = Buffer.allocUnsafe(suffixBytes);
    const { bytesRead: suffixRead } = suffixBytes
      ? await handle.read(suffix, 0, suffix.length, stat.size - suffixBytes)
      : { bytesRead: 0 };
    let title: string | undefined;
    let id: string | undefined;
    let cwd: string | undefined;
    let firstPromptPreview: string | undefined;
    let lastPromptPreview: string | undefined;
    const lines = [
      ...completePrefixLines(prefix.subarray(0, prefixRead)),
      ...completeSuffixLines(suffix.subarray(0, suffixRead)),
    ];
    for (const bytes of lines) {
      if (bytes.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "title") {
        title = safeText(record.title, 512) ?? title;
        continue;
      }
      if (record.type === "session_info") {
        title ??= safeText(record.title ?? record.sessionName ?? record.name, 512);
        continue;
      }
      if (record.type === "session") {
        id = validateNativeSessionId(record.id);
        cwd = validatedCwd(record.cwd);
        if (!cwd) return;
        title ??= safeText(record.title, 512);
        continue;
      }
      if (record.type !== "message") continue;
      const message = record.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== "user") continue;
      const preview = promptPreview(messageRecord.content);
      if (!preview) continue;
      firstPromptPreview ??= preview;
      lastPromptPreview = preview;
    }
    if (!id || !cwd) return;
    return {
      id,
      cwd,
      transcriptFile: file,
      ...(title ? { title } : {}),
      updatedAt: stat.mtime.toISOString(),
      ...(firstPromptPreview ? { firstPromptPreview } : {}),
      ...(lastPromptPreview ? { lastPromptPreview } : {}),
    };
  } catch {
    return;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function retainNewest(
  descriptors: OmpSessionDescriptor[],
  descriptor: OmpSessionDescriptor,
  limit: number,
): void {
  descriptors.push(descriptor);
  descriptors.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  if (descriptors.length > limit) descriptors.pop();
}

async function scanSessionFiles(
  root: string,
  budget: ScanBudget,
  visit: (file: string) => Promise<boolean>,
): Promise<void> {
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0 && !budgetExceeded(budget)) {
    const current = pending.pop();
    if (!current) return;
    budget.directories += 1;
    let directory: Dir;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    try {
      for await (const entry of directory) {
        budget.entries += 1;
        if (budget.entries % SCAN_YIELD_INTERVAL === 0) await yieldToEventLoop();
        if (budgetExceeded(budget)) return;
        const path = join(current.path, entry.name);
        if (entry.isDirectory() && current.depth < MAX_DIRECTORY_DEPTH) {
          if (pending.length + budget.directories < MAX_SCAN_DIRECTORIES) {
            pending.push({ path, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        budget.files += 1;
        if (!entry.name.endsWith(".jsonl")) continue;
        if (!(await visit(path))) return;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
}

export async function listOmpSessionDescriptors(
  options: OmpSessionListOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<OmpSessionDescriptor[]> {
  if (
    options.cwd !== undefined &&
    (!options.cwd || !isAbsolute(options.cwd) || options.cwd.includes("\0"))
  ) {
    throw new Error("OMP session listing requires an absolute working directory when scoped");
  }
  const requestedId = options.sessionId ? validateNativeSessionId(options.sessionId) : undefined;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIST_RESULTS);
  const retentionLimit = requestedId ? 2 : limit;
  const query = options.query?.trim().toLowerCase();
  const matches: OmpSessionDescriptor[] = [];
  const budget: ScanBudget = {
    startedAt: Date.now(),
    directories: 0,
    files: 0,
    bytes: 0,
    entries: 0,
    exhausted: false,
  };
  const root = options.sessionDir
    ? options.sessionDir.startsWith("~/")
      ? join(environment.HOME ?? environment.USERPROFILE ?? homedir(), options.sessionDir.slice(2))
      : resolve(options.cwd ?? homedir(), options.sessionDir)
    : ompSessionDir(environment);
  await scanSessionFiles(root, budget, async (file) => {
    const fileName = basename(file);
    const stem = fileName.slice(0, -".jsonl".length);
    if (requestedId && !stem.endsWith(`_${requestedId}`)) return true;
    const descriptor = await parseDescriptor(file, budget);
    if (
      !descriptor ||
      !stem.endsWith(`_${descriptor.id}`) ||
      (options.cwd !== undefined && descriptor.cwd !== options.cwd)
    )
      return !budgetExceeded(budget);
    if (
      query &&
      !descriptor.id.toLowerCase().includes(query) &&
      !descriptor.title?.toLowerCase().includes(query) &&
      !descriptor.firstPromptPreview?.toLowerCase().includes(query) &&
      !descriptor.lastPromptPreview?.toLowerCase().includes(query)
    ) {
      return !budgetExceeded(budget);
    }
    retainNewest(matches, descriptor, retentionLimit);
    return !requestedId || matches.length < 2;
  });
  return matches;
}

interface PersistedTranscriptNode {
  parentId: string | null;
  message?: unknown;
}

function persistedTranscriptMessage(record: Record<string, unknown>, entryId: string): unknown {
  if (record.type === "message") {
    if (!record.message || typeof record.message !== "object" || Array.isArray(record.message))
      return;
    return { ...(record.message as Record<string, unknown>), entryId };
  }
  if (record.type !== "custom_message") return;
  return {
    role: "custom",
    entryId,
    customType: record.customType,
    content: record.content,
    display: record.display,
    details: record.details,
  };
}

/**
 * Reads the active root-to-leaf display history from an already authorized native transcript.
 * OMP's get_messages endpoint exposes model-safe context and deliberately removes failed turns,
 * so persisted replay must use the journal to preserve user-visible assistant and tool history.
 */
export async function readOmpPersistedSessionTranscript(
  sessionFile: string,
  sessionId: string,
  cwd: string,
  signal?: AbortSignal,
  blobDirectory?: string,
): Promise<OmpPersistedSessionTranscript> {
  signal?.throwIfAborted();
  const expectedSessionId = validateNativeSessionId(sessionId);
  if (
    !isAbsolute(sessionFile) ||
    !sessionFile.endsWith(".jsonl") ||
    sessionFile.includes("\0") ||
    validatedCwd(cwd) !== cwd
  ) {
    throw new Error("Invalid OMP session transcript descriptor");
  }
  const expectedFile = resolve(sessionFile);
  let handle: FileHandle;
  try {
    handle = await open(
      expectedFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("OMP session transcript could not be opened");
  }
  try {
    const [stat, pathStat, canonicalFile] = await Promise.all([
      handle.stat(),
      lstat(expectedFile),
      realpath(expectedFile),
    ]);
    if (
      !stat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      stat.size > MAX_SESSION_TRANSCRIPT_BYTES
    ) {
      throw new Error("OMP session transcript failed ownership validation");
    }
    const bytes = await readStableFile(
      handle,
      stat.size,
      signal,
      "OMP session transcript changed while reading",
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const nodes = new Map<string, PersistedTranscriptNode>();
    let nativeSessionId: string | undefined;
    let leafId: string | undefined;
    let recordsRead = 0;
    for (const line of text.split("\n")) {
      signal?.throwIfAborted();
      recordsRead += 1;
      if (recordsRead % 1_024 === 0) await yieldToEventLoop();
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "session") {
        const candidateId = validateNativeSessionId(record.id);
        if (candidateId !== expectedSessionId || validatedCwd(record.cwd) !== cwd) {
          throw new Error("OMP session transcript identity does not match its descriptor");
        }
        nativeSessionId ??= candidateId;
        if (nativeSessionId !== candidateId) {
          throw new Error("OMP session transcript identity changed");
        }
        continue;
      }
      if (typeof record.id !== "string" || !CHILD_TRANSCRIPT_ID.test(record.id)) {
        if (record.type === "message" || record.type === "custom_message") {
          throw new Error("OMP session transcript contains an unlinked message");
        }
        continue;
      }
      const parentId = record.parentId;
      if (
        parentId !== null &&
        (typeof parentId !== "string" || !CHILD_TRANSCRIPT_ID.test(parentId))
      ) {
        throw new Error("OMP session transcript contains an invalid parent identity");
      }
      if (nodes.size >= MAX_SESSION_TRANSCRIPT_ENTRIES) {
        throw new Error("OMP session transcript exceeds entry limits");
      }
      if (nodes.has(record.id))
        throw new Error("OMP session transcript contains duplicate entries");
      nodes.set(record.id, {
        parentId,
        message: persistedTranscriptMessage(record, record.id),
      });
      leafId = record.id;
    }
    if (!nativeSessionId) throw new Error("OMP session transcript is missing session identity");

    const messages: unknown[] = [];
    const seen = new Set<string>();
    let currentId = leafId;
    let pathEntriesRead = 0;
    while (currentId) {
      pathEntriesRead += 1;
      if (pathEntriesRead % 1_024 === 0) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
      if (seen.has(currentId)) throw new Error("OMP session transcript contains a parent cycle");
      seen.add(currentId);
      const node = nodes.get(currentId);
      if (!node) throw new Error("OMP session transcript contains an unresolved parent");
      if (node.message !== undefined) messages.push(node.message);
      currentId = node.parentId ?? undefined;
    }
    messages.reverse();
    if (messages.length > MAX_CHILD_TRANSCRIPT_MESSAGES) {
      throw new Error("OMP session transcript exceeds message limits");
    }
    const hydratedMessages: unknown[] = [];
    const blobBudget = { bytes: 0 };
    for (const message of messages) {
      signal?.throwIfAborted();
      hydratedMessages.push(
        await hydratePersistedMessageImages(message, blobDirectory, blobBudget, signal),
      );
    }
    return {
      sessionFile: canonicalFile,
      nativeSessionId,
      byteLength: bytes.byteLength,
      messages: hydratedMessages,
    };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("OMP session transcript could not be decoded");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readOmpPersistedSubagentTranscript(
  parentSessionFile: string,
  childTranscriptId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<OmpPersistedSubagentTranscript> {
  signal?.throwIfAborted();
  if (
    !isAbsolute(parentSessionFile) ||
    !parentSessionFile.endsWith(".jsonl") ||
    parentSessionFile.includes("\0") ||
    !CHILD_TRANSCRIPT_ID.test(childTranscriptId) ||
    basename(childTranscriptId) !== childTranscriptId
  ) {
    throw new Error("Invalid OMP child transcript descriptor");
  }
  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      parentSessionFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("OMP parent transcript could not be opened");
  }
  try {
    const stat = await parentHandle.stat();
    if (!stat.isFile()) throw new Error("OMP parent transcript is not a file");
  } finally {
    await parentHandle.close().catch(() => undefined);
  }
  const canonicalParent = await realpath(parentSessionFile);
  const parentExtension = extname(canonicalParent);
  const expectedDirectory = canonicalParent.slice(0, -parentExtension.length);
  const canonicalDirectory = await realpath(expectedDirectory).catch(() => undefined);
  if (!canonicalDirectory || canonicalDirectory !== expectedDirectory) {
    throw new Error("OMP child transcript directory is not canonically owned by its parent");
  }
  const sessionFile = join(canonicalDirectory, `${childTranscriptId}.jsonl`);
  let handle: FileHandle;
  try {
    handle = await open(
      sessionFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("OMP child transcript could not be opened");
  }
  try {
    const [stat, canonicalChild] = await Promise.all([handle.stat(), realpath(sessionFile)]);
    if (
      !stat.isFile() ||
      stat.size > MAX_CHILD_TRANSCRIPT_BYTES ||
      dirname(canonicalChild) !== canonicalDirectory ||
      canonicalChild !== sessionFile
    ) {
      throw new Error("OMP child transcript failed ownership validation");
    }
    const bytes = await handle.readFile();
    signal?.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const messages: unknown[] = [];
    let nativeSessionId: string | undefined;
    for (const line of text.split("\n")) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === "session") {
        const candidateId = validateNativeSessionId(record.id);
        const candidateCwd = validatedCwd(record.cwd);
        if (candidateCwd !== cwd)
          throw new Error("OMP child transcript belongs to another workspace");
        nativeSessionId ??= candidateId;
        if (nativeSessionId !== candidateId)
          throw new Error("OMP child transcript identity changed");
      } else if (record.type === "message" && record.message !== undefined) {
        if (messages.length >= MAX_CHILD_TRANSCRIPT_MESSAGES) {
          throw new Error("OMP child transcript exceeds message limits");
        }
        messages.push(record.message);
      }
    }
    if (!nativeSessionId) throw new Error("OMP child transcript is missing session identity");
    return { sessionFile, nativeSessionId, byteLength: bytes.byteLength, messages };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("OMP child transcript could not be decoded");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
