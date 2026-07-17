import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe2,
  HeartHandshake,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Alert, Button, useTheme } from "@hermes/shared-ui";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import wechatCommunityQr from "@/assets/wechat-community-qr.png";
import { openExternalUrl } from "@/lib/external-links";
import { runtime } from "@/lib/runtime";
import { ConnectionSection } from "./settings-connection-section";
import s from "./guide.module.css";

type GuideChoice = "external" | null;

export function GuideRoute() {
  const navigate = useNavigate();
  const { config: themeConfig } = useTheme();
  const desktop = typeof window === "undefined" ? undefined : window.hermesDesktop;
  const externalSetupRef = useRef<HTMLElement>(null);
  const [choice, setChoice] = useState<GuideChoice>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");

  const openDesktopRoute = (path: string) => {
    if (runtime.platform === "web") {
      navigate(path, { replace: true });
      return;
    }
    window.location.hash = `#${path}`;
    window.location.reload();
  };

  const completeGuide = async () => {
    if (!desktop?.setGuideState) {
      if (runtime.platform !== "web") {
        throw new Error("当前桌面版本无法保存引导状态，请更新后重试。");
      }
      return;
    }
    const result = await desktop.setGuideState("completed");
    if (!result.ok) throw new Error(result.error ?? "无法保存引导状态");
    runtime.applyRuntimeControlResult(result);
  };

  const startWithDesktop = async () => {
    setPreparing(true);
    setError("");
    try {
      if (desktop?.applyConnectionConfig) {
        const result = await desktop.applyConnectionConfig({ mode: "managed" });
        if (!result.ok) throw new Error(result.error ?? "Hermes 准备失败");
      } else if (runtime.platform !== "web") {
        throw new Error("当前桌面版本无法自动准备 Hermes，请更新后重试。");
      }
      await completeGuide();
      openDesktopRoute("/models");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreparing(false);
    }
  };

  const finishExternalConnection = async () => {
    await completeGuide();
    openDesktopRoute("/");
  };

  useEffect(() => {
    if (choice !== "external") return;
    const frame = window.requestAnimationFrame(() => {
      externalSetupRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [choice]);

  return (
    <main className={s.page} data-testid="guide-scroll-container">
      <header className={s.header}>
        <HermesLogoMark
          className={s.brandMark}
          size={44}
          title="Hermes Agent 品牌 Logo"
          tone={
            themeConfig.theme === "light" || themeConfig.theme === "light-modern"
              ? "dark"
              : "light"
          }
        />
        <div>
          <p>Hermes Agent 中文社区桌面版</p>
          <h1>你想怎么开始使用 Hermes？</h1>
          <span>不确定怎么选？直接选择“开箱即用”，适合绝大多数用户。</span>
        </div>
      </header>

      <div className={s.body}>
        <section className={s.intro} aria-labelledby="guide-choice-title">
          <div className={s.introCopy}>
            <span className={s.stepLabel}>只需选择一次，以后可以随时更改</span>
            <h2 id="guide-choice-title">选择适合你的开始方式</h2>
            <p>如果“服务器、地址、Token”这些词对你很陌生，选择左边就对了。</p>
          </div>

          <div className={s.choiceGrid}>
            <button
              type="button"
              className={s.choiceCard}
              data-recommended="true"
              onClick={() => void startWithDesktop()}
              disabled={preparing}
            >
              <span className={s.choiceTopline}>
                <span className={s.choiceIcon}><Sparkles size={22} /></span>
                <span className={s.recommendedBadge}>推荐</span>
              </span>
              <strong>开箱即用</strong>
              <span className={s.choiceLead}>第一次使用、不了解技术配置，或者只想尽快开始，就选这个。</span>
              <span className={s.choiceDetail}>
                <CheckCircle2 size={15} /> 桌面端自动完成准备，无需理解或管理后台服务
              </span>
              <span className={s.choiceDetail}>
                <CheckCircle2 size={15} /> 下一步直接进入模型页，填写 API Key 后即可使用
              </span>
              <span className={s.choiceAction}>
                {preparing ? <Loader2 size={15} className={s.spin} /> : <ArrowRight size={15} />}
                {preparing ? "正在为你准备 Hermes…" : "选择开箱即用"}
              </span>
            </button>

            <button
              type="button"
              className={s.choiceCard}
              data-active={choice === "external" ? "true" : undefined}
              onClick={() => {
                setChoice("external");
                setError("");
              }}
              disabled={preparing}
            >
              <span className={s.choiceTopline}>
                <span className={s.choiceIcon}><Globe2 size={22} /></span>
                <span className={s.advancedBadge}>已有用户</span>
              </span>
              <strong>连接已有 Hermes</strong>
              <span className={s.choiceLead}>仅当你已经在本机另一套环境或服务器上运行 Hermes 时选择。</span>
              <span className={s.choiceDetail}>
                <CheckCircle2 size={15} /> 你知道现有 Hermes 的访问地址
              </span>
              <span className={s.choiceDetail}>
                <CheckCircle2 size={15} /> 你持有连接所需的 Token，或知道如何完成登录
              </span>
              <span className={s.choiceAction}>
                <ArrowRight size={15} /> 填写已有 Hermes 的连接信息
              </span>
            </button>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
        </section>

        {choice === "external" && (
          <section
            ref={externalSetupRef}
            className={s.externalSetup}
            aria-labelledby="external-setup-title"
          >
            <div className={s.externalHeader}>
              <div>
                <span className={s.stepLabel}>适合已经部署过 Hermes 的用户</span>
                <h2 id="external-setup-title">连接你已有的 Hermes</h2>
                <p>选择它是在这台电脑上运行，还是在另一台电脑或服务器上运行。</p>
              </div>
              <Button variant="ghost" onClick={() => setChoice(null)}>
                <ArrowLeft size={14} /> 返回重新选择
              </Button>
            </div>
            <ConnectionSection
              showHeading={false}
              externalOnly
              onApplied={finishExternalConnection}
            />
          </section>
        )}

        <aside className={s.support}>
          <img src={wechatCommunityQr} alt="Hermes Agent 中文社区微信群二维码" />
          <HeartHandshake size={22} />
          <div>
            <strong>不确定怎么选，也可以来中文社区问我们</strong>
            <span>扫码加入微信群；二维码失效时可从官网获取最新联系方式。</span>
          </div>
          <button type="button" onClick={() => void openExternalUrl("https://hermesagent.org.cn")}>
            <ExternalLink size={13} /> 打开官网
          </button>
        </aside>
      </div>
    </main>
  );
}
