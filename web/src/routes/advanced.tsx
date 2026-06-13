import { Navigate, useLocation } from "react-router-dom";
import { SectionShell } from "./section-shell";
import { AboutSection, ConfigSection, GeneralSection, KernelSection, NotificationSection, ThemeSection } from "./settings";
import { ConnectionSection } from "./settings-connection-section";
import { EnvironmentSection } from "./environment";

type AdvancedSection = "general" | "notifications" | "config" | "connection" | "kernel" | "env" | "about";

const SECTION_META: Record<AdvancedSection, { title: string; sub: string }> = {
  general: { title: "常规", sub: "调整会话显示与输入偏好。" },
  notifications: { title: "通知", sub: "控制任务完成与权限确认的系统通知、提示音。" },
  config: { title: "配置", sub: "编辑 Hermes config.yaml 中的高级配置项。" },
  connection: { title: "连接", sub: "选择本机内核或连接远程 Hermes Agent 实例。" },
  kernel: { title: "内核", sub: "查看运行时、版本和本地路径信息。" },
  env: { title: "环境", sub: "检查 managed runtime 与本机可选工具能力。" },
  about: { title: "关于", sub: "联系方式、社区入口和致谢信息。" },
};

export function ThemeRoute() {
  return (
    <SectionShell title="主题" sub="选择皮肤、信息密度和对话字号。">
      <ThemeSection showHeading={false} />
    </SectionShell>
  );
}

function sectionFromPath(pathname: string): AdvancedSection | null {
  if (pathname === "/advanced" || pathname === "/advanced/") return "general";
  if (pathname === "/advanced/notifications") return "notifications";
  if (pathname === "/advanced/config") return "config";
  if (pathname === "/advanced/connection") return "connection";
  if (pathname === "/advanced/kernel") return "kernel";
  if (pathname === "/advanced/env") return "env";
  if (pathname === "/advanced/about") return "about";
  return null;
}

export function AdvancedRoute() {
  const { pathname } = useLocation();
  const section = sectionFromPath(pathname);

  if (!section) return <Navigate to="/advanced" replace />;

  const meta = SECTION_META[section];
  return (
    <SectionShell title={meta.title} sub={meta.sub}>
      {section === "general" && <GeneralSection showHeading={false} />}
      {section === "notifications" && <NotificationSection showHeading={false} />}
      {section === "config" && <ConfigSection showHeading={false} />}
      {section === "connection" && <ConnectionSection showHeading={false} />}
      {section === "kernel" && <KernelSection showHeading={false} />}
      {section === "env" && <EnvironmentSection showHeading={false} />}
      {section === "about" && <AboutSection showHeading={false} />}
    </SectionShell>
  );
}
