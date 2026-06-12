import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvent, HermesUIMessage } from "@hermes/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import type { NotificationSettings } from "@/stores/ui";

async function loadNotifications(seed: Record<string, unknown> = {}) {
  vi.resetModules();
  const uiStore = await import("@/lib/ui-store");
  uiStore.__resetUiStoreForTests(seed);
  const queryClientModule = await import("@/lib/query-client");
  const mod = await import("./notifications");
  return { ...mod, uiStore, queryClient: queryClientModule.queryClient };
}

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    system: true,
    sound: true,
    onComplete: true,
    onApproval: true,
    onlyBackground: true,
    ...overrides,
  };
}

function runtimeWith(partial: Partial<ChatSessionRuntime> = {}): ChatSessionRuntime {
  return {
    messages: [],
    streamStatus: "streaming",
    pendingApprovals: [],
    statusMessage: "",
    updatedAt: 0,
    ...partial,
  };
}

function userMessage(text: string): HermesUIMessage {
  return {
    id: "u1",
    sessionId: "s1",
    role: "user",
    createdAt: 0,
    status: "complete",
    parts: [{ type: "text", text }],
  } as HermesUIMessage;
}

function approvalEvent(
  payload: Record<string, unknown> | undefined = { request_id: "r1", command: "rm -rf build" },
  sessionId: string | undefined = "s1",
): GatewayEvent {
  return { type: "approval.request", session_id: sessionId, payload } as GatewayEvent;
}

function completeEvent(
  payload: Record<string, unknown> = {},
  sessionId: string | undefined = "s1",
): GatewayEvent {
  return { type: "message.complete", session_id: sessionId, payload } as GatewayEvent;
}

const never = () => false;

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  delete (globalThis as any).window;
  vi.unstubAllGlobals();
});

describe("decideNotification — approval.request", () => {
  it("produces an approval action with command body and a stable dedupe key", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: approvalEvent(),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action).toEqual({
      dedupeKey: "approval:s1:r1",
      kind: "approval",
      title: "需要权限确认",
      body: "rm -rf build",
    });
  });

  it("falls back from command to reason to description to a default body", async () => {
    const { decideNotification } = await loadNotifications();
    const byReason = decideNotification({
      event: approvalEvent({ request_id: "r1", reason: "需要写入磁盘" }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(byReason?.body).toBe("需要写入磁盘");

    const byDefault = decideNotification({
      event: approvalEvent({ request_id: "r1" }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(byDefault?.body).toBe("任务等待你的确认后才能继续");
  });

  it("returns null when the approval toggle is off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings({ onApproval: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when both system notification and sound are off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings({ system: false, sound: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null without a request_id (cannot dedupe replays)", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent({ command: "rm -rf build" }),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the approval is already pending in the previous runtime", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith({
          pendingApprovals: [{ requestId: "r1", sessionId: "s1", command: "rm -rf build" }],
        }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the dedupe key was already notified", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: (key) => key === "approval:s1:r1",
      }),
    ).toBeNull();
  });

  it("truncates an overlong command body", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: approvalEvent({ request_id: "r1", command: "x".repeat(500) }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.body.length).toBeLessThanOrEqual(120);
    expect(action?.body.endsWith("…")).toBe(true);
  });
});

describe("decideNotification — message.complete", () => {
  it("produces a complete action summarizing the latest user prompt", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: completeEvent({ status: "complete" }),
      prevRuntime: runtimeWith({
        activeAssistantId: "live-assistant-1",
        messages: [userMessage("帮我重构登录模块")],
      }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action).toEqual({
      dedupeKey: "complete:s1:live-assistant-1",
      kind: "complete",
      title: "任务完成",
      body: "帮我重构登录模块",
    });
  });

  it("falls back to a default body without a user prompt", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: completeEvent(),
      prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1" }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.body).toBe("会话回复已就绪");
  });

  it("maps status=error to an error action carrying the error text", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      event: completeEvent({ status: "error", error: "API Key 已失效" }),
      prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1" }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.kind).toBe("error");
    expect(action?.title).toBe("任务出错");
    expect(action?.body).toBe("API Key 已失效");
  });

  it("returns null without an active assistant turn (SSE replay protection)", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: undefined,
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null after a manual interrupt", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1", interrupted: true }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the complete toggle is off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: completeEvent(),
        prevRuntime: runtimeWith({ activeAssistantId: "live-assistant-1" }),
        settings: settings({ onComplete: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });
});

describe("decideNotification — other events", () => {
  it("ignores unrelated event types and missing session ids", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        event: { type: "tool.start", session_id: "s1", payload: {} } as GatewayEvent,
        prevRuntime: runtimeWith({ activeAssistantId: "a" }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
    expect(
      decideNotification({
        event: {
          type: "approval.request",
          payload: { request_id: "r1", command: "rm -rf build" },
        } as GatewayEvent,
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });
});

describe("dedupe store", () => {
  it("remembers marked keys", async () => {
    const { markNotified, hasNotified } = await loadNotifications();
    expect(hasNotified("k1")).toBe(false);
    markNotified("k1");
    markNotified("k1");
    expect(hasNotified("k1")).toBe(true);
  });

  it("evicts the oldest keys beyond the FIFO cap of 500", async () => {
    const { markNotified, hasNotified } = await loadNotifications();
    for (let i = 0; i < 501; i += 1) markNotified(`k${i}`);
    expect(hasNotified("k0")).toBe(false);
    expect(hasNotified("k1")).toBe(true);
    expect(hasNotified("k500")).toBe(true);
  });
});

describe("shouldPlayFallbackSound", () => {
  const delivered = { delivered: true, focused: false };
  const undelivered = { delivered: false, focused: false };

  it("never plays when the sound toggle is off", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings({ sound: false }), undelivered)).toBe(false);
    expect(shouldPlayFallbackSound(settings({ sound: false, system: false }), undelivered)).toBe(false);
  });

  it("stays silent in the foreground when only-background is on", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(
      shouldPlayFallbackSound(settings(), { delivered: false, focused: true }),
    ).toBe(false);
    expect(
      shouldPlayFallbackSound(settings({ onlyBackground: false }), {
        delivered: false,
        focused: true,
      }),
    ).toBe(true);
  });

  it("skips the chime when the system notification carried its own sound", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings(), delivered)).toBe(false);
  });

  it("plays when system notifications are disabled or failed", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings({ system: false }), undelivered)).toBe(true);
    expect(
      shouldPlayFallbackSound(settings(), { ...undelivered, error: "permission denied" }),
    ).toBe(true);
  });
});

describe("notifyFromGatewayEvent", () => {
  class FakeAudioContext {
    static created = 0;
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
      FakeAudioContext.created += 1;
    }
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    resume() {
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    FakeAudioContext.created = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  it("is a no-op without the desktop bridge", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    (globalThis as any).window = {};
    expect(() => notifyFromGatewayEvent(approvalEvent(), runtimeWith())).not.toThrow();
  });

  it("invokes desktopNotify once with the settings-driven payload", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: true });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
    expect(desktopNotify).toHaveBeenCalledWith({
      kind: "approval",
      title: "需要权限确认",
      body: "rm -rf build",
      showSystemNotification: true,
      withSound: true,
      respectFocus: true,
      requestAttention: true,
    });
  });

  it("does not notify twice for a replayed event", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
  });

  it("swallows bridge rejections", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications();
    const desktopNotify = vi.fn().mockRejectedValue(new Error("ipc down"));
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    expect(() => notifyFromGatewayEvent(approvalEvent(), runtimeWith())).not.toThrow();
    await flushAsync();
    expect(desktopNotify).toHaveBeenCalledTimes(1);
  });

  it("plays the WebAudio chime when system notifications are disabled", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications({
      "hermes.notify-system": false,
    });
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: false, focused: false, attentionRequested: true });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ showSystemNotification: false, withSound: true }),
    );
    expect(FakeAudioContext.created).toBe(1);
  });

  it("respects disabled event-type toggles end to end", async () => {
    const { notifyFromGatewayEvent } = await loadNotifications({
      "hermes.notify-on-approval": false,
    });
    const desktopNotify = vi.fn();
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("prefixes the body with the session title from the query cache", async () => {
    const { notifyFromGatewayEvent, queryClient } = await loadNotifications();
    queryClient.setQueryData(["sessions", "default", 50, 0], {
      sessions: [{ id: "s1", title: "重构登录" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { hermesDesktop: { desktopNotify } };

    notifyFromGatewayEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ body: "「重构登录」 · rm -rf build" }),
    );
  });
});
