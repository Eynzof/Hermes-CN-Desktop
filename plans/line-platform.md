# LINE Platform Adapter (Messaging API) — Python → TypeScript Rewrite Plan

> Feature slug: `line-platform`（`_INDEX.md` #79）· `plugins/platforms/line/plugin.yaml` `name: line-platform`

## 1. Summary

LINE 接入是 Hermes messaging gateway 的一个 **gateway-side 平台适配器**：通过 LINE
Messaging API 官方 webhook（HMAC-SHA256 签名）+ Reply/Push REST 出站，把 LINE 的
1:1 私聊 / 群组（`C…`）/ 多人群聊房间（`R…`）与 Hermes agent 对接。适配器以
**bundled platform plugin** 形式存在于 `D:/hermes-agent-cn/plugins/platforms/line/`
（`adapter.py` 1,756 行 + `plugin.yaml` 65 行），零 core 改动，靠 `gateway/config.py`
的 bundled-plugin 扫描自动发现（见 `website/docs/user-guide/messaging/line.md` L84）。

**核心决策（recorded port decision）**：与 `plans/discord-platform.md`、
`plans/slack-platform.md`、`plans/whatsapp-platform.md`、`plans/telegram-platform.md`
一致 —— 桌面 standalone（React webview + in-process TS agent runtime）**不托管
messaging gateway**，因此 LINE adapter **out of scope for desktop standalone**：本 plan
只记录 port 决策、冻结的 API surface 与"若桌面未来自托管 gateway"时的 TS 设计，不在
桌面内实现 webhook 服务器 / bot 长连接。桌面今天通过 REST（`transport.ts`）+ WS
（`gateway-client.ts`）连接托管 Python runtime 中的 gateway；LINE 配置与平台状态经
通用 settings 通道透传（`GET /api/status` → `gateway_platforms.line`），无需专属
onboarding 页（桌面 IM onboarding 目前仅 CN IM：feishu/weixin/dingtalk）。

TS 侧关键结论（§5 详述）：**kimi-code 没有任何 LINE / messaging 平台适配器实现可作
证据**——全树 grep `@line/bot-sdk` 0 命中、`pnpm-lock.yaml` 0 命中、`node_modules/@line`
不存在，`package.json` 中也没有 telegram/discord/slack/whatsapp/feishu 等任何 IM
平台依赖。若未来 port，整个 adapter 需 **from scratch** 实现；推荐沿用 Python 侧的
"薄客户端"路线（`aiohttp` → 内置 `fetch` + `crypto` + Node `http`），**不引官方
`@line/bot-sdk`**（Python 侧明确为避开 SDK 的 httpx pin 而不用，见 adapter L501-504）。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/plugins/platforms/line/adapter.py` | 1,756 行 | 全部逻辑：webhook 服务器 + 签名校验 + 去重 + 三 allowlist + 出站 Reply/Push + 慢回复 postback 状态机 + 媒体 HTTPS 服务 + 插件入口 |
| `D:/hermes-agent-cn/plugins/platforms/line/plugin.yaml` | 65 行 | `requires_env`（`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`）+ `optional_env`（PORT/HOST/PUBLIC_URL/三 allowlist/HOME_CHANNEL/SLOW_RESPONSE_THRESHOLD 等），供 `hermes config`/`hermes gateway setup` 向导消费 |
| `D:/hermes-agent-cn/plugins/platforms/line/__init__.py` | 3 行 | 包标记 |
| `D:/hermes-agent-cn/website/docs/user-guide/messaging/line.md` | 200 行 | 用户手册：channel 创建、tunnel、env 表、postback 流程、限制 |
| `D:/hermes-agent-cn/tests/gateway/test_line_plugin.py` | 509 行 | 17 组用例（签名 / source / allowlist / dedup / RequestCache / markdown / chunking / 入站媒体 / 出站路由 / register / env / standalone / postback / 校验 / 双栈 bind / 媒体 URL 守卫） |

关键实现单元（行号实测于 `adapter.py`）：

- **常量与硬限制** L128-209：`LINE_REPLY_URL`/`LINE_PUSH_URL`/`LINE_LOADING_URL`/
  `LINE_CONTENT_URL_FMT`/`LINE_BOT_INFO_URL`；每气泡 5000 字符、安全 4500、
  每次 Reply/Push ≤ 5 条、reply token TTL 50s（保守值）、webhook body 1 MiB、
  默认端口 8646、路径 `/line/webhook`、媒体前缀 `/line/media`、默认 bind `None`
  （IPv4+IPv6 双栈，NS-603 回归）。
- **Markdown 剥离** `strip_markdown_preserving_urls` L225：code fence 保留内容 →
  inline code 去反引号 → `[label](url)` → `label (url)` → 去 `**`/`*`/`#`/bullet。
- **分块** `split_for_line` L263：优先段落/换行切分，最多 5 块，超出截断加 `…`。
- **验签** `verify_line_signature` L309：HMAC-SHA256(raw body, channel_secret) →
  base64 → `hmac.compare_digest` 常量时间比较。
- **状态机** `State` L336 + `RequestCache` L352：`PENDING → READY → DELIVERED`
  （+`ERROR`），pending TTL 24h、其余 1h；`set_ready` 对 DELIVERED 是 no-op。
- **去重** `_MessageDeduplicator` L426：webhookEventId LRU（上限 1000）。
- **source 解析** `_resolve_chat` L450：user→`U…`/dm、group→`C…`/group、
  room→`R…`/room；**allowlist** `_allowed_for_source` L470 三张表 + allow_all。
- **REST 客户端** `_LineClient` L498：直接用 `aiohttp`（**刻意不用 line-bot-sdk**，
  L501-504 注释：SDK 自带 httpx pin、4 个端点收益小）——`reply` L514 / `push` L527 /
  `loading` L540（DM-only，5 秒步进 ≤60s）/ `fetch_content` L558 / `get_bot_user_id`
  L569。
- **消息构造** L588-647：`_text_message` / `_image_message` / `_audio_message` /
  `_video_message` / `build_postback_button_message`（Template Buttons，text≤160、
  altText≤400、label≤20、postback data 为 JSON：`{"action":"show_response","request_id":…}`）。
- **主适配器** `LineAdapter(BasePlatformAdapter)` L689（ABC 在
  `gateway/platforms/base.py` L2884）：`connect` L798（凭据→scoped lock 防同 token
  双 profile→`get_bot_user_id`→起 aiohttp 服务器）；`_handle_webhook` L935（1 MiB
  body cap→验签 401→JSON→逐 event `_dispatch_event` L966）；`_handle_message_event`
  L1001（存 reply token→入站媒体下载缓存→typing→`MessageEvent`）；`_handle_postback_event`
  L1069（按 READY/ERROR/DELIVERED/PENDING 分发）；`send` L1170（system-bypass 前缀
  `⚡/⏳/⏩/💾` 直发；有 PENDING 按钮则写缓存）；`_send_text_chunks` L1195
  （strip→chunk→reply 优先→push 兜底）；`_consume_reply_token` L1226；
  `_keep_typing` 后处理 L1280-1315（超阈值烧掉 reply token 发按钮）；
  `interrupt_session_activity` L1317（`/stop` 把孤儿 PENDING 置 ERROR）；
  媒体 L1324-1564（`_register_media` 临时 token→`_media_url`→`_handle_media`
  允许根目录守卫→`send_image_file` 10MB / `send_voice`+`send_video` 200MB、
  `LINE_PUBLIC_URL` 守卫）。
- **插件入口**：`check_requirements` L1584、`validate_config` L1597、`is_connected`
  L1608、`_env_enablement` L1613（env-only 自动 seed）、`_standalone_send` L1637
  （cron `deliver=line` 无 adapter 进程时的 Push-only 发送）、`interactive_setup`
  L1682（`hermes setup line` stdin 向导）、`register` L1724
  （`register_platform(name="line", required_env=[…], cron_deliver_env_var=
  "LINE_HOME_CHANNEL", standalone_sender_fn=…, max_message_length=4500, …)`）。

数据流：

```
LINE app ──webhook POST──> aiohttp /line/webhook ──X-Line-Signature 验签──>
_dispatch_event（dedup→self-echo→allowlist）──> _handle_message_event（存 reply
token + 入站媒体）──> MessageEvent ──> handle_message() ──> agent
出站：agent ──> send()/send_image_file() 等 ──> split+strip ──> reply token 优先
（免费）──失败/过期──> push（计费）──> api.line.me
慢回复：_keep_typing 超阈值 ──> 烧原 token 发 Template Buttons postback ──> 用户
tap ──> _handle_postback_event 用新 token 送缓存答案（仍免费）
```

## 3. Target TypeScript design

**推荐：不移植**（out of scope，理由见 §1/§9）。为记录"若桌面未来自托管 gateway"
时的设计，给出模块布局（design only，不写实现）：

```
packages/line-platform/                 # 或未来 web/src/platforms/line（in-process）
  line-constants.ts   # 端点 URL、5000/4500/5/TTL50s/8646/路径/1MiB/10MB/200MB 常量
  crypto.ts           # verifyLineSignature（crypto.createHmac + timingSafeEqual）
  formatting.ts       # stripMarkdownPreservingUrls / splitForLine（逐行移植 L225/L263）
  policy.ts           # resolveChat / allowedForSource / isSystemBypass（L450/L470/L662）
  cache.ts            # RequestCache 状态机 + _MessageDeduplicator（L352/L426，Map+LRU）
  messages.ts         # textMessage/imageMessage/audioMessage/videoMessage/
                      #   buildPostbackButtonMessage（L588-647）
  client.ts           # LineClient：reply/push/loading/fetchContent/getBotUserId
                      #   （内置 fetch/undici，见 §5）
  webhook-server.ts   # Node http：POST /line/webhook + GET /line/webhook/health +
                      #   GET /line/media/:token/:file（body cap + 根目录守卫）
  adapter.ts          # LineAdapter：connect/disconnect/send/sendImageFile/sendVoice/
                      #   sendVideo/_consumeReplyToken/_keepTyping 状态机（对齐 §2）
  standalone-send.ts  # 仅 Push 的 cron 直发（对齐 _standalone_send L1637）
  config.ts           # 读 LINE_* env / platform config；解析 allowlist CSV
```

关键接口签名（示意，非实现）：

```ts
interface LinePlatformAdapter {            // BasePlatformAdapter 的 TS 等价
  connect(cfg: LineConfig): Promise<ConnectResult>;   // 验凭据 + 起 webhook 服务器
  disconnect(): Promise<void>;
  send(chatId: string, content: string, replyTo?: string): Promise<SendResult>;
  sendImageFile(chatId: string, path: string, caption?: string): Promise<SendResult>;
  sendVoice(chatId: string, path: string, durationMs?: number): Promise<SendResult>;
  sendVideo(chatId: string, path: string, previewPath?: string): Promise<SendResult>;
  sendTyping(chatId: string): Promise<void>;
  onWebhook(req: IncomingMessage, body: Buffer): Promise<WebhookResponse>;
}
interface LineConfig {
  channelAccessToken: string; channelSecret: string;
  host?: string; port: number; webhookPath: string; publicBaseUrl?: string;
  allowAll: boolean; allowedUsers: Set<string>; allowedGroups: Set<string>;
  allowedRooms: Set<string>; slowResponseThreshold: number;
}
```

运行形态：若 port，webhook 服务器必须由**常驻进程**监听公网端口（Tauri 托管 Node /
Rust sidecar 子进程），webview 内不可靠（需对外 HTTPS + 媒体文件系统 + 长生命期
Reply token 关联）。事件经 `web/src/lib/transport.ts` 同接口送入 agent loop。

## 4. Data models & persistence

| 数据 | Python 位置 | 结构 | TS 策略 |
|---|---|---|---|
| reply token 缓存 | `LineAdapter._reply_tokens` L779（chat_id → (token, expiry)） | in-memory dict | `Map<string, {token, expiresAt}>`，无持久化（与 Python 一致） |
| 慢回复 postback 缓存 | `RequestCache` L352 + `_pending_buttons` L792 | in-memory（TTL 24h/1h） | `Map` + TTL 清理；**重启丢失**（tap 降级：PENDING→重新提示 / READY 丢失→已交付文本），与 Python 一致 |
| 入站去重 | `_MessageDeduplicator` L426（LRU 1000） | in-memory | `Map` + FIFO 上限；不持久化 |
| 媒体 token | `_media_tokens` L786（token → (path, expiry)，TTL 30min）+ `_media_temp_paths` | in-memory + 临时文件 | `Map` + `fs.unlink` 清理；临时文件放系统 temp / app data |
| 媒体文件 | 入站 `cache_*_from_bytes`（`~/.hermes/cache/…`）；出站注册本地路径 | 文件系统 | app data 下同布局；`_handle_media` 的 allowed-roots 守卫需移植（tempdir + HERMES_HOME，`fs.realpath` 后 `isRelative` 检查） |
| 配置 | `~/.hermes/.env` `LINE_*` + `config.yaml platforms.line.extra` | env / yaml | 桌面沿用 settings 通用 env 编辑器保存/重启；自托管后改本地 config 文件 |
| bot 自身 userId | `connect()` 时 `get_bot_user_id` | in-memory | `Map` 缓存，失败容忍（与 Python 一致） |
| 会话本身 | gateway session store（`~/.hermes/sessions/`） | 通用 | 由 `plans/messaging-gateway-core.md` / session-lifecycle 覆盖，LINE 无专属格式 |

schema migration：无新持久化格式（全部 in-memory）；唯一文件是媒体临时文件，与
Python 保持相同命名/扩展（image→.jpg、audio→.m4a、video→.mp4、file→原名）。

## 5. Third-party library strategy

**kimi-code 验证结果（本轮实测）**：
- `D:/kimi-code` 全树 grep `@line/bot-sdk`：**0 命中**（源码 + package.json +
  pnpm-lock.yaml 全部 0；`ls node_modules/@line` 不存在）。
- 全树 grep `LINE Messaging|lineMessaging|line-bot|Messaging API|@line`：仅
  `apps/kimi-code/dist-web/assets/*.js/css` 打包产物命中（如 CSS 变量 `--underline-*`、
  通用 `-line-` 字符串），**非真实引用**；`LINE_NOTIFY` 0 命中。
- `package.json` grep `telegram|discord|slack|whatsapp|feishu|dingtalk|wecom|weixin`：
  **0 命中**——kimi-code 连其他 IM 平台适配器都没有，更没有 LINE。
- 结论：**kimi-code 没有任何 LINE / messaging 平台 TS 实现可作证据**；TS 侧必须
  from scratch。

| Python 依赖 | TS 等价 | 证据 / 设计 |
|---|---|---|
| `aiohttp`（webhook 服务器 + REST 客户端） | Node 内置 `http`/`fetch`（undici） | kimi-code：`packages/kap-server` 有 HTTP 服务先例；Node 18+ 内置 fetch。Python 侧 L501-504 刻意不用 SDK，TS 侧 1:1 对齐也走薄实现 |
| `hmac`/`hashlib`（HMAC-SHA256 验签） | Node 内置 `crypto.createHmac('sha256', secret)` + `timingSafeEqual` | 内置能力，无第三方 |
| `pybase64`/`orjson`（base64 / JSON） | 内置 `Buffer.toString('base64')` / `JSON.parse` | 内置能力 |
| `re`（markdown 剥离正则） | 内置 `RegExp`（逐行移植 L216-260 8 条正则 + 顺序） | Hermes 私有逻辑，从零移植（parity 见 §10） |
| `secrets`/`uuid`（token/request_id） | `crypto.randomBytes(32).toString('base64url')` / `crypto.randomUUID()` | 内置能力 |
| `mimetypes` | `mime-types` npm 或手动 map（image/jpeg、audio/mp4、video/mp4） | 可手动 map，映射表很小 |
| `cache_*_from_bytes`（`gateway/platforms/base.py` 媒体缓存） | 桌面已有文件缓存工具 / `fs.writeFile` 到 app data cache | kimi-code：`packages/minidb`/fs 先例 |
| 官方 `@line/bot-sdk`（npm，候选调研） | **推荐不引**；仅可选 `import type` 用其 webhook event / 消息类型 | 见下方 SDK 决策 |

**@line/bot-sdk 调研结论（TS SDK）**：npm 官方包 `@line/bot-sdk`
（line-bot-sdk-nodejs）存在、TS-first，提供 Express/Fastify/Koa 适配器中间件、
Messaging API client、webhook event 全量类型。**推荐不引 SDK**，理由：
1. Python 侧明确为避开 SDK 的依赖 pin / API 封装而用裸 aiohttp（adapter L501-504），
   TS 用 `fetch` + `crypto` + `http` 可 1:1 对齐 Python 行为（验签/去重/5 条批处理/
   错误映射），避免 SDK API 漂移与双份实现；
2. 实际只调用 5 个端点（reply/push/loading/content/bot info），SDK 收益小；
3. kimi-code 无使用先例，引入即"首次大依赖"，需依赖评审。若未来要省事，可用
   `@line/bot-sdk` 的**类型**（`import type`）而非运行时依赖——这是零运行时成本。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（桌面不 port 时的集成点，全部实测）：
- `web/src/routes/settings.tsx` — 通用 env/config 编辑器；L1478-1485 已有
  `Object.entries(status.gateway_platforms)` 通用平台状态列表，`line` 平台状态
  （`connected/not_configured/error` 等）**自动透传显示，无需新增代码**。
- `web/src/lib/config-translations.ts` — 实测**无 `line.*` / `LINE_*` 键**（现有
  `telegram.*`/`discord.*` 区块）；若想给 LINE 配置项加中文翻译需新增（可选小改）。
- `web/src/lib/im-onboarding-diagnostics.ts` + `web/src/routes/im-onboarding.tsx` —
  **仅 CN IM**：`ImPlatform = "feishu" | "weixin"`
  （`packages/protocol/src/channels.ts` L491），route 层 `ImSection = "feishu" |
  "weixin" | "dingtalk"`（im-onboarding.tsx L52）；诊断 bundle 的
  `DIAGNOSTIC_REQUIRED_KEYS`/`DIAGNOSTIC_POLICY_KEYS`（diagnostics L105-113）只含
  feishu/weixin。**没有 LINE onboarding 页**，无需新增（LINE 走通用 settings env）。
  若未来要"仅管理"页，可复用 `hooks/use-im-onboarding.ts` 的
  `useMessagingPlatform` / `useTestMessagingPlatform`
  （`GET/POST /api/messaging/platforms[/:id/test]`，平台无关且已存在）。
- `web/src/lib/transport.ts` / `gateway-client.ts` — REST env 保存/重启 + WS
  JSON-RPC 会话事件；LINE 本身不经桌面 WS（见 §7）。
- Rust 侧无需新 Tauri 命令：配置/状态经 `api_proxy.rs` 透传；仅当未来自托管
  gateway 时才考虑 sidecar 起 webhook 服务器。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今日由 Python `hermes_cli/web_server.py` 暴露，桌面
`transport.ts` / `gateway-client.ts` 消费；与 `plans/messaging-gateway-core.md` §7
一致）：
- `GET /api/status` → `gateway_platforms.line`（连接状态/错误码）——`useStatus`
  已消费；
- env 保存/重启（`LINE_*` 全部变量）——settings 通用 env 编辑器已消费；
- `GET/POST /api/messaging/platforms[/:id/test]`——平台无关，已存在（hooks 已用）；
- cron `deliver: line` 的 `LINE_HOME_CHANNEL` 目标——由 Python cron/gateway 侧处理。

迁移路径：
1. **今天（现状）**：桌面继续通过 REST 管理 LINE 配置、读取平台状态；LINE adapter
   只在托管 Python runtime 中运行。无变化。
2. **WS 移除对 LINE 的影响**：LINE 消息**从不经过桌面 WS**——入站消息进入 gateway
   agent，桌面聊天区通过 gateway session 事件（JSON-RPC）看到结果；移除 `/api/ws`
   后，桌面需要由 `plans/messaging-gateway-core.md` 定义的新会话事件通道（桌面聊天
   UI 成为 "local platform"），平台状态展示降级为 `useStatus` 轮询（已具备）。对
   LINE 本身**零影响**。
3. **如果桌面未来自托管 gateway（in-process TS agent）**：才需要按 §3 port LINE
   adapter；届时删除 `ws_proxy.rs` / `api_proxy.rs` 相关转发，改为 in-process
   `LineAdapter` 直接把 `MessageEvent` 送 agent loop，`send()` 走 `IEventBus` 等价物。

## 8. Migration phases & task breakdown

> 仅当 §1 的 port 决策被推翻（桌面自托管 gateway）时执行；否则 Phase 0 即为终态。

- **Phase 0 — 记录与冻结（本 plan）**：确认 LINE out of scope；冻结 §7 API surface；
  桌面零代码改动。验收：settings 能显示 `gateway_platforms.line` 状态；env 编辑器能
  保存 `LINE_*` 并重启。
- **Phase 1 — 纯函数移植（设计先行）**：`crypto.ts`（验签）、`formatting.ts`
  （strip + split）、`policy.ts`（source/allowlist/system-bypass）、`messages.ts`
  （消息构造）、`cache.ts`（RequestCache + dedup）。验收：与
  `test_line_plugin.py` 逐断言 parity（vitest）。
- **Phase 2 — 客户端与服务器**：`client.ts`（fetch 版 reply/push/loading/content/
  bot info）、`webhook-server.ts`（`/line/webhook` + `/health` + `/line/media/*`，
  1 MiB body cap、401 验签、413/400 错误映射、双栈 bind 语义）。验收：本地起服 +
  curl 伪造签名请求测 401/200。
- **Phase 3 — adapter 接线**：`adapter.ts`（connect/disconnect/send/sendMedia/
  _consumeReplyToken/_keepTyping 慢回复 postback 状态机 + `/stop` 孤儿清理）、
  `standalone-send.ts`。验收：mock LINE 端点的 integration tests（与 Python
  `tests/gateway/test_line_plugin.py` 用例一一对应）。
- **Phase 4 — 桌面自托管接入**（若启用）：webview 内 in-process adapter → agent
  loop；Rust sidecar 起 webhook 监听；settings 显示本地 adapter 状态；删除 WS 路径。
  验收：Playwright E2E 配置 → 起服 → LINE 测试通道收发。

## 9. Risks & open questions

**"no TS equivalent found" 风险清单**：
1. **kimi-code 整体缺席 LINE / 所有 IM 平台**——无任何 TS 证据可引用；整个 adapter
   必须 from scratch。已用 npm 生态知识补齐 `@line/bot-sdk` 调研，但**无仓库内先例
   验证**（锁版本 + 依赖评审是前提）。
2. **`strip_markdown_preserving_urls` / `split_for_line` 为 Hermes 私有**——8 条
   正则管线 + 段落/换行/空格三级切分 + 5 块截断，必须逐断言对齐
   `test_line_plugin.py`（含 `test_split_caps_at_five_chunks` 这类边界）。
3. **慢回复 postback 状态机为 Hermes 私有**——PENDING→READY→DELIVERED+ERROR、
   `_keep_typing` 定时器与 `_pending_buttons` 单槽、`interrupt_session_activity`
   孤儿清理；TS 侧无现成等价，重启即丢失（tap 降级行为需明确定义）。
4. **`@line/bot-sdk` 不在 kimi-code node_modules**（验证：`node_modules/@line` 不存在、
   pnpm-lock 0 命中）；不引 SDK 的决定依赖"薄 fetch 客户端"路径，若未来 LINE 加
   新 API（如 flex message 富文本、quota API），SDK 类型收益可能变大，需重评。
5. **webhook 需要公网 HTTPS + 常驻进程**——桌面 standalone 无法可靠托管（同一
   风险在 discord/slack/whatsapp/telegram plans 已记录）；tunnel 教程属 Python 文档
   域（line.md L37-54），TS 化后仍需用户侧 cloudflared/ngrok。

**Open questions**：
- 桌面是否要"仅管理"LINE 配置页（复用 `useMessagingPlatform`），还是维持纯通用
  settings env 编辑？本 plan 默认后者（与 WhatsApp 一致）。
- LINE 群组/房间 allowlist 的 onboarding 引导（找 `C…`/`R…` ID 需要 grep 日志）是否
  值得做桌面专属 UI？Python 侧是 CLI/文档域。
- 未来自托管时 webhook 由 Rust sidecar（Node/TS 运行时）还是 webview 内 Node worker
  承载？影响 §3 模块边界（`webhook-server.ts` 是否独立进程）。

## 10. Test strategy

**Parity 基准**：`D:/hermes-agent-cn/tests/gateway/test_line_plugin.py`（509 行，
经 `tests/gateway/_plugin_adapter_loader.load_plugin_adapter("line")` 加载）。TS 侧
vitest 用例按 1:1 映射：

| Python 测试类 | TS 对应（vitest） |
|---|---|
| `TestSignature` | `crypto.test.ts`：错 secret 拒绝、空 secret 拒绝、常量时间比较 |
| `TestSourceResolution` / `TestAllowlist` | `policy.test.ts`：user/group/room 解析 + 三 allowlist + allow_all 短路 |
| `TestDedup` | `cache.test.ts`：webhookEventId 去重 |
| `TestRequestCache` | `cache.test.ts`：PENDING→READY→DELIVERED、DELIVERED 后 set_ready no-op、prune |
| `TestMarkdownAndChunking` | `formatting.test.ts`：bold/italic 剥离、URL 保留、段落切分、5 块上限 |
| `TestInboundMedia` | `adapter.test.ts`：image→PHOTO+image/jpeg、fetch_content mock、cache 调用 |
| `TestSendRouting` / `TestMessageTypeMapping` | `adapter.test.ts`：system-bypass、≤5 条/调用、format_message、MessageType 映射（无 `IMAGE` 枚举回归） |
| `TestRegister` / `TestEnvEnablement` / `TestStandaloneSend` / `TestPostbackButtonShape` / `TestCheckRequirements` / `TestValidateConfig` / `TestAdapterInit` | `config.test.ts` / `standalone-send.test.ts` / `messages.test.ts`：register 元数据、env seed、缺 token 报错、template buttons JSON 形状、凭据校验 |
| `TestDualStackBind` / `TestMediaPublicUrlGuard` | `webhook-server.test.ts`：`host: undefined` 双栈 bind（v4+v6 socket）、缺 `LINE_PUBLIC_URL` 拒绝媒体发送 |

集成/E2E：mock `api.line.me` 的 fetch 层（`nock`/`undici.MockAgent`）；Playwright
E2E（若自托管）覆盖 settings 保存 `LINE_*` → 重启 → `gateway_platforms.line` 状态
变化；`/line/webhook/health` 返回 `{"status":"ok","platform":"line"}`。

## 11. Reference links

- Python 源：`D:/hermes-agent-cn/plugins/platforms/line/adapter.py`、
  `.../plugin.yaml`、`.../__init__.py`
- Python 文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/line.md`
- Python 测试：`D:/hermes-agent-cn/tests/gateway/test_line_plugin.py`、
  `tests/gateway/_plugin_adapter_loader.py`
- 基类接口：`D:/hermes-agent-cn/gateway/platforms/base.py`
  （`BasePlatformAdapter` L2884、`MessageEvent`/`MessageType`/`SendResult`、
  `cache_*_from_bytes`）
- 同类平台 plans：`D:/Hermes-CN-Desktop/plans/whatsapp-platform.md`、
  `discord-platform.md`、`slack-platform.md`、`telegram-platform.md`
- 共享 gateway 设计：`D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md`（§6-§7）
- 桌面集成点：`web/src/routes/settings.tsx`（L1478-1485）、
  `web/src/lib/im-onboarding-diagnostics.ts`、`web/src/routes/im-onboarding.tsx`、
  `packages/protocol/src/channels.ts`（L491 `ImPlatform`）、
  `web/src/lib/transport.ts`、`web/src/lib/gateway-client.ts`
- 官方 LINE Messaging API：https://developers.line.biz/en/docs/messaging-api/
- npm SDK 调研：https://www.npmjs.com/package/@line/bot-sdk（kimi-code 内无此依赖）
