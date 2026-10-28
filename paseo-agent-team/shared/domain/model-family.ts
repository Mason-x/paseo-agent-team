// Model family of a live Profile, read from its provider/model tuple. Shared by the Team model
// summary and the economy-all eligibility check, so both name a model the same way.
//
// Only the model id is evidence. A Profile name proves nothing (it can say "Lite" over an Opus
// model), and a provider is not a family: claude serves Opus and Sonnet, omp/codex route several
// vendors. A missing or automatic model, an unknown family, or an id naming two families never
// resolves, so it can never pass as cheap. Adding a model means extending this table after the
// tuple is verified, never guessing.
//
// No imports: scripts may load this file through Node's type stripping.

export type ModelCost = "high" | "low" | "unknown";

/**
 * Supported families. Opus, Astra, and Sol are high-cost and never eligible for a cheap seat;
 * Sonnet, DeepSeek, and Grok (plus Haiku and Luna for small hosts) are low-cost; a family that is
 * recognized for display but whose cost is not verified stays "unknown".
 */
export const MODEL_FAMILIES = {
  opus: { cost: "high", name: "Opus" },
  astra: { cost: "high", name: "Astra" },
  sol: { cost: "high", name: "Sol" },
  sonnet: { cost: "low", name: "Sonnet" },
  haiku: { cost: "low", name: "Haiku" },
  deepseek: { cost: "low", name: "DeepSeek" },
  grok: { cost: "low", name: "Grok" },
  luna: { cost: "low", name: "Luna" },
  gemini: { cost: "unknown", name: "Gemini" },
} as const satisfies Record<string, { cost: ModelCost; name: string }>;

export type ModelFamily = keyof typeof MODEL_FAMILIES;

/** A model setting that leaves the choice to the provider is not a model identity. */
const AUTOMATIC_MODELS = new Set(["auto", "default"]);

export type ModelFamilyMatch =
  | { status: "identified"; family: ModelFamily; cost: ModelCost }
  | {
      status: "unresolved";
      reason: "model-missing" | "model-auto" | "family-unknown" | "family-ambiguous";
      /** Every family named by the id; non-empty only for family-ambiguous. */
      families: readonly ModelFamily[];
    };

export type ModelTuple = { provider: string; model?: string };

export function isModelFamily(value: string): value is ModelFamily {
  return Object.hasOwn(MODEL_FAMILIES, value);
}

/** The binding rule: an empty model string means "not specified"; anything else is compared as is. */
function boundModelOf(tuple: { model?: string | null }): string | undefined {
  return tuple.model === undefined || tuple.model === null || tuple.model === ""
    ? undefined
    : tuple.model;
}

/**
 * Identify the family from the model id. Every routing segment ("cursor/", "opencode-go/") is
 * scanned and a family must be a whole token: "solar" is not Sol and "grok4" is not Grok.
 */
export function identifyModelFamily(tuple: { model?: string | null }): ModelFamilyMatch {
  const model = tuple.model?.trim().toLowerCase();
  if (!model) return { status: "unresolved", reason: "model-missing", families: [] };
  if (AUTOMATIC_MODELS.has(model)) {
    return { status: "unresolved", reason: "model-auto", families: [] };
  }
  const families: ModelFamily[] = [];
  for (const token of model.split(/[^a-z0-9]+/)) {
    if (isModelFamily(token) && !families.includes(token)) families.push(token);
  }
  const [family] = families;
  if (family === undefined) return { status: "unresolved", reason: "family-unknown", families };
  if (families.length > 1) return { status: "unresolved", reason: "family-ambiguous", families };
  return { status: "identified", family, cost: MODEL_FAMILIES[family].cost };
}

/** True when any family the id names is high-cost, including an ambiguous id. */
export function namesHighCostFamily(match: ModelFamilyMatch): boolean {
  if (match.status === "identified") return match.cost === "high";
  return match.families.some((family) => MODEL_FAMILIES[family].cost === "high");
}

/** A stored family string (pool or allSeats entry) as a supported family, if it is one. */
export function storedModelFamily(raw: unknown): ModelFamily | undefined {
  if (typeof raw !== "string") return undefined;
  const family = raw.trim().toLowerCase();
  return isModelFamily(family) ? family : undefined;
}

export function modelFamilyName(family: ModelFamily): string {
  return MODEL_FAMILIES[family].name;
}

/** The live runtime tuple, with an empty model normalized to "not specified". */
export function modelTupleOf(profile: { provider: string; model?: string }): ModelTuple {
  const model = boundModelOf(profile);
  return model === undefined
    ? { provider: profile.provider }
    : { provider: profile.provider, model };
}

/**
 * A saved boundModel still describes the live Profile only when provider and model both match
 * exactly (the pool's existing rule); any re-pointing means the family must be verified again.
 */
export function sameModelTuple(
  saved: { provider: string; model?: string | null },
  live: { provider: string; model?: string | null },
): boolean {
  return saved.provider === live.provider && boundModelOf(saved) === boundModelOf(live);
}
