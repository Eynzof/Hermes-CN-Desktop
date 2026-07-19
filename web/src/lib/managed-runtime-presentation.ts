import type {
  ManagedRuntimeDesiredState,
  ManagedRuntimeLifecycleState,
} from "@hermes/protocol";

const LIFECYCLE_LABELS: Record<ManagedRuntimeLifecycleState, string> = {
  running: "运行中",
  stopped: "已停止",
  uninstalled: "未安装",
  installing: "安装中",
  starting: "启动中",
  stopping: "停止中",
  uninstalling: "卸载中",
  error: "异常",
};

export interface ManagedRuntimePresentationInput {
  installed: boolean;
  running: boolean;
  attached: boolean;
  lifecycleState: ManagedRuntimeLifecycleState;
  desiredState: ManagedRuntimeDesiredState;
}

export interface ManagedRuntimePresentation {
  lifecycleState: ManagedRuntimeLifecycleState;
  statusLabel: string;
  unavailable: boolean;
  explicitlyUninstalled: boolean;
  installLabel: "安装内核" | "重新安装内核";
  showInstall: boolean;
  showStart: boolean;
  showStop: boolean;
  showSwitch: boolean;
  showReinstall: boolean;
  showUninstall: boolean;
}

export function resolveManagedRuntimePresentation(
  input: ManagedRuntimePresentationInput,
): ManagedRuntimePresentation {
  const unavailable = !input.installed || input.lifecycleState === "uninstalled";
  const explicitlyUninstalled = unavailable && input.desiredState === "uninstalled";
  const lifecycleState = unavailable
    ? "uninstalled"
    : input.running
      ? "running"
      : input.lifecycleState;
  const available = input.installed && !unavailable;

  return {
    lifecycleState,
    statusLabel: explicitlyUninstalled
      ? "已卸载"
      : LIFECYCLE_LABELS[lifecycleState],
    unavailable,
    explicitlyUninstalled,
    installLabel: explicitlyUninstalled ? "重新安装内核" : "安装内核",
    showInstall: unavailable,
    showStart: available && !input.running && !input.attached,
    showStop: available && input.running && !input.attached,
    showSwitch: available && input.attached,
    showReinstall: available,
    showUninstall: available,
  };
}
