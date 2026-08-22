import { describe, expect, it } from "vitest";
import { SentenceChunker } from "./chunker";

describe("SentenceChunker", () => {
  it("emits complete sentences", () => {
    const chunker = new SentenceChunker({ minLength: 5 });
    const result = chunker.push("Hello world. This is a test.");
    expect(result).toEqual(["Hello world.", "This is a test."]);
  });

  it("buffers until sentence end", () => {
    const chunker = new SentenceChunker({ minLength: 5 });
    let result = chunker.push("Hello world");
    expect(result).toEqual([]);
    result = chunker.push(". Next sentence.");
    expect(result).toEqual(["Hello world.", "Next sentence."]);
  });

  it("flushes remainder above min length", () => {
    const chunker = new SentenceChunker({ minLength: 5 });
    chunker.push("Hello world. This is");
    expect(chunker.flush()).toEqual(["This is"]);
  });

  it("drops tiny remainder on flush", () => {
    const chunker = new SentenceChunker({ minLength: 20 });
    chunker.push("Hi.");
    expect(chunker.flush()).toEqual([]);
  });

  it("hard breaks long sentences", () => {
    const chunker = new SentenceChunker({ minLength: 5, maxLength: 20 });
    const long = "A long sentence with many words no punctuation";
    const result = chunker.push(long);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].length).toBeLessThanOrEqual(20);
  });
});
