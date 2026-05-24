import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveProfileName } from "@/hooks/use-profiles";
import type {
  ImOnboardingApplyInput,
  ImOnboardingApplyResult,
  ImOnboardingBeginInput,
  ImOnboardingBeginResult,
  ImOnboardingPollInput,
  ImOnboardingPollResult,
  ImOnboardingStateResult,
  ImPlatform,
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
      qc.invalidateQueries({ queryKey: ["env"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
