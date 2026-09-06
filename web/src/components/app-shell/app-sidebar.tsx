import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { CapabilitySidebar } from "./capability-sidebar";
import { GatewaySidebar } from "./gateway-sidebar";
import { WanderMemorySidebar } from "./wander-memory-sidebar";
import { ExternalMemorySidebar } from "./external-memory-sidebar";
import { AdvancedSidebar } from "./advanced-sidebar";
import { PlaceholderSidebar } from "./placeholder-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "workbench") return <WorkbenchSidebar />;
  if (tab === "skills") return <CapabilitySidebar />;
  if (tab === "gateway") return <GatewaySidebar />;
  if (tab === "wanderMemory") return <WanderMemorySidebar />;
  if (tab === "hermesMemory") return <ExternalMemorySidebar />;
  if (tab === "advanced") return <AdvancedSidebar />;
  return <PlaceholderSidebar tab={tab} />;
}
