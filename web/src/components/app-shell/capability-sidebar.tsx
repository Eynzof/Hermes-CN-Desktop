import { Link, useLocation } from "react-router-dom";
import {
  Boxes,
  Brain,
  Clock,
  MessageCircle,
  MessageSquareText,
  Cpu,
  Puzzle,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface CapabilityItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title?: string;
}

const CONFIG_ITEMS: readonly CapabilityItem[] = [
  { label: "模型", path: "/models", icon: Cpu },
  {
    label: "档案",
    path: "/profiles",
    icon: Boxes,
    title: "档案：独立 config / .env / sessions / skills 的环境",
  },
  { label: "技能", path: "/skills", icon: Sparkles },
  { label: "MCP", path: "/mcp", icon: Puzzle },
  { label: "记忆", path: "/memory", icon: Brain },
];

const AUTOMATION_ITEMS: readonly CapabilityItem[] = [
  { label: "定时任务", path: "/cron", icon: Clock },
];

const IM_ITEMS: readonly CapabilityItem[] = [
  { label: "飞书接入", path: "/im/feishu", icon: MessageCircle, title: "飞书 / Lark 开放平台机器人接入" },
  { label: "微信接入", path: "/im/weixin", icon: MessageSquareText, title: "个人微信 iLink bot 接入" },
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
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={s.item}
                  data-active={isActive(item.path) ? "true" : undefined}
                  title={item.title ?? item.path}
                >
                  <span className={s.itemIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={s.itemLabel}>{item.label}</span>
                  <span className={s.itemPath}>{item.path}</span>
                </Link>
              );
            })}
          </section>
        ))}
      </div>
    </aside>
  );
}
