import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { ProfileSoulResponse, MutationOkResponse } from "@hermes/protocol";

// 后端 CONTEXT_FILE_MAX_CHARS：SOUL.md 超出此长度会在注入系统提示词时被截断
// （是软上限，写入本身不会被拒绝）。
export const SOUL_CHAR_LIMIT = 20_000;

// 中文结构化起始模板，依据上游 personality.md 推荐的四个分节：
// 人格 / 风格 / 避免 / 技术取向。仅在编辑器为空时供用户一键填入。
export const SOUL_TEMPLATE = `# 人格
（你是谁、核心身份与定位）

## 风格
- （如何沟通：语气、直接程度、互动偏好）

## 避免
- （需要刻意规避的表达或行为）

## 技术取向
- （面对问题的方法论与偏好）
`;

// SOUL.md 按档案（profile）存储，端点把档案名放在 URL path 里，
// 因此这里显式带上当前激活档案名（含 "default"，后端可正确解析）。
export function useSoul() {
  const profile = useActiveProfileName();
  return useQuery<ProfileSoulResponse>({
    queryKey: ["soul", profile],
    queryFn: () =>
      fetchJSON(
        `/api/profiles/${encodeURIComponent(profile)}/soul`,
        undefined,
        ProfileSoulResponse,
      ),
  });
}

export function useSaveSoul() {
  const qc = useQueryClient();
  const profile = useActiveProfileName();
  return useMutation({
    mutationFn: (content: string) =>
      putJSON(
        `/api/profiles/${encodeURIComponent(profile)}/soul`,
        { content },
        MutationOkResponse,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["soul", profile] }),
  });
}
