import { describe, expect, test } from "vitest";
import {
  identifyModelFamily,
  isModelFamily,
  MODEL_FAMILIES,
  type ModelFamily,
  modelFamilyName,
  modelTupleOf,
  namesHighCostFamily,
  sameModelTuple,
  storedModelFamily,
} from "../shared/domain/model-family";

// Live provider/model tuples in the shape real hosts report them: native ids, bare provider
// aliases, and routed omp/opencode/cursor ids. Names are deliberately misleading where noted.
const LIVE: readonly { name: string; provider: string; model: string; family: ModelFamily }[] = [
  { name: "Claude-Opus-5.5-Max", provider: "claude", model: "claude-opus-5-5", family: "opus" },
  {
    name: "Claude-Sonnet 5.5-Max",
    provider: "claude",
    model: "claude-sonnet-5-5",
    family: "sonnet",
  },
  { name: "Long context", provider: "claude", model: "claude-sonnet-5-5[1m]", family: "sonnet" },
  { name: "Alias", provider: "claude", model: "opus", family: "opus" },
  { name: "Alias", provider: "claude", model: "sonnet", family: "sonnet" },
  { name: "DEV Haiku 5.5", provider: "claude", model: "claude-haiku-5-5", family: "haiku" },
  { name: "GPT-6-Astra-Max", provider: "codex", model: "gpt-6-astra", family: "astra" },
  { name: "GPT-6.1-Sol Max", provider: "codex", model: "gpt-6.1-sol", family: "sol" },
  { name: "GPT-5.6-Sol-Xhigh", provider: "codex", model: "gpt-5.6-sol", family: "sol" },
  { name: "DEV GPT-6-Luna", provider: "codex", model: "gpt-6-luna", family: "luna" },
  {
    name: "DeepSeek-V4.1-Flash-Max",
    provider: "omp",
    model: "opencode-go/deepseek-v4.1-flash",
    family: "deepseek",
  },
  {
    name: "Grok-4.6-High-Fast",
    provider: "omp",
    model: "cursor/cursor-grok-4.6-fast",
    family: "grok",
  },
  {
    name: "Cursor-Claude-Sonnet-5.5",
    provider: "omp",
    model: "magpie/cursor/claude-sonnet-5-5",
    family: "sonnet",
  },
  {
    name: "Gemini-3.8-flash-High",
    provider: "omp",
    model: "CPA/gemini-3.8-flash-high",
    family: "gemini",
  },
  { name: "Opus-Lite (misnamed)", provider: "omp", model: "deepseek-chat", family: "deepseek" },
  { name: "Cheap Sonnet (misnamed)", provider: "claude", model: "claude-opus-5-5", family: "opus" },
];

describe("model family identification", () => {
  test.each(LIVE)("$provider/$model -> $family", ({ name, provider, model, family }) => {
    const profile = { id: `profile-${family}`, name, provider, model };
    expect(identifyModelFamily(profile)).toEqual({
      status: "identified",
      family,
      cost: MODEL_FAMILIES[family].cost,
    });
  });

  test("Opus, Astra, and Sol are high-cost; the supported cheap families are low-cost", () => {
    const byCost = (cost: string) =>
      Object.entries(MODEL_FAMILIES)
        .filter(([, value]) => value.cost === cost)
        .map(([family]) => family);
    expect(byCost("high")).toEqual(["opus", "astra", "sol"]);
    expect(byCost("low")).toEqual(["sonnet", "haiku", "deepseek", "grok", "luna"]);
    expect(byCost("unknown")).toEqual(["gemini"]);
  });

  test("the name never decides: the same model under any name is the same family", () => {
    for (const name of ["Opus", "Sonnet-cheap", "DeepSeek", "budget", ""]) {
      const profile = { id: "astra", name, provider: "codex", model: "gpt-6-astra" };
      expect(identifyModelFamily(profile)).toMatchObject({ family: "astra", cost: "high" });
    }
  });

  test("the provider is not a family: a missing or automatic model never resolves", () => {
    for (const model of [undefined, null, "", "   "]) {
      expect(identifyModelFamily({ model })).toEqual({
        status: "unresolved",
        reason: "model-missing",
        families: [],
      });
    }
    for (const model of ["auto", "Default", " AUTO "]) {
      expect(identifyModelFamily({ model })).toEqual({
        status: "unresolved",
        reason: "model-auto",
        families: [],
      });
    }
  });

  test("a family is a whole token, never a substring", () => {
    for (const model of ["solar-pro", "console-1", "grok4", "deepseekv4", "opusplan", "gpt-6"]) {
      expect(identifyModelFamily({ model })).toEqual({
        status: "unresolved",
        reason: "family-unknown",
        families: [],
      });
    }
    expect(identifyModelFamily({ model: "OPUS_4" })).toMatchObject({ family: "opus" });
    expect(identifyModelFamily({ model: "grok:4@latest" })).toMatchObject({ family: "grok" });
  });

  test("an id naming two families is ambiguous and still reports a high-cost one", () => {
    const mixed = identifyModelFamily({ model: "router-sonnet/claude-opus-5-5" });
    expect(mixed).toEqual({
      status: "unresolved",
      reason: "family-ambiguous",
      families: ["sonnet", "opus"],
    });
    expect(namesHighCostFamily(mixed)).toBe(true);
    const cheapPair = identifyModelFamily({ model: "deepseek-grok-merge" });
    expect(cheapPair).toMatchObject({ reason: "family-ambiguous", families: ["deepseek", "grok"] });
    expect(namesHighCostFamily(cheapPair)).toBe(false);
    expect(identifyModelFamily({ model: "sonnet-sonnet-5" })).toMatchObject({ family: "sonnet" });
  });

  test("namesHighCostFamily follows the identified cost", () => {
    expect(namesHighCostFamily(identifyModelFamily({ model: "gpt-6.1-sol" }))).toBe(true);
    expect(namesHighCostFamily(identifyModelFamily({ model: "claude-sonnet-5-5" }))).toBe(false);
    expect(namesHighCostFamily(identifyModelFamily({ model: "gemini-4-argon" }))).toBe(false);
    expect(namesHighCostFamily(identifyModelFamily({ model: "auto" }))).toBe(false);
  });
});

describe("family names and stored values", () => {
  test("stored family strings map only onto supported families", () => {
    expect(storedModelFamily("deepseek")).toBe("deepseek");
    expect(storedModelFamily(" Sonnet ")).toBe("sonnet");
    for (const raw of ["unverified-family", "", "constructor", 7, null, undefined, ["grok"]]) {
      expect(storedModelFamily(raw)).toBeUndefined();
    }
    expect(isModelFamily("hasOwnProperty")).toBe(false);
  });

  test("every family has a display name", () => {
    for (const family of Object.keys(MODEL_FAMILIES) as ModelFamily[]) {
      expect(modelFamilyName(family).length).toBeGreaterThan(0);
    }
    expect(modelFamilyName("deepseek")).toBe("DeepSeek");
  });
});

describe("runtime tuples", () => {
  test("an empty model means not specified; any other text is kept exactly", () => {
    expect(modelTupleOf({ provider: "claude", model: "" })).toEqual({ provider: "claude" });
    expect(modelTupleOf({ provider: "claude" })).toEqual({ provider: "claude" });
    expect(modelTupleOf({ provider: "omp", model: "cursor/cursor-grok-4.6-fast" })).toEqual({
      provider: "omp",
      model: "cursor/cursor-grok-4.6-fast",
    });
  });

  test("a saved tuple matches only the same provider and the same model", () => {
    const live = { provider: "claude", model: "claude-sonnet-5-5" };
    expect(sameModelTuple({ provider: "claude", model: "claude-sonnet-5-5" }, live)).toBe(true);
    expect(sameModelTuple({ provider: "omp", model: "claude-sonnet-5-5" }, live)).toBe(false);
    expect(sameModelTuple({ provider: "claude", model: "claude-opus-5-5" }, live)).toBe(false);
    expect(sameModelTuple({ provider: "claude" }, live)).toBe(false);
    expect(sameModelTuple({ provider: "claude", model: " claude-sonnet-5-5" }, live)).toBe(false);
    expect(sameModelTuple({ provider: "claude", model: "" }, { provider: "claude" })).toBe(true);
    expect(sameModelTuple({ provider: "claude", model: null }, { provider: "claude" })).toBe(true);
  });
});
