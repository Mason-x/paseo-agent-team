/** Paseo's useSettings write path runs `z.json().parse(...)`, which rejects `undefined`. */
export function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
