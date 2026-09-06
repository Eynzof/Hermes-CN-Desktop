import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, postJSON, putJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  MutationOkResponse,
  SkillContentResponse,
  SkillWriteResponse,
  SkillsHubSearchResponse,
  SkillsResponse,
  type SkillInfo,
} from "@hermes/protocol";

export interface CopyBuiltinSkillInput {
  sourceName: string;
  name: string;
  category?: string | null;
}

export function replaceSkillFrontmatterName(content: string, name: string): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom ? content.slice(1) : content;
  if (!source.startsWith("---")) {
    throw new Error("源 Skill 缺少 YAML frontmatter");
  }
  const closing = source.slice(3).match(/\r?\n---(?:\r?\n|$)/);
  if (!closing || closing.index === undefined) {
    throw new Error("源 Skill 的 YAML frontmatter 未闭合");
  }
  const frontmatterEnd = 3 + closing.index;
  const frontmatter = source.slice(0, frontmatterEnd);
  if (!/^\s*name\s*:/m.test(frontmatter)) {
    throw new Error("源 Skill 的 frontmatter 缺少 name 字段");
  }
  const renamed = frontmatter.replace(/^([ \t]*name[ \t]*:).*$/m, `$1 ${name}`);
  return `${bom}${renamed}${source.slice(frontmatterEnd)}`;
}

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

export function useCopyBuiltinSkill(profileOverride?: string | null) {
  const qc = useQueryClient();
  const active = useActiveProfileName();
  const effectiveProfile = profileOverride || active;
  return useMutation({
    mutationFn: async ({ sourceName, name, category }: CopyBuiltinSkillInput) => {
      const source = await fetchJSON(
        scopedPath(`/api/skills/content?name=${encodeURIComponent(sourceName)}`, profileOverride),
        undefined,
        SkillContentResponse,
      );
      return postJSON(
        "/api/skills",
        {
          name,
          content: replaceSkillFrontmatterName(source.content, name),
          category: category || undefined,
          profile: profileOverride || undefined,
        },
        SkillWriteResponse,
      );
    },
    onSuccess: (_result, input) => Promise.all([
      qc.invalidateQueries({ queryKey: ["skills", effectiveProfile] }),
      qc.invalidateQueries({ queryKey: ["skill-markdown", effectiveProfile, input.name] }),
    ]),
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
