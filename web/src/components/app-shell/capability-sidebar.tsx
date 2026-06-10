import { Link, useLocation } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Archive,
  Boxes,
  Brain,
  Clock,
  Ghost,
  MessageCircle,
  MessageSquareText,
  Cpu,
  Puzzle,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { prefetchSoul } from "@/hooks/use-soul";
import s from "./debug-sidebar.module.css";

interface CapabilityItem {
  label: string;
  path: string;
  icon: LucideIcon;
  shortcut?: string;
  title?: string;
  // hover/聚焦时预取页面数据，点进去时已在缓存或在途
  prefetch?: (qc: QueryClient, profile: string) => void;
}

export const CONFIG_ITEMS: readonly CapabilityItem[] = [
  { label: "模型", path: "/models", icon: Cpu },
  { label: "备份恢复", path: "/backup", icon: Archive },
  { label: "配置迁移", path: "/config-migration", icon: Sparkles, shortcut: "/migration" },
  {
    label: "档案",
    path: "/profiles",
    icon: Boxes,
    title: "档案：独立 config / .env / sessions / skills 的环境",
  },
  { label: "技能", path: "/skills", icon: Sparkles },
  { label: "MCP", path: "/mcp", icon: Puzzle },
  { label: "终端", path: "/console", icon: TerminalSquare, title: "Hermes Console：直接运行 Hermes 命令" },
  { label: "记忆", path: "/memory", icon: Brain },
  {
    label: "灵魂",
    path: "/soul",
    icon: Ghost,
    title: "SOUL.md：智能体的核心人格（系统提示词第一身份）",
    prefetch: prefetchSoul,
  },
];

const AUTOMATION_ITEMS: readonly CapabilityItem[] = [
  { label: "定时任务", path: "/cron", icon: Clock },
];

const IM_ITEMS: readonly CapabilityItem[] = [
  { label: "飞书接入", path: "/im/feishu", icon: MessageCircle, title: "将飞书消息平台接入中文社区桌面版" },
  { label: "微信接入", path: "/im/weixin", icon: MessageSquareText, title: "将微信消息平台接入中文社区桌面版" },
];

export const CAPABILITY_SECTIONS: readonly {
  label: string;
  items: readonly CapabilityItem[];
}[] = [
  { label: "§021 · 配置", items: CONFIG_ITEMS },
  { label: "§022 · 自动化", items: AUTOMATION_ITEMS },
  { label: "§023 · 消息平台接入", items: IM_ITEMS },
];

export function CapabilitySidebar() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const profile = useActiveProfileName();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  return (
    <aside className={s.sidebar} aria-label="配置侧栏">
      <div className={s.scrollY}>
        {CAPABILITY_SECTIONS.map((section) => (
          <section key={section.label} className={s.section}>
            <div className={s.label}>
              <span>{section.label}</span>
              <span className={s.labelNum}>✕✕</span>
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              const onPrefetch = item.prefetch
                ? () => item.prefetch!(queryClient, profile)
                : undefined;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  title={item.title ?? item.path}
                  onMouseEnter={onPrefetch}
                  onFocus={onPrefetch}
                >
                  <span className={s.itemIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={s.itemLabel}>{item.label}</span>
                  <span className={s.itemPath}>{item.shortcut ?? item.path}</span>
                </Link>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
