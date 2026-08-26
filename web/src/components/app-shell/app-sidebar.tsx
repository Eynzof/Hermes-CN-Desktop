import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { CapabilitySidebar } from "./capability-sidebar";
import { GatewaySidebar } from "./gateway-sidebar";
// Wander 记忆窗口暂不可用（MemOS/WanderMemory 服务未接入），禁用侧栏入口。
// import { WanderMemorySidebar } from "./wander-memory-sidebar";
import { ExternalMemorySidebar } from "./external-memory-sidebar";
import { AdvancedSidebar } from "./advanced-sidebar";
import { PlaceholderSidebar } from "./placeholder-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "workbench") return <WorkbenchSidebar />;
  if (tab === "skills") return <CapabilitySidebar />;
  if (tab === "gateway") return <GatewaySidebar />;
  // Wander 记忆窗口已禁用（见 use-active-top-tab.ts / app.tsx）。
  // if (tab === "wanderMemory") return <WanderMemorySidebar />;
  if (tab === "hermesMemory") return <ExternalMemorySidebar />;
  if (tab === "advanced") return <AdvancedSidebar />;
  return <PlaceholderSidebar tab={tab} />;
}
