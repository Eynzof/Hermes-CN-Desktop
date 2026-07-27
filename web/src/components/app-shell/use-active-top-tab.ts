import { useLocation } from "react-router-dom";

export type TopTab =
  | "workbench"
  | "skills"
  | "gateway"
  | "advanced";

export interface TopTabDef {
  id: TopTab;
  num: string;
  label: string;
  href: string;
  matches: (path: string) => boolean;
}

const isRoute = (path: string, route: string) => path === route || path.startsWith(`${route}/`);

const ADVANCED_ROUTES = [
  "/common",
  "/notifications",
  "/config",
  "/connection",
  "/kernel",
  "/env",
  "/about",
  "/advanced",
  "/settings",
] as const;

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
      path.startsWith("/projects") ||
      path.startsWith("/kanban"),
  },
  {
    id: "skills",
    num: "02",
    label: "配置",
    href: "/models",
    matches: (path) =>
      path.startsWith("/skills") ||
      path.startsWith("/plugins") ||
      path.startsWith("/backup") ||
      path.startsWith("/mcp") ||
      path.startsWith("/profiles") ||
      path.startsWith("/models") ||
      path.startsWith("/voice") ||
      path.startsWith("/config-migration") ||
      path.startsWith("/soul") ||
      path.startsWith("/memory") ||
      path.startsWith("/cron") ||
      path.startsWith("/console") ||
      path.startsWith("/coding-agents"),
  },
  {
    id: "gateway",
    num: "03",
    label: "消息接入",
    href: "/im/feishu",
    matches: (path) => path.startsWith("/im"),
  },
  {
    id: "advanced",
    num: "04",
    label: "高级",
    href: "/health",
    matches: (path) =>
      path.startsWith("/health") ||
      path.startsWith("/analytics") ||
      path.startsWith("/logs") ||
      path.startsWith("/debug") ||
      path.startsWith("/theme") ||
      ADVANCED_ROUTES.some((route) => isRoute(path, route)),
  },
];

export function useActiveTopTab(): TopTab | null {
  const { pathname } = useLocation();
  const match = TOP_TABS.find((tab) => tab.matches(pathname));
  return match?.id ?? null;
}
