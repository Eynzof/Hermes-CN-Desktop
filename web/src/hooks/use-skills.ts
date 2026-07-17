import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  MutationOkResponse,
  SkillContentResponse,
  SkillsHubSearchResponse,
  SkillsResponse,
  type SkillInfo,
} from "@hermes/protocol";

// 给路径追加 ?profile=（管理范围 scope）。override 为空时不动 URL，行为与历史一致。
function scopedPath(path: string, override?: string | null): string {
  if (!override) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}profile=${encodeURIComponent(override)}`;
}

// profileOverride 不传（默认）= 活跃档案，行为与历史完全一致（聊天/面板等沿用）。
// 技能页传入「管理范围」即可就地查看/编辑任意档案的技能，不切换 dashboard。
export function useSkills(profileOverride?: string | null) {
  const active = useActiveProfileName();
  const eff = profileOverride || active;
  return useQuery<SkillInfo[]>({
    queryKey: ["skills", eff],
    queryFn: ({ signal }) =>
      fetchJSON(scopedPath("/api/skills", profileOverride), { signal }, SkillsResponse),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useToggleSkill(profileOverride?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; enabled: boolean }) =>
      putJSON(
        "/api/skills/toggle",
        profileOverride ? { ...vars, profile: profileOverride } : vars,
        MutationOkResponse,
      ),
    // 失效所有档案的 skills query（含 scoped 与活跃），两边都会重新拉。
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}


export interface SkillsHubSearchInput {
  q: string;
  source?: string;
  limit?: number;
  profile?: string;
}

// 技能 hub 搜索（profile builder 的「从 hub 添加」）。按需触发，故用 mutation。
export function useSkillsHubSearch() {
  return useMutation<SkillsHubSearchResponse, Error, SkillsHubSearchInput>({
    mutationFn: ({ q, source = "all", limit = 20, profile }) => {
      const params = new URLSearchParams({ q, source, limit: String(limit) });
      if (profile) params.set("profile", profile);
      return fetchJSON(
        `/api/skills/hub/search?${params.toString()}`,
        undefined,
        SkillsHubSearchResponse,
      );
    },
  });
}

export function useSkillMarkdown(
  name: string | null | undefined,
  profileOverride?: string | null,
) {
  const active = useActiveProfileName();
  const eff = profileOverride || active;
  return useQuery({
    queryKey: ["skill-markdown", eff, name],
    queryFn: ({ signal }) => {
      if (!name) throw new Error("缺少 Skill 名称");
      const path = scopedPath(
        `/api/skills/content?name=${encodeURIComponent(name)}`,
        profileOverride,
      );
      return fetchJSON(path, { signal }, SkillContentResponse);
    },
    enabled: Boolean(name),
    staleTime: 30_000,
  });
}
