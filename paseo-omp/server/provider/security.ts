export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_PUBLIC_STRING_BYTES = 1024 * 1024;
const MAX_PUBLIC_COLLECTION_ITEMS = 128;
const MAX_PUBLIC_DEPTH = 16;
const MAX_PUBLIC_NODES = 2_048;
const MAX_SENSITIVE_VALUES = 256;
const MAX_SENSITIVE_VALUE_BYTES = 256 * 1024;
const MAX_PUBLIC_JSON_BYTES = 256 * 1024;
const REDACTED = "<redacted>";
const OMITTED = "<omitted>";

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonStringBytes(value: string): number {
  return utf8Bytes(JSON.stringify(value));
}

function jsonStringCharacterBytes(character: string): number {
  const codeUnit = character.charCodeAt(0);
  if (codeUnit === 0x22 || codeUnit === 0x5c) return 2;
  if (codeUnit <= 0x1f) {
    return codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
      ? 2
      : 6;
  }
  if (character.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdfff) return 6;
  return utf8Bytes(character);
}

function truncateJsonString(value: string, maxBytes: number): string {
  if (jsonStringBytes(value) <= maxBytes) return value;
  const suffix = "<truncated>";
  const suffixBytes = jsonStringBytes(suffix);
  if (suffixBytes > maxBytes) return "";
  const budget = maxBytes - suffixBytes;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = jsonStringCharacterBytes(character);
    if (bytes + characterBytes > budget) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${suffix}`;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = "<truncated>";
  const budget = Math.max(0, maxBytes - utf8Bytes(suffix));
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > budget) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${suffix}`;
}

export interface BoundedJsonMetrics {
  bytes: number;
  nodes: number;
}

/** Returns undefined as soon as a depth, item, node, string, or cumulative limit is crossed. */
export function boundedJsonMetrics(
  value: unknown,
  maxBytes: number,
  maxItems = MAX_PUBLIC_COLLECTION_ITEMS,
  maxStringBytes = maxBytes,
  maxNodes = MAX_PUBLIC_NODES,
): BoundedJsonMetrics | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes || current.depth > MAX_PUBLIC_DEPTH) return;
    const item = current.value;
    if (item === null || typeof item === "boolean" || typeof item === "number") continue;
    if (typeof item === "string") {
      const itemBytes = utf8Bytes(item);
      if (itemBytes > maxStringBytes) return;
      bytes += itemBytes;
      if (bytes > maxBytes) return;
      continue;
    }
    if (typeof item !== "object") return;
    if (Array.isArray(item)) {
      if (item.length > maxItems) return;
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    let itemCount = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      const child = (item as Record<string, unknown>)[key];
      if (child === undefined) continue;
      itemCount += 1;
      if (itemCount > maxItems) return;
      bytes += utf8Bytes(key);
      if (bytes > maxBytes) return;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return { bytes, nodes };
}

/** Returns Infinity as soon as a depth, item, node, string, or cumulative byte limit is crossed. */
export function boundedJsonBytes(
  value: unknown,
  maxBytes: number,
  maxItems = MAX_PUBLIC_COLLECTION_ITEMS,
  maxStringBytes = maxBytes,
  maxNodes = MAX_PUBLIC_NODES,
): number {
  return (
    boundedJsonMetrics(value, maxBytes, maxItems, maxStringBytes, maxNodes)?.bytes ??
    Number.POSITIVE_INFINITY
  );
}

export class BoundedStringSet {
  private readonly values = new Map<string, true>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Bounded set limit must be positive");
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    if (this.values.delete(value)) {
      this.values.set(value, true);
      return;
    }
    this.values.set(value, true);
    if (this.values.size <= this.limit) return;
    const oldest = this.values.keys().next().value;
    if (oldest !== undefined) this.values.delete(oldest);
  }
}

export class OmpPublicError extends Error {
  override readonly name = "OmpPublicError";
}

export function isOmpPublicError(error: unknown): error is OmpPublicError {
  return (
    error instanceof OmpPublicError || (error instanceof Error && error.name === "OmpPublicError")
  );
}

export class OmpCleanupFailure extends Error {
  override readonly name = "OmpCleanupFailure";

  constructor(
    message: string,
    readonly cleanup: Promise<void>,
    readonly nativeSessionId?: string,
  ) {
    void cleanup.catch(() => undefined);
    super(message);
  }
}

export function isOmpCleanupFailure(error: unknown): error is OmpCleanupFailure {
  return (
    error instanceof OmpCleanupFailure ||
    (error instanceof Error &&
      error.name === "OmpCleanupFailure" &&
      "cleanup" in error &&
      error.cleanup instanceof Promise)
  );
}

export class OmpPublicDataFilter {
  private readonly sensitiveValueSet = new Set<string>();
  private readonly sensitiveValues: string[] = [];
  private sensitiveValueBytes = 0;

  constructor(values: Iterable<string> = []) {
    this.addSensitiveValues(values);
  }

  addSensitiveValues(values: Iterable<string>): void {
    const additions: string[] = [];
    let addedBytes = 0;
    for (const value of values) {
      if (utf8Bytes(value) < 4) continue;
      if (this.sensitiveValueSet.has(value) || additions.includes(value)) continue;
      additions.push(value);
      addedBytes += utf8Bytes(value);
    }
    if (
      this.sensitiveValueSet.size + additions.length > MAX_SENSITIVE_VALUES ||
      this.sensitiveValueBytes + addedBytes > MAX_SENSITIVE_VALUE_BYTES
    ) {
      throw new Error("OMP sensitive-value redaction budget exceeded");
    }
    additions.sort((left, right) => right.length - left.length);
    for (const value of additions) {
      this.sensitiveValueSet.add(value);
      this.sensitiveValueBytes += utf8Bytes(value);
      const index = this.sensitiveValues.findIndex((existing) => existing.length < value.length);
      if (index < 0) this.sensitiveValues.push(value);
      else this.sensitiveValues.splice(index, 0, value);
    }
  }

  text(input: string, maxBytes = MAX_PUBLIC_STRING_BYTES): string {
    let output = input;
    for (const value of this.sensitiveValues) output = output.split(value).join(REDACTED);
    return truncateUtf8(output, maxBytes);
  }

  json(
    input: unknown,
    maxStringBytes = MAX_PUBLIC_STRING_BYTES,
    maxOutputBytes = MAX_PUBLIC_JSON_BYTES,
  ): JsonValue {
    const seen = new WeakSet<object>();
    let nodes = 0;
    let remaining = maxOutputBytes;
    const consume = (bytes: number) => {
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    };
    const boundedString = (value: string): string => {
      const sanitized = this.text(value, Math.min(maxStringBytes, remaining));
      const output = truncateJsonString(sanitized, remaining);
      consume(jsonStringBytes(output));
      return output;
    };
    const visit = (value: unknown, depth: number): JsonValue => {
      nodes += 1;
      if (nodes > MAX_PUBLIC_NODES || depth > MAX_PUBLIC_DEPTH || remaining < 16) return OMITTED;
      if (value === null) {
        consume(4);
        return null;
      }
      if (typeof value === "boolean") {
        consume(value ? 4 : 5);
        return value;
      }
      if (typeof value === "number") {
        const safe = Number.isFinite(value) ? value : null;
        consume(utf8Bytes(JSON.stringify(safe)));
        return safe;
      }
      if (typeof value === "string") return boundedString(value);
      if (typeof value !== "object" || seen.has(value)) return OMITTED;
      seen.add(value);
      if (Array.isArray(value)) {
        if (!consume(2)) return OMITTED;
        const output: JsonValue[] = [];
        const length = Math.min(value.length, MAX_PUBLIC_COLLECTION_ITEMS);
        for (let index = 0; index < length && remaining >= 16; index += 1) {
          if (index > 0) consume(1);
          output.push(visit(value[index], depth + 1));
        }
        return output;
      }
      if (!consume(2)) return OMITTED;
      const output = Object.create(null) as { [key: string]: JsonValue };
      let itemCount = 0;
      for (const childKey in value) {
        if (!Object.hasOwn(value, childKey) || remaining < 32) continue;
        itemCount += 1;
        if (itemCount > MAX_PUBLIC_COLLECTION_ITEMS) break;
        const safeKey = this.text(childKey, 256);
        if (
          safeKey === "__proto__" ||
          safeKey === "constructor" ||
          safeKey === "prototype" ||
          Object.hasOwn(output, safeKey)
        ) {
          continue;
        }
        const keyBytes = utf8Bytes(JSON.stringify(safeKey)) + 1 + (itemCount > 1 ? 1 : 0);
        if (!consume(keyBytes)) break;
        output[safeKey] = visit((value as Record<string, unknown>)[childKey], depth + 1);
      }
      return output;
    };
    return visit(input, 0);
  }
}
