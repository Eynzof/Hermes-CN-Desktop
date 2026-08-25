import { describe, expect, it, vi } from "vitest";
import { OutboundWebhookDispatcher, signPayload, isLifecycleEvent } from "./outbound.js";

describe("outbound webhooks (P1-22)", () => {
  it("signPayload produces a stable HMAC-SHA256 hex signature", async () => {
    const sig = await signPayload("secret", '{"event":"turn_complete"}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Same input+secret ⇒ same signature (deterministic HMAC).
    expect(await signPayload("secret", '{"event":"turn_complete"}')).toBe(sig);
    expect(await signPayload("secret", '{"event":"other"}')).not.toBe(sig);
  });

  it("isLifecycleEvent recognizes known events only", () => {
    expect(isLifecycleEvent("turn_complete")).toBe(true);
    expect(isLifecycleEvent("session_archived")).toBe(true);
    expect(isLifecycleEvent("brand.new.event")).toBe(false);
  });

  it("dispatches signed payloads to matching webhooks", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const dispatcher = new OutboundWebhookDispatcher({ fetchImpl: fetchMock });
    dispatcher.register({ id: "w1", url: "https://hooks.example/a", secret: "s" });
    dispatcher.register({ id: "w2", url: "https://hooks.example/b", events: ["turn_start"] });

    const deliveries = await dispatcher.dispatch("turn_complete", { text: "hi" });
    expect(deliveries).toHaveLength(1); // w2 does not match turn_complete
    expect(deliveries[0].webhookId).toBe("w1");
    expect(deliveries[0].ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://hooks.example/a");
    expect(init.headers["X-Hermes-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body).event).toBe("turn_complete");
  });

  it("reports delivery failures without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const dispatcher = new OutboundWebhookDispatcher({ fetchImpl: fetchMock });
    dispatcher.register({ id: "w1", url: "https://hooks.example/a" });
    const deliveries = await dispatcher.dispatch("turn_start", {});
    expect(deliveries[0].ok).toBe(false);
    expect(deliveries[0].error).toBe("network down");
  });
});
