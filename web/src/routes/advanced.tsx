import { Navigate, useLocation } from "react-router-dom";
import { SectionShell } from "./section-shell";
import { AboutSection, ConfigSection, GeneralSection, KernelSection } from "./settings";
import { EnvironmentSection } from "./environment";

type AdvancedSection = "general" | "config" | "kernel" | "env" | "about";

const SECTION_META: Record<AdvancedSection, { title: string; sub: string }> = {
  general: { title: "常规", sub: "调整主题、密度和对话显示偏好。" },
  config: { title: "配置", sub: "编辑 Hermes config.yaml 中的高级配置项。" },
  kernel: { title: "内核", sub: "查看运行时、版本和本地路径信息。" },
  env: { title: "环境", sub: "检查 managed runtime 与本机可选工具能力。" },
  about: { title: "关于", sub: "联系方式、社区入口和致谢信息。" },
};

function sectionFromPath(pathname: string): AdvancedSection | null {
  if (pathname === "/advanced" || pathname === "/advanced/") return "general";
  if (pathname === "/advanced/config") return "config";
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
      {section === "config" && <ConfigSection showHeading={false} />}
      {section === "kernel" && <KernelSection showHeading={false} />}
      {section === "env" && <EnvironmentSection showHeading={false} />}
      {section === "about" && <AboutSection showHeading={false} />}
    </SectionShell>
  );
}
