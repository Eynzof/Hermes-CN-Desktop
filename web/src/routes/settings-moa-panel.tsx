import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Field, Input, Select } from "@hermes/shared-ui";
import type { MoaConfigResponse, MoaModelSlot, MoaPresetConfig } from "@hermes/protocol";
import { useMoaConfig, useSaveMoaConfig } from "@/hooks/use-moa-config";
import { useModelOptions } from "@/hooks/use-model-options";
import { ModelCombobox } from "@/components/settings/model-combobox";
import s from "./settings.module.css";

// MoA（Mixture of Agents）预设编辑器。功能范围与交互对齐官方桌面端
// （Core apps/desktop settings/model-settings.tsx 的 Mixture of Agents 区块）：
// - 预设新建 / 删除 / 设为默认立即保存；
// - 参考模型与聚合器槽位的编辑先落本地，点「保存」才 PUT；
// - 服务商选择排除 moa 自身（禁止递归 MoA，后端保存时也会拒绝）；
// - enabled / 温度 / max_tokens 等字段不提供控件，原样 round-trip（官方同样如此）。

const MOA_SLUG = "moa";

interface SlotProviderOption {
  slug: string;
  name: string;
  models: string[];
}

function cloneSlot(slot: MoaModelSlot): MoaModelSlot {
  return { provider: slot.provider, model: slot.model };
}

function clonePreset(preset: MoaPresetConfig): MoaPresetConfig {
  return {
    ...preset,
    reference_models: preset.reference_models.map(cloneSlot),
    aggregator: cloneSlot(preset.aggregator),
  };
}

function SlotEditor({
  title,
  slot,
  providerOptions,
  onChange,
  action,
}: {
  title: string;
  slot: MoaModelSlot;
  providerOptions: SlotProviderOption[];
  onChange: (patch: Partial<MoaModelSlot>) => void;
  action?: React.ReactNode;
}) {
  const current = providerOptions.find((p) => p.slug === slot.provider);
  // 当前 provider 不在网关列表里（如手工编辑过 config.yaml）时补一个占位
  // 选项，避免 Select 显示成第一个 option 造成误保存。
  const options = current
    ? providerOptions
    : slot.provider
      ? [{ slug: slot.provider, name: slot.provider, models: [] }, ...providerOptions]
      : providerOptions;

  return (
    <div className={s.auxEditorPanel}>
      <div className={s.auxEditorHeader}>
        <div>
          <div className={s.auxEditorTitle}>{title}</div>
          <div className={s.auxEditorSubtitle}>
            <code>{slot.provider || "?"}</code> · <code>{slot.model || "未选择模型"}</code>
          </div>
        </div>
        {action}
      </div>
      <div className={s.providerFormGrid}>
        <Field label="服务商" className={s.fieldRow}>
          <Select
            value={slot.provider}
            onChange={(event) => onChange({ provider: event.target.value, model: "" })}
          >
            {options.map((provider) => (
              <option key={provider.slug} value={provider.slug}>
                {provider.name} · {provider.slug}
              </option>
            ))}
          </Select>
        </Field>
        <label className={s.fieldRow}>
          <div className={s.fieldLabel}>模型</div>
          <ModelCombobox
            value={slot.model}
            onChange={(next) => onChange({ model: next })}
            options={current?.models ?? []}
            placeholder="搜索或输入模型 ID"
          />
        </label>
      </div>
    </div>
  );
}

export function MoaPanel() {
  const { data: moaData, isLoading, isError, refetch } = useMoaConfig();
  const saveMoaConfig = useSaveMoaConfig();
  const { data: modelOptions } = useModelOptions();

  // 本地编辑副本。服务端数据（首次加载 / 保存回执）到达时整体覆盖，
  // 与官方桌面端 refresh → setMoa 的语义一致。
  const [moa, setMoa] = useState<MoaConfigResponse | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [newPresetName, setNewPresetName] = useState("");
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (!moaData) return;
    setMoa(moaData);
    setSelectedPreset((prev) => (prev && moaData.presets[prev] ? prev : moaData.default_preset));
  }, [moaData]);

  useEffect(() => {
    if (!savedFlash) return;
    const handle = window.setTimeout(() => setSavedFlash(false), 2500);
    return () => window.clearTimeout(handle);
  }, [savedFlash]);

  // 槽位可选的服务商：网关 model.options 里的真实 provider，排除 moa 自身。
  const providerOptions = useMemo<SlotProviderOption[]>(() => {
    return (modelOptions?.providers ?? [])
      .filter((provider) => provider.slug.toLowerCase() !== MOA_SLUG)
      .map((provider) => ({
        slug: provider.slug,
        name: provider.name || provider.slug,
        models: provider.models ?? [],
      }));
  }, [modelOptions]);

  const presetName = useMemo(() => {
    if (!moa) return "";
    if (moa.presets[selectedPreset]) return selectedPreset;
    if (moa.presets[moa.default_preset]) return moa.default_preset;
    return Object.keys(moa.presets)[0] ?? "";
  }, [moa, selectedPreset]);
  const currentPreset = moa && presetName ? moa.presets[presetName] : null;
  const presetNames = useMemo(() => Object.keys(moa?.presets ?? {}), [moa]);

  const saveNow = async (next: MoaConfigResponse) => {
    setError("");
    setMoa(next);
    try {
      await saveMoaConfig.mutateAsync(next);
      setSavedFlash(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateCurrentPreset = (mutate: (preset: MoaPresetConfig) => MoaPresetConfig) => {
    setMoa((prev) => {
      if (!prev || !presetName) return prev;
      const preset = prev.presets[presetName];
      if (!preset) return prev;
      return { ...prev, presets: { ...prev.presets, [presetName]: mutate(preset) } };
    });
  };

  const setDefaultPreset = () => {
    if (!moa || !presetName) return;
    void saveNow({ ...moa, default_preset: presetName });
  };

  const deletePreset = () => {
    if (!moa || !presetName || presetNames.length <= 1) return;
    const remaining = Object.fromEntries(
      Object.entries(moa.presets).filter(([name]) => name !== presetName),
    );
    const names = Object.keys(remaining);
    const nextDefault = remaining[moa.default_preset] ? moa.default_preset : names[0];
    const nextActive = moa.active_preset && remaining[moa.active_preset] ? moa.active_preset : "";
    setSelectedPreset(nextDefault);
    void saveNow({ ...moa, presets: remaining, default_preset: nextDefault, active_preset: nextActive });
  };

  const addPreset = () => {
    const name = newPresetName.trim();
    if (!moa || !currentPreset || !name || moa.presets[name]) return;
    setSelectedPreset(name);
    setNewPresetName("");
    void saveNow({ ...moa, presets: { ...moa.presets, [name]: clonePreset(currentPreset) } });
  };

  const addReference = () => {
    updateCurrentPreset((preset) => ({
      ...preset,
      // 官方行为：新参考槽位从聚合器克隆，用户在此基础上改。
      reference_models: [...preset.reference_models.map(cloneSlot), cloneSlot(preset.aggregator)],
    }));
  };

  const removeReference = (index: number) => {
    updateCurrentPreset((preset) => {
      if (preset.reference_models.length <= 1) return preset;
      return {
        ...preset,
        reference_models: preset.reference_models.filter((_, i) => i !== index),
      };
    });
  };

  const updateReference = (index: number, patch: Partial<MoaModelSlot>) => {
    updateCurrentPreset((preset) => ({
      ...preset,
      reference_models: preset.reference_models.map((slot, i) =>
        i === index ? { ...slot, ...patch } : slot,
      ),
    }));
  };

  const updateAggregator = (patch: Partial<MoaModelSlot>) => {
    updateCurrentPreset((preset) => ({ ...preset, aggregator: { ...preset.aggregator, ...patch } }));
  };

  if (isLoading) {
    return <div className={s.desc}>加载 MoA 配置…</div>;
  }
  if (isError || !moa || !currentPreset) {
    return (
      <Alert
        tone="warning"
        title="MoA 配置不可用"
        actions={<Button variant="outline" tone="warning" onClick={() => void refetch()}>重试</Button>}
      >
        <p>读取 /api/model/moa 失败。当前后端内核可能低于 0.18（不支持 Mixture of Agents），或 Dashboard 暂时不可达。</p>
      </Alert>
    );
  }

  return (
    <div className={s.auxModels}>
      <div className={s.auxIntroCard}>
        <div>
          <div className={s.auxIntroTitle}>Mixture of Agents（MoA 混合模型）</div>
          <p>
            配置命名预设，预设会作为可选模型出现在模型选择器的「MoA 预设」分组下。
            <b>聚合器（aggregator）是实际行动的模型</b>——它输出回答、调用工具；参考模型先并行运行，为聚合器提供多视角分析。
          </p>
          <p>
            默认预设：<code>{moa.default_preset}</code>
            {moa.active_preset && <> · 会话激活：<code>{moa.active_preset}</code></>}
          </p>
        </div>
      </div>

      <div className={s.auxToolbar}>
        <div className={s.providerFormGrid}>
          <Field label="预设" className={s.fieldRow}>
            <Select value={presetName} onChange={(event) => setSelectedPreset(event.target.value)}>
              {presetNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {name === moa.default_preset ? "（默认）" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="新预设名称" className={s.fieldRow}>
            <Input
              mono
              value={newPresetName}
              placeholder="如 review、fast"
              onChange={(event) => setNewPresetName(event.target.value)}
            />
          </Field>
        </div>
        <div className={s.providerActions}>
          <Button
            type="button"
            variant="outline"
            disabled={saveMoaConfig.isPending || presetName === moa.default_preset}
            onClick={setDefaultPreset}
          >
            设为默认
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saveMoaConfig.isPending || presetNames.length <= 1}
            title={presetNames.length <= 1 ? "至少保留一个预设" : undefined}
            onClick={deletePreset}
          >
            删除此预设
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              saveMoaConfig.isPending ||
              !newPresetName.trim() ||
              Boolean(moa.presets[newPresetName.trim()])
            }
            onClick={addPreset}
          >
            新建预设（克隆当前）
          </Button>
        </div>
      </div>

      {currentPreset.reference_models.map((slot, index) => (
        <SlotEditor
          key={`reference-${index}`}
          title={`参考模型 ${index + 1}`}
          slot={slot}
          providerOptions={providerOptions}
          onChange={(patch) => updateReference(index, patch)}
          action={
            <Button
              type="button"
              variant="outline"
              disabled={currentPreset.reference_models.length <= 1}
              title={currentPreset.reference_models.length <= 1 ? "至少保留一个参考模型" : undefined}
              onClick={() => removeReference(index)}
            >
              移除
            </Button>
          }
        />
      ))}

      <div className={s.providerActions}>
        <Button type="button" variant="outline" onClick={addReference}>
          + 添加参考模型
        </Button>
      </div>

      <SlotEditor
        title="聚合器（实际行动模型）"
        slot={currentPreset.aggregator}
        providerOptions={providerOptions}
        onChange={updateAggregator}
      />

      {error && <div className={s.modelPickerError}>保存失败：{error}</div>}
      {savedFlash && <div className={s.auxSavedHint}>✓ MoA 配置已保存</div>}

      <div className={s.providerActions}>
        <Button
          type="button"
          variant="solid"
          tone="accent"
          disabled={saveMoaConfig.isPending}
          onClick={() => void saveNow(moa)}
        >
          {saveMoaConfig.isPending ? "保存中…" : "保存 MoA 配置"}
        </Button>
        <div className={s.modelPickerHint}>
          预设的新建 / 删除 / 设为默认会立即保存；参考模型与聚合器的修改需点击「保存 MoA 配置」。
        </div>
      </div>
    </div>
  );
}
