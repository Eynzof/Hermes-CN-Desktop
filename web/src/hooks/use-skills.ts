import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { MutationOkResponse, SkillsResponse, type SkillInfo } from "@hermes/protocol";

export function useSkills() {
  const profile = useActiveProfileName();
  return useQuery<SkillInfo[]>({
    queryKey: ["skills", profile],
    queryFn: ({ signal }) => fetchJSON("/api/skills", { signal }, SkillsResponse),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useToggleSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; enabled: boolean }) =>
      putJSON("/api/skills/toggle", vars, MutationOkResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}


export function useSkillMarkdown(name: string | null | undefined) {
  const profile = useActiveProfileName();
  return useQuery({
    queryKey: ["skill-markdown", profile, name],
    queryFn: async () => {
      const readSkillMarkdown = window.hermesDesktop?.readSkillMarkdown;
      if (!readSkillMarkdown) {
        throw new Error("当前运行环境不支持读取 SKILL.md");
      }
      if (!name) throw new Error("缺少 Skill 名称");
      return readSkillMarkdown({ name });
    },
    enabled: Boolean(name && window.hermesDesktop?.readSkillMarkdown),
    staleTime: 30_000,
  });
}
