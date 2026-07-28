import { BrainCircuit, Database, SlidersHorizontal } from "lucide-react";
import { MemoryBackendsPanel } from "@/components/memory/memory-backends-panel";
import { MEMORY_BACKEND_META } from "@/components/memory/memory-backend-utils";
import type { VisibleMemoryProvider } from "@/hooks/use-memory";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import s from "./external-memory.module.css";

export interface ExternalMemoryRouteProps {
  page: "config" | VisibleMemoryProvider;
}

const PAGE_COPY = {
  config: {
    title: "外置记忆",
    sub: "配置",
    eyebrow: "Hermes Agent 外置记忆",
    heading: "外置记忆配置",
    description: "查看当前档案启用的记忆后端及总体状态，并进入 OpenViking 或 Hindsight 完成接入配置。",
    icon: SlidersHorizontal,
  },
  openviking: {
    title: "OpenViking",
    sub: "外置记忆 / OpenViking",
    eyebrow: "Hermes Agent 外置记忆",
    heading: "OpenViking 连接与监控",
    description: MEMORY_BACKEND_META.openviking.description,
    icon: Database,
  },
  hindsight: {
    title: "Hindsight",
    sub: "外置记忆 / Hindsight",
    eyebrow: "Hermes Agent 外置记忆",
    heading: "Hindsight 连接与监控",
    description: MEMORY_BACKEND_META.hindsight.description,
    icon: BrainCircuit,
  },
} as const;

export function ExternalMemoryRoute({ page }: ExternalMemoryRouteProps) {
  const copy = PAGE_COPY[page];
  const Icon = copy.icon;
  return (
    <SectionShell title={copy.title} sub={copy.sub}>
      <SettingsHero
        icon={<Icon size={24} />}
        eyebrow={copy.eyebrow}
        title={copy.heading}
        description={copy.description}
      />
      <div className={s.externalMemoryPage}>
        <MemoryBackendsPanel view={page} />
      </div>
    </SectionShell>
  );
}
