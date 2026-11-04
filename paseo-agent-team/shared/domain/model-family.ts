// Model family of a live Profile, read from its provider/model tuple. Shared by the Team model
// summary and the same-family review warning, so both name a model the same way.
//
// Only the model id is evidence. A Profile name proves nothing (it can say "Lite" over an Opus
// model), and a provider is not a family: claude serves Opus and Sonnet, omp/codex route several
// vendors. A missing or automatic model, an unknown family, or an id naming two families never
// resolves. Adding a model means extending this table after the tuple is verified, never
// guessing.
//
// No imports: scripts may load this file through Node's type stripping.

export type ModelCost = "high" | "low" | "unknown";

/**
 * Supported families, with the cost class the table records for each. The cost class is
 * informational: nothing restricts a seat by it.
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

export function isModelFamily(value: string): value is ModelFamily {
  return Object.hasOwn(MODEL_FAMILIES, value);
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

export function modelFamilyName(family: ModelFamily): string {
  return MODEL_FAMILIES[family].name;
}
