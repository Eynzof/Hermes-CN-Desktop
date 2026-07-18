import { useMutation } from "@tanstack/react-query";
import type { UiInstallUpdateResult, UiUpdateCheckResult } from "@hermes/protocol";

// UI 热更通道（轨道 B）。与内核更新不同：安装/回滚只换 webview 加载的
// 前端 bundle，不碰 dashboard 子进程 —— Rust 侧成功后会直接把主窗口导航到
// 新 bundle（hermesui:// 协议），所以这里不需要遮罩/断连处理。注意：导航
// 发生时当前页面即被替换，mutation 的 onSuccess 可能来不及展示。

export function useCheckUiUpdate() {
  return useMutation<UiUpdateCheckResult>({
    mutationFn: () => window.hermesDesktop!.checkUiUpdate!(),
  });
}

export function useInstallUiUpdate() {
  return useMutation<UiInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.installUiUpdate!(),
  });
}

export function useRollbackUiUpdate() {
  return useMutation<UiInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.rollbackUiUpdate!(),
  });
}

export function hasUiUpdateBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.hermesDesktop?.checkUiUpdate);
}
