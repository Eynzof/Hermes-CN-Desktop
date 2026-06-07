import { z } from "zod";

const NullableStringAsEmpty = z.string().nullable().optional().transform((value) => value ?? "");

function stringifyMessageContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Status (/api/status) ──────────────────────────────────────────────

export const PlatformStatus = z.object({
  state: z.string(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type PlatformStatus = z.infer<typeof PlatformStatus>;

export const StatusResponse = z.object({
  version: z.string(),
  release_date: z.string(),
  hermes_home: z.string().optional(),
  config_path: z.string().optional(),
  env_path: z.string().optional(),
  config_version: z.number().optional(),
  latest_config_version: z.number().optional(),
  gateway_running: z.boolean(),
  gateway_pid: z.number().nullable(),
  gateway_health_url: z.string().nullable(),
  gateway_state: NullableStringAsEmpty,
  gateway_platforms: z.record(z.string(), PlatformStatus).optional(),
  gateway_exit_reason: z.string().nullable(),
  gateway_updated_at: z.string().nullable(),
  active_sessions: z.number(),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

// ── Messaging platforms (/api/messaging/platforms) ────────────────────

export const MessagingEnvVarInfo = z
  .object({
    key: z.string(),
    required: z.boolean().optional().default(false),
    is_set: z.boolean().optional().default(false),
    redacted_value: z.string().nullable().optional(),
    prompt: z.string().optional().default(""),
    description: z.string().optional().default(""),
    advanced: z.boolean().optional().default(false),
    is_password: z.boolean().optional().default(false),
    url: z.string().nullable().optional(),
  })
  .passthrough();
export type MessagingEnvVarInfo = z.infer<typeof MessagingEnvVarInfo>;

export const MessagingHomeChannel = z
  .object({
    chat_id: z.string(),
    name: z.string(),
    platform: z.string(),
    thread_id: z.string().optional(),
  })
  .passthrough();
export type MessagingHomeChannel = z.infer<typeof MessagingHomeChannel>;

export const MessagingPlatformInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional().default(""),
    docs_url: z.string().optional().default(""),
    enabled: z.boolean().optional().default(false),
    configured: z.boolean().optional().default(false),
    gateway_running: z.boolean().optional().default(false),
    state: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    home_channel: MessagingHomeChannel.nullable().optional(),
    env_vars: z.array(MessagingEnvVarInfo).optional().default([]),
  })
  .passthrough();
export type MessagingPlatformInfo = z.infer<typeof MessagingPlatformInfo>;

export const MessagingPlatformsResponse = z
  .object({
    platforms: z.array(MessagingPlatformInfo),
  })
  .passthrough();
export type MessagingPlatformsResponse = z.infer<typeof MessagingPlatformsResponse>;

export const MessagingPlatformTestResponse = z
  .object({
    ok: z.boolean(),
    message: z.string(),
    state: z.string().nullable().optional(),
  })
  .passthrough();
export type MessagingPlatformTestResponse = z.infer<typeof MessagingPlatformTestResponse>;

// ── Sessions (/api/sessions) ──────────────────────────────────────────

export const SessionSummary = z.object({
  id: z.string(),
  source: z.string().optional(),
  user_id: z.string().nullable().optional(),
  model: NullableStringAsEmpty,
  title: z.string().nullable(),
  preview: z.string().optional(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  end_reason: z.string().nullable().optional(),
  message_count: z.number(),
  tool_call_count: z.number().optional(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable().optional(),
  is_active: z.boolean().optional(),
  api_call_count: z.number().optional(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const HermesImageSource = z.union([
  z.string(),
  z
    .object({
      url: z.string().optional(),
      src: z.string().optional(),
      path: z.string().optional(),
      data: z.string().optional(),
      image_url: z.unknown().optional(),
      imageUrl: z.unknown().optional(),
      alt: z.string().optional(),
      title: z.string().optional(),
      name: z.string().optional(),
      filename: z.string().optional(),
      file_name: z.string().optional(),
      mimeType: z.string().optional(),
      mime_type: z.string().optional(),
      mediaType: z.string().optional(),
      contentType: z.string().optional(),
      content_type: z.string().optional(),
      is_image: z.boolean().optional(),
    })
    .passthrough(),
]);
export type HermesImageSource = z.infer<typeof HermesImageSource>;

const MessageContent = z.unknown().transform(stringifyMessageContent);

export const SessionDetail = SessionSummary.extend({
  last_active: z.number().optional(),
}).passthrough();
export type SessionDetail = z.infer<typeof SessionDetail>;

export const SessionsResponse = z.object({
  sessions: z.array(SessionSummary),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type SessionsResponse = z.infer<typeof SessionsResponse>;

export const SessionMessage = z.object({
  id: z.number(),
  session_id: z.string(),
  // role was a strict enum, but Hermes-side integrations (e.g. the
  // Feishu bridge) write extra marker roles like "session_meta" into
  // the persisted session log. A strict enum rejected the whole
  // response on the first unknown row, so a 23-message Feishu session
  // showed "暂无对话记录" in our UI while hermes-desktop loaded it
  // fine. Keep this loose so any future role doesn't blank the
  // history; the renderer (legacySessionMessageToHermesUIMessage)
  // returns null for roles it doesn't know how to draw, which drops
  // those rows cleanly without crashing the parse.
  role: z.string(),
  content: MessageContent,
  images: z.array(HermesImageSource).optional(),
  tool_call_id: z.string().nullable(),
  tool_calls: z.any().nullable(),
  tool_name: z.string().nullable(),
  timestamp: z.number(),
  token_count: z.number().nullable(),
  finish_reason: z.string().nullable(),
  reasoning: z.string().nullable(),
  reasoning_details: z.any().nullable(),
  codex_reasoning_items: z.any().nullable(),
  reasoning_content: z.string().nullable(),
});
export type SessionMessage = z.infer<typeof SessionMessage>;

export const HermesMessageUsage = z
  .object({
    tokensInput: z.number().optional(),
    tokensOutput: z.number().optional(),
    tokensPrompt: z.number().optional(),
    tokensCompletion: z.number().optional(),
    tokensTotal: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    apiCalls: z.number().optional(),
    contextUsed: z.number().optional(),
    contextMax: z.number().optional(),
    contextPercent: z.number().optional(),
  })
  .passthrough();
export type HermesMessageUsage = z.infer<typeof HermesMessageUsage>;

export const HermesMessageTiming = z
  .object({
    startedAt: z.number().optional(),
    firstTokenAt: z.number().optional(),
    completedAt: z.number().optional(),
    ttftMs: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough();
export type HermesMessageTiming = z.infer<typeof HermesMessageTiming>;

export const HermesMessageMetadata = z
  .object({
    usage: HermesMessageUsage.optional(),
    timing: HermesMessageTiming.optional(),
    model: z.string().optional(),
    finishReason: z.string().optional(),
    costUsd: z.number().nullable().optional(),
    costStatus: z.string().optional(),
    persistedId: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
export type HermesMessageMetadata = z.infer<typeof HermesMessageMetadata>;

const HermesTextMessagePart = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const HermesReasoningMessagePart = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
});

const HermesProgressMessagePart = z.object({
  type: z.literal("progress"),
  text: z.string(),
});

const HermesImageMessagePart = z
  .object({
    type: z.literal("image"),
    url: z.string().optional(),
    src: z.string().optional(),
    path: z.string().optional(),
    data: z.string().optional(),
    image_url: z.unknown().optional(),
    imageUrl: z.unknown().optional(),
    alt: z.string().optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    filename: z.string().optional(),
    file_name: z.string().optional(),
    mimeType: z.string().optional(),
    mime_type: z.string().optional(),
    mediaType: z.string().optional(),
    contentType: z.string().optional(),
    content_type: z.string().optional(),
    is_image: z.boolean().optional(),
  })
  .passthrough();

const HermesToolMessagePart = z
  .object({
    type: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    state: z.enum(["running", "done", "error"]),
    input: z.unknown().optional(),
    preview: z.string().optional(),
    output: z.unknown().optional(),
    errorText: z.string().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
  })
  .passthrough();

const HermesNoticeMessagePart = z.object({
  type: z.literal("notice"),
  level: z.enum(["info", "warning", "error", "system"]),
  text: z.string(),
});

export const HermesMessagePart = z.discriminatedUnion("type", [
  HermesTextMessagePart,
  HermesReasoningMessagePart,
  HermesProgressMessagePart,
  HermesImageMessagePart,
  HermesToolMessagePart,
  HermesNoticeMessagePart,
]);
export type HermesMessagePart = z.infer<typeof HermesMessagePart>;

export const HermesUIMessage = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    createdAt: z.number(),
    status: z.enum(["streaming", "complete", "error"]),
    parts: z.array(HermesMessagePart),
    metadata: HermesMessageMetadata.optional(),
  })
  .passthrough();
export type HermesUIMessage = z.infer<typeof HermesUIMessage>;

export const MessagesResponse = z.object({
  session_id: z.string(),
  messages: z.array(SessionMessage).default([]),
  ui_messages: z.array(HermesUIMessage).optional(),
});
export type MessagesResponse = z.infer<typeof MessagesResponse>;

export const SearchResult = z.object({
  session_id: z.string(),
  snippet: z.string().optional(),
  role: z.string().optional(),
  source: z.string().optional(),
  model: z.string().optional(),
  session_started: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResponse = z.object({
  results: z.array(SearchResult),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ── Config (/api/config, /api/config/schema) ──────────────────────────

export const ConfigResponse = z.record(z.unknown());
export type ConfigResponse = z.infer<typeof ConfigResponse>;

export const ConfigUpdateRequest = z.object({
  config: z.record(z.unknown()),
});
export type ConfigUpdateRequest = z.infer<typeof ConfigUpdateRequest>;

export const MutationOkResponse = z.object({
  ok: z.boolean().optional(),
}).passthrough();
export type MutationOkResponse = z.infer<typeof MutationOkResponse>;

export const ConfigSchemaField = z.object({
  type: z.string(),
  description: z.string(),
  category: z.string(),
  options: z.array(z.string()).optional(),
});
export type ConfigSchemaField = z.infer<typeof ConfigSchemaField>;

export const ConfigSchemaResponse = z.object({
  fields: z.record(z.string(), ConfigSchemaField),
  category_order: z.array(z.string()),
});
export type ConfigSchemaResponse = z.infer<typeof ConfigSchemaResponse>;

export const ModelInfo = z.object({
  model: z.string(),
  provider: z.string(),
  auto_context_length: z.number().optional(),
  config_context_length: z.number().optional(),
  effective_context_length: z.number(),
  capabilities: z.any().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ProviderModelsResponse = z.object({
  object: z.string().optional(),
  data: z.array(z.object({
    id: z.string(),
    object: z.string().optional(),
    owned_by: z.string().optional(),
    created: z.number().optional(),
  })).default([]),
});
export type ProviderModelsResponse = z.infer<typeof ProviderModelsResponse>;

// ── Environment Variables (/api/env) ──────────────────────────────────

export const EnvVarInfo = z.object({
  is_set: z.boolean(),
  redacted_value: z.string().nullable(),
  description: z.string(),
  url: z.string().nullable(),
  category: z.string(),
  is_password: z.boolean(),
  tools: z.array(z.string()),
  advanced: z.boolean(),
});
export type EnvVarInfo = z.infer<typeof EnvVarInfo>;

export const EnvVarsResponse = z.record(EnvVarInfo);
export type EnvVarsResponse = z.infer<typeof EnvVarsResponse>;

export const RevealEnvResponse = z.object({
  value: z.string(),
});
export type RevealEnvResponse = z.infer<typeof RevealEnvResponse>;

// ── Skills (/api/skills) ──────────────────────────────────────────────

export const SkillInfo = z.object({
  name: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  enabled: z.boolean(),
  origin: z.enum(["builtin", "user", "external"]).optional(),
  source_path: z.string().optional(),
  skill_file: z.string().optional(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

export const SkillsResponse = z.array(SkillInfo);
export type SkillsResponse = z.infer<typeof SkillsResponse>;

// ── Toolsets (/api/tools/toolsets) ────────────────────────────────────

export const ToolsetInfo = z.object({
  name: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  tools: z.array(z.any()).optional(),
});
export type ToolsetInfo = z.infer<typeof ToolsetInfo>;

// ── MCP Servers (/api/mcp-servers) ────────────────────────────────────

export const McpServerInfo = z.object({
  name: z.string(),
  enabled: z.boolean(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

export const McpServersResponse = z.object({
  summary: z.object({
    total: z.number(),
    enabled: z.number(),
  }),
  servers: z.array(McpServerInfo),
});
export type McpServersResponse = z.infer<typeof McpServersResponse>;

// ── Analytics (/api/analytics/usage) ──────────────────────────────────

export const AnalyticsTotals = z.object({
  total_input: z.number(),
  total_output: z.number(),
  total_tokens: z.number(),
  total_cache_read: z.number(),
  total_cache_write: z.number(),
  total_reasoning: z.number(),
  total_sessions: z.number(),
  total_api_calls: z.number(),
  avg_tokens_per_session: z.number(),
}).passthrough();
export type AnalyticsTotals = z.infer<typeof AnalyticsTotals>;

export const AnalyticsDay = z.object({
  day: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  reasoning_tokens: z.number(),
  sessions: z.number(),
  api_calls: z.number(),
}).passthrough();
export type AnalyticsDay = z.infer<typeof AnalyticsDay>;

export const AnalyticsModelBreakdown = z.object({
  model: z.string(),
  provider: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  reasoning_tokens: z.number(),
  sessions: z.number(),
  api_calls: z.number(),
}).passthrough();
export type AnalyticsModelBreakdown = z.infer<typeof AnalyticsModelBreakdown>;

export const AnalyticsTopSession = z.object({
  session_id: z.string(),
  title: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  reasoning_tokens: z.number(),
  api_calls: z.number(),
}).passthrough();
export type AnalyticsTopSession = z.infer<typeof AnalyticsTopSession>;

export const AnalyticsResponse = z.object({
  daily: z.array(AnalyticsDay),
  by_model: z.array(AnalyticsModelBreakdown),
  top_sessions: z.array(AnalyticsTopSession),
  totals: AnalyticsTotals,
  comparison: z.object({
    previous_totals: AnalyticsTotals,
  }).passthrough(),
  period_days: z.number(),
  skills: z.object({
    summary: z.object({
      total_skill_loads: z.number(),
      total_skill_edits: z.number(),
      total_skill_actions: z.number(),
      distinct_skills_used: z.number(),
    }).passthrough(),
    top_skills: z.array(z.object({
      skill: z.string(),
      view_count: z.number(),
      manage_count: z.number(),
      total_count: z.number(),
      percentage: z.number(),
      last_used_at: z.number().nullable(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();
export type AnalyticsResponse = z.infer<typeof AnalyticsResponse>;

// ── Cron (/api/cron/jobs) ─────────────────────────────────────────────

export const CronSchedule = z.union([
  z.string(),
  z.object({
    kind: z.string().optional(),
    expr: z.string().optional(),
    display: z.string().optional(),
    value: z.string().optional(),
  }).passthrough(),
]).nullable().optional();
export type CronSchedule = z.infer<typeof CronSchedule>;

export const CronJob = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  schedule: CronSchedule,
  schedule_display: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  script: z.string().nullable().optional(),
  deliver: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
  state: z.string().nullable().optional(),
  last_run: z.number().nullable().optional(),
  next_run: z.number().nullable().optional(),
  last_run_at: z.string().nullable().optional(),
  next_run_at: z.string().nullable().optional(),
  last_status: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  paused_at: z.string().nullable().optional(),
  paused_reason: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  profile: z.string().nullable().optional(),
  profile_name: z.string().nullable().optional(),
  hermes_home: z.string().nullable().optional(),
  is_default_profile: z.boolean().optional(),
}).passthrough();
export type CronJob = z.infer<typeof CronJob>;

export const CronJobsResponse = z.array(CronJob);
export type CronJobsResponse = z.infer<typeof CronJobsResponse>;

export const CronRunStatus = z.enum(["success", "error", "blocked", "silent", "unknown"]);
export type CronRunStatus = z.infer<typeof CronRunStatus>;

export const CronRun = z.object({
  job_id: z.string(),
  profile: z.string(),
  filename: z.string(),
  started_at: z.string(),
  status: CronRunStatus,
  summary: z.string(),
  size_bytes: z.number(),
}).passthrough();
export type CronRun = z.infer<typeof CronRun>;

export const CronRunsResponse = z.object({
  job_id: z.string(),
  profile: z.string(),
  runs: z.array(CronRun),
}).passthrough();
export type CronRunsResponse = z.infer<typeof CronRunsResponse>;

export const CronRunDetail = CronRun.extend({
  content: z.string(),
  truncated: z.boolean(),
}).passthrough();
export type CronRunDetail = z.infer<typeof CronRunDetail>;

// ── Logs (/api/logs) ──────────────────────────────────────────────────

export const LogsResponse = z.object({
  file: z.string(),
  lines: z.array(z.string()),
});
export type LogsResponse = z.infer<typeof LogsResponse>;

// ── OAuth Providers (/api/providers/oauth) ────────────────────────────

export const OAuthProviderStatus = z.object({
  logged_in: z.boolean(),
  source: z.string().optional(),
  source_label: z.string().nullable().optional(),
  token_preview: z.string().nullable().optional(),
  expires_at: z.union([z.string(), z.number()]).nullable().optional(),
  has_refresh_token: z.boolean().optional(),
  last_refresh: z.string().nullable().optional(),
  error: z.string().optional(),
});
export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatus>;

export const OAuthProvider = z.object({
  id: z.string(),
  name: z.string(),
  flow: z.enum(["pkce", "device_code", "external"]).optional(),
  cli_command: z.string().optional(),
  docs_url: z.string().optional(),
  status: OAuthProviderStatus,
});
export type OAuthProvider = z.infer<typeof OAuthProvider>;

export const OAuthProvidersResponse = z.object({
  providers: z.array(OAuthProvider),
});
export type OAuthProvidersResponse = z.infer<typeof OAuthProvidersResponse>;

const OAuthStartResponsePkce = z.object({
  session_id: z.string(),
  flow: z.literal("pkce"),
  auth_url: z.string(),
  expires_in: z.number(),
});

const OAuthStartResponseDeviceCode = z.object({
  session_id: z.string(),
  flow: z.literal("device_code"),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  poll_interval: z.number(),
});

export const OAuthStartResponse = z.discriminatedUnion("flow", [
  OAuthStartResponsePkce,
  OAuthStartResponseDeviceCode,
]);
export type OAuthStartResponse = z.infer<typeof OAuthStartResponse>;

export const OAuthSubmitResponse = z.object({
  ok: z.boolean(),
  status: z.enum(["approved", "error"]),
  message: z.string().optional(),
});
export type OAuthSubmitResponse = z.infer<typeof OAuthSubmitResponse>;

export const OAuthPollResponse = z.object({
  session_id: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired", "error"]),
  error_message: z.string().nullable().optional(),
  expires_at: z.number().nullable().optional(),
});
export type OAuthPollResponse = z.infer<typeof OAuthPollResponse>;

export const OAuthDisconnectResponse = z.object({
  ok: z.boolean(),
  provider: z.string(),
});
export type OAuthDisconnectResponse = z.infer<typeof OAuthDisconnectResponse>;

// ── Dashboard (/api/dashboard/themes) ─────────────────────────────────

export const DashboardTheme = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type DashboardTheme = z.infer<typeof DashboardTheme>;

export const DashboardThemesResponse = z.object({
  themes: z.array(DashboardTheme),
  active: z.string(),
});
export type DashboardThemesResponse = z.infer<typeof DashboardThemesResponse>;

// ── Profile management (/api/profiles, /api/profiles/active) ──────────
// Mix of upstream main endpoints (list/create/delete/rename/SOUL) and
// our [CN-fork] P-008 (active getter/setter). Note: switching active
// profile only writes the sticky default file — the running dashboard
// process stays bound to the profile it started with. Clients must
// prompt the user to restart hermes for the switch to take effect.

export const ProfileSummary = z.object({
  name: z.string(),
  path: z.string(),
  is_default: z.boolean(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  has_env: z.boolean(),
  skill_count: z.number(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const ProfilesListResponse = z.object({
  profiles: z.array(ProfileSummary),
});
export type ProfilesListResponse = z.infer<typeof ProfilesListResponse>;

export const ActiveProfileResponse = z.object({
  name: z.string(),
});
export type ActiveProfileResponse = z.infer<typeof ActiveProfileResponse>;

// SOUL.md（按档案存储的首要身份）— GET /api/profiles/{name}/soul
// content 为档案下 SOUL.md 的原文；exists=false 表示尚未创建（content 为空）。
export const ProfileSoulResponse = z.object({
  content: z.string(),
  exists: z.boolean(),
});
export type ProfileSoulResponse = z.infer<typeof ProfileSoulResponse>;

export const ProfileCreateRequest = z.object({
  name: z.string(),
  clone_from_default: z.boolean().optional(),
});
export type ProfileCreateRequest = z.infer<typeof ProfileCreateRequest>;

export const ProfileRenameRequest = z.object({
  new_name: z.string(),
});
export type ProfileRenameRequest = z.infer<typeof ProfileRenameRequest>;

export const ActiveProfileSetRequest = z.object({
  name: z.string(),
});
export type ActiveProfileSetRequest = z.infer<typeof ActiveProfileSetRequest>;

// ── TUI Gateway JSON-RPC (/api/ws) ────────────────────────────────────

export const SessionCreateResult = z.object({
  session_id: z.string(),
}).passthrough();
export type SessionCreateResult = z.infer<typeof SessionCreateResult>;

export const SessionResumeResult = z.object({
  session_id: z.string(),
  resumed: z.string().optional(),
  message_count: z.number().optional(),
}).passthrough();
export type SessionResumeResult = z.infer<typeof SessionResumeResult>;

export const SessionTitleResult = z.object({
  title: z.string().optional(),
  session_key: z.string().optional(),
}).passthrough();
export type SessionTitleResult = z.infer<typeof SessionTitleResult>;

export const PromptSubmitParams = z.object({
  session_id: z.string(),
  text: z.string(),
  images: z.array(z.string()).optional(),
});
export type PromptSubmitParams = z.infer<typeof PromptSubmitParams>;

export const SlashCompletionItem = z.object({
  text: z.string(),
  display: z.string().optional(),
  meta: z.string().optional(),
}).passthrough();
export type SlashCompletionItem = z.infer<typeof SlashCompletionItem>;

export const SlashCompletionResult = z.object({
  items: z.array(SlashCompletionItem).default([]),
  replace_from: z.number().optional(),
}).passthrough();
export type SlashCompletionResult = z.infer<typeof SlashCompletionResult>;

export const CommandDispatchResult = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  name: z.string().optional(),
  output: z.string().optional(),
  target: z.string().optional(),
}).passthrough();
export type CommandDispatchResult = z.infer<typeof CommandDispatchResult>;

export const SessionUsageResult = z.object({
  model: z.string().optional(),
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  prompt: z.number().optional(),
  completion: z.number().optional(),
  total: z.number().optional(),
  calls: z.number().optional(),
  context_used: z.number().optional(),
  context_max: z.number().optional(),
  context_percent: z.number().optional(),
  compressions: z.number().optional(),
  cost_usd: z.number().optional(),
  cost_status: z.string().optional(),
}).passthrough();
export type SessionUsageResult = z.infer<typeof SessionUsageResult>;

export const GatewayModelProvider = z.object({
  slug: z.string(),
  name: z.string().optional(),
  models: z.array(z.string()).optional(),
  total_models: z.number().optional(),
  is_current: z.boolean().optional(),
  is_user_defined: z.boolean().optional(),
  source: z.string().optional(),
  warning: z.string().optional(),
}).passthrough();
export type GatewayModelProvider = z.infer<typeof GatewayModelProvider>;

export const ModelOptionsResult = z.object({
  providers: z.array(GatewayModelProvider),
  model: z.string().optional(),
  provider: z.string().optional(),
}).passthrough();
export type ModelOptionsResult = z.infer<typeof ModelOptionsResult>;

export const ProviderProbeResult = z.object({
  ok: z.boolean(),
  latency_ms: z.number(),
  model_count: z.number(),
  sample_models: z.array(z.string()),
  status_code: z.number().nullable(),
  error: z.string().nullable(),
  error_kind: z.enum(["auth", "timeout", "http", "network", "unknown"]).nullable(),
}).passthrough();
export type ProviderProbeResult = z.infer<typeof ProviderProbeResult>;

export const ConfigSetResult = z.object({
  key: z.string().optional(),
  value: z.string().optional(),
  warning: z.string().optional(),
}).passthrough();
export type ConfigSetResult = z.infer<typeof ConfigSetResult>;

export const ImageAttachResult = z.object({
  attached: z.boolean().optional(),
  path: z.string().optional(),
  count: z.number().optional(),
  text: z.string().optional(),
  remainder: z.string().optional(),
  name: z.string().optional(),
}).passthrough();
export type ImageAttachResult = z.infer<typeof ImageAttachResult>;

export const AttachmentUploadResult = z.object({
  ok: z.boolean().optional(),
  filename: z.string(),
  path: z.string(),
  size: z.number(),
  mime_type: z.string().optional(),
}).passthrough();
export type AttachmentUploadResult = z.infer<typeof AttachmentUploadResult>;

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  is_dir: z.boolean(),
});
export type FsEntry = z.infer<typeof FsEntry>;

export const FsListResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  home: z.string(),
  entries: z.array(FsEntry).default([]),
}).passthrough();
export type FsListResponse = z.infer<typeof FsListResponse>;

export const InputDetectDropResult = z.object({
  matched: z.boolean(),
  is_image: z.boolean().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  count: z.number().optional(),
  text: z.string().optional(),
}).passthrough();
export type InputDetectDropResult = z.infer<typeof InputDetectDropResult>;

export const ApprovalRespondParams = z.object({
  session_id: z.string(),
  request_id: z.string(),
  choice: z.enum(["approve", "deny"]),
});
export type ApprovalRespondParams = z.infer<typeof ApprovalRespondParams>;

export const GatewayMessageUsage = z
  .object({
    model: z.string().optional(),
    input: z.number().optional(),
    output: z.number().optional(),
    prompt: z.number().optional(),
    completion: z.number().optional(),
    total: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
    calls: z.number().optional(),
    context_used: z.number().optional(),
    context_max: z.number().optional(),
    context_percent: z.number().optional(),
    cost_usd: z.number().nullable().optional(),
    cost_status: z.string().optional(),
    finish_reason: z.string().optional(),
  })
  .passthrough();

export type GatewayMessageUsageT = z.infer<typeof GatewayMessageUsage>;

const GatewayTextPayload = z.object({
  text: z.string().optional(),
  rendered: z.string().optional(),
}).passthrough();

export const GatewayKnownEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("gateway.ready"),
    session_id: z.string().optional(),
    payload: z.object({ skin: z.unknown().optional() }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("session.info"),
    session_id: z.string(),
    payload: z.record(z.unknown()).optional(),
  }).passthrough(),
  z.object({
    type: z.literal("message.start"),
    session_id: z.string(),
    payload: z.unknown().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("message.delta"),
    session_id: z.string(),
    payload: GatewayTextPayload.optional(),
  }).passthrough(),
  z.object({
    type: z.literal("message.complete"),
    session_id: z.string(),
    payload: z.object({
      text: z.string().optional(),
      rendered: z.string().optional(),
      reasoning: z.string().optional(),
      usage: GatewayMessageUsage.optional(),
      status: z.string().optional(),
      warning: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("thinking.delta"),
    session_id: z.string(),
    payload: GatewayTextPayload.optional(),
  }).passthrough(),
  z.object({
    type: z.literal("reasoning.delta"),
    session_id: z.string(),
    payload: GatewayTextPayload.optional(),
  }).passthrough(),
  z.object({
    type: z.literal("reasoning.available"),
    session_id: z.string(),
    payload: GatewayTextPayload.optional(),
  }).passthrough(),
  z.object({
    type: z.literal("status.update"),
    session_id: z.string().optional(),
    payload: z.object({
      kind: z.string().optional(),
      text: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("tool.start"),
    session_id: z.string(),
    payload: z.object({
      tool_id: z.string().optional(),
      name: z.string(),
      context: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("tool.progress"),
    session_id: z.string(),
    payload: z.object({
      tool_id: z.string().optional(),
      name: z.string().optional(),
      preview: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("tool.complete"),
    session_id: z.string(),
    payload: z.object({
      tool_id: z.string().optional(),
      name: z.string().optional(),
      summary: z.string().optional(),
      error: z.string().optional(),
      duration_s: z.number().optional(),
      inline_diff: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("approval.request"),
    session_id: z.string(),
    payload: z.object({
      request_id: z.string().optional(),
      command: z.string().optional(),
      description: z.string().optional(),
      reason: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("error"),
    session_id: z.string().optional(),
    payload: z.object({
      message: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough(),
]);
export type GatewayKnownEvent = z.infer<typeof GatewayKnownEvent>;

export const RawGatewayEvent = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  payload: z.unknown().optional(),
}).passthrough();
export type RawGatewayEvent = z.infer<typeof RawGatewayEvent>;

export type GatewayEvent = GatewayKnownEvent | RawGatewayEvent;

export function parseGatewayEvent(value: unknown): GatewayEvent {
  const known = GatewayKnownEvent.safeParse(value);
  if (known.success) return known.data;
  return RawGatewayEvent.parse(value);
}
