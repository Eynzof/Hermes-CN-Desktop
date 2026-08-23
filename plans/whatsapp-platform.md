# WhatsApp / WhatsApp Cloud Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

WhatsApp 接入是 Hermes messaging gateway 的两个**独立平台适配器**（`_INDEX.md` #72
`whatsapp-platform`）：
1. **Baileys bridge**（`plugins/platforms/whatsapp/adapter.py` + Node 子进程
   `scripts/whatsapp-bridge/`）——非官方 WhatsApp Web 协议，个人账号、扫码配对、无
   公网 URL、有封号风险；支持 DM/群组全能力、原生 poll/location、文本批处理。
2. **WhatsApp Cloud API**（`gateway/platforms/whatsapp_cloud.py`）——Meta 官方
   Business 平台，纯 Python（aiohttp webhook 服务器 + httpx Graph 客户端）、需公网
   HTTPS webhook、token 鉴权、DM only（v1）、24h 会话窗口。

两者通过 `gateway/platforms/whatsapp_common.py` 的 `WhatsAppBehaviorMixin` 共享
**格式化**（markdown → WhatsApp 语法，`format_message` + 4096 字符分块）与
**访问策略**（allowlist / mention / DM / group gating）。本 feature 的两个重点行为
正是该 mixin 的格式化管线与 Baileys 桥的**媒体路径白名单校验**
（`_is_allowed_bridge_path`，含 profile override 回归，见
`test_whatsapp_formatting.py` / `test_whatsapp_media_path_profile.py`）。

**核心决策（recorded port decision）**：本功能属于 **gateway-side 平台适配器**，
桌面 standalone（React webview 内进程 agent runtime，TS）**不托管 messaging
gateway**；因此 WhatsApp / WhatsApp Cloud 两个 adapter **out of scope for desktop
standalone**——与 `plans/discord-platform.md`、`plans/slack-platform.md`、
`plans/voice-mode.md`（§9）、`plans/cron-scheduled-tasks.md`（§7）一致：保留 plan
文件记录 port 决策与"若桌面未来自托管 gateway"时的 TS 设计，但不在桌面内实现 bot
长连接 / webhook 服务器。桌面端今天通过 REST（`transport.ts`）+ WS
（`gateway-client.ts`）连托管 Python runtime 中的 gateway；WhatsApp 配置与平台状态
经通用 settings 通道透传（`gateway_platforms.whatsapp*`），无专属 onboarding 页。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/plugins/platforms/whatsapp/adapter.py` | 1,926 行 | `WhatsAppAdapter(WhatsAppBehaviorMixin, BasePlatformAdapter)`（L385）：管理 Node bridge 子进程（health 探针 + `scriptHash` 源哈希握手、`bridge.pid` pidfile + 内核 start time 防 PID 复用误杀、端口 LISTEN 探测 `_listener_pids_on_port`/`_kill_port_process`）、入站消息队列与文本批处理（`text_batch_delay_seconds` 默认 5s / split 10s）、`send`/`edit_message`/`send_poll`/`send_location`/`send_image(_file)` 等出站、媒体路径白名单 `_is_allowed_bridge_path`（L305，resolve 后必须落在 4 类 cache root 下）、`register(ctx)` 插件入口（L1907） |
| `.../whatsapp/plugin.yaml` | 33 行 | `WHATSAPP_ENABLED` required；`WHATSAPP_ALLOWED_USERS` / `WHATSAPP_ALLOW_ALL_USERS` / `WHATSAPP_HOME_CHANNEL(_NAME)` optional |
| `D:/hermes-agent-cn/scripts/whatsapp-bridge/bridge.js` | 1,154 行 | Node 桥：`@whiskeysockets/baileys` socket、QR/配对、`/health`（含 scriptHash）、`/send`、`/send-media`、`/send-poll`、`/send-location`、入站事件 POST 回 adapter |
| `.../whatsapp-bridge/bridge_helpers.js` | 626 行 | bridge 工具（allowlist.js / outbound_ids.js / owner_message_gate.js 等 + `.test.mjs`） |
| `.../whatsapp-bridge/package.json` | 20 行 | `@whiskeysockets/baileys: 7.0.0-rc13`、`express ^4.21.0`、`qrcode-terminal ^0.12.0`、`pino ^9.0.0`；`protobufjs`/`body-parser` overrides |
| `D:/hermes-agent-cn/gateway/platforms/whatsapp_cloud.py` | 2,116 行 | `WhatsAppCloudAdapter(WhatsAppBehaviorMixin, BasePlatformAdapter)`（L204）：aiohttp webhook 服务器（`GET /health` L1415、`GET <path>` verify handshake L1431、`POST <path>` L1462；默认 host 双栈、port 8090、path `/whatsapp/webhook`、`client_max_size=3MB`）、`X-Hub-Signature-256` HMAC 常量时间校验（L1530）、wamid FIFO 去重 5000（L1556）、Graph 出站（`send` Bearer+payload 形状 L514、`_upload_media` L971、`_send_media*`、ffmpeg opus 转换 L1264）、入站媒体下载 `_download_media_to_cache`（L1319）、交互按钮（clarify/exec_approval/slash_confirm）、`_build_message_event_from_cloud`（L1892）、媒体大小上限表（image 5MB / video·audio 16MB / document 100MB / sticker 100KB） |
| `D:/hermes-agent-cn/gateway/platforms/whatsapp_common.py` | 552 行 | `WhatsAppBehaviorMixin`（L64）：`format_message`（L425，6 步正则管线：fence/code 占位保护 → `*italic*`→`_italic_` → `**bold**`/`__bold__`→`*bold*` → `~~strike~~`→`~strike~` → `# header`→`*header*` → `[t](u)`→`t (u)`）、`_outgoing_chunk_limit`（MAX_MESSAGE_LENGTH=4096 减 reply prefix）、allowlist/mention/`_should_process_message`、`resolve_whatsapp_bridge_dir`（L506，install 只读时 mirror 到 HERMES_HOME） |
| `D:/hermes-agent-cn/gateway/whatsapp_identity.py` | — | `to_whatsapp_jid`（LID 解析等身份归一） |
| `D:/hermes-agent-cn/gateway/rich_sent_store.py` | — | `record/lookup(chat_id, message_id) → text`：出站 wamid→文本索引，供入站回复上下文解析 |
| `D:/hermes-agent-cn/hermes_cli/setup_whatsapp_cloud.py` | 540 行 | Cloud 向导：字段形状校验器（Phone Number ID 防粘贴手机号、token/secret 校验）、写 `.env`、打印 cloudflared + Meta 后台指引 |
| `D:/hermes-agent-cn/hermes_cli/subcommands/whatsapp.py` | — | Baileys 向导：bot/self-chat 模式、QR 展示、保存 session |
| `D:/hermes-agent-cn/hermes_cli/platforms.py` | L26-27 | 平台→默认工具集：`whatsapp`/`whatsapp_cloud` → `hermes-whatsapp` |

数据流：
- **Baileys**：gateway 启动时拉起 Node bridge 子进程（bridge_port 默认 3000）→ adapter
  轮询 `http://127.0.0.1:<port>/health`（scriptHash 握手 + read_receipts 配置一致性
  检查）→ bridge 把入站事件 POST 回 adapter → `MessageEvent` → `handle_message` →
  agent；出站 POST `/send`（reply_to 首块带 context）、`/send-media`、`/send-poll`、
  `/send-location`。
- **Cloud**：Meta 公网 webhook POST → `_handle_webhook`（验签 + 去重）→
  `_dispatch_payload` → `MessageEvent`；出站 HTTPS POST
  `graph.facebook.com/<v20.0>/<phone_id>/messages`（Bearer token）；媒体先
  `POST /<phone_id>/media` 上传再发送；入站媒体经 Graph `/media` 下载到
  `~/.hermes/platforms/whatsapp_cloud/media/`。

文档：`website/docs/user-guide/messaging/whatsapp.md`（Baileys，279 行）、
`.../whatsapp-cloud.md`（Cloud，418 行；含 24h 窗口、模板未实现、DM only 等
Known limitations）。测试：`tests/gateway/` 共 **17 个 `test_whatsapp_*.py`** +
`tests/hermes_cli/test_whatsapp_cloud_setup.py` = **18 个**。

## 3. Target TypeScript design

推荐：**不移植**（out of scope，理由见 §1/§9）。为记录"若桌面未来自托管 gateway
时应如何设计"，给出如下模块布局（design only）：

```
packages/whatsapp-platform/            # 或未来 web/src/platforms/whatsapp（in-process）
  common/
    formatting.ts     # formatMessage / truncateMessage（移植 WhatsAppBehaviorMixin L425-499）
    policy.ts         # allowlist / mention / DM·group gating（_should_process_message 等价）
    media-path.ts     # isAllowedBridgePath（移植 _is_allowed_bridge_path + 每调用解析 cache root）
  baileys/
    adapter.ts        # makeWASocket in-process；events → MessageEvent
    session.ts        # useMultiFileAuthState（auth_info 目录 = Python 的 session 目录）
    bridge-http.ts    # 仅当保留"子进程桥"模式（Rust sidecar 起 bridge.js）才需要
    qr.ts             # QR → webview（复用桌面已有 qrcode 依赖，替代 qrcode-terminal）
  cloud/
    graph-client.ts   # fetch 封装 Graph REST（send / media upload+download / 错误映射）
    webhook-server.ts # Node http：GET /health、GET verify、POST webhook（HMAC + 去重）
    media.ts          # opus 转换（ffmpeg spawn）、mime 扩展映射
    interactive.ts    # clarify / execApproval / slashConfirm 按钮状态机
  setup/
    cloud-validators.ts  # 移植 hermes_cli/setup_whatsapp_cloud.py 的字段校验器
    baileys-wizard.ts    # QR / 配对流程（CLI 或 webview 页面）
```

关键接口签名（示意，非实现）：
```ts
interface WhatsPlatformAdapter {          // BasePlatformAdapter 的 TS 等价
  connect(cfg: WhatsConfig): Promise<ConnectResult>;   // Baileys: socket open; Cloud: webhook listen
  disconnect(): Promise<void>;
  send(chatId: string, content: string, replyTo?: string): Promise<SendResult>; // 分块 + formatMessage
  onMessage(ev: MessageEvent): Promise<void>;
  sendClarify(chatId, q, options): Promise<SendResult>;   // Cloud: interactive buttons; Baileys: poll/buttons
  sendMedia(chatId, pathOrUrl, kind): Promise<SendResult>;
}
interface WhatsMediaPathValidator { validate(path: string, profileRoot: string): boolean; }
```
运行形态：若 port，Baileys 必须在 **Node 运行时**（Rust sidecar 子进程或 Tauri 托管
Node）中常驻，webview 内不可靠（需长连 WebSocket 到 WhatsApp、本地 HTTP 桥、媒体
文件系统写）；Cloud webhook 服务器同理必须由常驻进程监听公网端口。事件经
`web/src/lib/transport.ts` 同接口送入 agent loop。

## 4. Data models & persistence

| 数据 | Python 位置 | 结构 | TS 策略 |
|---|---|---|---|
| Baileys 会话 | `~/.hermes/platforms/whatsapp/session/`（`useMultiFileAuthState` 多文件：creds + keys） | JSON 文件 | 原样复用 Baileys `useMultiFileAuthState(appDataDir)`；Tauri `path_resolver` 取 app data 目录 |
| bridge pidfile | `session_path/bridge.pid`（pid + 内核 start time 两行） | 文本 | 仅在保留子进程桥模式时需要；in-process 无 pidfile，改为 `AbortController`/child handle |
| Cloud wamid 去重 | 内存 `OrderedDict` FIFO 5000（`_seen_wamids`） | in-memory | `Map` + FIFO 上限；跨重启不持久化（与 Python 一致） |
| 回复上下文索引 | `gateway/rich_sent_store.py` `record/lookup(chat_id, wamid)` | JSON 存储（hermes dir） | kimi-code `packages/minidb` 或 JSON 文件；键 `chat_id:wamid` → 文本 |
| Cloud 入站媒体缓存 | `~/.hermes/platforms/whatsapp_cloud/media/` + `cache/{images,audio,videos,documents}` | 文件 | app data 下同布局；`media-path.ts` 校验必须 resolve 后落在这些 root 内 |
| 交互按钮状态 | 内存 `_clarify_state` / `_exec_approval_state` / `_slash_confirm_state`（各 1000） | in-memory | `Map` + LRU 上限；重启丢失（tap 降级为普通文本） |
| 配置 | `~/.hermes/.env`：`WHATSAPP_*` / `WHATSAPP_CLOUD_*` | env | 桌面沿用 `transport.ts` REST 的 env 保存/重启；自托管后改本地 config 文件 |
| 会话本身 | gateway session store（`~/.hermes/sessions/`） | 通用 | 由 `plans/messaging-gateway-core.md` / session-lifecycle 计划覆盖 |

schema migration：与 Python 保持字段级兼容（Baileys session 是第三方格式，不得改；
wamid 键为 TEXT；时间为 UTC ISO-8601）；TS 首次启动自动建表/目录，不做破坏性迁移。

## 5. Third-party library strategy

**kimi-code 验证结果（本轮实测）**：
- `D:/kimi-code` 全树 grep `whatsapp|baileys`：源码（`apps`、`packages`，排除
  `dist-web`）**0 命中**；`pnpm-lock.yaml` **0 命中**；`node_modules` 下
  `@whiskeysockets` / `whatsapp-web.js` / `baileys` **均不存在**（仅 `dist-web`
  打包产物有 96 处无关文本命中，如主题/图标名，非真实引用）。
- 结论：**kimi-code 没有任何 WhatsApp TS 实现可作证据**。npm 生态核查见下。

| Python 依赖 | TS 等价 | 证据 / 设计 |
|---|---|---|
| Baileys bridge（Node 子进程 `@whiskeysockets/baileys` 7.0.0-rc13，见 `scripts/whatsapp-bridge/package.json`） | **同一库 `@whiskeysockets/baileys`**（TS-first，WebSocket 直连 WhatsApp Web，无需浏览器）；若 port 则**去掉子进程边界改为 in-process** | kimi-code：无。rationale：Python 侧本来就是"Node 跑 Baileys + HTTP 桥"，TS 化后 `makeWASocket`/`useMultiFileAuthState` 直接可用，`bridge-http.ts` 仅在保留 Rust sidecar 桥时保留。v7 有 breaking changes，锁版本 + 跟随官方迁移指南 |
| `express`（bridge HTTP） | 保留（子进程模式）或**直接函数调用**（in-process 模式，不需要 HTTP） | kimi-code：`packages/kap-server` 有 HTTP 服务先例 |
| `qrcode-terminal`（终端 QR） | `qrcode`（桌面 `web/src/routes/im-onboarding.tsx` 已依赖，`QRCode.toDataURL` 渲染 webview） | kimi-code：无 WhatsApp QR 先例；桌面 QR 渲染现成 |
| `pino`（bridge 日志） | 桌面已有日志体系或 `console` | 非关键路径 |
| `httpx`（Cloud Graph 出站） | **内置 `fetch`/`undici`**（thin client，不引 SDK） | kimi-code：`apps/kimi-code` 大量 `fetch` 用法 |
| `aiohttp`（Cloud webhook 服务器） | Node `http`/`Fastify`/`Express`；可选 `whatsapp-api-js`（server-agnostic webhook 框架，npm 6.x） | 推荐薄 `http` 服务以逐行对齐 Python 行为（bounded body 3MB、GET verify、POST webhook、503 无 app_secret 拒绝） |
| `hmac`/`hashlib`（X-Hub-Signature-256） | Node 内置 `crypto.createHmac` + `timingSafeEqual`（常量时间比较） | 内置能力，无第三方 |
| `mimetypes` + `_WHATSAPP_MIME_EXTENSION_OVERRIDES`（ogg→.ogg / audio/mp4→.m4a 等） | `mime-types` npm 或手动 map（镜像 overrides 表） | 必须复刻 override 顺序：overrides → mime → None |
| `shutil.which("ffmpeg")` + 子进程 opus 转换 | `child_process.spawn` + PATH 探测或 `ffmpeg-static` | kimi-code：`apps/kimi-code/src/native` 有子进程先例；桌面 Rust 侧有子进程惯例 |
| `re`（format_message 正则管线） | 内置 `RegExp`（移植 6 步管线 + fence/code 占位） | Hermes 私有逻辑，从零移植（parity 见 §10） |
| `sqlite3`/JSON（rich_sent_store） | `packages/minidb` 或 JSON 文件 | kimi-code：`packages/minidb` 内嵌 DB 先例 |
| STT/TTS（语音转写/回复） | 已在 `plans/tts-voice-messages.md` / `plans/voice-mode.md` 设计 | 本 plan 只引用，不重复 |
| Cloud SDK 候选（调研结论） | `@kapso/whatsapp-cloud-api`（typed，但含 Kapso proxy 倾向）、`meta-cloud-api`（活跃维护）、`whatsapp-api-js`（webhook 框架）、Meta 官方 Node SDK（**已归档 2023-06**） | **推荐不引 SDK**：Python 侧是薄 httpx/aiohttp 包装，TS 用 fetch+crypto+http 即可 1:1 对齐，避免 SDK API 漂移/供应商锁定；仅当后续需要模板/产品消息等大面时才评估 `whatsapp-api-js` |

**“no TS equivalent found” 风险清单**（详见 §9）：
1. **kimi-code 整体缺席 WhatsApp**——桌面首次引入 Baileys 大库，需依赖评审/锁版本。
2. **`format_message` 正则管线为 Hermes 私有**——无现成 npm 等价，必须从零移植且
   与 `test_whatsapp_formatting.py` 逐断言对齐（含 `# **Title**` 防双星号、`*italic*`
   → `_italic_` 等细节）。
3. **`_is_allowed_bridge_path` 为 Hermes 私有**——symlink resolve + 每调用解析 profile
   cache root（`test_whatsapp_media_path_profile.py` 的 A/B profile 切换语义）需小心
   移植（Node `fs.realpath` + `path.resolve`）。
4. **Baileys 本身易变**：v7 breaking changes、WhatsApp 协议更新、封号风险——与
   Python 侧风险相同，不因 TS 化消失。
5. **Cloud webhook 需要公网 HTTPS + 常驻进程**——桌面 standalone 无法可靠托管。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（桌面不 port 时的集成点）：
- `web/src/routes/settings.tsx` — 通用 env/config 编辑器；L1478-1485 已有
  `gateway_platforms` 通用状态列表（`Object.entries(status.gateway_platforms)`），
  `whatsapp` / `whatsapp_cloud` 的平台状态会自动透传显示，无需新增代码。
- `web/src/lib/config-translations.ts` — 实测**无 `whatsapp.*` 键**；若想给
  settings 的 whatsapp 配置项加中文翻译，需新增（可选小改，非必需）。
- `web/src/lib/im-onboarding-diagnostics.ts` + `web/src/routes/im-onboarding.tsx` —
  **仅 CN IM**：protocol `ImPlatform = "feishu" | "weixin"`
  （`D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts` L491），route 层
  `ImSection = "feishu" | "weixin" | "dingtalk"`；**没有 WhatsApp onboarding**。
  若未来要加"仅管理"页，可复用 `hooks/use-im-onboarding.ts` 的
  `useMessagingPlatform` / `useTestMessagingPlatform`
  （`GET/POST /api/messaging/platforms[/:id/test]`，已存在且平台无关）；Baileys 的
  QR 配对则需要新的 `im-onboarding` 后端端点（当前 subcommands/whatsapp.py 是 CLI
  向导，无 REST）。
- Rust 侧无需新 Tauri 命令：配置/状态经 `api_proxy.rs` 透传即可；仅当未来自托管
  gateway 时才考虑 sidecar 启动 Node bridge。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今日由 Python `hermes_cli/web_server.py` 暴露，桌面
`transport.ts` / `gateway-client.ts` 消费）：
- `GET /api/status` → `gateway_platforms.whatsapp` / `gateway_platforms.whatsapp_cloud`
  （连接状态/错误码）——`useStatus` 已消费；
- env 保存/重启（`WHATSAPP_*` / `WHATSAPP_CLOUD_*`）——settings 通用 env 编辑器已消费；
- `GET/POST /api/messaging/platforms[/:id/test]` ——平台无关，已存在（hooks 已用）。

迁移路径：
1. **今天（Bridge）**：桌面继续通过 REST 管理 WhatsApp 配置、读取平台状态；两个
   adapter 只在托管 Python runtime 中运行。无变化。
2. **WS 移除对 WhatsApp 的影响**：WhatsApp 消息**从不经过桌面 WS**——入站消息进入
   gateway agent，桌面聊天区通过 gateway session 事件（JSON-RPC）看到结果；移除
   `/api/ws` 后，桌面需要新的会话事件通道（由 `plans/messaging-gateway-core.md`
   定义），平台状态展示降级为 `useStatus` 轮询（已具备）。对 WhatsApp 本身零影响。
3. **如果桌面未来自托管 gateway（in-process TS agent）**：才需要按 §3 port 两个
   adapter；届时删除 `ws_proxy.rs` / `api_proxy.rs` 中相关转发，改为
   `packages/whatsapp-platform/*` 直接调用。本 plan 记录该 future-work。
4. **推荐**：两个 adapter 保持 gateway-side out of scope；WS 移除只影响状态/会话
   事件通道，不影响功能归属。

## 8. Migration phases & task breakdown

- **Phase 0 — 记录决策（本 plan）**：标注 out of scope；`_INDEX.md` #72 已占位。
  无代码。
- **Phase 1 — 维持现状（桌面侧，可选小改）**：确认 `gateway_platforms.whatsapp*`
  状态列表继续工作；可选给 `config-translations.ts` 补 `whatsapp.*` 翻译；可选新增
  "仅管理" settings 区块（REST 测试连接，复用 `useMessagingPlatform`）。不 port。
- **Phase 2（条件性 future work）— common 层**：`formatting.ts` + `policy.ts` +
  `media-path.ts`；parity 对 `test_whatsapp_formatting.py`、
  `test_whatsapp_media_path_profile.py`、`test_whatsapp_to_jid.py`、
  `test_whatsapp_group_gating.py` 等。
- **Phase 3（条件性）— Cloud adapter TS**：`graph-client.ts` + `webhook-server.ts` +
  `media.ts` + `interactive.ts`；parity 对 `test_whatsapp_cloud.py`、
  `test_whatsapp_cloud_allowed_users.py`、`test_whatsapp_reply_prefix.py`、
  `test_whatsapp_native_delivery.py`、`tests/hermes_cli/test_whatsapp_cloud_setup.py`
  （校验器）。
- **Phase 4（条件性）— Baileys in-process adapter**：`adapter.ts` + `session.ts` +
  `qr.ts`（webview 渲染，复用 `qrcode`）；文本批处理、poll/location、read receipts；
  parity 对 `test_whatsapp_connect.py`（health 握手/错误路径）、
  `test_whatsapp_bridge_pidfile.py`、`test_whatsapp_stale_bridge.py`、
  `test_whatsapp_text_batching.py`、`test_whatsapp_allowlist_lid_resolution.py` 等。
- **Phase 5 — 删 WS 路径**：仅在 messaging-gateway-core plan 定义新会话事件通道后
  执行；删除 `ws_proxy.rs` 中 WhatsApp 无关转发。
- 每个 phase 结束跑 `pnpm typecheck` / `pnpm test:unit` / `cargo check`，确保无回归。

## 9. Risks & open questions

- **R1 — 无 TS 先例**：kimi-code 无任何 WhatsApp/消息平台证据（已验证源码、pnpm
  lock、node_modules）。引入 Baileys 大库需依赖评审；v7 破坏性变更需锁版本。
- **R2 — 格式化管线私有**：`format_message` 的 6 步正则 + 占位保护是 Hermes 私有，
  无 npm 等价，必须逐断言移植；微小差异（如 `# **Title**` 双星号）会直接影响
  用户可见渲染。
- **R3 — 媒体路径校验语义**：`_is_allowed_bridge_path` 的 symlink resolve + profile
  override 每调用解析是安全边界；TS 移植若用 import-time 常量缓存会重蹈 Python 旧
  bug（见 `test_whatsapp_media_path_profile.py` 回归动机）。
- **R4 — Cloud 24h 窗口 / 模板未实现**：Meta 规则（`graph error 131047`）与 Python
  行为一致；TS 移植同样需要 system prompt 提示 + 未来模板支持，不能只搬发送代码。
- **R5 — Cloud webhook 公网依赖**：桌面 standalone 无法保证公网 HTTPS 可达，这是
  out of scope 的硬理由之一（与 R6 并列）。
- **R6 — Baileys 长连常驻语义**：桌面 standalone 定位是本地 agent 交互，bot 必须
  7×24 常驻才能回消息，违背定位；由"桌面自托管 gateway"或"远程 gateway 部署"解决。
- **Q1**：是否需要在桌面加 WhatsApp "仅管理"页（token + allowlist + 测试连接），
  还是继续通用 env 编辑器 + 状态列表？建议后者（零新 UI），Cloud 凭据校验可复用
  `useTestMessagingPlatform`。
- **Q2**：Baileys 的 QR 配对是否值得加 REST 端点（`im-onboarding` 风格）？Python
  侧目前只有 CLI 向导（`hermes_cli/subcommands/whatsapp.py`），桌面 QR 页面需要
  Core 新增 bridge 状态/QR 轮询端点——建议仅在用户提出需求后做。
- **Q3**：移除 WS 后平台状态轮询频率与降级策略（沿用 `useStatus` 即可，待
  messaging-gateway-core plan 确认）。

## 10. Test strategy

Python parity 源（`D:/hermes-agent-cn/tests/`）：
- `tests/gateway/` 共 **17 个 `test_whatsapp_*.py`**：`test_whatsapp_cloud.py`、
  `test_whatsapp_connect.py`、`test_whatsapp_formatting.py`、
  `test_whatsapp_media_path_profile.py`、`test_whatsapp_allowlist_lid_resolution.py`、
  `test_whatsapp_bridge_dir_resolution.py`、`test_whatsapp_bridge_pidfile.py`、
  `test_whatsapp_cloud_allowed_users.py`、`test_whatsapp_from_owner.py`、
  `test_whatsapp_group_gating.py`、`test_whatsapp_identity.py`、
  `test_whatsapp_native_delivery.py`、`test_whatsapp_plugin_setup.py`、
  `test_whatsapp_reply_prefix.py`、`test_whatsapp_stale_bridge.py`、
  `test_whatsapp_text_batching.py`、`test_whatsapp_to_jid.py`。
- `tests/hermes_cli/test_whatsapp_cloud_setup.py` — 字段校验器 + 向导 e2e（mock stdin）。

TS 测试策略（若 port）：
- **vitest unit**：`formatting.ts` 直接移植 `TestFormatMessage` / `TestMessageLimits` /
  `TestSendChunking`（strikethrough、header→bold、`# **Title**` 防双星号、
  `*italic*`→`_italic_`、4096 分块、reply prefix 预留）；`media-path.ts` 复刻
  `test_whatsapp_media_path_profile.py`（A/B profile 目录切换、symlink resolve）；
  `cloud-validators.ts` 复刻 `test_whatsapp_cloud_setup.py`（Phone Number ID 防粘贴
  手机号、token/secret/hex 校验）。
- **integration**：用 `vi.mock("@whiskeysockets/baileys")` / MSW（`fetch` mock）对应
  Python `MagicMock` 风格——覆盖 `test_whatsapp_cloud.py` 的 Bearer auth、payload
  形状（`messaging_product`/`recipient_type`/`text.preview_url`）、长消息多 POST、
  Graph 错误映射；`webhook-server.ts` 用 supertest 式请求覆盖 verify handshake、
  HMAC 验签（常量时间）、wamid 去重、503 无 secret 拒绝。
- **Playwright E2E**：桌面 standalone 不包含 WhatsApp bot；E2E 仅验证 settings 页
  `gateway_platforms.whatsapp*` 状态与 env 保存可用（沿用现有 settings e2e），
  不模拟 Meta/Baileys。
- parity 判定：TS 行为与 Python `test_whatsapp_*` 断言一一对应（正则输出、分块数、
  路径校验布尔值、payload 字段名、错误文案）。

## 11. Reference links

- Core 实现：`D:/hermes-agent-cn/plugins/platforms/whatsapp/{adapter.py,plugin.yaml}`、
  `D:/hermes-agent-cn/scripts/whatsapp-bridge/{bridge.js,bridge_helpers.js,package.json}`、
  `D:/hermes-agent-cn/gateway/platforms/whatsapp_cloud.py`、
  `D:/hermes-agent-cn/gateway/platforms/whatsapp_common.py`、
  `D:/hermes-agent-cn/gateway/whatsapp_identity.py`、
  `D:/hermes-agent-cn/gateway/rich_sent_store.py`、
  `D:/hermes-agent-cn/gateway/platforms/base.py`（BasePlatformAdapter/MessageEvent/SendResult）
- CLI：`D:/hermes-agent-cn/hermes_cli/setup_whatsapp_cloud.py`、
  `D:/hermes-agent-cn/hermes_cli/subcommands/whatsapp.py`、
  `D:/hermes-agent-cn/hermes_cli/platforms.py`
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/whatsapp.md`、
  `.../whatsapp-cloud.md`
- 测试：`D:/hermes-agent-cn/tests/gateway/test_whatsapp_*.py`（17）、
  `D:/hermes-agent-cn/tests/hermes_cli/test_whatsapp_cloud_setup.py`
- TS 参考（无 WhatsApp 证据）：`D:/kimi-code`（apps/packages 源码 0 命中、
  pnpm-lock.yaml / node_modules 均无 baileys/whatsapp-cloud-api）
- npm 生态：`@whiskeysockets/baileys`（7.0.0 RC，TS-first）、Meta 官方 Node SDK
  `whatsapp`（已归档 2023-06）、`whatsapp-api-js` / `meta-cloud-api` /
  `@kapso/whatsapp-cloud-api`（社区 Cloud 候选，推荐不引）
- 桌面现状：`D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`、
  `web/src/lib/config-translations.ts`（无 whatsapp 键）、
  `web/src/routes/im-onboarding.tsx`、`web/src/lib/im-onboarding-diagnostics.ts`、
  `web/src/hooks/use-im-onboarding.ts`、`packages/protocol/src/channels.ts`（L491）
- 相关 plan：`D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md`（#68）、
  `plans/discord-platform.md`（#70，同款 out-of-scope 决策模板）、
  `plans/tts-voice-messages.md`、`plans/_INDEX.md`（#72 whatsapp-platform）
