import type { ReasoningEffort } from "@/lib/reasoning-effort";

export interface SessionCreateParams extends Record<string, unknown> {
  cwd?: string;
  reasoning_effort?: ReasoningEffort;
}

/**
 * Build the `session.create` RPC params for a fresh chat.
 *
 * The backend bakes the composer's model/effort/fast into the session as
 * per-session overrides — see tui_gateway/methods_session.py ("The desktop
 * composer owns its model/effort/fast as plain UI state and ships it on every
 * session.create"): shipping `reasoning_effort` here means the first turn's
 * agent is built with the user's thinking-effort instead of the backend
 * default (medium). The official Core desktop ships the same key on every
 * create; the CN Desktop previously omitted it and only compensated with a
 * post-create `config.set`, which left every request on the backend's
 * `reasoning_cfg.get("effort") or "medium"` fallback (agent/auxiliary_client.py).
 */
export function sessionCreateParams(
  cwd?: string,
  reasoningEffort?: ReasoningEffort | null,
): SessionCreateParams {
  const cleanCwd = cwd?.trim();
  return {
    ...(cleanCwd ? { cwd: cleanCwd } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}
