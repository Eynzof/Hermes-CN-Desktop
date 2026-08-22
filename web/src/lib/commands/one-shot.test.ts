import { describe, expect, it, vi } from "vitest";
import { runOneShot } from "./one-shot";
import type { GatewayClientLike } from "@/lib/gateway-client";
import type { GatewayEvent } from "@hermes/protocol";

interface MockClient {
  client: GatewayClientLike;
  emit: (ev: GatewayEvent) => void;
}

function makeClient(): MockClient {
  const listeners = new Set<(ev: GatewayEvent) => void>();
  const client = {
    state: "open",
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "session.create") {
        return { session_id: "sess-123", cwd: params?.cwd ?? "/tmp" };
      }
      return null;
    }),
    on: vi.fn().mockReturnValue(() => {}),
    onAny: vi.fn((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    onState: vi.fn().mockReturnValue(() => {}),
    enableAutoReconnect: vi.fn(),
    disableAutoReconnect: vi.fn(),
  } as unknown as GatewayClientLike;
  return {
    client,
    emit: (ev: GatewayEvent) => listeners.forEach((cb) => cb(ev)),
  };
}

describe("runOneShot", () => {
  it("returns empty text for empty prompt", async () => {
    const { client } = makeClient();
    const result = await runOneShot(client, { prompt: "" });
    expect(result.text).toBe("");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("creates session, submits prompt, and returns message text", async () => {
    const { client, emit } = makeClient();
    const promise = runOneShot(client, { prompt: "hi", timeoutMs: 100 });

    // Allow the session.create promise and onAny registration to settle.
    await Promise.resolve();

    // Simulate streaming deltas
    emit({ type: "message.delta", payload: { delta: "Hello" } } as GatewayEvent);
    emit({ type: "message.delta", payload: { delta: " world" } } as GatewayEvent);
    emit({
      type: "message.complete",
      payload: { model: "gpt-4", provider: "openai", usage: { input_tokens: 2, output_tokens: 3 } },
    } as GatewayEvent);

    const result = await promise;
    expect(result.text).toBe("Hello world");
    expect(result.sessionId).toBe("sess-123");
    expect(result.model).toBe("gpt-4");
    expect(result.provider).toBe("openai");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: undefined });
  });

  it("rejects on gateway error", async () => {
    const { client, emit } = makeClient();
    const promise = runOneShot(client, { prompt: "fail", timeoutMs: 100 });
    await Promise.resolve();
    emit({ type: "error", payload: { message: "model down" } } as GatewayEvent);
    await expect(promise).rejects.toThrow("model down");
  });
});
