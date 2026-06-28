import { useMemo } from "react";
import { Select } from "@hermes/shared-ui";
import { useModelOptions } from "@/hooks/use-model-options";
import { modelChoiceKey, parseModelChoiceKey } from "./profile-model-key";

// 纯函数放在 ./profile-model-key（无 React/app 依赖，便于单测）；这里转出，
// 让消费方继续从本模块统一引用。
export { modelChoiceKey, parseModelChoiceKey };

export interface ModelChoice {
  provider: string;
  model: string;
  label: string;
  key: string;
}

export interface UseModelChoicesResult {
  choices: ModelChoice[];
  loading: boolean;
  error: boolean;
}

interface ModelChoiceProvider {
  slug: string;
  name?: string | null;
  models?: readonly string[] | null;
}

/**
 * 把 model.options（providers[].models）摊平成 {provider, model, label} 列表并去重。
 * 网关 model.options 可能在同一 provider 下重复返回同一 model，或重复返回同一
 * provider（同型号横跨多个预设很常见，如 deepseek-v4-flash）。按 key 去重，否则
 * ProfileModelSelect 会渲染出 key 相同的 <option>，触发 React 重复 key 警告。
 * 纯函数：测试可直接引入，不必拉起 React / gateway 依赖图。
 */
export function flattenModelChoices(
  providers: readonly ModelChoiceProvider[] | undefined,
): ModelChoice[] {
  const flat: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const prov of providers ?? []) {
    for (const m of prov.models ?? []) {
      const key = modelChoiceKey(prov.slug, m);
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push({
        provider: prov.slug,
        model: m,
        label: `${prov.name ?? prov.slug} · ${m}`,
        key,
      });
    }
  }
  return flat;
}

export function useModelChoices(): UseModelChoicesResult {
  const q = useModelOptions();
  const choices = useMemo<ModelChoice[]>(
    () => flattenModelChoices(q.data?.providers),
    [q.data],
  );
  return { choices, loading: q.isLoading, error: q.isError };
}

export interface ProfileModelSelectProps {
  id?: string;
  value: string;
  onChange: (key: string) => void;
  choices: ModelChoice[];
  /** 顶部「不设置 / 保持不变」选项的文案；不传则不渲染该项。 */
  noneLabel?: string;
  disabled?: boolean;
}

export function ProfileModelSelect({
  id,
  value,
  onChange,
  choices,
  noneLabel,
  disabled,
}: ProfileModelSelectProps) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      mono
    >
      {noneLabel !== undefined ? <option value="">{noneLabel}</option> : null}
      {choices.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </Select>
  );
}
