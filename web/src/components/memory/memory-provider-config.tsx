import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Save } from "lucide-react";
import { Button, LoadingState } from "@hermes/shared-ui";
import type { MemoryProviderConfigResponse } from "@hermes/protocol";
import type { VisibleMemoryProvider } from "@/hooks/use-memory";
import { openExternalUrl } from "@/lib/external-links";
import {
  humanizeKey,
  isAdvancedMemoryField,
  isMemoryFieldVisible,
} from "./memory-backend-utils";
import s from "./memory-backends.module.css";

interface Props {
  provider: VisibleMemoryProvider;
  config?: MemoryProviderConfigResponse;
  loading: boolean;
  saving: boolean;
  setupPending: boolean;
  error?: string;
  onSave(values: Record<string, unknown>): Promise<void>;
  onSetup(): Promise<void>;
}

function initialValues(config?: MemoryProviderConfigResponse): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of config?.fields ?? []) {
    if (!(field.key in values)) values[field.key] = field.kind === "secret" ? "" : field.value;
  }
  for (const field of config?.fields ?? []) {
    if (isMemoryFieldVisible(field, values)) {
      values[field.key] = field.kind === "secret" ? "" : field.value;
    }
  }
  return values;
}

export function MemoryProviderConfig({
  provider,
  config,
  loading,
  saving,
  setupPending,
  error,
  onSave,
  onSetup,
}: Props) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValues(initialValues(config));
    setSaved(false);
  }, [config, provider]);

  const visibleFields = useMemo(
    () => (config?.fields ?? []).filter((field) => isMemoryFieldVisible(field, values)),
    [config?.fields, values],
  );
  const basicFields = visibleFields.filter((field) => !isAdvancedMemoryField(provider, field.key));
  const advancedFields = visibleFields.filter((field) => isAdvancedMemoryField(provider, field.key));
  const dependenciesInstalled = config?.setup?.dependencies_installed ?? true;

  const renderField = (field: MemoryProviderConfigResponse["fields"][number], index: number) => {
    const id = `${provider}-${field.key}-${index}`;
    const value = values[field.key];
    if (field.kind === "boolean") {
      return (
        <label className={s.booleanField} htmlFor={id} key={id}>
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.checked }))}
          />
          <span>
            <strong>{humanizeKey(field.key)}</strong>
            {field.description && <small>{field.description}</small>}
          </span>
        </label>
      );
    }

    return (
      <label className={s.configField} htmlFor={id} key={id}>
        <span>
          {humanizeKey(field.key)}
          {field.required && <em>必填</em>}
        </span>
        {field.kind === "select" ? (
          <select
            id={id}
            value={String(value ?? "")}
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
          >
            {field.options.map((option) => (
              <option value={option.value} key={option.value}>{option.label || option.value}</option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            type={field.kind === "secret" ? "password" : "text"}
            value={String(value ?? "")}
            placeholder={field.kind === "secret" && field.is_set ? "已保存，留空保持不变" : field.placeholder}
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
          />
        )}
        <small>
          {field.description}
          {field.url && (
            <button type="button" onClick={() => void openExternalUrl(field.url)}>
              获取凭据 <ExternalLink size={12} />
            </button>
          )}
        </small>
      </label>
    );
  };

  if (loading) return <LoadingState variant="block" label="正在读取配置…" />;
  if (!config) return <div className={s.inlineError}>无法读取配置。</div>;

  return (
    <section className={s.configSection}>
      <div className={s.sectionTitle}>
        <div>
          <strong>接入配置</strong>
          <span>保存只更新当前档案，不会自动切换当前记忆后端。</span>
        </div>
        {!dependenciesInstalled && (
          <Button type="button" variant="outline" size="sm" loading={setupPending} onClick={() => void onSetup()}>
            安装依赖
          </Button>
        )}
      </div>

      <div className={s.configGrid}>{basicFields.map(renderField)}</div>

      {advancedFields.length > 0 && (
        <details className={s.advancedConfig}>
          <summary>高级配置 · {advancedFields.length} 项</summary>
          <div className={s.configGrid}>{advancedFields.map(renderField)}</div>
        </details>
      )}

      {error && <div className={s.inlineError}>{error}</div>}
      {saved && <div className={s.savedNotice}>已保存并完成状态检测；确认在线后可设为当前。</div>}

      <div className={s.configActions}>
        <Button
          type="button"
          variant="solid"
          tone="accent"
          size="sm"
          loading={saving}
          disabled={!dependenciesInstalled}
          leadingIcon={<Save size={12} />}
          onClick={() => {
            setSaved(false);
            void onSave(values).then(() => setSaved(true)).catch(() => setSaved(false));
          }}
        >
          保存并检测
        </Button>
      </div>
    </section>
  );
}
