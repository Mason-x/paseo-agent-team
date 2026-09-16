import type { OmpQuota } from "../shared/quota";
import { isOmpProvider } from "./omp-store-state";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  cursor: "Cursor",
  "google-antigravity": "Google",
  "openai-codex": "OpenAI",
};

// Paseo's own provider brand icons (@getpaseo/protocol names such as "claude" or "omp") are
// host-internal: passing one as a button `icon` string fails host validation, and rendering it
// through `Icon` draws nothing. Plugin icons resolve Lucide names only, so each provider maps
// to the Lucide vector closest to its mark.
const PROVIDER_ICON_NAMES: Record<string, string> = {
  anthropic: "Asterisk",
  azure: "Cloud",
  cursor: "MousePointer2",
  "google-antigravity": "Gem",
  openai: "Atom",
  "openai-codex": "Atom",
};

export function quotaProviderIconName(provider: string | null): string {
  return (provider ? PROVIDER_ICON_NAMES[provider] : undefined) ?? "Gauge";
}

export type QuotaSeverity = "ok" | "warning" | "danger" | "unknown";

export function quotaSeverityFromFraction(fraction: number | null): QuotaSeverity {
  if (fraction === null) return "unknown";
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warning";
  return "ok";
}
export function quotaProviderFromSession(
  provider: string,
  model: string | null = null,
): string | null {
  const [runtime, modelProvider] = provider.split("/");
  if (!isOmpProvider(runtime)) return null;
  if (modelProvider) return modelProvider;
  return model?.includes("/") ? model.split("/")[0] : null;
}

export function quotaProviderLabel(provider: string | null): string {
  return provider
    ? (PROVIDER_LABELS[provider] ?? `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`)
    : "Provider";
}

export function quotasForProvider(
  quotas: readonly OmpQuota[],
  provider: string | null,
  includeAll = false,
): OmpQuota[] {
  return provider
    ? quotas.filter((quota) => quota.provider === provider)
    : includeAll
      ? [...quotas]
      : [];
}

export function quotaSummaryForProvider(
  quotas: readonly OmpQuota[],
  provider: string | null,
  includeAll = false,
): { visible: boolean; label: string } {
  const matching = quotasForProvider(quotas, provider, includeAll);
  const label = provider ? quotaProviderLabel(provider) : "Quotas";
  const used = matching.flatMap((quota) =>
    quota.usedFraction === null ? [] : [quota.usedFraction],
  );
  if (used.length === 0) {
    return provider
      ? { visible: true, label: `${quotaProviderLabel(provider)} · —` }
      : { visible: includeAll, label: "Quotas · —" };
  }
  const peak = Math.round(Math.max(...used) * 100);
  return { visible: true, label: `${label} · ${peak}%` };
}

export function quotaSeverityForProvider(
  quotas: readonly OmpQuota[],
  provider: string | null,
  includeAll = false,
): QuotaSeverity {
  const used = quotasForProvider(quotas, provider, includeAll).flatMap((quota) =>
    quota.usedFraction === null ? [] : [quota.usedFraction],
  );
  return used.length === 0 ? "unknown" : quotaSeverityFromFraction(Math.max(...used));
}

export type QuotaProviderGroup = {
  provider: string;
  quotas: OmpQuota[];
  peakFraction: number | null;
  severity: QuotaSeverity;
};

/** Groups every recorded provider (not just the active session's) so a popover can show the
 * full comparison a user needs to decide which provider to switch to. The active session's
 * provider always sorts first; the rest fall back to worst-quota-first. */
export function quotaProviderGroups(
  quotas: readonly OmpQuota[],
  currentProvider: string | null,
): QuotaProviderGroup[] {
  const byProvider = new Map<string, OmpQuota[]>();
  for (const quota of quotas) {
    const group = byProvider.get(quota.provider);
    if (group) group.push(quota);
    else byProvider.set(quota.provider, [quota]);
  }
  const groups = [...byProvider.entries()].map(([provider, providerQuotas]) => {
    const used = providerQuotas.flatMap((quota) =>
      quota.usedFraction === null ? [] : [quota.usedFraction],
    );
    const peakFraction = used.length === 0 ? null : Math.max(...used);
    return {
      provider,
      quotas: [...providerQuotas].sort((a, b) => (b.usedFraction ?? -1) - (a.usedFraction ?? -1)),
      peakFraction,
      severity: quotaSeverityFromFraction(peakFraction),
    };
  });
  groups.sort((a, b) => {
    if (a.provider === currentProvider) return -1;
    if (b.provider === currentProvider) return 1;
    return (b.peakFraction ?? -1) - (a.peakFraction ?? -1);
  });
  return groups;
}

export function quotaResetLabel(resetsAtMs: number | null, nowMs: number = Date.now()): string {
  if (resetsAtMs === null) return "";
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return hours > 0 ? `resets ${hours}h ${minutes}m` : `resets ${minutes}m`;
}
