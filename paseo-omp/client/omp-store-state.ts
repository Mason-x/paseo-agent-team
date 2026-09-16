import { type OmpStore, storeForProvider } from "../shared/omp-store";
import type { OmpQuota } from "../shared/quota";

export function ompStoreKey(store?: OmpStore): string {
  return store?.profile
    ? `profile:${store.profile}`
    : store?.agentDir
      ? `directory:${store.agentDir}`
      : "default";
}

export function isOmpPluginProvider(provider?: string): boolean {
  return provider === "omp-plugin" || storeForProvider(provider) !== undefined;
}

export function isOmpProvider(provider?: string): boolean {
  return provider === "omp" || isOmpPluginProvider(provider);
}

/** Each store owns its own result and in-flight read. Failed reads never become empty success. */
export function createStoreQuotaLoader(
  load: (input: { store?: OmpStore }) => Promise<{ quotas: OmpQuota[] }>,
  maxAgeMs: number,
  now = Date.now,
) {
  const cache = new Map<string, { value: { quotas: OmpQuota[] }; at: number }>();
  const pending = new Map<string, Promise<{ quotas: OmpQuota[] }>>();
  return (store?: OmpStore): Promise<{ quotas: OmpQuota[] }> => {
    const key = ompStoreKey(store);
    const cached = cache.get(key);
    if (cached && now() - cached.at < maxAgeMs) return Promise.resolve(cached.value);
    const current = pending.get(key);
    if (current) return current;
    const request = load({ store })
      .then((value) => {
        cache.set(key, { value, at: now() });
        return value;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, request);
    return request;
  };
}
