import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteJSON, fetchJSON, postJSON, putJSON } from "@/lib/transport";
import { runtime } from "@/lib/runtime";
import { reloadUiStore } from "@/lib/ui-store";
import { activeProfileAtom, profileSwitchingAtom } from "@/stores/ui";
import {
  ActiveProfileResponse,
  MutationOkResponse,
  ProfileCreateRequest,
  ProfileSummary,
  ProfilesListResponse,
} from "@hermes/protocol";

export function useProfiles() {
  return useQuery<ProfileSummary[]>({
    queryKey: ["profiles"],
    queryFn: async () => {
      const r = await fetchJSON("/api/profiles", undefined, ProfilesListResponse);
      return r.profiles;
    },
    // Profile list 不会经常变（用户主动 create/delete 后我们 invalidate），
    // 拉一次缓存 30 秒避免每次面板渲染都打一次后端
    staleTime: 30_000,
  });
}

export function useActiveProfile() {
  return useQuery<string>({
    queryKey: ["profile-active"],
    queryFn: async () => {
      const r = await fetchJSON(
        "/api/profiles/active",
        undefined,
        ActiveProfileResponse,
      );
      return r.name;
    },
    staleTime: 30_000,
  });
}

export function useActiveProfileName(): string {
  return useAtomValue(activeProfileAtom);
}

// Bootstrap: 首次拉到后端 sticky default 后，把 atom 同步过去。
// atom 默认 "default"，只有在 atom 还是 "default" 而后端是别的时才覆盖；
// 用户主动切过的 profile（已写入 UI SQLite）不会被清。
//
// 桌面端启动时主进程已经把 currentProfile 通过 --hermes-current-profile
// arg 推到 __HERMES_RUNTIME__ 里——直接读它就够了，不需要走后端 query
// （而且桌面端的 dashboard 进程绑定的就是这个 profile，绕开 query 减少
// 一次启动 RTT）。Web 模式下走 query 路径。
export function useBootstrapActiveProfile() {
  const setActive = useSetAtom(activeProfileAtom);
  const current = useAtomValue(activeProfileAtom);
  const electronProfile = runtime.getCurrentProfile();
  const query = useActiveProfile();
  useEffect(() => {
    if (electronProfile && current === "default" && electronProfile !== "default") {
      setActive(electronProfile);
      return;
    }
    if (!query.data) return;
    if (current === "default" && query.data !== "default") {
      setActive(query.data);
    }
  }, [electronProfile, query.data, current, setActive]);
}

// 切 profile 时需要 invalidate 的 query keys——和下面在 hook 里加 profileId
// 的清单保持一致。改这里时记得同步改 use-config / use-env / use-skills /
// use-mcp-servers / use-sessions / use-cron / use-analytics。
export const PROFILE_AWARE_QUERY_KEYS = [
  "config",
  "model-info",
  "env",
  "skills",
  "mcp-servers",
  "status",
  "sessions",
  "session",
  "session-messages",
  "sessions-search",
  "cron-jobs",
  "analytics",
  "im-onboarding",
] as const;

// Mutation result distinguishes the two switching strategies for callers
// that want to render different UI (e.g. show restart hint vs. don't):
// - electron-restart: desktop main process owned the dashboard, killed +
//   respawned it with the new HERMES_HOME, switch is *live*. Renderer just
//   needs to invalidate caches and reconnect WS.
// - web-sticky: web mode (or desktop dev mode where dashboard is external),
//   only sticky was written. Caller should prompt user to restart hermes
//   manually.
export type SwitchProfileMode = "electron-restart" | "web-sticky";
export interface SwitchProfileMutationResult {
  mode: SwitchProfileMode;
  profileName: string;
}

export function useSetActiveProfile() {
  const qc = useQueryClient();
  const setActive = useSetAtom(activeProfileAtom);
  const setSwitching = useSetAtom(profileSwitchingAtom);
  return useMutation<SwitchProfileMutationResult, Error, string>({
    mutationFn: async (name: string) => {
      // Prefer the desktop IPC path when available — it actually restarts
      // the dashboard subprocess so the switch takes effect immediately.
      if (window.hermesDesktop?.switchProfile) {
        // 主进程会 stop+spawn dashboard，期间所有 REST/WS 请求都会失败。
        // 标记 switching=true 让全局 overlay 罩住 UI，避免用户在断网状态下
        // 看到一堆 401/network error。
        setSwitching({ active: true, targetName: name });
        try {
          const result = await window.hermesDesktop.switchProfile({ name });
          if (result.ok) {
            runtime.applySwitchProfileResult(result);
            return { mode: "electron-restart", profileName: name };
          }
          // recoveredPreviousProfile=true means dashboard rolled back, the
          // switch failed cleanly (config invalid, etc.). Surface as error.
          throw new Error(result.error || "切换失败");
        } finally {
          setSwitching({ active: false });
        }
      }
      // Web / dev fallback: write sticky default and let the user restart.
      await putJSON("/api/profiles/active", { name }, MutationOkResponse);
      return { mode: "web-sticky", profileName: name };
    },
    onSuccess: async (_result, name) => {
      await reloadUiStore();
      // 1) 同步 atom：所有 queryKey 含 profileId 的 hook 会自动以新 key 抓数据
      setActive(name);
      // 2) sticky 字段本身刷新
      qc.invalidateQueries({ queryKey: ["profile-active"] });
      // 3) profile-aware 业务 query 全部失效
      //    Electron 模式下 dashboard 已重启，refetch 真的会拿到新 profile 的
      //    数据；web 模式下 dashboard 仍绑旧 profile，refetch 拉到的还是旧值
      //    （但 cache key 已切换，重启 dashboard 后页面 reload 即生效）。
      for (const key of PROFILE_AWARE_QUERY_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileCreateRequest) =>
      postJSON("/api/profiles", body, MutationOkResponse),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      deleteJSON(
        `/api/profiles/${encodeURIComponent(name)}`,
        undefined,
        MutationOkResponse,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}
