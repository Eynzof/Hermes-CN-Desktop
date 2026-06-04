import { useLocation } from "react-router-dom";

export type TopTab =
  | "workbench"
  | "skills"
  | "advanced";

export interface TopTabDef {
  id: TopTab;
  num: string;
  label: string;
  href: string;
  matches: (path: string) => boolean;
}

export const TOP_TABS: readonly TopTabDef[] = [
  {
    id: "workbench",
    num: "01",
    label: "工作台",
    href: "/",
    matches: (path) =>
      path === "/" ||
      path.startsWith("/new") ||
      path.startsWith("/tasks/") ||
      path.startsWith("/history") ||
      path.startsWith("/projects"),
  },
  {
    id: "skills",
    num: "02",
    label: "配置",
    href: "/models",
    matches: (path) =>
      path.startsWith("/skills") ||
      path.startsWith("/mcp") ||
      path.startsWith("/profiles") ||
      path.startsWith("/models") ||
      path.startsWith("/config-migration") ||
      path.startsWith("/soul") ||
      path.startsWith("/memory") ||
      path.startsWith("/cron") ||
      path.startsWith("/im") ||
      path.startsWith("/console"),
  },
  {
    id: "advanced",
    num: "03",
    label: "高级",
    href: "/health",
    matches: (path) =>
      path.startsWith("/health") ||
      path.startsWith("/analytics") ||
      path.startsWith("/logs") ||
      path.startsWith("/debug") ||
      path.startsWith("/advanced") ||
      path.startsWith("/settings"),
  },
];

export function useActiveTopTab(): TopTab | null {
  const { pathname } = useLocation();
  const match = TOP_TABS.find((tab) => tab.matches(pathname));
  return match?.id ?? null;
}
