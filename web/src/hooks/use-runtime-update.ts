import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type {
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
} from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { runtimeUpdatingAtom } from "@/stores/ui";

const RUNTIME_INFO_KEY = ["desktop-runtime-info"] as const;

function hasRuntimeBridge(): boolean {
  return typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.getRuntimeInfo);
}

async function refreshDesktopGateway(): Promise<void> {
  if (window.hermesDesktop?.refreshGatewayUrl) {
    await runtime.refreshGatewayUrl();
    forceExistingGatewayReconnect("runtime-update");
  }
}

export function useRuntimeInfo() {
  return useQuery<RuntimeInfo>({
    queryKey: RUNTIME_INFO_KEY,
    queryFn: () => window.hermesDesktop!.getRuntimeInfo!(),
    enabled: hasRuntimeBridge(),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useCheckRuntimeUpdate() {
  return useMutation<RuntimeUpdateCheckResult>({
    mutationFn: () => window.hermesDesktop!.checkRuntimeUpdate!(),
  });
}

export function useInstallRuntimeUpdate() {
  const qc = useQueryClient();
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  return useMutation<RuntimeInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.installRuntimeUpdate!(),
    // Raise the blocking overlay before the IPC call so the dashboard restart
    // window (stale token → 401) never surfaces to the user. Keep it up through
    // onSettled until the token has been refreshed.
    onMutate: () => {
      setUpdating({ active: true, mode: "install" });
    },
    onSettled: async () => {
      // Runs on success AND failure — a partial install can still have
      // restarted the dashboard, so always resync the rotated session token.
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
      setUpdating({ active: false });
    },
  });
}

export function useRollbackRuntime() {
  const qc = useQueryClient();
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  return useMutation<RuntimeInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.rollbackRuntime!(),
    onMutate: () => {
      setUpdating({ active: true, mode: "rollback" });
    },
    onSettled: async () => {
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
      setUpdating({ active: false });
    },
  });
}
