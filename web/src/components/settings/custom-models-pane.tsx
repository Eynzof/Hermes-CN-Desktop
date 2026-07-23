import { useMemo, useState } from "react";
import { Dialog } from "@hermes/shared-ui";
import {
  Eye,
  EyeOff,
  Pencil,
  PlusCircle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useConfig, useSaveConfig } from "@/hooks/use-config";
import { useGateway } from "@/hooks/use-gateway";
import {
  buildCustomProviderDeleteUpdate,
  buildProviderSettingsUpdate,
  customProviderPresetsFromConfig,
  type ProviderPreset,
} from "@/lib/provider-catalog";
import {
  applyEnterpriseSync,
  DEFAULT_TEAM_SERVER_URL,
  ENTERPRISE_PROVIDER_PREFIX,
  enterpriseProviderId,
  readEnterpriseBinding,
  readEnterpriseSyncMeta,
  syncEnterpriseModels,
  writeEnterpriseBinding,
  writeEnterpriseSyncMeta,
  type EnterpriseBinding,
  type EnterpriseSyncMeta,
} from "@/lib/enterprise-sync";
import s from "./custom-models-pane.module.css";

/* ── 工具 ─────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function slugifyProviderId(modelName: string): string {
  const slug = modelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom:${slug || "model"}`;
}

const INPUT_WINDOW_OPTIONS = [
  { label: "使用提供商默认值", value: 0 },
  { label: "32K", value: 32_768 },
  { label: "64K", value: 65_536 },
  { label: "128K", value: 131_072 },
  { label: "256K", value: 262_144 },
];

const OUTPUT_WINDOW_OPTIONS = [
  { label: "使用提供商默认值", value: 0 },
  { label: "8K", value: 8_192 },
  { label: "16K", value: 16_384 },
  { label: "32K", value: 32_768 },
  { label: "64K", value: 65_536 },
];

interface ModelDraft {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  inputWindow: number;
  outputWindow: number;
}

const EMPTY_DRAFT: ModelDraft = {
  baseUrl: "",
  apiKey: "",
  modelName: "",
  supportsTools: true,
  supportsImages: false,
  supportsReasoning: false,
  inputWindow: 0,
  outputWindow: 0,
};

function draftFromConfig(config: Record<string, any> | undefined, providerId: string): ModelDraft {
  const entry = asRecord(asRecord(config?.providers)[providerId]);
  const modelName = String(entry.model || providerId.replace(/^custom:/, ""));
  const modelEntry = asRecord(asRecord(entry.models)[modelName]);
  return {
    baseUrl: String(entry.base_url || ""),
    apiKey: String(entry.api_key || ""),
    modelName,
    supportsTools: modelEntry.supports_tools !== false,
    supportsImages: modelEntry.supports_vision === true,
    supportsReasoning: modelEntry.supports_reasoning === true,
    inputWindow: typeof modelEntry.context_length === "number" ? modelEntry.context_length : 0,
    outputWindow: typeof modelEntry.max_output_tokens === "number" ? modelEntry.max_output_tokens : 0,
  };
}

/* ── 编辑模型弹窗（对齐 自定义模型3.png） ────────────────────────── */

interface EditDialogProps {
  title: string;
  initial: ModelDraft;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (draft: ModelDraft) => void;
}

function CustomModelEditDialog({ title, initial, saving, error, onClose, onSave }: EditDialogProps) {
  const [draft, setDraft] = useState<ModelDraft>(initial);
  const [showKey, setShowKey] = useState(false);
  const patch = (part: Partial<ModelDraft>) => setDraft((d) => ({ ...d, ...part }));

  const windowSelector = (
    value: number,
    options: typeof INPUT_WINDOW_OPTIONS,
    onChange: (v: number) => void,
  ) => (
    <select
      className={s.select}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.editDialog} aria-describedby={undefined}>
          <Dialog.Title asChild>
            <span className={s.editTitle}>{title}</span>
          </Dialog.Title>
          <span className={s.editBadge}>仅支持 OpenAI 兼容协议 API</span>
          <button type="button" className={s.editClose} aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>

          <div className={s.editBody}>
            <label className={s.field}>
              <span className={s.label}>提供商</span>
              <input className={s.input} value="自定义 / Custom" disabled />
            </label>
            <label className={s.field}>
              <span className={s.label}>接口地址</span>
              <input
                className={s.input}
                value={draft.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
                placeholder="http://localhost:3000/v1"
                spellCheck={false}
              />
            </label>
            <label className={s.field}>
              <span className={s.label}>API Key</span>
              <span className={s.keyWrap}>
                <input
                  className={s.input}
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                  placeholder="sk-..."
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={s.eye}
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
            </label>
            <label className={s.field}>
              <span className={s.label}>模型名称</span>
              <input
                className={s.input}
                value={draft.modelName}
                onChange={(event) => patch({ modelName: event.target.value })}
                placeholder="claude-opus-4-8"
                spellCheck={false}
              />
            </label>

            <div className={s.field}>
              <span className={s.label}>高级配置</span>
              <div className={s.checkRow}>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={draft.supportsTools}
                    onChange={(event) => patch({ supportsTools: event.target.checked })}
                  />
                  工具调用
                </label>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={draft.supportsImages}
                    onChange={(event) => patch({ supportsImages: event.target.checked })}
                  />
                  图片输入
                </label>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={draft.supportsReasoning}
                    onChange={(event) => patch({ supportsReasoning: event.target.checked })}
                  />
                  思考模式
                </label>
                <label className={s.check} data-disabled="true" title="预留，依赖 Core 支持">
                  <input type="checkbox" disabled />
                  自定义协议
                </label>
              </div>
            </div>

            <div className={s.windowGrid}>
              <div className={s.field}>
                <span className={s.label}>输入</span>
                {windowSelector(draft.inputWindow, INPUT_WINDOW_OPTIONS, (v) => patch({ inputWindow: v }))}
              </div>
              <div className={s.field}>
                <span className={s.label}>输出</span>
                {windowSelector(draft.outputWindow, OUTPUT_WINDOW_OPTIONS, (v) => patch({ outputWindow: v }))}
              </div>
            </div>

            {error ? <div className={s.error}>{error}</div> : null}
          </div>

          <div className={s.editFoot}>
            <button type="button" className={s.btn} onClick={onClose} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className={s.btn}
              data-variant="primary"
              onClick={() => onSave(draft)}
              disabled={saving || !draft.baseUrl.trim() || !draft.modelName.trim()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── 企业模型下发 ─────────────────────────────────────────────── */

function EnterpriseSection() {
  const { data: config } = useConfig();
  const saveConfig = useSaveConfig();
  const { setRuntimeModel } = useGateway();
  const [binding, setBinding] = useState<EnterpriseBinding | null>(readEnterpriseBinding);
  const [meta, setMeta] = useState<EnterpriseSyncMeta | null>(readEnterpriseSyncMeta);
  const [serverUrl, setServerUrl] = useState(binding?.serverUrl ?? DEFAULT_TEAM_SERVER_URL);
  const [deviceToken, setDeviceToken] = useState(binding?.deviceToken ?? "");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const enterprisePresets = useMemo(
    () =>
      customProviderPresetsFromConfig(config, [], undefined).filter((preset) =>
        preset.id.startsWith(ENTERPRISE_PROVIDER_PREFIX),
      ),
    [config],
  );

  const handleSync = async () => {
    if (!config) {
      setError("配置尚未加载完成，请稍后再试。");
      return;
    }
    const nextBinding: EnterpriseBinding = {
      serverUrl: serverUrl.trim().replace(/\/+$/, ""),
      deviceToken: deviceToken.trim(),
    };
    if (!nextBinding.serverUrl || !nextBinding.deviceToken) {
      setError("请输入服务器地址与设备令牌。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await syncEnterpriseModels(nextBinding);
      const next = applyEnterpriseSync(config, nextBinding, data);
      await saveConfig.mutateAsync(next);
      if (!data.cleanupOnly && data.defaultModel) {
        try {
          await setRuntimeModel(data.defaultModel, enterpriseProviderId(data.defaultModel));
        } catch {
          // 热切换失败不阻塞：下轮新会话也会读到落盘的默认模型
        }
      }
      setBinding(nextBinding);
      writeEnterpriseBinding(nextBinding);
      const nextMeta: EnterpriseSyncMeta = {
        lastSyncAt: Date.now(),
        modelCount: data.cleanupOnly ? 0 : (data.models ?? []).length,
        defaultModel: data.defaultModel,
        cleanupOnly: data.cleanupOnly === true,
      };
      setMeta(nextMeta);
      writeEnterpriseSyncMeta(nextMeta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async () => {
    if (!binding || !config) return;
    setBusy(true);
    setError("");
    try {
      const next = applyEnterpriseSync(config, binding, { cleanupOnly: true });
      await saveConfig.mutateAsync(next);
      setBinding(null);
      setMeta(null);
      writeEnterpriseBinding(null);
      writeEnterpriseSyncMeta(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.section}>
      <h4 className={s.sectionTitle}>企业模型下发</h4>
      <div className={s.desc}>
        由企业管理员（HuanXing-Team）为子账号下发模型；输入团队服务器地址与设备令牌后同步，
        模型会出现在对话的模型选择器中。
      </div>
      <div className={s.card}>
        <div className={s.bindRow}>
          <input
            className={s.input}
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder={DEFAULT_TEAM_SERVER_URL}
            spellCheck={false}
          />
          <span className={s.keyWrap} data-grow="true">
            <input
              className={s.input}
              type={showToken ? "text" : "password"}
              value={deviceToken}
              onChange={(event) => setDeviceToken(event.target.value)}
              placeholder="设备令牌（wbd_...）"
              spellCheck={false}
            />
            <button
              type="button"
              className={s.eye}
              aria-label={showToken ? "隐藏令牌" : "显示令牌"}
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </span>
          <button
            type="button"
            className={s.btn}
            data-variant="primary"
            onClick={() => void handleSync()}
            disabled={busy}
          >
            <RefreshCw size={13} />
            {busy ? "同步中…" : binding ? "重新同步" : "绑定并同步"}
          </button>
          {binding ? (
            <button type="button" className={s.btn} onClick={() => void handleUnbind()} disabled={busy}>
              解除绑定
            </button>
          ) : null}
        </div>
        <div className={s.syncMeta}>
          {meta
            ? meta.cleanupOnly
              ? "设备已被企业停用，本地托管模型已清理。"
              : `上次同步 ${new Date(meta.lastSyncAt).toLocaleString()} · ${meta.modelCount} 个模型${meta.defaultModel ? ` · 默认 ${meta.defaultModel}` : ""}`
            : binding
              ? "已绑定，尚未同步。"
              : "未绑定设备。设备令牌由企业管理员在后台注册设备时发放。"}
        </div>
        {error ? <div className={s.error}>{error}</div> : null}
      </div>

      {enterprisePresets.length > 0 ? (
        <div className={s.modelList}>
          {enterprisePresets.map((preset) => (
            <div className={s.modelRow} key={preset.id}>
              <span className={s.modelIcon} data-tone="enterprise">
                <PlusCircle size={15} />
              </span>
              <div className={s.modelText}>
                <div className={s.modelName}>{preset.defaultModel}</div>
                <div className={s.modelSub}>企业下发{ preset.vendor && preset.vendor !== "自定义" ? ` · ${preset.vendor}` : "" }</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* ── 自定义模型 ───────────────────────────────────────────────── */

export function CustomModelsPane() {
  const { data: config } = useConfig();
  const saveConfig = useSaveConfig();
  const [editor, setEditor] = useState<
    | { mode: "add" }
    | { mode: "edit"; providerId: string }
    | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const customPresets = useMemo(
    () =>
      customProviderPresetsFromConfig(config, [], undefined).filter(
        (preset) => !preset.id.startsWith(ENTERPRISE_PROVIDER_PREFIX),
      ),
    [config],
  );

  const handleSave = async (draft: ModelDraft) => {
    if (!config) {
      setError("配置尚未加载完成，请稍后再试。");
      return;
    }
    const modelName = draft.modelName.trim();
    const providerId = editor?.mode === "edit" ? editor.providerId : slugifyProviderId(modelName);
    const preset: ProviderPreset = {
      id: providerId,
      name: modelName,
      vendor: "自定义",
      region: "cn",
      baseUrl: draft.baseUrl.trim(),
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: modelName,
      models: [
        {
          id: modelName,
          contextWindow: draft.inputWindow || undefined,
          supportsVision: draft.supportsImages,
          supportsTools: draft.supportsTools,
          supportsReasoning: draft.supportsReasoning,
        },
      ],
      isCustom: true,
    };
    setSaving(true);
    setError("");
    try {
      let next = buildProviderSettingsUpdate(config, preset, {
        apiKey: draft.apiKey,
        baseUrl: draft.baseUrl,
        model: modelName,
        contextWindow: "",
      });
      // 输出窗口不是 Core 的标准字段：存在 models map 条目里（Core 不识则忽略）。
      if (draft.outputWindow) {
        const providers = asRecord(next.providers);
        const key = Object.hasOwn(providers, providerId) ? providerId : providerId.replace(/^custom:/i, "");
        const entry = asRecord(providers[key]);
        const modelsMap = asRecord(entry.models);
        const modelEntry = asRecord(modelsMap[modelName]);
        modelsMap[modelName] = { ...modelEntry, max_output_tokens: draft.outputWindow };
        entry.models = modelsMap;
        providers[key] = entry;
        next = { ...next, providers };
      }
      await saveConfig.mutateAsync(next);
      setEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (providerId: string) => {
    if (!config) return;
    if (!window.confirm("确定删除这个自定义模型吗？")) return;
    setError("");
    try {
      await saveConfig.mutateAsync(buildCustomProviderDeleteUpdate(config, providerId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败。");
    }
  };

  return (
    <div>
      <EnterpriseSection />

      <section className={s.section}>
        <h4 className={s.sectionTitle}>自定义模型</h4>
        <div className={s.card}>
          <div className={s.cardHead}>
            <div>
              <div className={s.cardHeadTitle}>本地配置文件</div>
              <div className={s.desc}>
                自定义模型会写入 Core config.yaml 的 providers 配置，保存后立即出现在对话的模型选择器中。
              </div>
            </div>
            <button
              type="button"
              className={s.btn}
              data-variant="primary"
              onClick={() => {
                setError("");
                setEditor({ mode: "add" });
              }}
            >
              + 添加模型
            </button>
          </div>
        </div>

        <h5 className={s.savedTitle}>已保存模型</h5>
        {error ? <div className={s.error}>{error}</div> : null}
        {customPresets.length === 0 ? (
          <div className={s.empty}>暂无自定义模型，点击右上角「添加模型」。</div>
        ) : (
          <div className={s.modelList}>
            {customPresets.map((preset) => (
              <div className={s.modelRow} key={preset.id}>
                <span className={s.modelIcon}>
                  <PlusCircle size={15} />
                </span>
                <div className={s.modelText}>
                  <div className={s.modelName}>{preset.defaultModel}</div>
                  <div className={s.modelSub}>自定义</div>
                </div>
                <button
                  type="button"
                  className={s.rowOp}
                  title="编辑"
                  onClick={() => {
                    setError("");
                    setEditor({ mode: "edit", providerId: preset.id });
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className={s.rowOp}
                  title="删除"
                  onClick={() => void handleDelete(preset.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editor ? (
        <CustomModelEditDialog
          title={editor.mode === "add" ? "添加模型" : "编辑模型"}
          initial={editor.mode === "edit" ? draftFromConfig(config, editor.providerId) : EMPTY_DRAFT}
          saving={saving}
          error={error}
          onClose={() => setEditor(null)}
          onSave={(draft) => void handleSave(draft)}
        />
      ) : null}
    </div>
  );
}
