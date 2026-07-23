import type { ConnectionMode, DesktopBuildFlavor } from "@hermes/protocol";

export interface DesktopBuildPolicy {
  defaultConnectionMode: ConnectionMode;
  showManagedRuntime: boolean;
  showKernelSettings: boolean;
  showDesktopUpdates: boolean;
}

export function desktopBuildPolicy(flavor: DesktopBuildFlavor): DesktopBuildPolicy {
  const standard = flavor === "standard";
  return {
    defaultConnectionMode: standard ? "managed" : "local",
    showManagedRuntime: standard,
    showKernelSettings: standard,
    showDesktopUpdates: standard,
  };
}
