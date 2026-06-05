import type { EnvVarInfo } from "@hermes/protocol";

/**
 * 环境变量（/models 页面）的中文展示层。
 *
 * 后端 `/api/env` 返回的 description 来自上游英文元数据。这里和
 * `config-translations.ts` 一样，只在 UI 层按 env key 叠加中文标题和说明；
 * 未命中时保持后端返回，避免新版 runtime 新增变量后无法展示。
 */
export interface EnvVarTranslation {
  label: string;
  description: string;
}

const ENV_CATEGORY_TRANSLATIONS: Record<string, string> = {
  provider: "模型服务商",
  tool: "工具密钥",
  messaging: "消息平台",
  setting: "设置",
  service: "服务",
};

const ENV_VAR_TRANSLATIONS: Record<string, EnvVarTranslation> = {
  // ── 工具密钥：网页搜索 / 抽取 / 云浏览器 ─────────────────────────────
  EXA_API_KEY: {
    label: "Exa 搜索 API Key",
    description: "用于 Exa AI 原生网页搜索和网页内容抽取。",
  },
  PARALLEL_API_KEY: {
    label: "Parallel 搜索 API Key",
    description: "用于 Parallel.ai 网页搜索和内容抽取。",
  },
  FIRECRAWL_API_KEY: {
    label: "Firecrawl API Key",
    description: "用于 Firecrawl 网页搜索、内容抓取和云浏览器后端。",
  },
  TAVILY_API_KEY: {
    label: "Tavily API Key",
    description: "用于 Tavily AI 原生网页搜索、内容抽取和网页抓取。",
  },
  SEARXNG_URL: {
    label: "SearXNG 实例地址",
    description: "自托管或公开 SearXNG 实例 URL，用于免费网页搜索。",
  },
  BRAVE_SEARCH_API_KEY: {
    label: "Brave Search API Key",
    description: "Brave Search 订阅 token，用于网页搜索。",
  },
  BROWSERBASE_API_KEY: {
    label: "Browserbase API Key",
    description: "Browserbase 云浏览器 API Key；使用本地浏览器时可不配置。",
  },
  BROWSERBASE_PROJECT_ID: {
    label: "Browserbase 项目 ID",
    description: "Browserbase 云浏览器项目 ID；仅云浏览器模式需要。",
  },
  BROWSER_USE_API_KEY: {
    label: "Browser Use API Key",
    description: "Browser Use 云浏览器 API Key；使用本地浏览器时可不配置。",
  },
  FIRECRAWL_BROWSER_TTL: {
    label: "Firecrawl 浏览器会话 TTL",
    description: "Firecrawl 浏览器会话存活时间（秒），默认 300。",
  },
  CAMOFOX_URL: {
    label: "Camofox 浏览器服务地址",
    description: "本地反检测浏览器服务 URL，例如 http://localhost:9377。",
  },

  // ── 工具密钥：生成、多模态、记忆与观测 ───────────────────────────────
  FAL_KEY: {
    label: "FAL API Key",
    description: "用于图片和视频生成。",
  },
  KREA_API_KEY: {
    label: "Krea API Key",
    description: "用于 Krea 2 图片生成。",
  },
  VOICE_TOOLS_OPENAI_KEY: {
    label: "语音工具 OpenAI API Key",
    description: "用于 Whisper 语音转写和 OpenAI TTS。",
  },
  ELEVENLABS_API_KEY: {
    label: "ElevenLabs API Key",
    description: "用于高质量文本转语音和 Scribe 语音转写。",
  },
  MISTRAL_API_KEY: {
    label: "Mistral API Key",
    description: "用于 Voxtral TTS 和语音转写。",
  },
  GITHUB_TOKEN: {
    label: "GitHub Token",
    description: "用于 Skill Hub，提高 GitHub API 额度并支持发布 skill。",
  },
  HONCHO_API_KEY: {
    label: "Honcho API Key",
    description: "用于 AI 原生持久记忆。",
  },
  HONCHO_BASE_URL: {
    label: "Honcho 服务地址",
    description: "自托管 Honcho 实例的 Base URL；不一定需要 API Key。",
  },
  HERMES_LANGFUSE_PUBLIC_KEY: {
    label: "Langfuse Public Key",
    description: "Langfuse 项目公钥，通常以 pk-lf- 开头。",
  },
  HERMES_LANGFUSE_SECRET_KEY: {
    label: "Langfuse Secret Key",
    description: "Langfuse 项目密钥，通常以 sk-lf- 开头。",
  },

  // ── 消息平台：飞书 / 微信 ─────────────────────────────────────────────
  FEISHU_DOMAIN: {
    label: "飞书区域",
    description: "选择飞书中国（feishu）或 Lark 国际（lark）。",
  },
  FEISHU_APP_ID: {
    label: "飞书 App ID",
    description: "来自飞书开放平台自建应用的 App ID。",
  },
  FEISHU_APP_SECRET: {
    label: "飞书 App Secret",
    description: "飞书自建应用密钥，仅保存到当前 profile。",
  },
  FEISHU_CONNECTION_MODE: {
    label: "飞书连接模式",
    description: "桌面端推荐 WebSocket；Webhook 模式需要额外回调配置。",
  },
  FEISHU_WEBHOOK_HOST: {
    label: "飞书 Webhook Host",
    description: "Webhook 模式下本地回调服务监听地址。",
  },
  FEISHU_WEBHOOK_PORT: {
    label: "飞书 Webhook Port",
    description: "Webhook 模式下本地 handler 端口。",
  },
  FEISHU_WEBHOOK_PATH: {
    label: "飞书 Webhook Path",
    description: "飞书开放平台事件回调路径。",
  },
  FEISHU_ENCRYPT_KEY: {
    label: "飞书 Encrypt Key",
    description: "飞书事件加密密钥，可留空后续补充。",
  },
  FEISHU_VERIFICATION_TOKEN: {
    label: "飞书 Verification Token",
    description: "飞书事件签名校验 token。",
  },
  FEISHU_ALLOW_ALL_USERS: {
    label: "飞书允许所有私聊",
    description: "是否允许所有飞书用户私聊触发 Agent。",
  },
  FEISHU_ALLOWED_USERS: {
    label: "飞书允许用户",
    description: "允许使用机器人的飞书 open_id 白名单，多个值用英文逗号分隔。",
  },
  FEISHU_GROUP_POLICY: {
    label: "飞书群聊策略",
    description: "控制飞书群聊是否启用以及是否仅 @Hermes 时响应。",
  },
  FEISHU_REQUIRE_MENTION: {
    label: "飞书群聊需 @",
    description: "启用后，群聊里只有 @Hermes 才会响应。",
  },
  FEISHU_HOME_CHANNEL: {
    label: "飞书 Home Channel",
    description: "用于 cron 和跨平台通知的默认飞书频道。",
  },
  WEIXIN_ACCOUNT_ID: {
    label: "微信 iLink 账号 ID",
    description: "扫码成功后自动获取，也可用于恢复已有 iLink bot 配置。",
  },
  WEIXIN_TOKEN: {
    label: "微信 Bot Token",
    description: "iLink bot 认证 token，仅保存到当前 profile。",
  },
  WEIXIN_BASE_URL: {
    label: "微信 iLink API 地址",
    description: "默认 https://ilinkai.weixin.qq.com，通常无需修改。",
  },
  WEIXIN_CDN_BASE_URL: {
    label: "微信 iLink CDN 地址",
    description: "用于媒体加密上传与下载的 CDN Base URL。",
  },
  WEIXIN_DM_POLICY: {
    label: "微信私聊策略",
    description: "控制未知用户私聊时的配对、白名单或开放策略。",
  },
  WEIXIN_ALLOW_ALL_USERS: {
    label: "微信允许所有私聊",
    description: "是否允许所有微信用户私聊触发 Agent。",
  },
  WEIXIN_ALLOWED_USERS: {
    label: "微信允许用户",
    description: "允许使用机器人的微信用户 ID 白名单，多个值用英文逗号分隔。",
  },
  WEIXIN_GROUP_POLICY: {
    label: "微信群聊策略",
    description: "控制 iLink bot 收到群聊事件时如何响应。",
  },
  WEIXIN_GROUP_ALLOWED_USERS: {
    label: "微信允许群聊",
    description: "允许触发机器人的微信群聊 ID 白名单，多个值用英文逗号分隔。",
  },
  WEIXIN_HOME_CHANNEL: {
    label: "微信 Home Channel",
    description: "用于 cron 和通知的默认微信频道，可填扫码返回的 user_id。",
  },

  // ── 消息平台：其他 IM / Webhook ──────────────────────────────────────
  TELEGRAM_BOT_TOKEN: {
    label: "Telegram Bot Token",
    description: "从 @BotFather 获取的 Telegram 机器人 token。",
  },
  TELEGRAM_ALLOWED_USERS: {
    label: "Telegram 允许用户",
    description: "允许使用机器人的 Telegram 用户 ID，多个值用英文逗号分隔。",
  },
  TELEGRAM_PROXY: {
    label: "Telegram 代理地址",
    description: "Telegram 连接代理，会覆盖 HTTPS_PROXY；支持 http、https、socks5。",
  },
  DISCORD_BOT_TOKEN: {
    label: "Discord Bot Token",
    description: "来自 Discord Developer Portal 的机器人 token。",
  },
  DISCORD_ALLOWED_USERS: {
    label: "Discord 允许用户",
    description: "允许使用机器人的 Discord 用户 ID，多个值用英文逗号分隔。",
  },
  DISCORD_ALLOW_ALL_USERS: {
    label: "Discord 允许所有用户",
    description: "是否允许任意 Discord 用户触发机器人，仅建议开发调试时开启。",
  },
  DISCORD_REPLY_TO_MODE: {
    label: "Discord 回复模式",
    description: "控制 Discord 消息是否带 reply 引用：off、first 或 all。",
  },
  DISCORD_HOME_CHANNEL: {
    label: "Discord Home Channel",
    description: "cron 投递、提醒和通知使用的默认 Discord 频道 ID。",
  },
  DISCORD_HOME_CHANNEL_NAME: {
    label: "Discord Home Channel 名称",
    description: "Discord 主频道在日志和状态输出中的显示名称。",
  },
  GOOGLE_CHAT_PROJECT_ID: {
    label: "Google Chat GCP 项目 ID",
    description: "托管 Chat 事件 Pub/Sub 主题的 GCP 项目 ID；未设置时回退到 GOOGLE_CLOUD_PROJECT。",
  },
  GOOGLE_CHAT_SUBSCRIPTION_NAME: {
    label: "Google Chat Pub/Sub 订阅",
    description: "完整 Pub/Sub 订阅路径，例如 projects/<proj>/subscriptions/<sub>；旧版别名为 GOOGLE_CHAT_SUBSCRIPTION。",
  },
  GOOGLE_CHAT_SERVICE_ACCOUNT_JSON: {
    label: "Google Chat 服务账号 JSON",
    description: "Service Account JSON key 的文件路径或内联 JSON；留空时在 Cloud Run / GCE 使用应用默认凭据，并可回退到 GOOGLE_APPLICATION_CREDENTIALS。",
  },
  GOOGLE_CHAT_ALLOWED_USERS: {
    label: "Google Chat 允许用户",
    description: "允许与机器人交互的用户邮箱，多个值用英文逗号分隔。",
  },
  GOOGLE_CHAT_HOME_CHANNEL: {
    label: "Google Chat Home Space",
    description: "cron 投递、提醒和通知使用的默认 Google Chat 空间，例如 spaces/AAAA...。",
  },
  GOOGLE_CHAT_HOME_CHANNEL_NAME: {
    label: "Google Chat Home Space 名称",
    description: "Google Chat 主空间在日志和状态输出中的显示名称。",
  },
  SLACK_BOT_TOKEN: {
    label: "Slack Bot Token",
    description: "Slack xoxb- token，安装应用后在 OAuth & Permissions 获取。",
  },
  SLACK_APP_TOKEN: {
    label: "Slack App Token",
    description: "Slack Socket Mode 使用的 xapp- 应用级 token。",
  },
  MATTERMOST_URL: {
    label: "Mattermost 服务地址",
    description: "Mattermost 服务器 URL，例如 https://mm.example.com。",
  },
  MATTERMOST_TOKEN: {
    label: "Mattermost Token",
    description: "Mattermost bot token 或个人访问 token。",
  },
  MATTERMOST_ALLOWED_USERS: {
    label: "Mattermost 允许用户",
    description: "允许使用机器人的 Mattermost 用户 ID，多个值用英文逗号分隔。",
  },
  MATTERMOST_REQUIRE_MENTION: {
    label: "Mattermost 需 @",
    description: "频道消息是否必须 @ 机器人后才响应，默认 true。",
  },
  MATTERMOST_FREE_RESPONSE_CHANNELS: {
    label: "Mattermost 自由响应频道",
    description: "无需 @ 即可响应的 Mattermost 频道 ID，多个值用英文逗号分隔。",
  },
  MATRIX_HOMESERVER: {
    label: "Matrix Homeserver",
    description: "Matrix homeserver URL，例如 https://matrix.example.org。",
  },
  MATRIX_ACCESS_TOKEN: {
    label: "Matrix Access Token",
    description: "Matrix 访问 token，优先于密码登录。",
  },
  MATRIX_USER_ID: {
    label: "Matrix 用户 ID",
    description: "机器人 Matrix 用户 ID，例如 @hermes:example.org。",
  },
  MATRIX_ALLOWED_USERS: {
    label: "Matrix 允许用户",
    description: "允许使用机器人的 Matrix 用户 ID，格式为 @user:server。",
  },
  BLUEBUBBLES_SERVER_URL: {
    label: "BlueBubbles 服务地址",
    description: "用于 iMessage 集成的 BlueBubbles Server URL。",
  },
  BLUEBUBBLES_PASSWORD: {
    label: "BlueBubbles 密码",
    description: "BlueBubbles Server 设置里的 API 密码。",
  },
  BLUEBUBBLES_ALLOWED_USERS: {
    label: "BlueBubbles 允许用户",
    description: "允许使用机器人的 iMessage 邮箱或手机号，多个值用英文逗号分隔。",
  },
  BLUEBUBBLES_ALLOW_ALL_USERS: {
    label: "BlueBubbles 允许所有用户",
    description: "是否允许所有 BlueBubbles 用户使用机器人。",
  },
  QQ_APP_ID: {
    label: "QQ Bot App ID",
    description: "来自 QQ 开放平台 q.qq.com 的机器人 App ID。",
  },
  QQ_CLIENT_SECRET: {
    label: "QQ Bot Client Secret",
    description: "来自 QQ 开放平台的机器人 Client Secret。",
  },
  QQ_ALLOWED_USERS: {
    label: "QQ 允许用户",
    description: "允许使用机器人的 QQ 用户 ID，多个值用英文逗号分隔。",
  },
  QQ_GROUP_ALLOWED_USERS: {
    label: "QQ 允许群聊",
    description: "允许交互的 QQ 群 ID，多个值用英文逗号分隔。",
  },
  QQ_ALLOW_ALL_USERS: {
    label: "QQ 允许所有用户",
    description: "是否允许所有 QQ 用户使用机器人。",
  },
  QQBOT_HOME_CHANNEL: {
    label: "QQ Home Channel",
    description: "cron 投递和通知使用的默认 QQ 频道或群。",
  },
  QQBOT_HOME_CHANNEL_NAME: {
    label: "QQ Home Channel 名称",
    description: "QQ 默认频道或群的显示名称。",
  },
  QQ_SANDBOX: {
    label: "QQ 沙箱模式",
    description: "是否启用 QQ 开发测试沙箱模式。",
  },
  IRC_SERVER: {
    label: "IRC 服务器",
    description: "要连接的 IRC 服务器主机名，例如 irc.libera.chat。",
  },
  IRC_PORT: {
    label: "IRC 端口",
    description: "IRC 服务器端口；启用 TLS 时默认 6697，不启用 TLS 时默认 6667。",
  },
  IRC_CHANNEL: {
    label: "IRC 频道",
    description: "机器人要加入的 IRC 频道，例如 #hermes。",
  },
  IRC_NICKNAME: {
    label: "IRC 昵称",
    description: "机器人在 IRC 中使用的昵称，默认 hermes-bot。",
  },
  IRC_USE_TLS: {
    label: "IRC 启用 TLS",
    description: "是否使用 TLS 连接 IRC；填写 1、true 或 yes 表示启用，端口 6697 默认启用。",
  },
  IRC_SERVER_PASSWORD: {
    label: "IRC 服务器密码",
    description: "IRC PASS 命令使用的服务器密码，可选。",
  },
  IRC_NICKSERV_PASSWORD: {
    label: "IRC NickServ 密码",
    description: "连接后自动 IDENTIFY 使用的 NickServ 密码，可选。",
  },
  IRC_ALLOWED_USERS: {
    label: "IRC 允许用户",
    description: "允许与机器人聊天的 IRC 昵称，多个值用英文逗号分隔。",
  },
  IRC_ALLOW_ALL_USERS: {
    label: "IRC 允许所有用户",
    description: "是否允许频道内任意用户与机器人聊天，仅建议开发调试时开启。",
  },
  IRC_HOME_CHANNEL: {
    label: "IRC Home Channel",
    description: "cron 投递、提醒和通知使用的 IRC 频道；留空时默认使用 IRC_CHANNEL。",
  },
  WEBHOOK_ENABLED: {
    label: "启用 Webhook 平台",
    description: "允许通过 Webhook 接收 GitHub、GitLab 等外部事件。",
  },
  WEBHOOK_PORT: {
    label: "Webhook 端口",
    description: "Webhook HTTP 服务端口，默认 8644。",
  },
  WEBHOOK_SECRET: {
    label: "Webhook HMAC 密钥",
    description: "Webhook 签名校验的全局 HMAC secret，可被 config.yaml 中的路由配置覆盖。",
  },

  // ── 设置 ─────────────────────────────────────────────────────────────
  SUDO_PASSWORD: {
    label: "sudo 密码",
    description: "终端命令需要 root 权限时使用；设置为空字符串表示尝试空密码。",
  },
  HERMES_MAX_ITERATIONS: {
    label: "最大工具调用轮数",
    description: "单次对话最大工具调用迭代次数，默认 90。",
  },
  HERMES_TOOL_PROGRESS: {
    label: "工具进度显示（已弃用）",
    description: "已弃用，请改用 config.yaml 中的 display.tool_progress。",
  },
  HERMES_TOOL_PROGRESS_MODE: {
    label: "工具进度模式（已弃用）",
    description: "已弃用，请改用 config.yaml 中的 display.tool_progress。",
  },
  HERMES_PREFILL_MESSAGES_FILE: {
    label: "预填消息文件",
    description: "用于 few-shot priming 的临时预填消息 JSON 文件路径。",
  },
  HERMES_EPHEMERAL_SYSTEM_PROMPT: {
    label: "临时系统提示词",
    description: "仅在 API 调用时注入的系统提示词，不会持久化到会话记录。",
  },
  HERMES_YOLO_MODE: {
    label: "YOLO 模式",
    description: "自动批准高风险命令；也可在高级设置里切换。",
  },
};

const PROVIDER_PREFIX_TRANSLATIONS: Record<string, string> = {
  AI302: "302.AI",
  ALIBABA_CODING_PLAN: "阿里云百炼 Coding Plan",
  ANTHROPIC: "Anthropic",
  ARCEE: "Arcee AI",
  ARCEEAI: "Arcee AI",
  ARK: "火山方舟",
  AZURE_FOUNDRY: "Azure AI Foundry",
  CLAUDE_CODE: "Claude Code",
  COMPSHARE: "优云智算",
  COPILOT_GITHUB: "GitHub Copilot",
  DASHSCOPE: "阿里云百炼 DashScope",
  DEEPSEEK: "DeepSeek",
  GEMINI: "Gemini",
  GH: "GitHub",
  GLM: "智谱 GLM",
  GMI: "GMI Cloud",
  GOOGLE: "Google AI Studio",
  HERMES_GEMINI: "Gemini OAuth",
  HERMES_QWEN: "Qwen Portal",
  HF: "Hugging Face",
  HUNYUAN: "腾讯混元",
  KILOCODE: "Kilo Code",
  KIMI: "Kimi / Moonshot",
  KIMI_CN: "Kimi / Moonshot 中国",
  LM: "LM Studio",
  LONGCAT: "LongCat",
  MIMO: "小米 MiMo",
  MINIMAX: "MiniMax",
  MINIMAX_CN: "MiniMax 中国",
  MODELSCOPE: "ModelScope",
  NOUS: "Nous Portal",
  NOVITA: "Novita",
  NVIDIA: "NVIDIA NIM",
  OLLAMA: "Ollama Cloud",
  OPENCODE_GO: "OpenCode Go",
  OPENCODE_ZEN: "OpenCode Zen",
  OPENROUTER: "OpenRouter",
  QIANFAN: "百度千帆",
  QWEN: "Qwen",
  SILICONFLOW: "SiliconFlow",
  STEPFUN: "StepFun",
  XAI: "xAI",
  XIAOMI: "小米 MiMo",
  ZAI: "Z.AI",
  Z_AI: "Z.AI",
};

interface ProviderFieldTranslation {
  label: string;
  description: (provider: string) => string;
}

const PROVIDER_FIELD_TRANSLATIONS: Array<[suffix: string, field: ProviderFieldTranslation]> = [
  [
    "_SERVICE_ACCOUNT_JSON",
    {
      label: "服务账号 JSON",
      description: (provider) => `${provider} 服务账号 JSON 路径或内联 JSON，用于服务账号认证。`,
    },
  ],
  [
    "_SECRET_ACCESS_KEY",
    {
      label: "Secret Access Key",
      description: (provider) => `${provider} Secret Access Key，用于云服务鉴权。`,
    },
  ],
  [
    "_ACCESS_KEY_ID",
    {
      label: "Access Key ID",
      description: (provider) => `${provider} Access Key ID，用于云服务鉴权。`,
    },
  ],
  [
    "_CLIENT_SECRET",
    {
      label: "Client Secret",
      description: (provider) => `${provider} OAuth Client Secret；可选，通常与 Client ID 搭配使用。`,
    },
  ],
  [
    "_CLIENT_ID",
    {
      label: "Client ID",
      description: (provider) => `${provider} OAuth Client ID；可选，留空时使用默认客户端配置。`,
    },
  ],
  [
    "_PROJECT_ID",
    {
      label: "项目 ID",
      description: (provider) => `${provider} 项目 ID，用于绑定云端项目或计费项目。`,
    },
  ],
  [
    "_OAUTH_TOKEN",
    {
      label: "OAuth Token",
      description: (provider) => `${provider} OAuth Token，用于通过 OAuth 访问该模型服务商。`,
    },
  ],
  [
    "_ACCESS_TOKEN",
    {
      label: "Access Token",
      description: (provider) => `${provider} Access Token，用于访问该模型服务商。`,
    },
  ],
  [
    "_BASE_URL",
    {
      label: "Base URL",
      description: (provider) => `${provider} API Base URL 覆盖；留空时使用默认端点。`,
    },
  ],
  [
    "_API_URL",
    {
      label: "API URL",
      description: (provider) => `${provider} API URL 覆盖；留空时使用默认端点。`,
    },
  ],
  [
    "_API_KEY",
    {
      label: "API Key",
      description: (provider) => `${provider} API Key，用于访问该模型服务商。`,
    },
  ],
  [
    "_TOKEN",
    {
      label: "Token",
      description: (provider) => `${provider} Token，用于访问该模型服务商。`,
    },
  ],
  [
    "_REGION",
    {
      label: "区域",
      description: (provider) => `${provider} 区域或地域设置。`,
    },
  ],
  [
    "_PROFILE",
    {
      label: "配置档案",
      description: (provider) => `${provider} 本地配置档案名称。`,
    },
  ],
  [
    "_MODEL",
    {
      label: "模型",
      description: (provider) => `${provider} 默认模型名称。`,
    },
  ],
  [
    "_ENDPOINT",
    {
      label: "端点",
      description: (provider) => `${provider} 服务端点覆盖。`,
    },
  ],
];

function providerNameFromPrefix(prefix: string): string {
  return PROVIDER_PREFIX_TRANSLATIONS[prefix] ?? prefix
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

function translateProviderEnvVar(envKey: string, info: EnvVarInfo): EnvVarTranslation | null {
  if (info.category !== "provider") return null;

  for (const [suffix, field] of PROVIDER_FIELD_TRANSLATIONS) {
    if (!envKey.endsWith(suffix)) continue;
    const prefix = envKey.slice(0, -suffix.length);
    const provider = providerNameFromPrefix(prefix);
    return {
      label: `${provider} ${field.label}`,
      description: field.description(provider),
    };
  }

  const provider = providerNameFromPrefix(envKey.replace(/_(?:KEY|URL|TOKEN|SECRET|ID)$/u, ""));
  return {
    label: provider === envKey ? envKey.replace(/_/gu, " ") : provider,
    description: `模型服务商相关高级环境变量。原始变量名：${envKey}。`,
  };
}

export function translateEnvCategory(category: string): string {
  return ENV_CATEGORY_TRANSLATIONS[category] ?? category;
}

export function translateEnvVar(envKey: string, info: EnvVarInfo): EnvVarTranslation {
  const hit = ENV_VAR_TRANSLATIONS[envKey];
  if (hit) return hit;
  const providerHit = translateProviderEnvVar(envKey, info);
  if (providerHit) return providerHit;
  return {
    label: envKey,
    description: info.description || envKey,
  };
}
