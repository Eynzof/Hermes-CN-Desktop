import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { KeyRound, Settings2, Sparkles } from "lucide-react";
import { useModelInfo } from "@/hooks/use-config";
import s from "./model-onboarding-guard.module.css";

const DEFAULT_PROVIDER_HASH = "#provider-deepseek";
let dismissedForWindow = false;

function hasConfiguredModel(modelInfo: { model?: string; provider?: string } | undefined): boolean {
  return Boolean(modelInfo?.model?.trim() && modelInfo?.provider?.trim());
}

export function ModelOnboardingGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: modelInfo, isLoading, isError } = useModelInfo();
  const [dismissed, setDismissed] = useState(() => dismissedForWindow);

  const configured = hasConfiguredModel(modelInfo);

  useEffect(() => {
    if (!configured || typeof window === "undefined") return;
    dismissedForWindow = false;
    setDismissed(false);
  }, [configured]);

  if (
    isLoading ||
    isError ||
    configured ||
    dismissed ||
    location.pathname.startsWith("/models") ||
    location.pathname.startsWith("/console")
  ) {
    return null;
  }

  const goModels = () => {
    navigate(`/models${DEFAULT_PROVIDER_HASH}`);
  };

  const dismiss = () => {
    dismissedForWindow = true;
    setDismissed(true);
  };

  return (
    <div className={s.backdrop} role="presentation">
      <section className={s.card} role="dialog" aria-modal="true" aria-labelledby="model-onboarding-title">
        <div className={s.iconWrap} aria-hidden="true">
          <Sparkles size={22} />
        </div>
        <div className={s.copy}>
          <p className={s.kicker}>首次初始化</p>
          <h2 id="model-onboarding-title">先配置模型 API Key</h2>
          <p>
            当前桌面端使用的是独立内核，还没有配置模型服务商和默认模型。
            请进入模型页选择服务商，粘贴 API Key，保存后设为当前模型。
          </p>
          <div className={s.steps}>
            <span><KeyRound size={13} /> 填写 API Key</span>
            <span><Settings2 size={13} /> 保存配置</span>
            <span><Sparkles size={13} /> 设为当前模型</span>
          </div>
        </div>
        <div className={s.actions}>
          <button type="button" className={s.secondary} onClick={dismiss}>先看看界面</button>
          <button type="button" className={s.primary} onClick={goModels} autoFocus>进入模型页</button>
        </div>
      </section>
    </div>
  );
}
