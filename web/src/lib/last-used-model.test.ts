import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetLastUsedModel,
  rememberLastUsedModel,
  readLastUsedModel,
} from "./last-used-model";
import { __resetUiStoreForTests, readUiValue, writeUiValue } from "./ui-store";

describe("last-used-model", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("returns null when nothing stored", () => {
    expect(readLastUsedModel()).toBeNull();
  });

  it("round-trips a selection", () => {
    rememberLastUsedModel({
      model: "gpt-5",
      provider: "openai",
      providerName: "OpenAI",
      contextWindow: 200000,
    });
    expect(readLastUsedModel()).toEqual({
      model: "gpt-5",
      provider: "openai",
      providerName: "OpenAI",
      contextWindow: 200000,
    });
  });

  it("ignores selections without a model", () => {
    rememberLastUsedModel({ model: "" });
    expect(readLastUsedModel()).toBeNull();
  });

  it("expires entries older than 30 days", () => {
    rememberLastUsedModel({ model: "claude-sonnet-4-6" });
    const raw = readUiValue<{ selection: { model: string }; ts: number }>(
      "hermes:last-used-model",
      { selection: { model: "" }, ts: 0 },
    );
    raw.ts = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeUiValue("hermes:last-used-model", raw);
    expect(readLastUsedModel()).toBeNull();
  });

  it("survives malformed payloads", () => {
    writeUiValue("hermes:last-used-model", "not an object");
    expect(readLastUsedModel()).toBeNull();
    writeUiValue("hermes:last-used-model", { ts: Date.now() });
    expect(readLastUsedModel()).toBeNull();
    writeUiValue("hermes:last-used-model", { ts: Date.now(), selection: { model: 42 } });
    expect(readLastUsedModel()).toBeNull();
  });

  it("forgets on demand", () => {
    rememberLastUsedModel({ model: "claude-opus-4-7" });
    forgetLastUsedModel();
    expect(readLastUsedModel()).toBeNull();
  });
});
