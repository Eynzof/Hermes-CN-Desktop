import { describe, expect, it } from "vitest";
import {
  containsCjk,
  hasLoneCjkRun,
  tokenize,
  tokenizeForFtsCjk,
  tokenizeQueryCjk,
  trigramEligible,
} from "./tokenize";

describe("tokenize", () => {
  it("emits overlapping bigrams for CJK runs", () => {
    expect(tokenize("人工智能", { joinBigrams: false })).toEqual([
      "人工",
      "工智",
      "智能",
    ]);
  });

  it("emits lone CJK as unigram", () => {
    expect(tokenize("人", { joinBigrams: false })).toEqual(["人"]);
  });

  it("joins bigrams with private separator for FTS storage", () => {
    expect(tokenizeForFtsCjk("人工智能")).toBe("人工\u0001工智\u0001智能");
  });

  it("emits separate bigrams for query time", () => {
    expect(tokenizeQueryCjk("人工智能")).toEqual(["人工", "工智", "智能"]);
  });

  it("handles mixed Latin+CJK", () => {
    expect(tokenize("hello 人工智能 world", { includeNonCjk: true })).toEqual([
      "hello",
      "人工",
      "工智",
      "智能",
      "world",
    ]);
  });

  it("detects CJK presence", () => {
    expect(containsCjk("ai")).toBe(false);
    expect(containsCjk("人工")).toBe(true);
  });

  it("detects lone CJK run", () => {
    expect(hasLoneCjkRun("人工 智能")).toBe(false);
    expect(hasLoneCjkRun("人 工智能")).toBe(true);
  });

  it("evaluates trigram eligibility", () => {
    expect(trigramEligible("人工智能")).toBe(true);
    expect(trigramEligible("人工")).toBe(false);
    expect(trigramEligible("hello")).toBe(false);
  });

  it("handles Korean Hangul", () => {
    // Hangul is inside the CJK Unicode blocks used by fts5_cjk.
    expect(tokenize("한국어", { joinBigrams: false })).toEqual([
      "한국",
      "국어",
    ]);
  });

  it("handles Japanese kana", () => {
    expect(tokenize("カタカナ", { joinBigrams: false })).toEqual([
      "カタ",
      "タカ",
      "カナ",
    ]);
  });
});
