import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useGateway } from "@/hooks/use-gateway";
import { useCreateAndSendSession } from "@/hooks/use-create-and-send-session";
import { useConfig, useModelInfo, useSaveConfig } from "@/hooks/use-config";
import { useModelOptions } from "@/hooks/use-model-options";
import { resolveModelContextWindow } from "@/lib/model-context";
import { readLastUsedModel, rememberLastUsedModel } from "@/lib/last-used-model";
import { recordModelUsage } from "@/lib/model-usage-log";
import {
  normalizeWorkspacePath,
  rememberWorkspaceProject,
  writeWorkspacePath,
} from "@/lib/workspaces";
import { composerPrefillAtom } from "@/stores/panel";
import { GooseComposer } from "@/components/chat/goose-composer";
import type {
  ComposerModelSelection,
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";

export function PanelComposer() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    connect,
    getModelOptions,
  } = useGateway();
  const createAndSendSession = useCreateAndSendSession();
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const { data: modelOptionsCache } = useModelOptions();
  const saveConfig = useSaveConfig();
  const [sending, setSending] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ComposerModelSelection | null>(
    () => readLastUsedModel(),
  );
  const [prefilledText, setPrefilledText] = useState("");
  const [prefill, setPrefill] = useAtom(composerPrefillAtom);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const initialWorkspacePath = normalizeWorkspacePath(searchParams.get("workspace"));

  useEffect(() => {
    if (!initialWorkspacePath) return;
    writeWorkspacePath(initialWorkspacePath);
    rememberWorkspaceProject(initialWorkspacePath);
  }, [initialWorkspacePath]);

  useEffect(() => {
    if (!prefill) return;
    setPrefilledText(prefill.text);
    wrapperRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Consume the signal so re-renders don't replay it.
    setPrefill(null);
  }, [prefill, setPrefill]);

  useEffect(() => {
    void connect().catch(() => {});
  }, [connect]);

  const contextSelection = useMemo(() => {
    const model = selectedModel?.model ?? modelInfo?.model;
    if (!model) return null;
    return {
      model,
      provider: selectedModel?.provider ?? modelInfo?.provider,
      providerName: selectedModel?.providerName,
      contextWindow: selectedModel?.contextWindow,
    };
  }, [modelInfo?.model, modelInfo?.provider, selectedModel]);

  const contextMax = useMemo(
    () =>
      resolveModelContextWindow(config, contextSelection) ??
      modelInfo?.effective_context_length ??
      modelInfo?.auto_context_length,
    [config, contextSelection, modelInfo?.auto_context_length, modelInfo?.effective_context_length],
  );

  const onModelSelect = useCallback((selection: ComposerModelSelection) => {
    const enriched: ComposerModelSelection = {
      ...selection,
      contextWindow: resolveModelContextWindow(config, selection),
    };
    setSelectedModel(enriched);
    rememberLastUsedModel(enriched);
    recordModelUsage(enriched);
  }, [config]);

  const onConfigureProvider = useCallback((providerId: string) => {
    navigate(`/models#provider-${providerId}`);
  }, [navigate]);

  const onSelectAndSetDefault = useCallback((selection: ComposerModelSelection) => {
    onModelSelect(selection);
    if (!config) return;
    saveConfig.mutate({
      ...config,
      model: {
        ...(typeof config.model === "object" && config.model !== null && !Array.isArray(config.model)
          ? config.model as Record<string, unknown>
          : {}),
        provider: selection.provider,
        default: selection.model,
      },
    });
  }, [config, onModelSelect, saveConfig]);

  const onSend = useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => {
    if (sending) return;
    setSending(true);
    try {
      await createAndSendSession(payload, controls);
    } catch (err) {
      console.error("Failed to create session:", err);
      throw err;
    } finally {
      setSending(false);
    }
  }, [
    sending,
    createAndSendSession,
  ]);

  return (
    <div ref={wrapperRef}>
      <GooseComposer
        key={initialWorkspacePath || "default-workspace"}
        onSend={onSend}
        initial={prefilledText}
        initialWorkspacePath={initialWorkspacePath}
        placeholder="描述你想完成的任务，Enter 发送，Shift+Enter 换行…"
        variant="big"
        headerLabel="新任务"
        hints={[
          { kbd: "@", label: "引用文件" },
          { kbd: "/", label: "选择 Skill" },
          { label: "把文件拖入此处直接附加" },
        ]}
        showMeta={false}
        loading={sending}
        modelPicker={{
          selected: selectedModel,
          label: modelInfo?.model,
          loadOptions: () => getModelOptions(),
          initialOptions: modelOptionsCache ?? null,
          onSelect: onModelSelect,
          onSelectAndSetDefault,
          onConfigureProvider,
          disabled: sending,
        }}
        contextUsage={
          contextSelection
            ? {
                max: contextMax,
                model: contextSelection.model,
              }
            : null
        }
      />
    </div>
  );
}
