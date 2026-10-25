import { describe, expect, test } from "vitest";
import {
  checkDesignRequest,
  countCodePoints,
  DESIGN_REQUEST_MAX_CODE_POINTS,
} from "../shared/domain/design-request";

describe("countCodePoints", () => {
  test("counts ASCII and CJK one per character", () => {
    expect(countCodePoints("")).toBe(0);
    expect(countCodePoints("abc")).toBe(3);
    expect(countCodePoints("设计一个团队")).toBe(6);
  });

  test("counts an astral character once, not as two UTF-16 units", () => {
    expect("😀".length).toBe(2);
    expect(countCodePoints("😀")).toBe(1);
    expect(countCodePoints("𠮷野家")).toBe(3);
  });
});

describe("checkDesignRequest", () => {
  test("the limit is 4000 code points", () => {
    expect(DESIGN_REQUEST_MAX_CODE_POINTS).toBe(4000);
  });

  test("accepts a normal request and returns it trimmed", () => {
    expect(checkDesignRequest("  给后台做改版\n")).toEqual({
      ok: true,
      request: "给后台做改版",
      length: 6,
    });
  });

  test("trims full-width spaces and line breaks", () => {
    expect(checkDesignRequest("　\n需求\t　")).toMatchObject({ ok: true, request: "需求" });
  });

  test.each(["", "   ", "\n\n", "　　", " \t\r\n "])("rejects blank input %j", (text) => {
    expect(checkDesignRequest(text)).toEqual({ ok: false, reason: "empty", length: 0 });
  });

  test("allows exactly the maximum and rejects one more", () => {
    expect(checkDesignRequest("字".repeat(4000))).toMatchObject({ ok: true, length: 4000 });
    expect(checkDesignRequest("字".repeat(4001))).toEqual({
      ok: false,
      reason: "too-long",
      length: 4001,
      excess: 1,
    });
  });

  test("counts code points, so 4000 emoji still fit", () => {
    const text = "😀".repeat(4000);
    expect(text.length).toBe(8000);
    expect(checkDesignRequest(text)).toMatchObject({ ok: true, length: 4000 });
    expect(checkDesignRequest(`${text}😀`)).toMatchObject({ ok: false, reason: "too-long" });
  });

  test("measures the trimmed text, which is what gets sent", () => {
    expect(checkDesignRequest(`${"字".repeat(4000)}\n\n   `)).toMatchObject({
      ok: true,
      length: 4000,
    });
  });

  test("takes a custom limit", () => {
    expect(checkDesignRequest("abcd", 3)).toMatchObject({ ok: false, excess: 1 });
    expect(checkDesignRequest("abc", 3)).toMatchObject({ ok: true });
  });
});
