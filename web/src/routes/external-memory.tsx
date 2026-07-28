import { Database } from "lucide-react";
import { MemoryBackendsPanel } from "@/components/memory/memory-backends-panel";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import s from "./external-memory.module.css";

export function ExternalMemoryRoute() {
  return (
    <SectionShell title="外置记忆" sub="OpenViking / Hindsight">
      <SettingsHero
        icon={<Database size={24} />}
        eyebrow="Hermes Agent 外置记忆"
        title="连接与监控外置记忆"
        description="为当前档案配置 OpenViking 或 Hindsight，检测运行状态，并在确认在线后选择唯一启用的外置记忆后端。"
      />
      <div className={s.externalMemoryPage}>
        <MemoryBackendsPanel />
      </div>
    </SectionShell>
  );
}
