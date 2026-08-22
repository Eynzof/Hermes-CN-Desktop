export const ACP_TOOLSET = [
  "read_file",
  "write_file",
  "patch",
  "search_files",
  "terminal",
  "process",
  "execute_code",
  "todo",
  "memory",
  "session_search",
  "skill_view",
  "skills_list",
  "skill_manage",
  "web_search",
  "web_extract",
  "browser_navigate",
  "browser_snapshot",
  "vision_analyze",
  "image_generate",
  "text_to_speech",
] as const;

export function isAcpTool(name: string): boolean {
  return (ACP_TOOLSET as readonly string[]).includes(name);
}
