/**
 * Platform toolset configuration parity with `hermes_cli/tools_config.py`.
 *
 * These helpers read and write `platform_toolsets.<platform>` plus the
 * `agent.disabled_toolsets` global override, `known_*` maps, and `custom_toolsets`.
 *
 * During migration the YAML authority lives in Rust; these functions operate on
 * a plain JS object so they can be driven by either a Rust IPC read or a local
 * cached config object.
 */

import type { CustomToolset, ToolConfigLike } from "./types.js";

export const PLATFORMS = [
  "cli",
  "cron",
  "api-server",
  "telegram",
  "discord",
  "desktop",
  "webhook",
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Composite toolsets that expand into configurable keys. */
const COMPOSITE_TO_LEAVES: Record<string, string[]> = {
  hermes_cli: ["core", "file", "terminal", "web", "memory", "skills"],
  hermes_discord: ["core", "memory", "skills"],
  hermes_telegram: ["core", "memory", "skills"],
  coding: ["core", "file", "terminal", "code_execution", "skills"],
};

/** Toolsets disabled by default (user must opt-in). */
const DEFAULT_OFF_TOOLSETS = new Set([
  "browser",
  "computer_use",
  "homeassistant",
  "x_search",
  "spotify",
  "video",
  "image_gen",
  "kanban",
]);

/** Platform restrictions: these toolsets are ignored on the listed platforms. */
const TOOLSET_PLATFORM_RESTRICTIONS: Record<string, string[]> = {
  cron: ["browser", "computer_use", "terminal", "code_execution"],
  "api-server": ["desktop_ui", "project"],
  telegram: ["desktop_ui", "project"],
  discord: ["desktop_ui", "project"],
};

/** Configurable toolsets shown in the TUI / React management page. */
export const CONFIGURABLE_TOOLSETS: Record<string, { label: string; emoji: string }> = {
  hermes_cli: { label: "Hermes CLI 默认", emoji: "🖥️" },
  coding: { label: "编程姿态", emoji: "💻" },
  web: { label: "网页搜索", emoji: "🌐" },
  browser: { label: "浏览器自动化", emoji: "🧭" },
  code_execution: { label: "代码执行", emoji: "⚡" },
  memory: { label: "内置记忆", emoji: "🧠" },
  skills: { label: "技能调用", emoji: "✨" },
  desktop_ui: { label: "桌面 UI", emoji: "🖱️" },
  project: { label: "项目空间", emoji: "📁" },
  kanban: { label: "看板多智能体", emoji: "🗂️" },
  homeassistant: { label: "Home Assistant", emoji: "🏠" },
  x_search: { label: "X 搜索", emoji: "𝕏" },
  spotify: { label: "Spotify", emoji: "🎵" },
  image_gen: { label: "图像生成", emoji: "🖼️" },
  video: { label: "视频生成", emoji: "🎬" },
  tts: { label: "语音合成", emoji: "🔊" },
  stt: { label: "语音识别", emoji: "🎙️" },
};

export interface PlatformToolsResult {
  platform: string;
  enabled: string[];
  disabled: string[];
  knownPluginToolsets: Record<string, string[]>;
  knownBuiltinToolsets: Record<string, string[]>;
}

/** Resolve the effective enabled toolset keys for a platform. */
export function getPlatformTools(
  config: ToolConfigLike,
  platform: string,
  opts?: {
    /** Auto-enable credential-gated toolsets when keys are present (live probe later). */
    autoEnableCredentials?: boolean;
    /** Optional env map for credential detection. */
    env?: Record<string, string | undefined>;
    /** GUI session surfaces desktop_ui + project. */
    isGuiSession?: boolean;
  },
): PlatformToolsResult {
  const env = opts?.env ?? (typeof process !== "undefined" ? process.env : {});
  const raw = config.platform_toolsets?.[platform] ?? [];

  // Start from raw list; recover non-configurable ones.
  const enabled = new Set<string>(raw);

  // Expand composites and add leaf toolsets so the UI can toggle them.
  for (const key of Array.from(enabled)) {
    const leaves = COMPOSITE_TO_LEAVES[key];
    if (leaves) {
      for (const leaf of leaves) enabled.add(leaf);
    }
  }

  // Apply default-off removals.
  for (const off of DEFAULT_OFF_TOOLSETS) {
    // Keep if user explicitly listed it or a composite that includes it was listed.
    const explicit = raw.some((k) => k === off || COMPOSITE_TO_LEAVES[k]?.includes(off));
    if (!explicit) enabled.delete(off);
  }

  // Platform restrictions.
  for (const restricted of TOOLSET_PLATFORM_RESTRICTIONS[platform] ?? []) {
    enabled.delete(restricted);
  }

  // Credential auto-enable (best-effort, without running async probes).
  if (opts?.autoEnableCredentials) {
    if (hasEnv(env, "XAI_API_KEY", "X_API_BEARER_TOKEN")) enabled.add("x_search");
    if (hasEnv(env, "HOME_ASSISTANT_TOKEN", "HASS_TOKEN")) enabled.add("homeassistant");
    if (hasEnv(env, "SPOTIFY_CLIENT_ID")) enabled.add("spotify");
  }

  // GUI session surfaces desktop_ui + project.
  if (opts?.isGuiSession && platform === "cli") {
    enabled.add("desktop_ui");
    enabled.add("project");
  }

  // Global override applied last.
  const disabled = new Set<string>(config.agent?.disabled_toolsets ?? []);
  for (const d of disabled) enabled.delete(d);

  return {
    platform,
    enabled: Array.from(enabled).sort(),
    disabled: Array.from(disabled).sort(),
    knownPluginToolsets: config.known_plugin_toolsets ?? {},
    knownBuiltinToolsets: config.known_builtin_toolsets ?? {},
  };
}

/** Persist platform toolsets back into a config object (non-mutating helper). */
export function savePlatformTools(
  config: ToolConfigLike,
  platform: string,
  enabled: string[],
): ToolConfigLike {
  const next: ToolConfigLike = {
    ...config,
    platform_toolsets: { ...(config.platform_toolsets ?? {}) },
  };
  next.platform_toolsets![platform] = Array.from(new Set(enabled)).sort();
  return next;
}

/** Enable/disable helpers used by slash commands. */
export function enableToolset(config: ToolConfigLike, platform: string, name: string): ToolConfigLike {
  const current = getPlatformTools(config, platform);
  if (current.enabled.includes(name)) return config;
  return savePlatformTools(config, platform, [...current.enabled, name]);
}

export function disableToolset(
  config: ToolConfigLike,
  platform: string,
  name: string,
): ToolConfigLike {
  const current = getPlatformTools(config, platform);
  if (!current.enabled.includes(name)) return config;
  return savePlatformTools(
    config,
    platform,
    current.enabled.filter((n) => n !== name),
  );
}

/** Merge a custom toolset definition into config. */
export function upsertCustomToolset(
  config: ToolConfigLike,
  def: CustomToolset,
): ToolConfigLike {
  const next: ToolConfigLike = {
    ...config,
    custom_toolsets: { ...(config.custom_toolsets ?? {}) },
  };
  next.custom_toolsets![def.name] = {
    name: def.name,
    tools: def.tools,
    includes: def.includes,
    description: def.description,
  };
  return next;
}

/** Remove a custom toolset definition. */
export function deleteCustomToolset(
  config: ToolConfigLike,
  name: string,
): ToolConfigLike {
  const next: ToolConfigLike = {
    ...config,
    custom_toolsets: { ...(config.custom_toolsets ?? {}) },
  };
  delete next.custom_toolsets![name];
  return next;
}

function hasEnv(env: Record<string, string | undefined>, ...keys: string[]): boolean {
  return keys.some((k) => typeof env[k] === "string" && env[k]!.length > 0);
}
