import { beforeEach, describe, expect, it } from "vitest";
import type { HermesUIMessage } from "@hermes/protocol";
import {
  createEmptyChatRuntime,
  type ChatRuntimeBySession,
  type ChatSessionRuntime,
} from "@/stores/chat";
import { __resetUiStoreForTests, writeUiValue } from "@/lib/ui-store";
import { rememberSessionMapping } from "@/lib/session-map";
import { resolveSessionRuntime } from "./use-session-resolution";

const MAP_KEY = "hermes:gateway-session-map";

function userMessage(sessionId: string, text: string): HermesUIMessage {
  return {
    id: `u-${text}`,
    sessionId,
    role: "user",
    createdAt: 1,
    status: "complete",
    parts: [{ type: "text", text }],
  };
}

function runtimeWith(sessionId: string, text: string): ChatSessionRuntime {
  return { ...createEmptyChatRuntime(1), messages: [userMessage(sessionId, text)] };
}

function firstText(runtime: ChatSessionRuntime): string | undefined {
  const part = runtime.messages[0]?.parts[0];
  return part && part.type === "text" ? part.text : undefined;
}

describe("resolveSessionRuntime", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("reads the live runtime when the persisted map still holds a stale duplicate", () => {
    // Regression for the invisible-reply bug: a resumed session accumulated two
    // gateway ids for one persistent id (e.g. a map persisted across an app
    // relaunch). The route id is the persistent id; the optimistic send wrote
    // into the *live* gateway bucket. Resolution must land on that bucket, not
    // the empty runtimeBySession[persistentId] fallback.
    writeUiValue(MAP_KEY, {
      "gw-stale": { persistentId: "sess-1", ts: Date.now() - 60_000 },
      "gw-live": { persistentId: "sess-1", ts: Date.now() - 1_000 },
    });
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-live": runtimeWith("gw-live", "just sent"),
    };

    const resolved = resolveSessionRuntime("sess-1", "gw-live", runtimeBySession);

    expect(resolved.runtimeSessionId).toBe("gw-live");
    expect(firstText(resolved.runtime)).toBe("just sent");
    expect(resolved.isLiveSession).toBe(true);
    expect(resolved.restSessionId).toBe("sess-1");
  });

  it("does not bleed a different background-streaming session into the current view", () => {
    // Session B is the live gateway session (streaming in the background) while
    // the route is showing session A. Preferring the live gwSessionId must be
    // gated on it mapping to the *same* persistent session, or detail would
    // render B's transcript under A.
    rememberSessionMapping("gw-A", "persistent-A");
    rememberSessionMapping("gw-B", "persistent-B");
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-A": runtimeWith("gw-A", "from A"),
      "gw-B": runtimeWith("gw-B", "from B"),
    };

    const resolved = resolveSessionRuntime("persistent-A", "gw-B", runtimeBySession);

    expect(resolved.runtimeSessionId).toBe("gw-A");
    expect(firstText(resolved.runtime)).toBe("from A");
  });

  it("resolves a fresh new-task session keyed directly by its gateway id", () => {
    const runtimeBySession: ChatRuntimeBySession = {
      "gw-new": runtimeWith("gw-new", "hi"),
    };

    const resolved = resolveSessionRuntime("gw-new", "gw-new", runtimeBySession);

    expect(resolved.runtimeSessionId).toBe("gw-new");
    expect(firstText(resolved.runtime)).toBe("hi");
    expect(resolved.isGatewayLinked).toBe(true);
    expect(resolved.isLiveSession).toBe(true);
  });

  it("falls back to an empty idle runtime for an unknown session", () => {
    const resolved = resolveSessionRuntime("unknown", null, {});

    expect(resolved.runtime.messages).toHaveLength(0);
    expect(resolved.runtimeIsBusy).toBe(false);
    expect(resolved.isLiveSession).toBe(false);
  });
});
