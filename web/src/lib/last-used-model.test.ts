import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetLastUsedModel,
  modelSelectionScopeKey,
  rememberLastUsedModel,
  readLastUsedModel,
} from "./last-used-model";
import { __resetUiStoreForTests, readUiValue, writeUiValue } from "./ui-store";

function setRuntime(input: Partial<NonNullable<Window["__HERMES_RUNTIME__"]>> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  window.__HERMES_RUNTIME__ = {
    connectionMode: "managed",
    apiBaseUrl: "http://127.0.0.1:9120",
    currentProfile: "default",
    ...input,
  };
}

function scopedKey(): string {
  return `hermes:last-used-model:${modelSelectionScopeKey()}`;
}

describe("last-used-model", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
    setRuntime();
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

  it("isolates selections by connection mode, api base, and profile", () => {
    rememberLastUsedModel({ model: "k2.6", provider: "builtin" });
    setRuntime({
      connectionMode: "local",
      apiBaseUrl: "http://127.0.0.1:9119",
      dashboardApiBaseUrl: "http://127.0.0.1:9119",
      currentProfile: "default",
    });
    expect(readLastUsedModel()).toBeNull();

    rememberLastUsedModel({ model: "gpt-5.5", provider: "openai-codex" });
    expect(readLastUsedModel()).toEqual({ model: "gpt-5.5", provider: "openai-codex" });

    setRuntime({ connectionMode: "managed", apiBaseUrl: "http://127.0.0.1:9120", currentProfile: "default" });
    expect(readLastUsedModel()).toEqual({ model: "k2.6", provider: "builtin" });
  });

  it("ignores legacy global selections", () => {
    writeUiValue("hermes:last-used-model", {
      ts: Date.now(),
      selection: { model: "legacy-k2.6" },
    });
    expect(readLastUsedModel()).toBeNull();
  });

  it("ignores selections without a model", () => {
    rememberLastUsedModel({ model: "" });
    expect(readLastUsedModel()).toBeNull();
  });

  it("expires entries older than 30 days", () => {
    rememberLastUsedModel({ model: "claude-sonnet-4-6" });
    const raw = readUiValue<{ selection: { model: string }; ts: number }>(
      scopedKey(),
      { selection: { model: "" }, ts: 0 },
    );
    raw.ts = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeUiValue(scopedKey(), raw);
    expect(readLastUsedModel()).toBeNull();
  });

  it("survives malformed payloads", () => {
    writeUiValue(scopedKey(), "not an object");
    expect(readLastUsedModel()).toBeNull();
    writeUiValue(scopedKey(), { ts: Date.now() });
    expect(readLastUsedModel()).toBeNull();
    writeUiValue(scopedKey(), { ts: Date.now(), selection: { model: 42 } });
    expect(readLastUsedModel()).toBeNull();
  });

  it("forgets on demand", () => {
    rememberLastUsedModel({ model: "claude-opus-4-7" });
    forgetLastUsedModel();
    expect(readLastUsedModel()).toBeNull();
  });
});
