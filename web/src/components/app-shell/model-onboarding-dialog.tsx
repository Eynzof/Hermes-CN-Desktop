import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  ServerCog,
  Settings2,
  Sparkles,
} from "lucide-react";
import { Button, Dialog } from "@hermes/shared-ui";
import { useModelInfo } from "@/hooks/use-config";
import s from "./model-onboarding-dialog.module.css";

const DEFAULT_PROVIDER_HASH = "#provider-deepseek";
const DISMISS_KEY = "hermes:model-onboarding-dismissed";
const EXEMPT_PATH_PREFIXES = ["/models", "/connection", "/console"] as const;

export function hasConfiguredModel(
  modelInfo: { model?: string; provider?: string } | undefined,
): boolean {
  return Boolean(modelInfo?.model?.trim() && modelInfo?.provider?.trim());
}

interface ModelOnboardingVisibility {
  configured: boolean;
  dismissed: boolean;
  isError: boolean;
  isLoading: boolean;
  pathname: string;
}

export function shouldShowModelOnboarding({
  configured,
  dismissed,
  isError,
  isLoading,
  pathname,
}: ModelOnboardingVisibility): boolean {
  if (isLoading || isError || configured || dismissed) return false;
  return !EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function ModelOnboardingDialog() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: modelInfo, isLoading, isError } = useModelInfo();
  const [dismissed, setDismissed] = useState(() => (
    typeof window !== "undefined" && window.sessionStorage.getItem(DISMISS_KEY) === "1"
  ));
  const configured = hasConfiguredModel(modelInfo);

  useEffect(() => {
    if (!configured || typeof window === "undefined") return;
    window.sessionStorage.removeItem(DISMISS_KEY);
    setDismissed(false);
  }, [configured]);

  const visible = shouldShowModelOnboarding({
    configured,
    dismissed,
    isError,
    isLoading,
    pathname: location.pathname,
  });

  if (!visible) return null;

  const dismiss = () => {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const goModels = () => {
    navigate(`/models${DEFAULT_PROVIDER_HASH}`);
  };

  const goConnection = () => {
    navigate("/connection");
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.dialog}
          aria-describedby="model-onboarding-description"
        >
          <header className={s.header}>
            <span className={s.heroIcon} aria-hidden="true">
              <Sparkles size={26} />
            </span>
            <div>
              <p className={s.kicker}>首次使用</p>
              <Dialog.Title className={s.title}>开始使用 Hermes</Dialog.Title>
              <Dialog.Description id="model-onboarding-description" className={s.description}>
                内置 Hermes 已经准备好。配置一个模型后即可开始任务；你也可以先浏览工作台，
                稍后再完成设置。
              </Dialog.Description>
            </div>
          </header>

          <section className={s.modelPath} aria-labelledby="model-path-title">
            <div className={s.modelPathHeader}>
              <span className={s.pathIcon} aria-hidden="true">
                <KeyRound size={21} />
              </span>
              <div>
                <h3 id="model-path-title">先配置模型</h3>
                <p>选择常用服务商并填写 API Key，推荐模型会自动带出。</p>
              </div>
              <span className={s.recommended}>推荐</span>
            </div>

            <div className={s.steps} aria-label="模型配置步骤">
              <span><KeyRound size={14} /> 选择服务商</span>
              <span><Settings2 size={14} /> 填写 API Key</span>
              <span><CheckCircle2 size={14} /> 验证并设为当前模型</span>
            </div>

            <Button
              className={s.configureButton}
              variant="solid"
              tone="accent"
              size="lg"
              trailingIcon={<ArrowRight size={15} />}
              onClick={goModels}
              autoFocus
            >
              配置模型
            </Button>
          </section>

          <aside className={s.ownKernel}>
            <span className={s.kernelIcon} aria-hidden="true">
              <ServerCog size={20} />
            </span>
            <div>
              <span className={s.advancedLabel}>高级选项</span>
              <strong>已经有自己的 Hermes 内核？</strong>
              <p>可以连接本机其他 Hermes，或连接部署在服务器上的 Hermes。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              trailingIcon={<ArrowRight size={13} />}
              onClick={goConnection}
            >
              连接自己的内核
            </Button>
          </aside>

          <footer className={s.footer}>
            <span>所有设置之后都可以在“模型”和“连接”页面修改。</span>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              先看看界面
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
