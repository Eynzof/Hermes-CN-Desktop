import { useLocation } from "react-router-dom";

export type TopTab =
  | "workbench"
  | "skills"
  | "gateway"
  | "wanderMemory"
  | "hermesMemory"
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
      path.startsWith("/backup") ||
      path.startsWith("/mcp") ||
      path.startsWith("/profiles") ||
      path.startsWith("/models") ||
      path.startsWith("/voice") ||
      path.startsWith("/config-migration") ||
      path.startsWith("/soul") ||
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
  // Wander 记忆窗口暂不可用（MemOS/WanderMemory 服务未接入），先注释掉顶部 tab 入口。
  // TODO(embedded): 服务可用后恢复此 tab 定义（同时恢复 app.tsx 路由、
  // app-sidebar.tsx 分支与 command-palette.ts 命令）。
  // {
  //   id: "wanderMemory",
  //   num: "04",
  //   label: "Wander 记忆",
  //   href: "/wander-memory/memories",
  //   matches: (path) => path.startsWith("/wander-memory"),
  // },
  {
    id: "hermesMemory",
    num: "05",
    label: "Hermes 记忆",
    href: "/memory",
    matches: (path) => ["/memory", "/memconfig", "/openviking", "/hindsight"].some((route) => isRoute(path, route)),
  },
  {
    id: "advanced",
    num: "06",
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
