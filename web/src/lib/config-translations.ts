/**
 * 配置项（/advanced/config）的中文翻译表。
 *
 * 后端 `/api/config/schema` 返回的 `description` 是上游英文：约 20 个字段在内核
 * `_SCHEMA_OVERRIDES` 里有手写英文，其余字段由内核用 key 自动 Title-Case 生成
 * （如 `agent.max_turns` → `Agent → Max Turns`）。这里在 UI 层按字段 key（dot-path）
 * 叠一层中文展示，未命中时回退到后端给的英文（与 `skill-translations.ts` 同思路）。
 *
 * `configFieldTranslations` 覆盖标签页可见的全部分类 + 常见的搜索分类；
 * `auxiliary.*`（56 个槽位字段）走 `translateConfigField` 里的规则化拼接，不逐条列。
 * `configOptionTranslations` 只翻译「描述性」枚举值（如 ask/yolo/deny），
 * 品牌/技术枚举（docker、openai、honcho、主题名等）保持原样回退。
 */

/** 配置字段 key（dot-path）→ 中文标签。 */
export const configFieldTranslations: Record<string, string> = {
  // ── general（顶层标量） ───────────────────────────────────────────────
  "model": "默认模型",
  "model_context_length": "上下文窗口覆盖（0 = 自动从模型元数据探测）",
  "command_allowlist": "命令白名单",
  "fallback_providers": "备用提供商（fallback）",
  "file_read_max_chars": "文件读取最大字符数",
  "hooks_auto_accept": "自动接受 Hook",
  "paste_collapse_char_threshold": "粘贴折叠字符阈值",
  "paste_collapse_threshold": "粘贴折叠行数阈值",
  "paste_collapse_threshold_fallback": "粘贴折叠阈值（兜底）",
  "prefill_messages_file": "预填消息文件",
  "timezone": "时区",
  "toolsets": "工具集",

  // ── agent ─────────────────────────────────────────────────────────────
  "agent.api_max_retries": "API 最大重试次数",
  "agent.clarify_timeout": "澄清提问超时（秒）",
  "agent.disabled_toolsets": "禁用的工具集",
  "agent.environment_hint": "环境提示",
  "agent.environment_probe": "环境探测",
  "agent.gateway_auto_continue_freshness": "Gateway 自动续跑新鲜度（秒）",
  "agent.gateway_notify_interval": "Gateway 通知间隔（秒）",
  "agent.gateway_timeout": "Gateway 超时（秒）",
  "agent.gateway_timeout_warning": "Gateway 超时警告阈值（秒）",
  "agent.image_input_mode": "图片输入模式",
  "agent.max_turns": "单次任务最大轮数",
  "agent.restart_drain_timeout": "重启排空超时（秒）",
  "agent.service_tier": "API 服务层级（OpenAI/Anthropic）",
  "agent.task_completion_guidance": "任务完成引导",
  "agent.tool_use_enforcement": "工具调用强制策略",
  "checkpoints.auto_prune": "检查点自动清理",
  "checkpoints.delete_orphans": "删除孤立检查点",
  "checkpoints.enabled": "启用检查点",
  "checkpoints.max_file_size_mb": "单文件最大大小（MB）",
  "checkpoints.max_snapshots": "最大快照数",
  "checkpoints.max_total_size_mb": "检查点总大小上限（MB）",
  "checkpoints.min_interval_hours": "最小间隔（小时）",
  "checkpoints.retention_days": "保留天数",
  "code_execution.mode": "代码执行模式",
  "context.engine": "上下文管理引擎",
  "cron.max_parallel_jobs": "定时任务最大并行数",
  "cron.wrap_response": "定时任务包装响应",
  "goals.max_turns": "目标模式最大轮数",
  "network.force_ipv4": "强制使用 IPv4",
  "prompt_caching.cache_ttl": "提示缓存 TTL",
  "skills.external_dirs": "Skill 外部目录",
  "skills.guard_agent_created": "守护 Agent 创建的 Skill",
  "skills.inline_shell": "Skill 内联 Shell",
  "skills.inline_shell_timeout": "Skill 内联 Shell 超时（秒）",
  "skills.template_vars": "Skill 模板变量",

  // ── terminal ───────────────────────────────────────────────────────────
  "terminal.auto_source_bashrc": "自动加载 bashrc",
  "terminal.backend": "终端执行后端",
  "terminal.container_cpu": "容器 CPU",
  "terminal.container_disk": "容器磁盘",
  "terminal.container_memory": "容器内存",
  "terminal.container_persistent": "容器持久化",
  "terminal.cwd": "工作目录",
  "terminal.daytona_image": "Daytona 镜像",
  "terminal.docker_extra_args": "Docker 额外参数",
  "terminal.docker_forward_env": "Docker 转发环境变量",
  "terminal.docker_image": "Docker 镜像",
  "terminal.docker_mount_cwd_to_workspace": "Docker 挂载工作目录到 workspace",
  "terminal.docker_run_as_host_user": "Docker 以宿主用户运行",
  "terminal.docker_volumes": "Docker 卷",
  "terminal.env_passthrough": "环境变量透传",
  "terminal.modal_image": "Modal 镜像",
  "terminal.modal_mode": "Modal 沙箱模式",
  "terminal.persistent_shell": "持久化 Shell",
  "terminal.shell_init_files": "Shell 初始化文件",
  "terminal.singularity_image": "Singularity 镜像",
  "terminal.timeout": "终端超时（秒）",

  // ── display（含 dashboard / human_delay） ───────────────────────────────
  "dashboard.oauth.client_id": "仪表盘 OAuth Client ID",
  "dashboard.oauth.portal_url": "仪表盘 OAuth Portal URL",
  "dashboard.public_url": "仪表盘公开 URL",
  "dashboard.show_token_analytics": "显示 Token 分析",
  "dashboard.theme": "网页仪表盘主题",
  "display.bell_on_complete": "完成时响铃",
  "display.busy_input_mode": "运行时输入行为",
  "display.compact": "紧凑显示",
  "display.copy_shortcut": "复制快捷键",
  "display.ephemeral_system_ttl": "临时系统消息存活时长（秒）",
  "display.file_mutation_verifier": "文件改动校验",
  "display.final_response_markdown": "最终响应 Markdown 渲染",
  "display.inline_diffs": "内联 Diff",
  "display.interim_assistant_messages": "显示中间助手消息",
  "display.language": "语言",
  "display.persistent_output": "持久化输出",
  "display.persistent_output_max_lines": "持久化输出最大行数",
  "display.personality": "人格",
  "display.resume_display": "恢复会话历史显示方式",
  "display.resume_exchanges": "恢复会话展示的对话轮数",
  "display.resume_max_assistant_chars": "恢复时助手消息最大字符数",
  "display.resume_max_assistant_lines": "恢复时助手消息最大行数",
  "display.resume_max_user_chars": "恢复时用户消息最大字符数",
  "display.resume_skip_tool_only": "恢复时跳过纯工具消息",
  "display.runtime_footer.enabled": "启用运行时页脚",
  "display.runtime_footer.fields": "运行时页脚字段",
  "display.show_cost": "显示费用",
  "display.show_reasoning": "显示推理过程",
  "display.skin": "CLI 主题皮肤",
  "display.streaming": "流式输出",
  "display.timestamps": "显示时间戳",
  "display.tool_preview_length": "工具预览长度",
  "display.tool_progress_command": "显示工具进度命令",
  "display.tui_auto_resume_recent": "TUI 自动恢复最近会话",
  "display.tui_status_indicator": "TUI 状态指示器",
  "display.user_message_preview.first_lines": "用户消息预览首行数",
  "display.user_message_preview.last_lines": "用户消息预览末行数",
  "human_delay.max_ms": "模拟延迟最大值（毫秒）",
  "human_delay.min_ms": "模拟延迟最小值（毫秒）",
  "human_delay.mode": "模拟打字延迟模式",

  // ── delegation ───────────────────────────────────────────────────────
  "delegation.api_key": "委派 API Key",
  "delegation.api_mode": "委派 API 模式",
  "delegation.base_url": "委派 Base URL",
  "delegation.child_timeout_seconds": "子 Agent 超时（秒）",
  "delegation.inherit_mcp_toolsets": "继承 MCP 工具集",
  "delegation.max_concurrent_children": "最大并发子 Agent 数",
  "delegation.max_iterations": "最大迭代次数",
  "delegation.max_spawn_depth": "最大派生深度",
  "delegation.model": "委派模型",
  "delegation.orchestrator_enabled": "启用编排器",
  "delegation.provider": "委派提供商",
  "delegation.reasoning_effort": "子 Agent 推理强度",
  "delegation.subagent_auto_approve": "子 Agent 自动批准",

  // ── memory ──────────────────────────────────────────────────────────────
  "memory.memory_char_limit": "记忆字符上限",
  "memory.memory_enabled": "启用记忆",
  "memory.provider": "记忆提供方",
  "memory.user_char_limit": "用户画像字符上限",
  "memory.user_profile_enabled": "启用用户画像",

  // ── compression ──────────────────────────────────────────────────────
  "compression.abort_on_summary_failure": "总结失败时中止",
  "compression.enabled": "启用压缩",
  "compression.hygiene_hard_message_limit": "消息硬上限",
  "compression.protect_first_n": "保护开头 N 条消息",
  "compression.protect_last_n": "保护结尾 N 条消息",
  "compression.target_ratio": "目标压缩比",
  "compression.threshold": "压缩触发阈值",

  // ── security（含 approvals / privacy） ─────────────────────────────────
  "approvals.cron_mode": "定时任务审批模式",
  "approvals.destructive_slash_confirm": "危险斜杠命令确认",
  "approvals.mcp_reload_confirm": "MCP 重载确认",
  "approvals.mode": "危险命令审批模式",
  "approvals.timeout": "审批超时（秒）",
  "privacy.redact_pii": "脱敏个人信息（PII）",
  "security.acked_advisories": "已确认的安全公告",
  "security.allow_lazy_installs": "允许惰性安装",
  "security.allow_private_urls": "允许访问私有 URL",
  "security.redact_secrets": "脱敏密钥",
  "security.tirith_enabled": "启用 Tirith",
  "security.tirith_fail_open": "Tirith 失败放行",
  "security.tirith_path": "Tirith 路径",
  "security.tirith_timeout": "Tirith 超时（秒）",
  "security.website_blocklist.domains": "网站黑名单域名",
  "security.website_blocklist.enabled": "启用网站黑名单",
  "security.website_blocklist.shared_files": "网站黑名单共享文件",

  // ── browser ──────────────────────────────────────────────────────────
  "browser.allow_private_urls": "允许访问私有 URL",
  "browser.auto_local_for_private_urls": "私有 URL 自动用本地浏览器",
  "browser.camofox.adopt_existing_tab": "Camofox 复用已有标签页",
  "browser.camofox.loopback_host_alias": "Camofox 回环主机别名",
  "browser.camofox.managed_persistence": "Camofox 托管持久化",
  "browser.camofox.rewrite_loopback_urls": "Camofox 重写回环 URL",
  "browser.camofox.session_key": "Camofox 会话 Key",
  "browser.camofox.user_id": "Camofox 用户 ID",
  "browser.cdp_url": "CDP URL",
  "browser.command_timeout": "浏览器命令超时（秒）",
  "browser.dialog_policy": "对话框处理策略",
  "browser.dialog_timeout_s": "对话框超时（秒）",
  "browser.engine": "浏览器引擎",
  "browser.inactivity_timeout": "闲置超时（秒）",
  "browser.record_sessions": "录制会话",

  // ── voice ──────────────────────────────────────────────────────────────
  "voice.auto_tts": "自动朗读（TTS）",
  "voice.beep_enabled": "启用提示音",
  "voice.max_recording_seconds": "最大录音时长（秒）",
  "voice.record_key": "录音快捷键",
  "voice.silence_duration": "静音判定时长（秒）",
  "voice.silence_threshold": "静音阈值",

  // ── tts ──────────────────────────────────────────────────────────────
  "tts.edge.voice": "Edge 语音",
  "tts.elevenlabs.model_id": "ElevenLabs 模型 ID",
  "tts.elevenlabs.voice_id": "ElevenLabs 语音 ID",
  "tts.mistral.model": "Mistral 模型",
  "tts.mistral.voice_id": "Mistral 语音 ID",
  "tts.neutts.device": "NeuTTS 设备",
  "tts.neutts.model": "NeuTTS 模型",
  "tts.neutts.ref_audio": "NeuTTS 参考音频",
  "tts.neutts.ref_text": "NeuTTS 参考文本",
  "tts.openai.model": "OpenAI 模型",
  "tts.openai.voice": "OpenAI 语音",
  "tts.piper.voice": "Piper 语音",
  "tts.provider": "语音合成（TTS）提供方",
  "tts.xai.bit_rate": "xAI 比特率",
  "tts.xai.language": "xAI 语言",
  "tts.xai.sample_rate": "xAI 采样率",
  "tts.xai.voice_id": "xAI 语音 ID",

  // ── stt ──────────────────────────────────────────────────────────────
  "stt.enabled": "启用语音识别（STT）",
  "stt.local.language": "本地识别语言",
  "stt.local.model": "本地识别模型",
  "stt.mistral.model": "Mistral 识别模型",
  "stt.openai.model": "OpenAI 识别模型",
  "stt.provider": "语音识别（STT）提供方",

  // ── logging ──────────────────────────────────────────────────────────
  "logging.backup_count": "日志备份数量",
  "logging.level": "日志级别",
  "logging.max_size_mb": "单个日志最大大小（MB）",
  "logging.memory_monitor.enabled": "启用内存监控",
  "logging.memory_monitor.interval_seconds": "内存监控间隔（秒）",

  // ── discord（含 telegram） ─────────────────────────────────────────────
  "discord.allow_any_attachment": "允许任意附件",
  "discord.allowed_channels": "允许的频道",
  "discord.auto_thread": "自动创建讨论串",
  "discord.dm_role_auth_guild": "私信角色鉴权服务器",
  "discord.free_response_channels": "自由回复频道",
  "discord.history_backfill": "回填历史消息",
  "discord.history_backfill_limit": "历史回填上限",
  "discord.max_attachment_bytes": "最大附件字节数",
  "discord.reactions": "表情回应",
  "discord.require_mention": "需要 @提及",
  "discord.server_actions": "服务器操作",
  "discord.thread_require_mention": "讨论串需要 @提及",
  "telegram.allowed_chats": "Telegram 允许的会话",
  "telegram.reactions": "Telegram 表情回应",

  // ── 以下分类不在标签页里（仅搜索可达），一并翻译以求完整 ─────────────────
  // bedrock
  "bedrock.discovery.enabled": "Bedrock 模型发现",
  "bedrock.discovery.provider_filter": "Bedrock 提供商过滤",
  "bedrock.discovery.refresh_interval": "Bedrock 发现刷新间隔（秒）",
  "bedrock.guardrail.guardrail_identifier": "Bedrock Guardrail 标识",
  "bedrock.guardrail.guardrail_version": "Bedrock Guardrail 版本",
  "bedrock.guardrail.stream_processing_mode": "Bedrock Guardrail 流式处理模式",
  "bedrock.guardrail.trace": "Bedrock Guardrail 追踪",
  "bedrock.region": "Bedrock 区域",
  // curator
  "curator.archive_after_days": "归档天数",
  "curator.backup.enabled": "启用备份",
  "curator.backup.keep": "备份保留数",
  "curator.enabled": "启用 Curator",
  "curator.interval_hours": "运行间隔（小时）",
  "curator.min_idle_hours": "最小空闲（小时）",
  "curator.stale_after_days": "陈旧天数",
  // gateway
  "gateway.media_delivery_allow_dirs": "媒体投递允许目录",
  "gateway.strict": "严格模式",
  "gateway.trust_recent_files": "信任最近文件",
  "gateway.trust_recent_files_seconds": "信任最近文件时长（秒）",
  // kanban
  "kanban.auto_decompose": "自动分解任务",
  "kanban.auto_decompose_per_tick": "每轮自动分解数",
  "kanban.default_assignee": "默认负责人",
  "kanban.dispatch_in_gateway": "在 Gateway 内派发",
  "kanban.dispatch_interval_seconds": "派发间隔（秒）",
  "kanban.dispatch_stale_timeout_seconds": "派发陈旧超时（秒）",
  "kanban.failure_limit": "失败上限",
  "kanban.max_in_progress_per_profile": "每档案最大进行中任务数",
  "kanban.orchestrator_profile": "编排器档案",
  "kanban.worker_log_backup_count": "Worker 日志备份数",
  "kanban.worker_log_rotate_bytes": "Worker 日志轮转字节数",
  // lsp
  "lsp.enabled": "启用 LSP",
  "lsp.install_strategy": "LSP 安装策略",
  "lsp.wait_mode": "LSP 等待模式",
  "lsp.wait_timeout": "LSP 等待超时（秒）",
  // matrix
  "matrix.allowed_rooms": "Matrix 允许的房间",
  "matrix.free_response_rooms": "Matrix 自由回复房间",
  "matrix.require_mention": "Matrix 需要 @提及",
  // mattermost
  "mattermost.allowed_channels": "Mattermost 允许的频道",
  "mattermost.free_response_channels": "Mattermost 自由回复频道",
  "mattermost.require_mention": "Mattermost 需要 @提及",
  // model_catalog
  "model_catalog.enabled": "启用模型目录",
  "model_catalog.ttl_hours": "模型目录 TTL（小时）",
  "model_catalog.url": "模型目录 URL",
  // openrouter
  "openrouter.min_coding_score": "OpenRouter 最低编码评分",
  "openrouter.response_cache": "OpenRouter 响应缓存",
  "openrouter.response_cache_ttl": "OpenRouter 响应缓存 TTL（秒）",
  // secrets
  "secrets.bitwarden.access_token_env": "Bitwarden Access Token 环境变量",
  "secrets.bitwarden.auto_install": "Bitwarden 自动安装",
  "secrets.bitwarden.cache_ttl_seconds": "Bitwarden 缓存 TTL（秒）",
  "secrets.bitwarden.enabled": "启用 Bitwarden",
  "secrets.bitwarden.override_existing": "覆盖已有变量",
  "secrets.bitwarden.project_id": "Bitwarden 项目 ID",
  "secrets.bitwarden.server_url": "Bitwarden 服务器 URL",
  // sessions
  "sessions.auto_prune": "会话自动清理",
  "sessions.min_interval_hours": "最小清理间隔（小时）",
  "sessions.retention_days": "会话保留天数",
  "sessions.vacuum_after_prune": "清理后压缩数据库",
  "sessions.write_json_snapshots": "写入 JSON 快照",
  // slack
  "slack.allowed_channels": "Slack 允许的频道",
  "slack.free_response_channels": "Slack 自由回复频道",
  "slack.require_mention": "Slack 需要 @提及",
  // tool_loop_guardrails
  "tool_loop_guardrails.hard_stop_after.exact_failure": "硬停止：完全相同失败次数",
  "tool_loop_guardrails.hard_stop_after.idempotent_no_progress": "硬停止：幂等无进展次数",
  "tool_loop_guardrails.hard_stop_after.same_tool_failure": "硬停止：同一工具失败次数",
  "tool_loop_guardrails.hard_stop_enabled": "启用硬停止",
  "tool_loop_guardrails.warn_after.exact_failure": "警告：完全相同失败次数",
  "tool_loop_guardrails.warn_after.idempotent_no_progress": "警告：幂等无进展次数",
  "tool_loop_guardrails.warn_after.same_tool_failure": "警告：同一工具失败次数",
  "tool_loop_guardrails.warnings_enabled": "启用警告",
  // tool_output
  "tool_output.max_bytes": "工具输出最大字节数",
  "tool_output.max_line_length": "工具输出单行最大长度",
  "tool_output.max_lines": "工具输出最大行数",
  // tools
  "tools.tool_search.enabled": "启用工具搜索",
  "tools.tool_search.max_search_limit": "工具搜索最大返回数",
  "tools.tool_search.search_default_limit": "工具搜索默认返回数",
  "tools.tool_search.threshold_pct": "工具搜索阈值（%）",
  // updates
  "updates.backup_keep": "更新备份保留数",
  "updates.pre_update_backup": "更新前备份",
  // web
  "web.backend": "Web 后端",
  "web.extract_backend": "网页抽取后端",
  "web.search_backend": "网页搜索后端",
  // x_search
  "x_search.model": "X 搜索模型",
  "x_search.retries": "X 搜索重试次数",
  "x_search.timeout_seconds": "X 搜索超时（秒）",
};

/** `auxiliary.<task>.<field>` 槽位字段：规则化拼接，不逐条列。 */
const AUXILIARY_TASK_CN: Record<string, string> = {
  vision: "视觉分析",
  compression: "上下文压缩",
  web_extract: "网页抽取",
  title_generation: "标题生成",
  approval: "智能审批",
  mcp: "MCP 路由",
  skills_hub: "Skills Hub",
  triage_specifier: "Kanban 需求扩写",
  kanban_decomposer: "Kanban 任务分解",
  profile_describer: "档案描述生成",
  curator: "Skill 审查",
};

const AUXILIARY_FIELD_CN: Record<string, string> = {
  provider: "提供商",
  model: "模型",
  api_key: "API Key",
  base_url: "Base URL",
  timeout: "调用超时（秒）",
  download_timeout: "图片下载超时（秒）",
  extra_body: "extra_body",
};

/**
 * 「描述性」枚举值的中文显示标签，key = `dotpath::optionValue`。
 * 只翻译能意译的值；品牌 / 技术枚举（docker、ssh、openai、honcho、主题/皮肤名等）
 * 未命中时由 `translateConfigOption` 回退到原值。
 */
export const configOptionTranslations: Record<string, string> = {
  "agent.service_tier::auto": "自动",
  "agent.service_tier::default": "默认",
  "agent.service_tier::flex": "弹性",
  "context.engine::default": "默认",
  "context.engine::custom": "自定义",
  "terminal.backend::local": "本地",
  "terminal.modal_mode::sandbox": "沙箱",
  "terminal.modal_mode::function": "函数",
  "display.busy_input_mode::interrupt": "打断",
  "display.busy_input_mode::queue": "排队",
  "display.busy_input_mode::steer": "引导",
  "display.resume_display::minimal": "精简",
  "display.resume_display::full": "完整",
  "display.resume_display::off": "关闭",
  "display.skin::default": "默认",
  "dashboard.theme::default": "默认",
  "human_delay.mode::off": "关闭",
  "human_delay.mode::typing": "打字",
  "human_delay.mode::fixed": "固定",
  "delegation.reasoning_effort::low": "低",
  "delegation.reasoning_effort::medium": "中",
  "delegation.reasoning_effort::high": "高",
  "memory.provider::builtin": "内置",
  "approvals.mode::ask": "询问",
  "approvals.mode::yolo": "全部放行",
  "approvals.mode::deny": "拒绝",
  "stt.provider::local": "本地",
};

const AUXILIARY_FIELD_RE = /^auxiliary\.([^.]+)\.([^.]+)$/;

/** 取配置字段的中文标签，未命中时回退到后端给的英文 `fallback`。 */
export function translateConfigField(key: string, fallback: string): string {
  const hit = configFieldTranslations[key];
  if (hit) return hit;

  const aux = AUXILIARY_FIELD_RE.exec(key);
  if (aux) {
    const task = AUXILIARY_TASK_CN[aux[1]] ?? aux[1];
    const field = AUXILIARY_FIELD_CN[aux[2]] ?? aux[2];
    return `${task} · ${field}`;
  }

  return fallback;
}

/**
 * 取下拉枚举值的中文显示文本，仅影响展示；保存时仍写回原始枚举值。
 * 未命中时回退到原值，空值显示「(默认)」。
 */
export function translateConfigOption(key: string, option: string): string {
  return configOptionTranslations[`${key}::${option}`] ?? (option || "(默认)");
}
