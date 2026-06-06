import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { fetchJSON, postJSON } from "@/lib/transport";
import type {
  ImOnboardingApplyInput,
  ImOnboardingApplyResult,
  ImOnboardingBeginInput,
  ImOnboardingBeginResult,
  ImOnboardingPollInput,
  ImOnboardingPollResult,
  ImOnboardingStateResult,
  ImPlatform,
  MessagingPlatformInfo,
  MessagingPlatformTestResponse as MessagingPlatformTestResponseType,
} from "@hermes/protocol";
import {
  MessagingPlatformTestResponse,
  MessagingPlatformsResponse,
} from "@hermes/protocol";

function requireDesktop() {
  const api = window.hermesDesktop;
  if (!api?.imOnboardingState || !api.imOnboardingBegin || !api.imOnboardingPoll || !api.imOnboardingApply) {
    throw new Error("当前运行环境不支持桌面端 IM 接入命令，请在 Tauri 桌面端中使用。");
  }
  return api;
}

export function useImOnboardingState(platform: ImPlatform) {
  const profile = useActiveProfileName();
  return useQuery<ImOnboardingStateResult>({
    queryKey: ["im-onboarding", platform, profile],
    queryFn: () => requireDesktop().imOnboardingState!({ platform }),
    enabled: typeof window !== "undefined" && Boolean(window.hermesDesktop?.imOnboardingState),
    staleTime: 10_000,
  });
}

export function useBeginImOnboarding() {
  return useMutation<ImOnboardingBeginResult, Error, ImOnboardingBeginInput>({
    mutationFn: (input) => requireDesktop().imOnboardingBegin!(input),
  });
}

export function usePollImOnboarding() {
  return useMutation<ImOnboardingPollResult, Error, ImOnboardingPollInput>({
    mutationFn: (input) => requireDesktop().imOnboardingPoll!(input),
  });
}

export function useApplyImOnboarding(platform: ImPlatform) {
  const qc = useQueryClient();
  return useMutation<ImOnboardingApplyResult, Error, ImOnboardingApplyInput>({
    mutationFn: (input) => requireDesktop().imOnboardingApply!(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["im-onboarding", platform] });
      qc.invalidateQueries({ queryKey: ["messaging-platform", platform] });
      qc.invalidateQueries({ queryKey: ["messaging-platforms"] });
      qc.invalidateQueries({ queryKey: ["env"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

export function useMessagingPlatform(platform: ImPlatform) {
  const profile = useActiveProfileName();
  return useQuery<MessagingPlatformInfo | null>({
    queryKey: ["messaging-platform", platform, profile],
    queryFn: async () => {
      try {
        const result = await fetchJSON("/api/messaging/platforms", undefined, MessagingPlatformsResponse);
        return result.platforms.find((item) => item.id === platform) ?? null;
      } catch {
        // 旧版 runtime 可能还没有官方消息平台接口。接入向导仍然可以用
        // /api/status 和桌面端扫码命令完成主流程，所以这里降级为 null。
        return null;
      }
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useTestMessagingPlatform(platform: ImPlatform) {
  const qc = useQueryClient();
  return useMutation<MessagingPlatformTestResponseType, Error, void>({
    mutationFn: async () => {
      try {
        return await postJSON(
          `/api/messaging/platforms/${encodeURIComponent(platform)}/test`,
          {},
          MessagingPlatformTestResponse,
        );
      } catch (error) {
        return MessagingPlatformTestResponse.parse({
          ok: false,
          state: null,
          message: `当前运行时暂不能执行官方检测：${messageFromError(error)}`,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messaging-platform", platform] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
