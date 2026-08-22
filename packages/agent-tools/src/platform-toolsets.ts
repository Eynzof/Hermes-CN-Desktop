/**
 * Platform toolset catalog parity with Python `toolsets.py` + `hermes_cli/tools_config.py`.
 *
 * Defines `hermes-cli`, `hermes-acp`, `hermes-api-server`, `hermes-cron`,
 * `hermes-webhook`, `hermes-gateway`, and per-messaging-platform bundles.
 */

import type { ToolsetDef } from "./types.js";

const HERMES_CORE_TOOLS = [
  "todo",
  "clarify",
  "complete",
  "think",
  "delegate_task",
  "memory_read",
  "memory_write",
  "memory_search",
  "session_search",
  "file_read",
  "file_write",
  "file_search",
  "file_grep",
  "file_list",
  "terminal_run",
  "terminal_status",
  "process_start",
  "process_stop",
  "web_search",
  "web_extract",
  "web_fetch",
  "skill_invoke",
  "skill_search",
  "execute_code",
  "execute_code_status",
  "cronjob_schedule",
  "cronjob_list",
  "cronjob_cancel",
  "browser_navigate",
  "browser_click",
  "browser_screenshot",
  "computer_click",
  "computer_type",
  "computer_screenshot",
  "ha_call_service",
  "ha_get_state",
  "ha_list_entities",
  "x_search",
  "spotify_play",
  "spotify_pause",
  "spotify_search",
  "image_generate",
  "video_generate",
  "video_edit",
  "tts_speak",
  "stt_transcribe",
];

const HERMES_WEBHOOK_SAFE_TOOLS = ["web_search", "web_extract", "vision_analyze", "clarify"];

export const PLATFORM_TOOLSETS: Record<string, ToolsetDef> = {
  "hermes-cli": {
    description: "Full CLI default bundle",
    tools: [...HERMES_CORE_TOOLS],
    includes: [],
  },
  "hermes-acp": {
    description: "ACP IDE integration bundle",
    tools: HERMES_CORE_TOOLS.filter((t) => !["clarify", "cronjob_schedule", "image_generate", "tts_speak", "computer_click", "ha_call_service"].includes(t)),
    includes: [],
  },
  "hermes-api-server": {
    description: "API server bundle",
    tools: HERMES_CORE_TOOLS.filter((t) => !["clarify", "tts_speak", "computer_click"].includes(t)),
    includes: [],
  },
  "hermes-cron": {
    description: "Cron scheduler bundle",
    tools: [...HERMES_CORE_TOOLS],
    includes: [],
  },
  "hermes-webhook": {
    description: "Webhook safe subset",
    tools: [...HERMES_WEBHOOK_SAFE_TOOLS],
    includes: [],
  },
  "hermes-gateway": {
    description: "Gateway union bundle",
    tools: [],
    includes: [
      "hermes-cli",
      "hermes-telegram",
      "hermes-discord",
      "hermes-slack",
      "hermes-whatsapp",
      "hermes-sms",
      "hermes-signal",
      "hermes-email",
      "hermes-matrix",
      "hermes-mattermost",
      "hermes-irc",
      "hermes-line",
      "hermes-dingtalk",
      "hermes-feishu",
      "hermes-wecom",
      "hermes-webhook",
    ],
  },
  "hermes-telegram": { description: "Telegram platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-whatsapp": { description: "WhatsApp platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-sms": { description: "SMS (Twilio) platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-signal": { description: "Signal platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-bluebubbles": { description: "BlueBubbles platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-homeassistant": { description: "Home Assistant messaging bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-email": { description: "Email platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-mattermost": { description: "Mattermost platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-matrix": { description: "Matrix platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-dingtalk": { description: "DingTalk platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-weixin": { description: "Weixin platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-qqbot": { description: "QQ bot platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-wecom": { description: "WeCom platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-teams": { description: "Microsoft Teams platform bundle", tools: [...HERMES_CORE_TOOLS], includes: [] },
  "hermes-discord": {
    description: "Discord platform bundle",
    tools: [...HERMES_CORE_TOOLS, "discord", "discord_admin"],
    includes: [],
  },
  "hermes-feishu": {
    description: "Feishu / Lark platform bundle",
    tools: [...HERMES_CORE_TOOLS, "feishu_doc_read", "feishu_drive_list", "feishu_drive_upload", "feishu_drive_download", "feishu_drive_share"],
    includes: [],
  },
  "hermes-yuanbao": {
    description: "Tencent Yuanbao platform bundle",
    tools: [...HERMES_CORE_TOOLS, "yb_search", "yb_chat", "yb_image", "yb_video", "yb_doc"],
    includes: [],
  },
};

/** Resolve a platform toolset into the tool names it contains. */
export function resolvePlatformToolset(name: string): Set<string> {
  const def = PLATFORM_TOOLSETS[name];
  if (!def) return new Set<string>();
  const result = new Set<string>(def.tools);
  for (const inc of def.includes) {
    for (const t of resolvePlatformToolset(inc)) result.add(t);
  }
  return result;
}

/** All known platform toolset keys. */
export function getPlatformToolsetNames(): string[] {
  return Object.keys(PLATFORM_TOOLSETS).sort();
}
