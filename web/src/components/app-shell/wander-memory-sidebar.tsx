import { Link, useLocation } from "react-router-dom";
import {
  Activity,
  BookOpen,
  Brain,
  Database,
  FileText,
  MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { WANDER_MEMORY_PATHS } from "@/lib/wander-memory/paths";
import s from "./debug-sidebar.module.css";

interface WanderMemoryItem {
  label: string;
  path: string;
  icon: LucideIcon;
  title: string;
}

export const WANDER_MEMORY_ITEMS: readonly WanderMemoryItem[] = [
  {
    label: "记忆",
    path: WANDER_MEMORY_PATHS.memories,
    icon: Brain,
    title: "浏览、搜索、添加与删除 MemOS 记忆条目",
  },
  {
    label: "文件",
    path: WANDER_MEMORY_PATHS.files,
    icon: Database,
    title: "从本地文件目录导入记忆",
  },
  {
    label: "对话导入",
    path: WANDER_MEMORY_PATHS.dialogue,
    icon: MessageSquare,
    title: "导入历史对话作为记忆",
  },
  {
    label: "聊天",
    path: WANDER_MEMORY_PATHS.chat,
    icon: MessagesSquare,
    title: "基于记忆的 MemOS 聊天",
  },
  {
    label: "上下文",
    path: WANDER_MEMORY_PATHS.context,
    icon: FileText,
    title: "预览当前上下文构建结果",
  },
  {
    label: "状态",
    path: WANDER_MEMORY_PATHS.status,
    icon: Activity,
    title: "服务健康、端点发现与维护操作",
  },
  {
    label: "API 文档",
    path: WANDER_MEMORY_PATHS.api,
    icon: BookOpen,
    title: "MemOS REST / WS 接口参考",
  },
];

export function WanderMemorySidebar() {
  const location = useLocation();
  const isActive = (item: WanderMemoryItem) =>
    location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);

  return (
    <aside className={s.sidebar} aria-label="Wander 记忆侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§041 · Wander 记忆</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {WANDER_MEMORY_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={s.item}
                data-active={isActive(item) ? "true" : undefined}
                title={item.title}
              >
                <span className={s.itemIcon}><Icon size={16} /></span>
                <span className={s.itemLabel}>{item.label}</span>
                <span className={s.itemPath}>{item.path}</span>
              </Link>
            );
          })}
        </section>
      </div>
    </aside>
  );
}
