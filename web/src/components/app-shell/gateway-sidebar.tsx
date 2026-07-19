import { Link, useLocation } from "react-router-dom";
import { MessageCircle, MessageSquareText, type LucideIcon } from "lucide-react";
import s from "./debug-sidebar.module.css";

interface GatewayItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title?: string;
}

export const IM_ITEMS: readonly GatewayItem[] = [
  { label: "飞书接入", path: "/im/feishu", icon: MessageCircle, title: "将飞书消息平台接入中文社区桌面版" },
  { label: "微信接入", path: "/im/weixin", icon: MessageSquareText, title: "将微信消息平台接入中文社区桌面版" },
];

export const GATEWAY_SECTIONS: readonly {
  label: string;
  items: readonly GatewayItem[];
}[] = [
  { label: "§031 · 消息平台接入", items: IM_ITEMS },
];

export function GatewaySidebar() {
  const location = useLocation();
  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <aside className={s.sidebar} aria-label="消息接入侧栏">
      <div className={s.scrollY}>
        {GATEWAY_SECTIONS.map((section) => (
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
