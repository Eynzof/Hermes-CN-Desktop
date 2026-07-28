import { useEffect, useMemo, useState } from "react";
import { Check, Database, RefreshCw } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import {
  VISIBLE_MEMORY_PROVIDERS,
  useMemoryProviderConfig,
  useMemoryProviders,
  useMemoryProviderStatus,
  useSaveMemoryProviderConfig,
  useSetMemoryProvider,
  useSetupMemoryProvider,
  type VisibleMemoryProvider,
} from "@/hooks/use-memory";
import { MemoryProviderConfig } from "./memory-provider-config";
import { MemoryProviderStatus } from "./memory-provider-status";
import {
  formatCheckedAt,
  MEMORY_BACKEND_META,
  memoryBackendState,
} from "./memory-backend-utils";
import s from "./memory-backends.module.css";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemoryBackendsPanel() {
  const providersQuery = useMemoryProviders({ enabled: true });
  const openVikingStatus = useMemoryProviderStatus("openviking", true);
  const hindsightStatus = useMemoryProviderStatus("hindsight", true);
  const [selected, setSelected] = useState<VisibleMemoryProvider>("openviking");
  const [actionError, setActionError] = useState("");
  const configQuery = useMemoryProviderConfig(selected, true);
  const saveConfig = useSaveMemoryProviderConfig();
  const setupProvider = useSetupMemoryProvider();
  const setProvider = useSetMemoryProvider();

  const statusQueries = useMemo(() => ({
    openviking: openVikingStatus,
    hindsight: hindsightStatus,
  }), [openVikingStatus, hindsightStatus]);
  const selectedStatusQuery = statusQueries[selected];
  const selectedStatus = selectedStatusQuery.data;
  const active = providersQuery.data?.active ?? "";

  useEffect(() => {
    if (VISIBLE_MEMORY_PROVIDERS.includes(active as VisibleMemoryProvider)) {
      setSelected(active as VisibleMemoryProvider);
    }
  }, [active]);

  const activeStatus = VISIBLE_MEMORY_PROVIDERS.includes(active as VisibleMemoryProvider)
    ? statusQueries[active as VisibleMemoryProvider].data
    : undefined;
  const activeMeta = VISIBLE_MEMORY_PROVIDERS.includes(active as VisibleMemoryProvider)
    ? MEMORY_BACKEND_META[active as VisibleMemoryProvider]
    : undefined;
  const overallState = memoryBackendState(activeStatus);

  const refreshAll = () => {
    void providersQuery.refetch();
    void openVikingStatus.refetch();
    void hindsightStatus.refetch();
  };

  const handleSave = async (values: Record<string, unknown>) => {
    setActionError("");
    try {
      await saveConfig.mutateAsync({ provider: selected, values });
      await Promise.all([configQuery.refetch(), selectedStatusQuery.refetch(), providersQuery.refetch()]);
    } catch (error) {
      setActionError(message(error));
      throw error;
    }
  };

  const handleSetup = async () => {
    setActionError("");
    try {
      await setupProvider.mutateAsync(selected);
      await Promise.all([configQuery.refetch(), selectedStatusQuery.refetch(), providersQuery.refetch()]);
    } catch (error) {
      setActionError(message(error));
    }
  };

  const handleActivate = async () => {
    if (!selectedStatus?.healthy) return;
    setActionError("");
    try {
      await setProvider.mutateAsync(selected);
      await Promise.all([providersQuery.refetch(), openVikingStatus.refetch(), hindsightStatus.refetch()]);
    } catch (error) {
      setActionError(message(error));
    }
  };

  return (
    <section className={s.backendPanel}>
      <header className={s.backendSummary}>
        <div className={s.summaryIcon}><Database size={18} /></div>
        <div>
          <small>当前启用后端</small>
          <strong>{activeMeta?.label ?? "未启用外置后端"}</strong>
          <span>{activeMeta ? overallState.label : "本地记忆继续可用"}</span>
        </div>
        <div className={s.summaryCheck}>
          <small>总体状态</small>
          <span className={s.stateBadge} data-tone={activeMeta ? overallState.tone : "muted"}>
            {activeMeta ? overallState.label : "未配置"}
          </span>
          <em>最后检查 {formatCheckedAt(activeStatus?.checked_at)}</em>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={openVikingStatus.isFetching || hindsightStatus.isFetching}
          onClick={refreshAll}
        >
          <RefreshCw size={13} /> 刷新全部
        </Button>
      </header>

      <p className={s.backendIntro}>
        每个 Hermes 档案只能启用一个外置记忆后端。先保存并检测，确认在线可用后再设为当前；另一个后端的配置不会被删除。
      </p>

      {providersQuery.isError && <div className={s.inlineError}>无法读取记忆后端列表：{message(providersQuery.error)}</div>}

      <div className={s.backendSwitcher}>
        {VISIBLE_MEMORY_PROVIDERS.map((provider) => {
          const meta = MEMORY_BACKEND_META[provider];
          const status = statusQueries[provider].data;
          const state = memoryBackendState(status);
          return (
            <button
              key={provider}
              type="button"
              data-selected={selected === provider ? "true" : undefined}
              data-active={status?.active ? "true" : undefined}
              onClick={() => { setSelected(provider); setActionError(""); }}
            >
              <span className={s.backendCardHead}>
                <strong>{meta.label}</strong>
                <em className={s.stateBadge} data-tone={state.tone}>{state.label}</em>
              </span>
              <span>{meta.description}</span>
              <small>
                {status?.version ? `v${status.version}` : statusQueries[provider].isFetching ? "检测中…" : "尚未返回版本"}
                {status?.active && <b><Check size={11} /> 当前</b>}
              </small>
            </button>
          );
        })}
      </div>

      <div className={s.backendDetail}>
        <div className={s.detailHeader}>
          <div>
            <small>正在配置</small>
            <strong>{MEMORY_BACKEND_META[selected].label}</strong>
          </div>
          <Button
            type="button"
            variant={selectedStatus?.active ? "outline" : "solid"}
            tone={selectedStatus?.active ? "neutral" : "accent"}
            size="sm"
            disabled={Boolean(selectedStatus?.active) || !selectedStatus?.healthy || setProvider.isPending}
            onClick={() => void handleActivate()}
          >
            {selectedStatus?.active ? <><Check size={13} /> 当前启用</> : "设为当前"}
          </Button>
        </div>

        {!selectedStatus?.reachable && selectedStatus?.configured && (
          <div className={s.offlineHint}>{MEMORY_BACKEND_META[selected].offlineHint}</div>
        )}

        <MemoryProviderStatus
          status={selectedStatus}
          loading={selectedStatusQuery.isLoading}
          refreshing={selectedStatusQuery.isFetching}
          onRefresh={() => void selectedStatusQuery.refetch()}
        />

        <MemoryProviderConfig
          provider={selected}
          config={configQuery.data}
          loading={configQuery.isLoading}
          saving={saveConfig.isPending}
          setupPending={setupProvider.isPending}
          error={actionError || (configQuery.error ? message(configQuery.error) : undefined)}
          onSave={handleSave}
          onSetup={handleSetup}
        />
      </div>
    </section>
  );
}
