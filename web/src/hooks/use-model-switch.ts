import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import {
  switchModel,
  type ModelSwitchResult,
  type ModelSwitchScope,
} from "@hermes/agent-core";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { useGateway } from "@/hooks/use-gateway";
import { rememberSessionModelOverride } from "@/lib/session-model-override";
import type { ComposerModelSelection } from "@/components/chat/composer-types";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import { readUiValue, writeUiValue } from "@/lib/ui-store";

export interface UseModelSwitchRequest {
  sessionId: string;
  target: string;
  provider?: string;
  scope: ModelSwitchScope;
  currentSelection: ComposerModelSelection;
}

const LOCAL_MODEL_CONFIG_KEY = "hermes.active-model-config";

export function readLocalModelConfig(): { model?: string; provider?: string } | null {
  return readUiValue<{ model?: string; provider?: string } | null>(LOCAL_MODEL_CONFIG_KEY, null);
}

function writeLocalModelConfig(model: string, provider?: string): void {
  writeUiValue(LOCAL_MODEL_CONFIG_KEY, { model, provider: provider ?? null });
}

async function persistGlobalDefault(
  model: string,
  provider?: string,
): Promise<void> {
  const hasNativeBridge = typeof window !== "undefined" && (window.__TAURI_INTERNALS__ || window.hermesDesktop);
  if (hasNativeBridge) {
    // In the Tauri shell this lands in HERMES_HOME/config.yaml via a Rust
    // command. In standalone (no-backend) mode below, keep the selection in
    // the renderer's local UI store so the model-config UI still works.
    await invoke("set_model_config", {
      model,
      provider: provider ?? null,
    });
    return;
  }
  persistLocalModelConfig(model, provider);
}

function persistLocalModelConfig(model: string, provider?: string): void {
  writeLocalModelConfig(model, provider);
}

async function persistSessionOverride(
  sessionId: string,
  selection: ComposerModelSelection,
): Promise<void> {
  rememberSessionModelOverride(sessionId, selection);
}

/**
 * React mutation that performs a model switch with per-session/global/once scope.
 *
 * The actual provider/model resolution is delegated to `@hermes/agent-core` so
 * the same logic runs in the webview and in test harnesses. Global persistence
 * is routed through the Rust `set_model_config` command; session overrides live
 * in renderer memory (a full implementation would write to the backend session
 * store).
 */
export function useModelSwitch() {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const profile = useActiveProfileName();

  return useMutation({
    mutationFn: async (request: UseModelSwitchRequest): Promise<ModelSwitchResult> => {
      const currentProfile = {
        model: request.currentSelection.model,
        provider: request.currentSelection.provider ?? "openai",
        apiMode: "chat_completions" as const,
      };

      const result = await switchModel(
        {
          sessionId: request.sessionId,
          target: request.target,
          provider: request.provider,
          scope: request.scope,
        },
        {
          currentProfile,
          persistSession: async (sessionId, profile) => {
            await persistSessionOverride(sessionId, {
              model: profile.model,
              provider: profile.provider,
            });
          },
          persistGlobal: async (model, provider) => {
            await persistGlobalDefault(model, provider);
          },
        },
      );

      if (!result.success) {
        throw new Error(result.error || "Model switch failed");
      }

      // Notify the gateway so other clients / the backend can react.
      try {
        const args = [
          request.scope === "global" ? "--global" : request.scope === "once" ? "--once" : "",
          request.provider ? `--provider ${request.provider}` : "",
          request.target,
        ]
          .filter(Boolean)
          .join(" ");
        await gateway.dispatchCommand?.(request.sessionId, "model", args);
      } catch {
        // Gateway dispatch is a soft notification; the local switch already
        // succeeded and determines the UI state.
      }

      return result;
    },
    onSuccess: () => {
      invalidateModelOptionsCache();
      queryClient.invalidateQueries({ queryKey: ["model-info", profile] });
      queryClient.invalidateQueries({ queryKey: ["model-options"] });
    },
  });
}

/**
 * Hook that returns a convenience switch function pre-bound to a session.
 */
export function useSessionModelSwitch(sessionId: string, currentSelection: ComposerModelSelection) {
  const mutation = useModelSwitch();

  const switchTo = useCallback(
    (target: string, scope: ModelSwitchScope, provider?: string) => {
      return mutation.mutateAsync({
        sessionId,
        target,
        provider,
        scope,
        currentSelection,
      });
    },
    [mutation, sessionId, currentSelection],
  );

  return {
    switchTo,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}
