export const HERMES_TOOLS_MCP_ALLOWLIST = [
  "web_search",
  "web_extract",
  "browser_navigate",
  "browser_snapshot",
  "vision_analyze",
  "image_generate",
  "skill_view",
  "skills_list",
  "text_to_speech",
];

export function isHermesToolsMcpTool(name: string): boolean {
  return HERMES_TOOLS_MCP_ALLOWLIST.includes(name);
}
