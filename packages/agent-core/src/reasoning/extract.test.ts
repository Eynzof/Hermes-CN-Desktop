import { describe, it, expect } from "vitest";
import {
  extractReasoningBlocks,
  extractOpenAIReasoning,
  extractAnthropicReasoning,
  stripReasoning,
} from "./extract.js";

describe("extractReasoningBlocks", () => {
  it("extracts Anthropic <thinking> blocks", () => {
    const text = "Hello.\n<thinking>Step 1: check units.</thinking>Result.";
    const blocks = extractReasoningBlocks(text);
    expect(blocks).toEqual([
      { source: "anthropic", content: "Step 1: check units." },
    ]);
  });

  it("extracts OpenAI <reasoning> blocks", () => {
    const text = "<reasoning>First principles</reasoning>Answer.";
    const blocks = extractReasoningBlocks(text);
    expect(blocks).toEqual([
      { source: "openai", content: "First principles" },
    ]);
  });

  it("extracts DeepSeek R1 think tags", () => {
    const text = "Start. \\think Evaluate integral \\think Result: 0";
    const blocks = extractReasoningBlocks(text);
    expect(blocks).toEqual([
      { source: "deepseek", content: "Evaluate integral" },
    ]);
  });

  it("extracts mixed reasoning blocks in order", () => {
    const text =
      "<thinking>A</thinking><reasoning>B</reasoning>\\think C \\think";
    const blocks = extractReasoningBlocks(text);
    expect(blocks).toEqual([
      { source: "anthropic", content: "A" },
      { source: "openai", content: "B" },
      { source: "deepseek", content: "C" },
    ]);
  });

  it("trims whitespace around captured content", () => {
    const text = "<thinking>\n  indented  \n</thinking>";
    const blocks = extractReasoningBlocks(text);
    expect(blocks).toEqual([{ source: "anthropic", content: "indented" }]);
  });

  it("returns an empty array for non-reasoning text", () => {
    expect(extractReasoningBlocks("Just a normal response.")).toEqual([]);
    expect(extractReasoningBlocks("")).toEqual([]);
  });
});

describe("extractOpenAIReasoning", () => {
  it("prefers reasoning_content over content", () => {
    const response = {
      content: "<reasoning>Tagged</reasoning>",
      reasoning_content: "Direct reasoning",
    };
    expect(extractOpenAIReasoning(response)).toEqual([
      { source: "openai", content: "Direct reasoning" },
    ]);
  });

  it("falls back to tag extraction in content", () => {
    const response = {
      content: "<reasoning>Tagged</reasoning>",
    };
    expect(extractOpenAIReasoning(response)).toEqual([
      { source: "openai", content: "Tagged" },
    ]);
  });
});

describe("extractAnthropicReasoning", () => {
  it("extracts typed thinking blocks with signatures", () => {
    const blocks = extractAnthropicReasoning([
      { type: "thinking", thinking: "Plan A", signature: "sig-1" },
    ]);
    expect(blocks).toEqual([
      { source: "anthropic", content: "Plan A", signature: "sig-1" },
    ]);
  });

  it("extracts redacted thinking as signature-only blocks", () => {
    const blocks = extractAnthropicReasoning([
      { type: "redacted_thinking", data: "redacted-1" },
    ]);
    expect(blocks).toEqual([
      { source: "anthropic", content: "", signature: "redacted-1" },
    ]);
  });

  it("extracts <thinking> tags inside text blocks", () => {
    const blocks = extractAnthropicReasoning([
      { type: "text", text: "<thinking>nested</thinking>done" },
    ]);
    expect(blocks).toEqual([{ source: "anthropic", content: "nested" }]);
  });
});

describe("stripReasoning", () => {
  it("removes reasoning blocks and collapses whitespace", () => {
    const text = "Start.\n<thinking>Secret</thinking>\n\n\nEnd.";
    expect(stripReasoning(text)).toBe("Start.\n\nEnd.");
  });
});
