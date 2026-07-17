import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Globe2,
  HardDrive,
  HeartHandshake,
  KeyRound,
  Loader2,
  Radio,
  Server,
} from "lucide-react";
import { Alert, Button, Input } from "@hermes/shared-ui";
import { useConfig, useModelInfo, useSaveConfig } from "@/hooks/use-config";
import { useStatus } from "@/hooks/use-status";
import { useGateway } from "@/hooks/use-gateway";
import { runtime } from "@/lib/runtime";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildProviderConfigUpdate,
  TOP5_PROVIDER_IDS,
  type ProviderPreset,
} from "@/lib/provider-catalog";
import {
  probeAnthropicMessagesProvider,
  probeChatCompletionsProvider,
} from "@/lib/provider-probe";
import { openExternalUrl } from "@/lib/external-links";
import { canCompleteGuide, productModeForConnection, type ProductMode } from "@/lib/guide-state";
import wechatCommunityQr from "@/assets/wechat-community-qr.png";
import { ConnectionSection } from "./settings-connection-section";
import { ManagedRuntimePanel } from "./managed-runtime-panel";
import s from "./guide.module.css";

const QUICK_PROVIDERS = TOP5_PROVIDER_IDS
  .map((id) => BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === id))
  .filter((provider): provider is ProviderPreset => Boolean(provider));

function HealthItem({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className={s.healthItem} data-ok={ok ? "true" : undefined}>
      {ok ? <CheckCircle2 size={16} /> : <CircleDashed size={16} />}
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

export function GuideRoute() {
  const navigate = useNavigate();
  const backendReady = runtime.isBackendReady();
  const currentMode = runtime.getConnectionMode();
  const [mode, setMode] = useState<ProductMode>(productModeForConnection(currentMode));
  const config = useConfig();
  const saveConfig = useSaveConfig();
  const modelInfo = useModelInfo();
  const status = useStatus();
  const { connectionState, connect } = useGateway();
  const [providerId, setProviderId] = useState(QUICK_PROVIDERS[0]?.id ?? "deepseek");
  const provider = QUICK_PROVIDERS.find((item) => item.id === providerId) ?? QUICK_PROVIDERS[0];
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [model, setModel] = useState(provider?.defaultModel ?? "");
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelMessage, setModelMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);

  const dashboardOk = backendReady && status.isSuccess;
  const gatewayOk = dashboardOk && connectionState === "open";
  const modelOk = Boolean(modelInfo.data?.model?.trim() && modelInfo.data?.provider?.trim());
  const canComplete = canCompleteGuide({
    backendReady,
    dashboardHttpOk: dashboardOk,
    gatewayWsOk: gatewayOk,
    hasCurrentModel: modelOk,
  });
  const externalTarget = window.__HERMES_RUNTIME__?.dashboardApiBaseUrl ?? "尚未连接";

  useEffect(() => {
    if (!backendReady) return;
    void connect().catch(() => {
      // GatewayClient owns the reconnect/error state; the health row below
      // remains pending until the real WebSocket reaches `open`.
    });
  }, [backendReady, connect]);

  const stepSummary = useMemo(() => {
    if (!backendReady) return mode === "managed" ? "先安装并启动内置内核" : "先连接外部 Hermes";
    if (mode === "managed" && !modelOk) return "配置一个可用模型";
    if (!gatewayOk) return "等待 Gateway 健康";
    return "检查完成，可以进入工作台";
  }, [backendReady, gatewayOk, mode, modelOk]);

  const chooseProvider = (nextId: string) => {
    const next = QUICK_PROVIDERS.find((item) => item.id === nextId);
    if (!next) return;
    setProviderId(next.id);
    setBaseUrl(next.baseUrl);
    setModel(next.defaultModel);
    setModelMessage(null);
  };

  const probe = async () => {
    if (!provider) return;
    setProbing(true);
    setModelMessage(null);
    try {
      const input = { apiKey, baseUrl, model };
      const result = provider.apiMode === "anthropic_messages"
        ? await probeAnthropicMessagesProvider(input)
        : await probeChatCompletionsProvider(input);
      setModelMessage(result.ok
        ? { tone: "ok", text: `端点可用，响应约 ${result.latency_ms} ms。` }
        : { tone: "error", text: result.error ?? "端点探测失败" });
    } finally {
      setProbing(false);
    }
  };

  const saveQuickModel = async () => {
    if (!provider || !config.data) return;
    if (!apiKey.trim()) {
      setModelMessage({ tone: "error", text: "请填写 API Key；已有复杂配置可直接前往完整模型页。" });
      return;
    }
    setSaving(true);
    setModelMessage(null);
    try {
      await saveConfig.mutateAsync(buildProviderConfigUpdate(config.data, provider, {
        apiKey,
        baseUrl,
        model,
      }));
      setApiKey("");
      await modelInfo.refetch();
      setModelMessage({ tone: "ok", text: `${provider.name} / ${model} 已保存并设为当前模型。` });
    } catch (error) {
      setModelMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const setGuideState = async (next: "deferred" | "completed") => {
    if (!window.hermesDesktop?.setGuideState) {
      navigate("/");
      return;
    }
    setGuideBusy(true);
    try {
      const result = await window.hermesDesktop.setGuideState(next);
      runtime.applyRuntimeControlResult(result);
      navigate("/");
    } finally {
      setGuideBusy(false);
    }
  };

  return (
    <main className={s.page}>
      <header className={s.header}>
        <div className={s.brandMark}>H</div>
        <div>
          <p>Hermes Agent 中文社区桌面版</p>
          <h1>选择最适合你的 Hermes 使用方式</h1>
          <span>这不是一次性限制：之后可以随时在“连接”和“内核”页面切换、停用或重装。</span>
        </div>
        <div className={s.headerStatus}>
          <Radio size={14} /> {stepSummary}
        </div>
      </header>

      <div className={s.layout}>
        <nav className={s.steps} aria-label="使用引导步骤">
          {[
            ["01", "运行模式", "内置或外部 Hermes"],
            ["02", "连接内核", "安装、地址与认证"],
            ["03", "模型配置", "快速保存当前模型"],
            ["04", "健康与社区", "确认可用后进入"],
          ].map(([number, title, detail]) => (
            <div className={s.step} key={number}>
              <span>{number}</span>
              <div><strong>{title}</strong><small>{detail}</small></div>
            </div>
          ))}
        </nav>

        <div className={s.content}>
          <section className={s.section}>
            <div className={s.sectionTitle}>
              <span>01</span>
              <div><h2>先选择顶层模式</h2><p>内置内核适合开箱即用；外部 Hermes 适合复用本机或服务器上的既有实例。</p></div>
            </div>
            <div className={s.modeGrid} role="radiogroup" aria-label="Hermes 使用模式">
              <button type="button" data-active={mode === "managed" ? "true" : undefined} onClick={() => setMode("managed")}>
                <HardDrive size={22} />
                <strong>使用内置内核</strong>
                <span>桌面端负责安装、启停、更新与隔离。停止或卸载不会删除用户数据。</span>
              </button>
              <button type="button" data-active={mode === "external" ? "true" : undefined} onClick={() => setMode("external")}>
                <Globe2 size={22} />
                <strong>使用外部 Hermes</strong>
                <span>连接本机其他 Hermes，或通过 Token / OAuth 连接远端服务器。</span>
              </button>
            </div>
          </section>

          <section className={s.section}>
            <div className={s.sectionTitle}>
              <span>02</span>
              <div><h2>{mode === "managed" ? "准备内置内核" : "连接外部 Hermes"}</h2><p>{mode === "managed" ? "可以自由安装、启动、停止、卸载或重装。" : "本机与远端是外部模式下的两个连接位置。"}</p></div>
            </div>
            {mode === "managed" ? <ManagedRuntimePanel /> : <ConnectionSection showHeading={false} />}
          </section>

          <section className={s.section}>
            <div className={s.sectionTitle}>
              <span>03</span>
              <div><h2>{mode === "managed" ? "快速配置模型" : "使用目标 Hermes 的模型"}</h2><p>{mode === "managed" ? "选择常用服务商，一次完成端点探测、保存与当前模型设置。" : "外部模式直接读取目标端模型配置，不会重复索要 API Key。"}</p></div>
            </div>
            {mode === "managed" ? (
              backendReady ? (
                <div className={s.modelForm}>
                  <label>服务商
                    <select value={providerId} onChange={(event) => chooseProvider(event.target.value)}>
                      {QUICK_PROVIDERS.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                  <label>API Key<Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>
                  <label>Base URL<Input mono value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} /></label>
                  <label>模型<Input mono value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} /></label>
                  <div className={s.modelActions}>
                    <Button variant="outline" onClick={() => void probe()} disabled={probing || !baseUrl || !model}>
                      {probing ? <Loader2 size={13} className={s.spin} /> : <Radio size={13} />} 探测端点
                    </Button>
                    <Button variant="solid" tone="accent" onClick={() => void saveQuickModel()} disabled={saving || !config.data}>
                      {saving ? <Loader2 size={13} className={s.spin} /> : <KeyRound size={13} />} 保存并设为当前
                    </Button>
                    <Button variant="ghost" onClick={() => navigate("/models")}>进入完整模型页 <ArrowRight size={13} /></Button>
                  </div>
                  {modelMessage && <Alert tone={modelMessage.tone} size="sm">{modelMessage.text}</Alert>}
                </div>
              ) : (
                <Alert tone="info">先完成内置内核安装与启动，模型快速配置会在后端可用后出现。</Alert>
              )
            ) : (
              <Alert tone="info">当前外部目标：{externalTarget}。模型、配置、Skills 与 MCP 的修改都会作用于这个目标。</Alert>
            )}
          </section>

          <section className={s.section}>
            <div className={s.sectionTitle}>
              <span>04</span>
              <div><h2>健康检查与社区支持</h2><p>完成需要 Dashboard HTTP、Gateway 和当前模型都可用；暂时不方便也可以稍后继续。</p></div>
            </div>
            <div className={s.finalGrid}>
              <div className={s.healthGrid}>
                <HealthItem ok={dashboardOk} label="Dashboard HTTP" detail={dashboardOk ? "接口响应正常" : "等待后端连接"} />
                <HealthItem ok={gatewayOk} label="Gateway WebSocket" detail={gatewayOk ? "Gateway 正在运行" : "尚未确认实时连接"} />
                <HealthItem ok={modelOk} label="当前模型" detail={modelOk ? `${modelInfo.data?.provider} / ${modelInfo.data?.model}` : "尚未发现当前模型"} />
                <HealthItem ok={mode === "managed" ? backendReady : runtime.isAttached()} label="连接模式" detail={mode === "managed" ? "内置内核" : `外部 Hermes · ${currentMode === "remote" ? "远端" : "本机"}`} />
              </div>
              <div className={s.community}>
                <img src={wechatCommunityQr} alt="Hermes Agent 中文社区微信群二维码" />
                <div>
                  <HeartHandshake size={20} />
                  <strong>遇到问题，中文社区在这里</strong>
                  <span>扫码加入微信群；二维码失效时可从官网入口获取最新联系方式。</span>
                  <div className={s.communityLinks}>
                    <button type="button" onClick={() => void openExternalUrl("https://hermesagent.org.cn")}><ExternalLink size={12} /> 官网 / 备用入口</button>
                    <button type="button" onClick={() => void openExternalUrl("https://hermesagent.org.cn/docs")}><Server size={12} /> 使用文档</button>
                  </div>
                </div>
              </div>
            </div>
            <div className={s.finishActions}>
              <Button variant="ghost" onClick={() => void setGuideState("deferred")} disabled={guideBusy}>稍后进入</Button>
              <Button variant="solid" tone="accent" onClick={() => void setGuideState("completed")} disabled={guideBusy || !canComplete}>
                {guideBusy && <Loader2 size={13} className={s.spin} />}
                完成引导并进入工作台 <ArrowRight size={13} />
              </Button>
            </div>
            {!canComplete && <p className={s.finishHint}>完成按钮会在 HTTP、Gateway 和当前模型全部健康后启用。</p>}
          </section>
        </div>
      </div>
    </main>
  );
}
