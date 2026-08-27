/**
 * Minimal model-switch hook for the GUI-event test coverage.
 *
 * The full implementation lives in `@hermes/agent-core` on the dev-lite line
 * (providers/switch.ts); this branch does not carry that package. This
 * self-contained hook keeps the ModelSwitcher component (see
 * feature_report.md §3 — model-switcher tests) runnable and typecheckable:
 * the tests mock this module, so this file only needs to resolve.
 */
import { useCallback, useState } from "react";
import type { ComposerModelSelection } from "@/components/chat/composer-types";

export type ModelSwitchScope = "per-session" | "global" | "once";

export interface ModelSwitchResult {
  model: string;
  provider?: string;
  scope: ModelSwitchScope;
  success: boolean;
  error?: string;
}

export interface UseModelSwitchRequest {
  sessionId: string;
  target: string;
  provider?: string;
  scope: ModelSwitchScope;
  currentSelection: ComposerModelSelection;
}

/**
 * Hook that returns a switch function pre-bound to a session.
 */
export function useSessionModelSwitch(_sessionId: string, currentSelection: ComposerModelSelection) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const switchTo = useCallback(
    async (target: string, scope: ModelSwitchScope, provider?: string): Promise<ModelSwitchResult> => {
      setIsPending(true);
      try {
        return {
          model: target,
          provider: provider ?? currentSelection.provider,
          scope,
          success: true,
        };
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    [currentSelection],
  );

  return { switchTo, isPending, error };
}

/** React mutation-style convenience wrapper kept for API parity. */
export function useModelSwitch() {
  const { switchTo, isPending, error } = useSessionModelSwitch("", { model: "", provider: "" });
  return {
    switchTo,
    isPending,
    error,
    mutateAsync: switchTo,
  };
}