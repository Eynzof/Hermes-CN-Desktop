import { Activity, CheckCircle2, Cpu, Database, XCircle } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import type { MemoryProviderRuntimeStatusResponse } from "@hermes/protocol";
import type { VisibleMemoryProvider } from "@/hooks/use-memory";
import {
  asRecord,
  compactHealthDetail,
  formatCheckedAt,
  humanizeKey,
  memoryBackendState,
  numericValue,
} from "./memory-backend-utils";
import { MemoryConsoleDialog } from "./memory-console-dialog";
import s from "./memory-backends.module.css";

interface Props {
  provider: VisibleMemoryProvider;
  status?: MemoryProviderRuntimeStatusResponse;
  loading: boolean;
  refreshing: boolean;
  onRefresh(): void;
}

function textValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "正常" : "异常";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className={s.metric}>
      <strong>{textValue(value)}</strong>
      <span>{label}</span>
    </div>
  );
}

function HealthRows({ values }: { values: Record<string, unknown> }) {
  return (
    <div className={s.healthRows}>
      {Object.entries(values).map(([key, raw]) => {
        const record = asRecord(raw);
        const status = String(record.status ?? raw ?? "");
        const healthy = record.is_healthy !== false
          && record.has_errors !== true
          && !["error", "failed", "unhealthy"].includes(status.toLowerCase());
        return (
          <div key={key} data-healthy={healthy ? "true" : "false"}>
            {healthy ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{humanizeKey(key)}</span>
            <small>{compactHealthDetail(record.status, healthy)}</small>
          </div>
        );
      })}
    </div>
  );
}

function collectModels(value: unknown, prefix = ""): Array<{ label: string; provider: string; model: string }> {
  const record = asRecord(value);
  const model = typeof record.model === "string" ? record.model : "";
  const provider = typeof record.provider === "string" ? record.provider : "";
  const current = model || provider ? [{ label: prefix || "model", provider, model }] : [];
  return Object.entries(record).reduce<Array<{ label: string; provider: string; model: string }>>((items, [key, child]) => {
    if (key === "details") return items;
    if (child && typeof child === "object") {
      items.push(...collectModels(child, prefix ? `${prefix} · ${key}` : key));
    }
    return items;
  }, current);
}

function OpenVikingStatus({ status }: { status: MemoryProviderRuntimeStatusResponse }) {
  if (status.details?.kind !== "openviking") return null;
  const details = status.details;
  const memoryStats = details.memory_stats;
  const summary = details.summary;
  const counts = asRecord(summary.context_counts);
  const categories = asRecord(memoryStats.by_category);
  const staleness = asRecord(memoryStats.staleness);

  return (
    <div className={s.monitorStack}>
      <div className={s.metricGrid}>
        <Metric label="记忆" value={memoryStats.total_memories ?? counts.memories ?? 0} />
        <Metric label="文件" value={counts.resources ?? counts.files ?? 0} />
        <Metric label="技能" value={counts.skills ?? 0} />
        <Metric label="近期任务" value={details.tasks.length} />
      </div>

      <div className={s.monitorGrid}>
        <section className={s.monitorCard}>
          <h4><Activity size={16} /> 就绪检查</h4>
          <HealthRows values={details.ready_checks} />
        </section>
        <section className={s.monitorCard}>
          <h4><Database size={16} /> 组件健康</h4>
          <HealthRows values={details.components} />
        </section>
      </div>

      {(Object.keys(categories).length > 0 || Object.keys(staleness).length > 0) && (
        <section className={s.monitorCard}>
          <h4><Database size={16} /> 记忆分布</h4>
          <div className={s.tagMetrics}>
            {Object.entries(categories).map(([key, value]) => <span key={key}>{humanizeKey(key)} <strong>{textValue(value)}</strong></span>)}
            {Object.entries(staleness).map(([key, value]) => <span key={`stale-${key}`}>{humanizeKey(key)} <strong>{textValue(value)}</strong></span>)}
          </div>
        </section>
      )}

      {details.model_usage.length > 0 && (
        <section className={s.monitorCard}>
          <h4><Cpu size={16} /> 模型使用</h4>
          <div className={s.tableWrap}>
            <table><thead><tr><th>类型</th><th>模型</th><th>Provider</th><th>调用</th><th>Token</th></tr></thead>
              <tbody>{details.model_usage.map((item, index) => (
                <tr key={`${item.kind}-${item.model}-${index}`}><td>{item.kind}</td><td>{item.model}</td><td>{item.provider}</td><td>{item.calls}</td><td>{item.total_tokens.toLocaleString()}</td></tr>
              ))}</tbody></table>
          </div>
        </section>
      )}

      {details.queue_usage.length > 0 && (
        <section className={s.monitorCard}>
          <h4><Activity size={16} /> 队列</h4>
          <div className={s.tableWrap}>
            <table><thead><tr><th>队列</th><th>等待</th><th>处理中</th><th>已处理</th><th>错误</th></tr></thead>
              <tbody>{details.queue_usage.map((item) => (
                <tr key={item.queue}><td>{item.queue}</td><td>{item.pending}</td><td>{item.in_progress}</td><td>{item.processed}</td><td data-error={item.errors > 0 ? "true" : undefined}>{item.errors}</td></tr>
              ))}</tbody></table>
          </div>
        </section>
      )}
    </div>
  );
}

function HindsightStatus({ status }: { status: MemoryProviderRuntimeStatusResponse }) {
  if (status.details?.kind !== "hindsight") return null;
  const details = status.details;
  const stats = details.stats;
  const runtimeConfig = asRecord(details.runtime_config);
  const models = collectModels(runtimeConfig.model_stack);

  return (
    <div className={s.monitorStack}>
      <div className={s.metricGrid}>
        <Metric label="Facts" value={stats.total_nodes ?? asRecord(details.bank).fact_count ?? 0} />
        <Metric label="Documents" value={stats.total_documents ?? 0} />
        <Metric label="Observations" value={stats.total_observations ?? 0} />
        <Metric label="Pending" value={numericValue(stats.pending_operations) + numericValue(stats.pending_consolidation)} />
        <Metric label="Failed" value={numericValue(stats.failed_operations) + numericValue(stats.failed_consolidation)} />
      </div>

      <div className={s.monitorGrid}>
        <section className={s.monitorCard}>
          <h4><Activity size={16} /> API 与数据库</h4>
          <HealthRows values={details.health} />
        </section>
        <section className={s.monitorCard}>
          <h4><Database size={16} /> 当前 Bank</h4>
          <div className={s.bankSummary}>
            <strong>{details.bank_id || "—"}</strong>
            <span>{String(asRecord(details.bank).name ?? "未返回 bank 详情")}</span>
            <small>共 {details.banks_count} 个 bank</small>
          </div>
        </section>
      </div>

      {models.length > 0 && (
        <section className={s.monitorCard}>
          <h4><Cpu size={16} /> 模型栈</h4>
          <div className={s.modelGrid}>
            {models.map((model, index) => (
              <div key={`${model.label}-${index}`}>
                <span>{humanizeKey(model.label)}</span>
                <strong>{model.model || "默认模型"}</strong>
                <small>{model.provider || "未声明 provider"}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {!details.runtime_config && status.reachable && (
        <div className={s.compatNotice}>当前 Hindsight 版本未提供 runtime-config；基础健康与 bank 统计仍然可用。</div>
      )}
    </div>
  );
}

export function MemoryProviderStatus({ provider, status, loading, refreshing, onRefresh }: Props) {
  const state = memoryBackendState(status);
  if (loading && !status) return <div className={s.loadingBlock}>正在检测运行状态…</div>;

  return (
    <section className={s.statusSection}>
      <div className={s.statusToolbar}>
        <div>
          <span className={s.stateBadge} data-tone={state.tone}>{state.label}</span>
          {status?.error && status.healthy && <span className={s.partialBadge}>部分数据不可用</span>}
          <small>最后检查 {formatCheckedAt(status?.checked_at)}</small>
        </div>
        <div>
          <MemoryConsoleDialog provider={provider} consoleUrl={status?.console_url} />
          <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? "刷新中…" : "刷新状态"}
          </Button>
        </div>
      </div>

      {status && (
        <div className={s.connectionStrip}>
          <span><strong>Endpoint</strong>{status.endpoint || "未配置"}</span>
          <span><strong>版本</strong>{status.version || "未返回"}</span>
          {status.details?.kind === "openviking" && <span><strong>Auth</strong>{status.details.auth_mode || "未返回"}</span>}
          {status.details?.kind === "hindsight" && <span><strong>Mode</strong>{status.details.mode || "未返回"}</span>}
        </div>
      )}

      {status?.configured && !status.reachable && <div className={s.offlineNotice}>{status.error || "服务当前不可达。"}</div>}
      {status?.reachable && !status.healthy && <div className={s.inlineError}>{status.error || "后端返回了异常运行状态。"}</div>}
      {status?.reachable && status.error && status.healthy && <div className={s.compatNotice}>{status.error}</div>}

      {status && <OpenVikingStatus status={status} />}
      {status && <HindsightStatus status={status} />}
    </section>
  );
}
