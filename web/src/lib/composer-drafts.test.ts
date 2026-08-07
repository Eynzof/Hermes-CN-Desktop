import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composerDraftStorageKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-drafts";
import { __resetUiStoreForTests } from "./ui-store";

function setRuntime(input: Partial<NonNullable<Window["__HERMES_RUNTIME__"]>> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  window.__HERMES_RUNTIME__ = {
    connectionMode: "managed",
    apiBaseUrl: "http://127.0.0.1:9120",
    currentProfile: "default",
    ...input,
  };
}

beforeEach(() => {
  __resetUiStoreForTests();
  setRuntime();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("composer draft storage", () => {
  it("keeps the new-task draft separate from session drafts", () => {
    writeComposerDraft({ kind: "new", profile: "default" }, "new task draft");
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "default" }, "session draft");

    expect(readComposerDraft({ kind: "new", profile: "default" })).toBe("new task draft");
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("session draft");
    expect(readComposerDraft({ kind: "session", sessionId: "s2", profile: "default" })).toBe("");
  });

  it("isolates drafts by profile and runtime target", () => {
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "default" }, "managed default");
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "work" }, "managed work");

    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("managed default");
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "work" })).toBe("managed work");

    setRuntime({ connectionMode: "remote", apiBaseUrl: "https://remote.example/hermes" });
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("");
    writeComposerDraft({ kind: "session", sessionId: "s1", profile: "default" }, "remote default");
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("remote default");

    setRuntime();
    expect(readComposerDraft({ kind: "session", sessionId: "s1", profile: "default" })).toBe("managed default");
  });

  it("removes a draft when the text is blank", () => {
    const target = { kind: "new", profile: "default" } as const;
    writeComposerDraft(target, "  keep spacing  ");
    expect(readComposerDraft(target)).toBe("  keep spacing  ");

    writeComposerDraft(target, "   ");
    expect(readComposerDraft(target)).toBe("");
  });

  it("does not create a key for an empty session id", () => {
    expect(composerDraftStorageKey({ kind: "session", sessionId: "  ", profile: "default" })).toBeNull();
  });
});
