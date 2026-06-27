import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteJSON,
  fetchJSON,
  patchJSON,
  postJSON,
  putJSON,
} from "@/lib/transport";
import { runtime } from "@/lib/runtime";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { reloadUiStore } from "@/lib/ui-store";
import {
  activeProfileAtom,
  managementProfileAtom,
  profileSwitchingAtom,
} from "@/stores/ui";
import {
  ActiveProfileResponse,
  MutationOkResponse,
  ProfileCreateRequest,
  ProfileCreateResponse,
  ProfileDescribeAutoResponse,
  ProfileDescriptionUpdateResponse,
  ProfileModelUpdateResponse,
  ProfileSetupCommandResponse,
  ProfileSoulResponse,
  ProfileSummary,
  ProfilesListResponse,
} from "@hermes/protocol";

export function useProfiles() {
  return useQuery<ProfileSummary[]>({
    queryKey: ["profiles"],
    queryFn: async ({ signal }) => {
      const r = await fetchJSON("/api/profiles", { signal }, ProfilesListResponse);
      return r.profiles;
    },
    // Profile list 不会经常变（用户主动 create/delete 后我们 invalidate），
    // 拉一次缓存 30 秒避免每次面板渲染都打一次后端
    staleTime: 30_000,
  });
}

// active = sticky 默认（~/.hermes/active_profile）；current = 运行中 dashboard
// 实际绑定的档案。桌面端切换会自动重启 dashboard，二者一致；web/attached 模式
// 下 active 已改而 current 仍是旧档案，UI 据此显示「需重启」提示横幅。
export interface ActiveProfile {
  active: string;
  current: string;
}

export function useActiveProfile() {
  return useQuery<ActiveProfile>({
    queryKey: ["profile-active"],
    queryFn: ({ signal }) =>
      fetchJSON("/api/profiles/active", { signal }, ActiveProfileResponse),
    staleTime: 30_000,
  });
}

export function useActiveProfileName(): string {
  return useAtomValue(activeProfileAtom);
}

// 「管理范围」：null = 跟随活跃档案。见 managementProfileAtom 的说明。
export function useManagementProfile(): string | null {
  return useAtomValue(managementProfileAtom);
}

export function useSetManagementProfile() {
  return useSetAtom(managementProfileAtom);
}

// 当前应被 scoped 数据（如技能页）使用的档案名：有管理范围时用它，否则用活跃档案。
export function useScopedProfileName(): string {
  const mgmt = useAtomValue(managementProfileAtom);
  const active = useAtomValue(activeProfileAtom);
  return mgmt ?? active;
}

// Bootstrap: 首次拉到后端 sticky default 后，把 atom 同步过去。
// atom 默认 "default"，只有在 atom 还是 "default" 而后端是别的时才覆盖；
// 用户主动切过的 profile（已写入 UI SQLite）不会被清。
//
// 桌面端启动时主进程已经把 currentProfile 通过 --hermes-current-profile
// arg 推到 __HERMES_RUNTIME__ 里——直接读它就够了，不需要走后端 query
// （而且桌面端的 dashboard 进程绑定的就是这个 profile，绕开 query 减少
// 一次启动 RTT）。Web 模式下走 query 路径。

export interface BootstrapDecision {
  /** 要把 atom 设成的 profile 名；null 表示保持不变。 */
  next: string | null;
  /** 本次是否已完成首次同步——调用方据此置 ref，之后不再覆盖。 */
  hydrated: boolean;
}

// 纯函数（导出供测试）：决定引导期「一次性 hydration」的目标。
//
// 关键点：这是 *一次性* 引导。`useActiveProfile`（/api/profiles/active，staleTime 30s）
// 在切换瞬间会短暂返回旧 profile；老逻辑每次 atom 变化都重跑，于是用户从其他档案切回
// default 时，刚 setActive("default") 又被过期的 query 值改回旧档案（#189/#195 根因）。
// 一旦 alreadyHydrated 为 true，这里一律返回 next=null——绝不回退用户的主动切换。
export function resolveBootstrapProfile(input: {
  alreadyHydrated: boolean;
  current: string;
  electronProfile: string | undefined;
  queryData: string | undefined;
  forceElectronProfile?: boolean;
}): BootstrapDecision {
  const { alreadyHydrated, current, electronProfile, queryData, forceElectronProfile = false } = input;
  // 首次同步完成后，运行期的 profile 切换由 useSetActiveProfile 全权负责。
  if (alreadyHydrated) return { next: null, hydrated: true };
  // 桌面端：主进程已同步把权威 profile 推进 __HERMES_RUNTIME__，启动即可得。
  if (electronProfile) {
    const next =
      forceElectronProfile && current !== electronProfile
        ? electronProfile
        : current === "default" && electronProfile !== "default"
          ? electronProfile
          : null;
    return { next, hydrated: true };
  }
  // Web：等后端 sticky 到达再决定；未到达则先不标记 hydrated，待下次重试。
  if (queryData === undefined) return { next: null, hydrated: false };
  const next = current === "default" && queryData !== "default" ? queryData : null;
  return { next, hydrated: true };
}

export function useBootstrapActiveProfile() {
  const setActive = useSetAtom(activeProfileAtom);
  const current = useAtomValue(activeProfileAtom);
  const electronProfile = runtime.getCurrentProfile();
  const forceElectronProfile = runtime.isAttached();
  const query = useActiveProfile();
  const hydratedRef = useRef(false);
  useEffect(() => {
    const decision = resolveBootstrapProfile({
      alreadyHydrated: hydratedRef.current,
      current,
      electronProfile,
      queryData: query.data?.active,
      forceElectronProfile,
    });
    if (decision.hydrated) hydratedRef.current = true;
    if (decision.next !== null) setActive(decision.next);
  }, [electronProfile, forceElectronProfile, query.data?.active, current, setActive]);
}

// 切 profile 时需要 invalidate 的 query keys——和下面在 hook 里加 profileId
// 的清单保持一致。改这里时记得同步改 use-config / use-soul / use-env /
// use-skills / use-mcp-servers / use-sessions / use-cron / use-analytics。
export const PROFILE_AWARE_QUERY_KEYS = [
  "config",
  "model-info",
  "soul",
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
  const setManagement = useSetAtom(managementProfileAtom);
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
            forceExistingGatewayReconnect("profile-switch");
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
      // 上游路由是 POST /api/profiles/active（旧代码误用 PUT 会 405）。
      await postJSON("/api/profiles/active", { name }, MutationOkResponse);
      return { mode: "web-sticky", profileName: name };
    },
    onSuccess: async (_result, name) => {
      await reloadUiStore();
      // 1) 同步 atom：所有 queryKey 含 profileId 的 hook 会自动以新 key 抓数据
      setActive(name);
      // 切换活跃档案后，旧的「管理范围」失去意义——清空，回到跟随活跃档案。
      setManagement(null);
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
  return useMutation<ProfileCreateResponse, Error, ProfileCreateRequest>({
    mutationFn: (body: ProfileCreateRequest) =>
      postJSON("/api/profiles", body, ProfileCreateResponse),
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

// 以下编辑型 endpoint 都把 profile 名放在 URL path 里（/api/profiles/{name}/...），
// 对任意档案生效、无需切换 dashboard——所以「管理页」能就地编辑非当前档案。

const profilePath = (name: string, suffix = "") =>
  `/api/profiles/${encodeURIComponent(name)}${suffix}`;

export interface RenameProfileInput {
  name: string;
  newName: string;
}

export function useRenameProfile() {
  const qc = useQueryClient();
  return useMutation<MutationOkResponse, Error, RenameProfileInput>({
    mutationFn: ({ name, newName }) =>
      patchJSON(profilePath(name), { new_name: newName }, MutationOkResponse),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      // 重命名当前 sticky 档案时后端会同步改 active_profile。
      qc.invalidateQueries({ queryKey: ["profile-active"] });
    },
  });
}

export interface SetProfileModelInput {
  name: string;
  provider: string;
  model: string;
}

export function useSetProfileModel() {
  const qc = useQueryClient();
  return useMutation<ProfileModelUpdateResponse, Error, SetProfileModelInput>({
    mutationFn: ({ name, provider, model }) =>
      putJSON(
        profilePath(name, "/model"),
        { provider, model },
        ProfileModelUpdateResponse,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
      // 改的若是当前档案，model 概览页也要刷新。
      qc.invalidateQueries({ queryKey: ["model-info"] });
    },
  });
}

export interface UpdateProfileDescriptionInput {
  name: string;
  description: string;
}

export function useUpdateProfileDescription() {
  const qc = useQueryClient();
  return useMutation<
    ProfileDescriptionUpdateResponse,
    Error,
    UpdateProfileDescriptionInput
  >({
    mutationFn: ({ name, description }) =>
      putJSON(
        profilePath(name, "/description"),
        { description },
        ProfileDescriptionUpdateResponse,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

export interface DescribeProfileAutoInput {
  name: string;
  overwrite?: boolean;
}

export function useDescribeProfileAuto() {
  const qc = useQueryClient();
  return useMutation<ProfileDescribeAutoResponse, Error, DescribeProfileAutoInput>({
    mutationFn: ({ name, overwrite = true }) =>
      postJSON(
        profilePath(name, "/describe-auto"),
        { overwrite },
        ProfileDescribeAutoResponse,
      ),
    onSuccess: (result) => {
      // 仅生成成功才写库；失败时（ok:false）描述未变，无需失效。
      if (result.ok) qc.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}

// SOUL.md 内容按需拉取（编辑器打开时才 enabled），避免每张卡片预取。
export function useProfileSoul(name: string | null) {
  return useQuery<ProfileSoulResponse>({
    queryKey: ["profile-soul", name],
    queryFn: ({ signal }) =>
      fetchJSON(profilePath(name as string, "/soul"), { signal }, ProfileSoulResponse),
    enabled: Boolean(name),
    staleTime: 0,
  });
}

export interface UpdateProfileSoulInput {
  name: string;
  content: string;
}

export function useUpdateProfileSoul() {
  const qc = useQueryClient();
  return useMutation<MutationOkResponse, Error, UpdateProfileSoulInput>({
    mutationFn: ({ name, content }) =>
      putJSON(profilePath(name, "/soul"), { content }, MutationOkResponse),
    onSuccess: (_result, { name }) => {
      qc.invalidateQueries({ queryKey: ["profile-soul", name] });
      // 改的若是当前档案，SOUL 页也要刷新。
      qc.invalidateQueries({ queryKey: ["soul"] });
    },
  });
}

// 「复制 CLI 命令」按需取一次（点击时），不进 query 缓存。
export function useProfileSetupCommand() {
  return useMutation<string, Error, string>({
    mutationFn: async (name: string) => {
      const r = await fetchJSON(
        profilePath(name, "/setup-command"),
        undefined,
        ProfileSetupCommandResponse,
      );
      return r.command;
    },
  });
}
