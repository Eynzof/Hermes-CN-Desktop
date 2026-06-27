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

/** 把 model.options（providers[].models）摊平成 {provider, model, label} 列表。 */
export function useModelChoices(): UseModelChoicesResult {
  const q = useModelOptions();
  const choices = useMemo<ModelChoice[]>(() => {
    const flat: ModelChoice[] = [];
    for (const prov of q.data?.providers ?? []) {
      for (const m of prov.models ?? []) {
        flat.push({
          provider: prov.slug,
          model: m,
          label: `${prov.name ?? prov.slug} · ${m}`,
          key: modelChoiceKey(prov.slug, m),
        });
      }
    }
    return flat;
  }, [q.data]);
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
