# BlueBubbles (iMessage) Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front (per `plans/README.md`): **BlueBubbles is a gateway-side
> messaging platform adapter and is marked "out of scope for desktop standalone" for v1** —
> same convention already used by `plans/telegram-platform.md`. The Desktop keeps talking to
> the Core managed-runtime gateway over REST (`/api/status`, `/api/messaging/platforms`,
> `/api/env`) and WS (`/api/ws`) and does **not** host the BlueBubbles adapter in-process in
> v1. Sections 3–10 still design the in-process TS port so the decision is recorded and a
> future standalone build can pick it up.

## 1. Summary

BlueBubbles 是 Hermes messaging gateway 的 **iMessage 平台适配器**：它通过 BlueBubbles
macOS 服务器的 **REST API**（`/api/v1/*`）发送 iMessage，并**自带一个本地 webhook HTTP
监听器**接收 BlueBubbles 服务器推送的入站消息。支持文本、富媒体（图片/语音/视频/文档）、
tapback reactions、typing 指示、已读回执（后三者依赖 BlueBubbles Private API helper）。

Python 实现位于 `D:/hermes-agent-cn/gateway/platforms/bluebubbles.py`（1,071 行），
文档 `D:/hermes-agent-cn/website/docs/user-guide/messaging/bluebubbles.md`（171 行），
测试 `D:/hermes-agent-cn/tests/gateway/test_bluebubbles.py`（440 行）。

**Adapter port decision（记录）**：v1 保持 Python gateway（managed runtime）持有该适配器；
桌面端只消费现有的 REST 状态/配置面（`useStatus` 的 `gateway_platforms.bluebubbles` +
`env-translations.ts` 已有 4 个 `BLUEBUBBLES_*` 键）。不引入任何 TS SDK。若未来做
standalone，才按 §3 把适配器以 in-process TS 模块移植到 `web/src/lib/platforms/bluebubbles/`，
出站走 `fetch`/`undici` REST，入站 webhook 监听器只能由 **Rust/Tauri 或 Node sidecar**
提供（webview 不能绑定 TCP 端口）。

**WS-removal 影响（记录）**：BlueBubbles 的入站（webhook）与出站（REST）**从不经过桌面
Dashboard `/api/ws`** —— WS 只承载会话事件流与平台状态。因此移除 WS 对 BlueBubbles
功能归属零影响；只需按 `messaging-gateway-core.md` 提供新的 in-process 会话事件通道，
并把平台状态展示降级为 `useStatus` 轮询（今天 `settings.tsx` 的 debug 卡片已是读
`/api/status` 的轮询结果）。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/gateway/platforms/bluebubbles.py` | 1,071 行 | `BlueBubblesAdapter` 完整实现 |
| `D:/hermes-agent-cn/website/docs/user-guide/messaging/bluebubbles.md` | 171 行 | 安装/配置/env 表/功能/Private API/排障 |
| `D:/hermes-agent-cn/tests/gateway/test_bluebubbles.py` | 440 行 | 配置加载/解析/mention gating/GUID 解析/附件/Webhook 注册 parity 基准 |
| `D:/hermes-agent-cn/hermes_cli/web_server.py` | — | 平台目录 entry（L8716–8725）、端口绑定表（L3497） |
| `D:/hermes-agent-cn/gateway/pairing.py` | — | `bluebubbles → BLUEBUBBLES_ALLOWED_USERS`（L86） |
| `D:/hermes-agent-cn/hermes_cli/config_defaults.py` | — | `BLUEBUBBLES_SERVER_URL/PASSWORD/ALLOWED_USERS/ALLOW_ALL_USERS` 默认项（L4269–4290） |

关键实现块（按行号，实测读取）：

- **常量/配置**（L89–204）：`DEFAULT_WEBHOOK_HOST=127.0.0.1`、`DEFAULT_WEBHOOK_PORT=8645`、
  `DEFAULT_WEBHOOK_PATH=/bluebubbles-webhook`、`MAX_TEXT_LENGTH=4000`、
  `DEFAULT_MENTION_PATTERNS`（Hermes/@Hermes agent）；tapback 码表 `_TAPBACK_ADDED/REMOVED`
  （L108–115，2000–2005/3000–3005）；webhook 事件类型 `_MESSAGE_EVENTS = {new-message, message, updated-message}`（L118）；
  配置键全部支持 `extra.*` 与 `BLUEBUBBLES_*` env 双通道（`_get_scoped_secret` 处理 profile
  secret scope，L63–80）；`require_mention`/`mention_patterns` 由
  `gateway/platforms/helpers.py::compile_mention_patterns` 编译。
- **HTTP 层**（L210–258）：`_api_url` 把 password 以 query 参数 `?password=<quote>` 追加到
  每个 REST URL（BlueBubbles API 不支持 header 鉴权）；`httpx.AsyncClient(timeout=30.0,
  limits=platform_httpx_limits())`（`gateway/platforms/_http_client_limits.py`）。
- **生命周期**（L264–458）：`connect()` 先 `GET /api/v1/ping` + `GET /api/v1/server/info`
  （探测 `private_api` 与 `helper_connected` 能力位），再起 aiohttp webhook listener
  （`client_max_size=1 MiB`，`access_log=None` 防止 password 进日志），最后
  `_register_webhook()`；`disconnect()` 先注销 webhook 再关闭客户端与 runner。
  Webhook 注册是 **crash-resilient**：先 `_find_registered_webhooks(url)` 复用已存在条目，
  `_unregister_webhook` 清掉所有重复注册。
- **出站文本**（L527–585）：`send()` 先按空行切段（每段一个 iMessage 气泡），再
  `truncate_message(MAX_TEXT_LENGTH=4000)`（去掉 `(1/3)` 页码后缀）；`_resolve_chat_guid`
  （L464–504）把 email/手机号解析成 BlueBubbles chat GUID：命中缓存（LRU 500）→ 否则
  `POST /api/v1/chat/query` 严格匹配 `chatIdentifier`；**绝不**用 participant 命中兜底
  （回归 #24157，防止 DM 回复泄漏进群）；未命中且 `private_api_enabled` 时走
  `POST /api/v1/chat/new` 新建 DM（L506–521）。reply 走 Private API
  `method=private-api` + `selectedMessageGuid`。
- **出站媒体**（L591–716）：`_send_attachment` multipart POST `/api/v1/message/attachment`
  （`isAudioMessage=true` 发语音气泡，timeout=120s），caption 随后补发；
  `send_image/send_image_file/send_voice/send_video/send_document/send_animation` 全部复用。
- **Typing / 已读**（L722–765）：`POST|DELETE /api/v1/chat/{guid}/typing`、
  `POST /api/v1/chat/{guid}/read`，仅当 `private_api_enabled && helper_connected`。
- **入站 webhook**（L896–1071）：认证取 query `password`（或 `x-password`/`x-guid`/
  `x-bluebubbles-guid` header）；body 支持 JSON 与 form 两种形态（`_extract_payload_record`）；
  跳过 `isFromMe`、跳过 tapback 消息；附件逐个 `GET /api/v1/attachment/{guid}/download`
  下载后经 `cache_image_from_bytes/cache_audio_from_bytes/cache_document_from_bytes`
  落盘（封闭 mime→ext 覆盖表 L40–57：heic/heif→.jpg、audio/x-caf→.mp3 等）；群聊
  `require_mention` gating + `_clean_mention_text`；`build_source(...)` 后构造 `MessageEvent`
  交给 `handle_message`（fire-and-forget task），随后可选 `mark_read`。
- **日志安全**（L121–131, L359–365）：`_redact` 抹掉手机号/邮箱；注册 URL 只记
  `?password=***`。
- **格式化**（L806–807）：`format_message = strip_markdown`（`gateway/platforms/helpers.py`）。

测试面（`tests/gateway/test_bluebubbles.py`，10 个类，parity 基准）：env 覆盖（L26）、
helper/格式化/URL 归一（L47）、mention gating（L86）、webhook 解析回退（L117）、GUID
解析（L176，含 #24157 两条回归）、附件下载路由（L237）、webhook URL/注册 URL（L282）、
webhook 注册复用与去重（L305）。

## 3. Target TypeScript design

**Port decision（记录）**：v1 保持 Python gateway；下面是在-process 移植的目标设计（仅在
未来 standalone 时启用）。

模块布局（复用 `plans/messaging-gateway-core.md` 定义的 `PlatformAdapter` 接口）：

```
web/src/lib/platforms/
  types.ts               # 共享 PlatformAdapter / MessageEvent / SendResult / SessionSource
  bluebubbles/
    constants.ts         # 常量：webhook 默认端口/路径、MAX_TEXT_LENGTH=4000、mention 默认 pattern、tapback 码表、mime→ext 覆盖表
    api.ts               # BlueBubblesClient：_apiUrl(password query) / ping / serverInfo / chatQuery / chatNew / sendText / sendAttachment(multipart) / attachmentDownload / typing / read / getChat
    webhook.ts           # 入站 listener：认证、JSON/form 解析、事件类型过滤、isFromMe/tapback 跳过、_extractPayloadRecord/_value
    resolver.ts          # _resolveChatGuid（严格 identifier 匹配 + LRU 500 缓存，绝不 participant 兜底）+ _createChatForHandle
    media.ts             # 入站下载 + 缓存（封闭 mime→ext 映射）、出站 multipart 构造
    format.ts            # formatMessage = stripMarkdown；truncateMessage（去页码后缀）；空行分段
    gating.ts            # requireMention / _messageMatchesMentionPatterns / _cleanMentionText
    adapter.ts           # BlueBubblesAdapter implements PlatformAdapter
    index.ts             # factory + register()
web/src/lib/im-onboarding/   # （未来）蓝泡泡 onboarding 状态与诊断复用现有 im-onboarding 框架
```

关键接口（pseudocode，非实现）：

```ts
interface BlueBubblesConfig {
  serverUrl: string;              // 归一化 http(s)，去尾部 /
  password: string;               // 存 Tauri keychain / settings store，redacted 展示
  webhookHost: string;            // 默认 127.0.0.1
  webhookPort: number;            // 默认 8645
  webhookPath: string;            // 默认 /bluebubbles-webhook
  sendReadReceipts: boolean;      // 默认 true
  requireMention: boolean;
  mentionPatterns: RegExp[];
  allowedUsers?: string[];        // BLUEBUBBLES_ALLOWED_USERS（由 gateway 层配对模块消费）
  allowAllUsers?: boolean;
}

interface BlueBubblesAdapterLike extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: SendMeta }): Promise<SendResult>;
  sendImage/sendImageFile/sendVoice/sendVideo/sendDocument/sendAnimation(...): Promise<SendResult>;
  sendTyping(chatId: string, on: boolean): Promise<void>;
  markRead(chatId: string): Promise<boolean>;
  getChatInfo(chatId: string): Promise<{ name: string; type: "dm"|"group"; participants?: string[] }>;
  onMessage(handler: (ev: MessageEvent) => Promise<void>): void;
  test(): Promise<{ ok: boolean; state?: string; message?: string }>; // ping + server/info
}
```

数据流（in-process 目标）：

1. `connect()` 读配置 → `ping` + `server/info`（记录 `privateApiEnabled`/`helperConnected`）→
   注册 webhook（先查重）→ 启动入站 listener（Rust Tauri HTTP 或 Node sidecar，见 §5）。
2. 入站：BB 服务器 POST webhook → 认证（query/header password）→ 事件类型过滤 → 附件
   下载/缓存 → mention gating → 归一为 `MessageEvent`（`source` 用 `buildSource` 语义，
   session key 与 Python 保持一致 `agent:main:bluebubbles:<chatType>:<chatId>[:<userId>]`）
   → 交给本地 agent loop。
3. 出站 `send()`：`formatMessage`（stripMarkdown）→ 空行分段 → `truncateMessage` 4000
   字符去页码 → `resolveChatGuid`（缓存/严格匹配/Private API 新建 DM）→
   `POST /api/v1/message/text` → `SendResult`。
4. 媒体出站：`FormData` multipart（`isAudioMessage`）；入站：下载 → 按封闭 mime 映射落盘缓存。
5. `test()` 对齐 `MessagingPlatformTestResponse`（ping + server/info + 可选 webhook 注册检查）。

运行形态：**推荐 Rust/Tauri 提供本地 TCP 监听**（webview 不能 bind 端口；Rust 用
`tiny_http`/`axum` 起本地 webhook 服务并把请求转发给 TS 处理函数），或 **Node sidecar**
（内置 `node:http`）。纯 webview 方案不可行（无 TCP listen + 后台保活风险），记录为已知限制。

## 4. Data models & persistence

| 数据 | Python 位置 | 结构 | TS 策略 |
|---|---|---|---|
| 消息 | 无持久化（BB 服务器是事实源） | — | 不落库；会话由 gateway session 层管理（`messaging-gateway-core.md`） |
| chat GUID 缓存 | 内存 `_guid_cache: OrderedDict`（L204, L464–504） | `{target → guid}` LRU 500 | in-memory `Map`（插入序）LRU 500；未命中**不缓存 None**（回归 #24157） |
| 能力位 | 内存 `_private_api_enabled/_helper_connected`（L202–203） | bool | in-memory；connect 时 `server/info` 刷新；供 typing/read/reply/新建 DM 分支 |
| tapback 码表 | 常量 L108–115 | 2000–2005/3000–3005 → love/like/… | 常量表 1:1 移植（webhook 跳过逻辑） |
| mime→ext 覆盖表 | 常量 L40–57 | 封闭 map（heic/heif→.jpg 等） | 手写常量表，**保持 closed-map 语义**（不 consult mimetypes） |
| mention patterns | `_mention_patterns`（L215–226） | 编译后 RegExp[] | JS `RegExp[]`；默认 `DEFAULT_MENTION_PATTERNS` |
| 媒体缓存 | `cache_*_from_bytes` → 本地文件 | 文件 | app data 目录（Tauri fs IPC 或 sidecar）；键=附件 GUID |
| 配置/密钥 | `.env`/`config.yaml` + `BLUEBUBBLES_*`（docs L106–121） | env/extra | Phase 1 仍写 `.env`；Phase 2 迁移 TS settings store（`.env` seed），密钥 `ImRedactedValue` + fingerprint |

Schema migration：无 SQLite；仅需与 Python 字段级兼容的配置键迁移
（`BLUEBUBBLES_SERVER_URL/PASSWORD/WEBHOOK_HOST/WEBHOOK_PORT/WEBHOOK_PATH/REQUIRE_MENTION/
MENTION_PATTERNS/ALLOWED_USERS/ALLOW_ALL_USERS/HOME_CHANNEL` + `extra.send_read_receipts`）。

## 5. Third-party library strategy

**kimi-code 实测结果**：`D:/kimi-code` 全树 grep `\bbluebubbles?\b|\bimessage\b`
（apps/packages 源码 + 全部 package.json + pnpm-lock.yaml + node_modules）**0 命中**；
npm 生态无被 kimi-code 验证的 BlueBubbles/iMessage TS 客户端。**结论：kimi-code 无任何
BlueBubbles/iMessage TS 实现可作证据**（"no TS equivalent found"，见风险 §9）。

| Python 依赖 | TS 等价 | kimi-code 证据 / 设计 |
|---|---|---|
| `httpx`（REST GET/POST/DELETE + multipart + redirect + 超时） | `fetch` / **`undici`**（`AbortSignal.timeout` 替代 30s timeout；`FormData` 做 multipart；attachment download 手动 `redirect: "follow"` 或 undici dispatcher） | kimi-code `packages/agent-core/package.json:102` 依赖 `"undici": "^7.27.1"`（`packages/agent-core-v2/package.json:86` 同）；桌面 `web/src/lib/transport.ts` 已用 fetch |
| `aiohttp`（入站 webhook TCP listener） | **无 webview 等价**：Rust/Tauri 本地 HTTP 服务（`tiny_http`/`axum`）或 Node sidecar `node:http`，把请求体转交 TS 处理函数 | kimi-code `packages/kap-server` 是 HTTP 服务器实现（服务端，非 webview 内 TCP listen）；webview 本身无法 bind 端口 → 本 feature 最关键的运行形态决策 |
| `orjson` | `JSON.parse/stringify` | 内置 |
| `re`（URL 归一、mention pattern、`_redact`、页码后缀删除） | JS `RegExp`（lookbehind 现代引擎已支持，可对齐 `(?<![\w@])` pattern） | 从零移植；`gateway/helpers.py` 无 TS 等价 |
| `urllib.parse.quote` | `encodeURIComponent` | 内置 |
| `uuid` / `datetime` | `crypto.randomUUID()` / `Date.now()` ISO | 内置 |
| `mimetypes`（经 `ext_for_mime` 覆盖表） | 手写封闭 map（不 consult mime 库） | 常量表即可 |
| `agent.secret_scope.get_secret` | Tauri keychain / settings store（`ImRedactedValue` 语义） | 桌面已有 `im-onboarding-diagnostics.ts` redaction 逻辑 |
| 文件缓存（`cache_*_from_bytes`） | Tauri fs IPC 或 sidecar fs（app data） | kimi-code `apps/kimi-code/src/utils` fs 工具可参考 |

**BlueBubbles TS 客户端调研结论**：BlueBubbles 官方只有 macOS server + 移动/桌面客户端，
**无官方 TS SDK**；npm 上存在非官方第三方包但未经 kimi-code 验证、质量/维护不可控。
**决定：不引入任何第三方 BlueBubbles 包，从零实现薄 REST/webhook shim（约 700–1000 行 TS）**，
逐接口对齐 `bluebubbles.py` 行为（`/api/v1/ping|server/info|webhook|chat/query|chat/new|
message/text|message/attachment|chat/{guid}/typing|chat/{guid}/read|attachment/{guid}/download|
chat/{guid}?with=participants`）。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（BlueBubbles 不在桌面 onboarding 范围，集成点全部是"读"）：

- **复用（无需改动）**：
  - `web/src/routes/settings.tsx` L1478–1484：`status.gateway_platforms` debug 卡片已自动
    展示 `bluebubbles` 名称/state/error_message（一旦 gateway 启用该平台）。
  - `web/src/lib/env-translations.ts` L351–365：已有 `BLUEBUBBLES_SERVER_URL/PASSWORD/
    ALLOWED_USERS/ALLOW_ALL_USERS` 中文 label（高级 `.env` 编辑器用）。
  - `packages/protocol/src/hermes-api.ts`：`StatusResponse.gateway_platforms`（L47）、
    `MessagingPlatformInfo`（L127–144）、`MessagingPlatformsResponse`（L146–151）、
    `MessagingPlatformTestResponse`（L153+）——平台无关，bluebubbles 作为字符串 key 直接可用。
  - `web/src/hooks/use-status.ts`（轮询 `/api/status`）、`web/src/lib/transport.ts`。
- **不涉及（本 feature 范围外）**：`web/src/routes/im-onboarding.tsx` 的
  `sectionFromPath`（L70–76）只有 feishu/weixin/dingtalk；`packages/protocol/src/channels.ts:491`
  的 `ImPlatform = "feishu" | "weixin"`；`im-onboarding-diagnostics.ts` 的
  `DIAGNOSTIC_REQUIRED_KEYS`（L105–113）只有 feishu/weixin。若团队要加 BlueBubbles 向导，
  需扩展这些点（见 §9 开放问题）；v1 维持 `hermes gateway setup`（Core CLI）为唯一配置入口。
- **Phase 2 替换（若做 standalone）**：`useMessagingPlatform("bluebubbles")` /
  `useTestMessagingPlatform` 检测切到本地 adapter 的 `test()`；诊断分支
  `explainMessagingFailure` 增加 bluebubbles 文案（无法到达服务器、Private API helper 未连接、
  webhook 不可达、401 未授权）；`settings.tsx` 可加 BlueBubbles 平台卡片（读 in-process 状态）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今天桌面消费、迁移期间不得破坏）：
- `GET /api/status` → `gateway_platforms.bluebubbles`（state/error_code/error_message）——`useStatus` 已消费；
- `GET /api/messaging/platforms` → bluebubbles 目录 entry（`hermes_cli/web_server.py` L8716–8725，
  required_env=`BLUEBUBBLES_SERVER_URL`+`BLUEBUBBLES_PASSWORD`）；`/api/messaging/platforms/bluebubbles[/test]`
  检测端点；
- Rust `src/commands/api_proxy.rs` / `src/commands/ws_proxy.rs` 对上述 REST 的透传（managed 模式）。

迁移路径：
1. **今天**：桌面继续经 Rust 命令 + Python runtime 管理 BlueBubbles；无变化。
2. **WS 移除对 BlueBubbles 的影响**：BlueBubbles 入站（webhook）与出站（REST）**从不经过
   桌面 `/api/ws`**；移除 WS 只影响：会话事件流（由 `messaging-gateway-core.md` 的
   in-process `GatewayService`/`IEventBus` 接管）与平台状态刷新（降级为 `useStatus` 轮询，
   已是现状兜底）。对 BlueBubbles 传输零影响。
3. **Phase 2 in-process（未来 standalone）**：`web/src/lib/platforms/bluebubbles/` 直接持有
   REST 客户端 + 入站 listener；`test()` 变本地连接检查；删除 Rust 侧 bluebubbles 相关
   REST 透传；`.env` 写入迁移到 TS settings store。
4. **Phase 3**：删除 `ws_proxy.rs`/`api_proxy.rs` 中 bluebubbles 转发；保留
   `MessagingPlatformInfo` 类型与诊断 UI（读 in-process 状态）。
5. **端口注意**：Python `_PORT_BINDING_PLATFORM_PORTS`（web_server.py L3491–3501）中
   bluebubbles 默认 `webhook_port=8645`，与 `wecom_callback` 的 `port=8645` **同端口**
   ——迁移/启用两个平台时需在桌面配置层做冲突检测（Phase 2 开放问题）。

## 8. Migration phases & task breakdown

- **Phase 0 — 记录决策（本 plan）**：adapter port decision（out of scope for v1）+ WS-removal
  影响已记录；`_INDEX.md` #87 保持。
- **Phase 1 — 维持现状 + 纯函数抽取（可并行，不接 runtime）**：
  - 抽 `constants.ts`（tapback 码表、mime→ext 覆盖表、mention 默认 pattern、webhook 默认值）；
  - 抽 `format.ts`（`formatMessage`=stripMarkdown、`truncateMessage` 去页码、空行分段）与
    `resolver.ts` 的纯逻辑（严格 identifier 匹配 + LRU，不缓存 None）；
  - 与 `test_bluebubbles.py` 纯函数用例逐条对齐（§10）。
- **Phase 2 — in-process runtime（仅当 standalone 立项）**：
  - `api.ts`（undici/fetch REST + password query）+ `webhook.ts` + `media.ts` + `adapter.ts`；
  - Rust/Tauri 或 Node sidecar 本地 webhook listener 落地；`PlatformAdapter` 接入 agent loop；
  - 配置 store（`.env` seed）；onboarding/诊断 UI 扩展（若要做 BlueBubbles 向导）。
- **Phase 3 — 删除 WS/REST 桥（仅当 standalone 落地）**：
  - 删除 Rust 侧透传、`ws_proxy.rs`/`api_proxy.rs` 相关转发；诊断文案移除 Python 依赖提示。

## 9. Risks & open questions

1. **无官方 TS SDK（"no TS equivalent found"）**：BlueBubbles REST/webhook 协议只能以
   `bluebubbles.py` + `test_bluebubbles.py` 为准从零移植；协议漂移（webhook payload 形态
   变化，如 v1.9+ 把 chatGuid 移到 `data.chats[0]`，Python L1000–1005）需 fixture 测试兜底。
2. **入站 listener 运行形态**：webview 不能绑定 TCP 端口；必须 Rust/Tauri 本地 HTTP 服务
   或 Node sidecar。**开放问题：桌面团队确认 runtime 形态**（影响 §3 模块边界与 §5 依赖）。
3. **Private API 能力不可控**：tapback/typing/read receipts/新建 DM 依赖 BB 服务器
   `helper_connected`；TS 移植必须保留能力位探测与优雅降级（与 Python 一致）。
4. **webhook 网络拓扑**：桌面是 Windows 端、BB 服务器是 macOS 端；注册给 BB 的 webhook URL
   必须被 Mac 可达（局域网/Ngrok/Cloudflare/DNS）。in-process 方案需显式处理不可达场景
   （Python 今天由 gateway 常驻解决，standalone 桌面常驻性弱于 Python 服务）。
5. **端口冲突**：`bluebubbles` 与 `wecom_callback` 默认端口同为 8645（web_server.py L3497/L3496）；
   若 standalone 同时启用两平台需冲突检测与用户可见错误。
6. **日志安全**：password 走 query string（BB 不支持 header 鉴权）——TS 侧必须沿用
   `_webhook_register_url_for_log`（`?password=***`）与 `_redact` 手机/邮箱脱敏，防泄入
   Tauri 日志/telemetry。
7. **GUID 解析回归风险**：`_resolve_chat_guid` 的 "participant-only 不命中" 与 "未命中不缓存"
   两条语义（#24157）是防 DM→群泄漏的关键，TS 移植必须 1:1 对齐并有回归测试。
8. **会话 key 字节一致性**：in-process 与 Python gateway 共存期，`build_source` 产出的
   session key 必须与 Python `agent:main:bluebubbles:<chatType>:<chatId>[:<userId>]` 布局
   一致（参照 `messaging-gateway-core.md` §4 parity guard）。

## 10. Test strategy

- **vitest 单元（parity with Python）**，逐条对齐 `test_bluebubbles.py`：
  - `TestBlueBubblesConfigLoading`：env 覆盖 server_url/password/webhook_port/require_mention/
    mention_patterns；
  - `TestBlueBubblesHelpers`：`formatMessage` 保留下划线、strip markdown 标题、webhook path
    归一（补 `/`）、server URL 归一（去尾部 `/`）；
  - `TestBlueBubblesMentionGating`：群聊无 mention → 200 且不 dispatch；
  - `TestBlueBubblesWebhookParsing`：`data` 缺失时回退 sender；`data` 为数组取首元素；
  - `TestBlueBubblesGuidResolution`：participant-only 不命中（#24157）、未命中不缓存；
  - `TestBlueBubblesAttachmentDownload`：image mime → 图片缓存分支；
  - `TestBlueBubblesWebhookUrl`：host 归一 localhost；无 password 时注册 URL 不带 query；
  - `TestBlueBubblesWebhookRegistration`：find 匹配/新建/复用已有/删除全部重复。
- **集成（mock BlueBubbles HTTP）**：`ping`/`server/info`（private_api/helper 组合）→
  webhook 注册（先查重）→ 入站 webhook POST（JSON + form 两种 payload、认证失败 401、
  1 MiB body cap）→ 附件下载 redirect → 出站 text（分块、reply private-api）→
  typing/read 仅在能力位开启时调用；GUID 缓存 LRU 驱逐与 "未命中不缓存" 断言。
- **Playwright E2E（若加 onboarding）**：`/im/bluebubbles`（未来）配置表单 + 检测按钮在
  mock Tauri 命令下跑通；现有 E2E 只断言 `settings.tsx` debug 卡片出现
  `gateway_platforms.bluebubbles` 状态。
- **迁移期集成**：Python/TS 双实现跑同一组 golden fixture（webhook payload 样例、GUID
  query 响应、mime→ext 表），确保 Phase 3 删除 Python 前行为一致。

## 11. Reference links

- `D:/hermes-agent-cn/gateway/platforms/bluebubbles.py`（1,071 行，实现源）
- `D:/hermes-agent-cn/website/docs/user-guide/messaging/bluebubbles.md`（171 行，docs）
- `D:/hermes-agent-cn/tests/gateway/test_bluebubbles.py`（440 行，parity 基准）
- `D:/hermes-agent-cn/hermes_cli/web_server.py`（平台目录 L8716–8725、端口绑定 L3491–3501）
- `D:/hermes-agent-cn/gateway/pairing.py`（L86 `bluebubbles → BLUEBUBBLES_ALLOWED_USERS`）
- `D:/hermes-agent-cn/gateway/platforms/base.py`（`BasePlatformAdapter` L2884、`MessageEvent` L2294、
  `SendResult` L2460、`build_source` L7032）
- `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`（L1478–1484 debug 卡片）
- `D:/Hermes-CN-Desktop/web/src/lib/env-translations.ts`（L351–365 `BLUEBUBBLES_*` label）
- `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`（L70–76 `sectionFromPath`，当前无 bluebubbles）
- `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`（L105–113 required keys）
- `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`（L491 `ImPlatform = "feishu" | "weixin"`）
- `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts`（L47 `gateway_platforms`、L127–151 平台 info）
- `D:/Hermes-CN-Desktop/src/commands/api_proxy.rs` / `ws_proxy.rs` / `im_onboarding.rs`
- `D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md`（`PlatformAdapter` 接口、WS 移除总路线）
- `D:/Hermes-CN-Desktop/plans/telegram-platform.md` / `plans/weixin-platform.md`（同风格先例）
- `D:/kimi-code`（bluebubbles/imessage 全树 0 命中；`packages/agent-core/package.json:102` `undici ^7.27.1`）
