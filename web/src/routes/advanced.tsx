import { Navigate, useLocation } from "react-router-dom";
import { SectionShell } from "./section-shell";
import { AboutSection, ConfigSection, GeneralSection, KernelSection, NotificationSection, ThemeSection } from "./settings";
import { ConnectionSection } from "./settings-connection-section";
import { EnvironmentSection } from "./environment";

type AdvancedSection = "general" | "notifications" | "config" | "connection" | "kernel" | "env" | "about";

const SECTION_PATHS: Record<AdvancedSection, string> = {
  general: "/common",
  notifications: "/notifications",
  config: "/config",
  connection: "/connection",
  kernel: "/kernel",
  env: "/env",
  about: "/about",
};

const LEGACY_SECTION_PATHS: Record<string, AdvancedSection> = {
  "/advanced": "general",
  "/advanced/notifications": "notifications",
  "/advanced/config": "config",
  "/advanced/connection": "connection",
  "/advanced/kernel": "kernel",
  "/advanced/env": "env",
  "/advanced/about": "about",
};

const SECTION_META: Record<AdvancedSection, { title: string; sub: string }> = {
  general: { title: "常规", sub: "调整会话显示与输入偏好。" },
  notifications: { title: "通知", sub: "控制任务完成与权限确认的系统通知、提示音。" },
  config: { title: "配置", sub: "编辑 Hermes config.yaml 中的高级配置项。" },
  connection: { title: "连接", sub: "选择本机内核或连接远程 Hermes Agent 实例。" },
  kernel: { title: "内核", sub: "查看内核、版本和本地路径信息。" },
  env: { title: "环境", sub: "检查本机内核与可选工具能力。" },
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
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const canonicalSection = Object.entries(SECTION_PATHS).find(([, path]) => path === normalized)?.[0];
  return (canonicalSection as AdvancedSection | undefined) ?? LEGACY_SECTION_PATHS[normalized] ?? null;
}

export function AdvancedRoute() {
  const { hash, pathname } = useLocation();
  const section = sectionFromPath(pathname);

  if (!section) return <Navigate to="/common" replace />;

  const canonicalPath = SECTION_PATHS[section];
  const normalizedPathname = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalizedPathname !== canonicalPath) return <Navigate to={`${canonicalPath}${hash}`} replace />;

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
