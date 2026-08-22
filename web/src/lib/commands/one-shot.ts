import type { GatewayClientLike } from "@/lib/gateway-client";
import type { GatewayEvent } from "@hermes/protocol";
import type { OneShotResult } from "./types";

export interface RunOneShotOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  toolsets?: readonly string[];
  skills?: readonly string[];
  timeoutMs?: number;
}

/**
 * Run a scripted one-shot prompt (`hermes -z <prompt>`) through the gateway.
 *
 * Creates a temporary session, submits the prompt, waits for the assistant
 * message to complete, and returns the text plus optional usage metadata.
 */
export async function runOneShot(
  client: GatewayClientLike,
  options: RunOneShotOptions,
): Promise<OneShotResult> {
  const { prompt, cwd, model, provider, reasoningEffort, toolsets, skills, timeoutMs = 120_000 } = options;
  if (!prompt.trim()) {
    return { text: "" };
  }

  const session = await client.request<{ session_id: string; cwd?: string }>(
    "session.create",
    {
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(toolsets?.length ? { toolsets: [...toolsets] } : {}),
      ...(skills?.length ? { skills: [...skills] } : {}),
    },
    timeoutMs,
  );

  const sessionId = session.session_id;

  return new Promise<OneShotResult>((resolve, reject) => {
    const parts: string[] = [];
    let completed = false;
    const timer = setTimeout(() => {
      cleanup();
      resolve({ text: parts.join(""), sessionId });
    }, timeoutMs);

    const getPayload = (ev: GatewayEvent): Record<string, unknown> | undefined =>
      ev.payload as Record<string, unknown> | undefined;

    const onMessage = (ev: GatewayEvent) => {
      if (completed) return;
      const payload = getPayload(ev);
      if (ev.type === "message.delta") {
        const delta = typeof payload?.delta === "string" ? payload.delta : "";
        parts.push(delta);
        return;
      }
      if (ev.type === "message.complete") {
        completed = true;
        cleanup();
        resolve({
          text: parts.join(""),
          sessionId,
          model: typeof payload?.model === "string" ? payload.model : undefined,
          provider: typeof payload?.provider === "string" ? payload.provider : undefined,
          usage: parseUsage(payload?.usage),
        });
      }
      if (ev.type === "error") {
        completed = true;
        cleanup();
        reject(new Error(String(payload?.message ?? "One-shot failed")));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      unsub();
    };

    const unsub = client.onAny(onMessage);

    client
      .request("prompt.submit", { session_id: sessionId, text: prompt }, timeoutMs)
      .catch((err: Error) => {
        cleanup();
        reject(err);
      });
  });
}

function parseUsage(value: unknown): OneShotResult["usage"] {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
    totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
  };
}
