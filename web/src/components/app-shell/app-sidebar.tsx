import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { CapabilitySidebar } from "./capability-sidebar";
import { GatewaySidebar } from "./gateway-sidebar";
import { AdvancedSidebar } from "./advanced-sidebar";
import { PlaceholderSidebar } from "./placeholder-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "workbench") return <WorkbenchSidebar />;
  if (tab === "skills") return <CapabilitySidebar />;
  if (tab === "gateway") return <GatewaySidebar />;
  if (tab === "advanced") return <AdvancedSidebar />;
  return <PlaceholderSidebar tab={tab} />;
}
