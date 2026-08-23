# Signal Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

Signal 接入是 Hermes messaging gateway 的平台适配器之一（`Platform.SIGNAL`）：通过
**signal-cli 守护进程的 HTTP 模式**运行——入站消息走 SSE（`GET /api/v1/events`），
出站消息/动作走 JSON-RPC 2.0（`POST /api/v1/rpc`）。Signal 是端到端加密的隐私优先
messenger，bot 以“linked device”（副设备）身份接入，不需要额外 Python 依赖（仅
`httpx`，外部依赖是 Java 17+ 的 signal-cli）。

**核心决策（recorded port decision）**：本功能属于 **gateway-side 平台适配器**，
桌面 standalone 是 React webview 内进程式 agent runtime（TS），**不托管 messaging
gateway**；因此 Signal adapter **out of scope for desktop standalone**——与
`plans/discord-platform.md`（§1）、`plans/slack-platform.md` 以及
`plans/messaging-gateway-core.md`（§9）对 Telegram/Discord/Slack 平台的处理一致：
保留本 plan 记录 port 决策与未来若桌面自托管 gateway 时的 TS 设计，但不在桌面内实现
bot 长连接。

**TS 方案研究结论**：`D:/kimi-code` 全树 **无任何 Signal messenger 相关实现**
（grep `signal-cli|libsignal|signal messenger|@signal|SignalClient|signal-client`
= 0 命中；`pnpm-lock.yaml` 中只有无关的 `signal-exit`，`node_modules/.pnpm` 只有
`alien-signals`/`human-signals`/`signal-exit`）。TS 生态两条路线：
1. **推荐：继续使用 signal-cli 外部守护进程的 HTTP 桥**（signal-cli daemon 本身就是
   “REST 桥”），TS 只写纯 HTTP+SSE 客户端——零 Signal 协议复杂度，与 Python 行为一一对应；
2. **不推荐：`@signalapp/libsignal-client` 原生协议客户端**——需要实现 Signal Server
   WebSocket 协议、provisioning、prekeys、sealed sender、zkgroups 等，且是
   Rust/WASM 原生依赖，kimi-code 无先例，桌面打包复杂度高（详见 §5/§9）。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/gateway/platforms/signal.py` | 1,707 行 | 主适配器 `SignalAdapter(BasePlatformAdapter)`：connect/disconnect、SSE 监听 `_sse_listener`、健康监控 `_health_monitor`、`_handle_envelope` 事件分发、JSON-RPC `_rpc`、`send*` 全媒体路径、reaction/typing、回声过滤（Note to Self / 同步发送） |
| `D:/hermes-agent-cn/gateway/platforms/signal_format.py` | ~130 行 | `markdown_to_signal(text) -> (plain_text, textStyles)`：Markdown → Signal 原生 `bodyRanges`（BOLD/ITALIC/STRIKETHROUGH/MONOSPACE，UTF-16 位置） |
| `D:/hermes-agent-cn/gateway/platforms/signal_rate_limit.py` | ~300 行 | 进程级 token-bucket 附件限流调度器（`asyncio.Lock` FIFO；容量 50、默认 refill 4s、每消息上限 32 附件、最多 2 次尝试）+ 429/RetryLater/RateLimitException 识别 |
| `D:/hermes-agent-cn/website/docs/user-guide/messaging/signal.md` | 258 行 | Setup（link device、daemon、env）、访问控制、Features、Troubleshooting、Security |
| `D:/hermes-agent-cn/tests/gateway/test_signal.py` | 1,335 行 | ~30 个测试类（见 §10 parity 清单） |

依赖的 gateway 侧实现：
- `gateway/platforms/base.py` — `BasePlatformAdapter`、`MessageEvent`、`MessageType`、
  `ProcessingOutcome`、`SendResult`、`cache_image_from_bytes/audio/document/url`
- `gateway/platforms/helpers.py` — `redact_phone`（日志手机号打码）
- `gateway/platforms/media_cache.py` — `DEFAULT_EXT_TO_MIME`、`mime_for_ext`
- `tools/audio_container.py` — 魔数容器嗅探（MP3 vs ADTS AAC 等）
- `gateway/run.py` — DM 授权（`SIGNAL_ALLOWED_USERS` / pairing）、`SIGNAL_ALLOW_ALL_USERS`

功能面（来自 docs + 源码）：
- **连接**：`connect()` 先 `GET /api/v1/check` 健康检查 → 按 phone 加 scoped lock →
  启动 `_sse_listener` + `_health_monitor`；SSE 断线指数退避（2s→60s，±20% jitter），
  120s 无活动则 ping daemon 并强制重连。
- **入站**：`_handle_envelope` 处理 `syncMessage`（Note to Self 提升、echo 抑制）、
  stories 过滤、群允许列表（`SIGNAL_GROUP_ALLOWED_USERS`）、`require_mention`、
  群内自提及剥离、mention `\uFFFC` 渲染、quote 回复上下文、附件下载
  （`getAttachment` RPC）、消息类型分类（VOICE/PHOTO/VIDEO/DOCUMENT）、内容空信封跳过。
- **出站**：`send()` 把 markdown 转成 `textStyle`/`textStyles` 原生格式；DM 用
  `_resolve_recipient`（number↔UUID 缓存 + `listContacts` RPC），群用 `groupId`；
  `SendResult(message_id=None)`——**Signal 无已发消息编辑**（`SUPPORTS_MESSAGE_EDITING=False`）。
- **媒体**：`send_multiple_images`（每消息 ≤32 附件、token-bucket 限流、>10s 预等待
  通知、429 retry）、`send_image/image_file/voice/video/document`（≤100MB）；语音走
  `_remux_aac_to_m4a`（ffmpeg `-c:a copy` 无损转 M4A 供 STT）。
- **互动**：`send_typing`（8s 刷新 + NETWORK_FAILURE 冷却/退避）、`send_reaction`/
  `remove_reaction`（`sendReaction` RPC，`on_processing_start` 发 👀、
  `on_processing_complete` 移除）、`get_chat_info`（`getContact` RPC）。
- **回声防护**：`OrderedDict` LRU（512 条，TTL 300s）追踪最近出站 timestamp，
  过滤 `syncMessage` 自同步回显；独立 500 条缓存支持“回复自己消息”的 quote 识别。

环境变量（docs env 表）：`SIGNAL_HTTP_URL`（必填，默认 `http://127.0.0.1:8080`）、
`SIGNAL_ACCOUNT`（必填，E.164）、`SIGNAL_ALLOWED_USERS`、`SIGNAL_GROUP_ALLOWED_USERS`
（`*` = 全部，缺省 = 禁群）、`SIGNAL_ALLOW_ALL_USERS`、`SIGNAL_HOME_CHANNEL`、
`SIGNAL_REQUIRE_MENTION`。

## 3. Target TypeScript design

推荐：**不移植**（out of scope，理由见 §1/§9）。为记录“若桌面未来自托管 gateway
时应如何设计”，给出如下模块布局（design only）：

```
web/src/platforms/signal/
  config.ts        # SignalConfig 读取/校验（SIGNAL_* 等价物；envLookup 注入）
  http.ts          # JSON-RPC 2.0 客户端：rpc(method, params) → Result
  sse.ts           # SSE 监听器：连接/退避/健康监控/事件行解析（替代 asyncio task）
  envelope.ts      # _handle_envelope 移植：syncMessage/group/mention/quote/附件
  send.ts          # send / sendTyping / sendReaction / send_multiple_images
  attachments.ts   # 附件下载缓存、100MB 上限、AAC→M4A remux（ffmpeg 调用）
  formatting.ts    # markdown_to_signal 移植（bodyRanges 生成，UTF-16 位置）
  rate-limit.ts    # token-bucket 调度器（asyncio.Lock → 单线程互斥/队列）
  echo-filter.ts   # 最近发送 timestamp LRU+TTL、Note to Self 提升、echo 抑制
```

关键接口签名（示意，非实现）：
```ts
interface SignalPlatformAdapter {
  connect(cfg: SignalConfig): Promise<boolean>;         // /api/v1/check + SSE 启动
  disconnect(): Promise<void>;
  onEnvelope(env: SignalEnvelope): Promise<void>;       // 与 gateway 核心解耦的入站回调
  send(chatId: string, content: string, opts?: SendOpts): Promise<SendResult>;
  sendMultipleImages(chatId: string, images: Array<[url, alt]>): Promise<void>;
  sendReaction(chatId: string, emoji: string, targetAuthor: string, targetTs: number): Promise<boolean>;
  sendTyping(chatId: string): Promise<void>;            // 带失败冷却
  resolveRecipient(chatId: string): Promise<string>;    // number↔UUID 缓存
}
```
运行形态：若 port，adapter 在桌面内作为长连接任务运行，事件经
`web/src/lib/transport.ts` 同接口（`MessageEvent`）送入 agent loop；**signal-cli
daemon 仍是外部 Java 进程**（与 Python 版相同），TS 只写 HTTP/SSE 客户端。

## 4. Data models & persistence

Python 侧持久化（TS 若移植需等价物）：

| 数据 | Python 位置/结构 | TS 策略 |
|---|---|---|
| number↔UUID 映射 | 内存缓存 `_recipient_uuid_by_number` / `_recipient_number_by_uuid`（来自信封 + `listContacts`） | 纯内存 `Map`（重启重建），可选 minidb 持久化 |
| 最近出站 timestamp | 内存 `OrderedDict` LRU（512 条 TTL 300s）+ 独立 500 条 quote 缓存 | `Map` + 时间戳戳记实现 LRU/TTL，接口 `track(ts)`/`consume(ts)`（echo-filter.ts） |
| typing 失败冷却 | 内存 `_typing_failures` / `_typing_skip_until` | 内存 `Map<chatId, {fails, skipUntil}>`，指数退避 16s→60s |
| 媒体缓存 | `cache_*_from_bytes/url`（`~/.hermes/...` 文件） | 文件缓存目录 + `fs/promises`；附件先落盘再交给 agent |
| 会话/消息本身 | gateway session store（`~/.hermes/sessions/`） | 由 `plans/messaging-gateway-core.md` 与 session-lifecycle plan 覆盖，不在本 adapter 内 |

适配器自身无 SQLite 账本（对比 Discord 的 recovery store）；唯一进程级状态是
rate-limit 调度器（内存 token bucket）。schema 迁移策略：不引入新持久化格式，
如未来用 minidb 存映射也只需首次启动建表。

## 5. Third-party library strategy

**kimi-code 验证结果（本轮实测）**：
- `D:/kimi-code` 全树 grep `signal-cli|libsignal|signal messenger|@signal|SignalClient|signal-client`
  → **0 命中**；`pnpm-lock.yaml` 的 `signal*` 只有 `signal-exit`；`node_modules/.pnpm`
  只有 `alien-signals`、`human-signals`、`signal-exit`（均为进程信号/响应式库，与
  Signal messenger 无关）。
- **SSE 有可用先例**：`pnpm-lock.yaml` 含 `eventsource@3.0.7` + `eventsource-parser@3.0.6`，
  `node_modules/.pnpm` 实测存在；`packages/agent-core/src/mcp/client-sse.ts` 经
  `@modelcontextprotocol/sdk/client/sse.js` 的 `SSEClientTransport` 消费。

| Python 依赖 | TS 等价 | 证据 / 设计 |
|---|---|---|
| `httpx`（SSE + JSON-RPC） | Node 内置 `fetch`/`undici` + `eventsource`（或自写 fetch-stream SSE 解析） | kimi-code：`apps/kimi-code` 大量 `fetch`；`packages/agent-core/src/mcp/client-sse.ts` 是 SSE 客户端先例（依赖树含 `eventsource@3.0.7`）。signal-cli 的 SSE 是极简 `data:` 行协议，`eventsource-parser` 或 20 行手工解析皆可 |
| `orjson` | 内置 `JSON` | — |
| `pybase64` | `Buffer.from(...).toString("base64")` / `atob` | — |
| `ffmpeg`（AAC→M4A remux） | `ffmpeg-static` + `child_process`，或 Rust `src/commands/` sidecar | kimi-code：`apps/kimi-code/src/native` 有 child-process 惯例；桌面 Tauri `src/commands/` 已有子进程先例 |
| `asyncio` 任务/锁（SSE 循环、token bucket） | 单线程 Promise 循环 + 互斥队列 | kimi-code：`packages/agent-core` 大量 async 先例；单线程反而更简单 |
| `signal-cli` 外部守护进程（Java 17+） | **外部进程不变**——TS 客户端只调同一套 HTTP 端点（`/api/v1/check`、`/api/v1/events`、`/api/v1/rpc`） | 这是“REST 桥”方案：无 npm 等价物也不需要，signal-cli 是运行时依赖而非代码依赖 |
| libsignal 原生协议客户端 | **不采用**（无 TS 等价可引用；见风险 R1） | kimi-code：无 `@signalapp/*`。需要 Signal Server 协议全套（WS、provisioning、prekeys、sealed sender、zkgroups）+ Rust/WASM 原生，工作量远超适配器本身 |
| token-bucket 附件限流调度器 | **从零实现** `rate-limit.ts`（容量 50、refill 4s、429 retry_after 反馈） | kimi-code：无现成限流器（`packages/kap-server` 无附件限流先例）；逻辑小且纯内存 |

**“no TS equivalent found” 风险清单**（详见 §9）：
1. **Signal 原生协议客户端在 TS 生态缺席 kimi-code**——若绕开 signal-cli 需要引入
   `@signalapp/libsignal-client`（Rust/WASM）且需自行实现 Signal Server 协议，风险最高。
2. **markdown→bodyRanges 转换无现成库**——`signal_format.py` 的 UTF-16 位置计算与
   样式正则（BOLD/ITALIC/STRIKETHROUGH/MONOSPACE/heading）是 Hermes 私有逻辑，须从零移植。
3. **token-bucket 限流调度器**无现成 TS 库，且需与 signal-cli ≥ v0.14.3 的
   `retryAfterSeconds` / `RATE_LIMIT_FAILURE` / `RetryLaterException` 错误形态对齐。
4. **回声过滤/Note-to-Self**（`OrderedDict` LRU+TTL、syncMessage 提升）是 Hermes
   私有逻辑，无等价物，须按 `test_signal_sync_message_handling.py` 精确移植。
5. **SSE 断线退避 + 健康监控**没有一站式库（`eventsource` 只负责连接解析），退避/踢线
   逻辑需自写。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（桌面不 port 时的集成点）：
- `web/src/routes/settings.tsx` — 通用配置编辑器；**无 Signal 专属 UI**（实测仅
  feishu 社区二维码，L82/L1660）。`web/src/lib/config-translations.ts` 无 `signal.*`
  翻译（grep 0 命中）——Signal 的 `SIGNAL_*` env 目前走通用 env 编辑器透传给托管 runtime。
- `web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts` —
  **仅 CN IM**：`ImSection = "feishu" | "weixin" | "dingtalk"`，protocol
  `ImPlatform = "feishu" | "weixin"`（`D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`
  L491）。**没有 Signal onboarding**，也不建议加——Signal 是 gateway 侧 env 配置
  （signal-cli 外部 daemon），走通用配置即可。
- 平台状态/测试走通用 messaging 端点（已存在于 protocol）：
  `packages/protocol/src/hermes-api.ts` L100-151（`MessagingPlatformInfo`、
  `MessagingPlatformsResponse`、`MessagingPlatformTestResponse`），对应 Core
  `D:/hermes-agent-cn/hermes_cli/web_server.py` L10422
  `POST /api/messaging/platforms/{platform_id}/test`——Signal 若未来需要“检测连接”
  按钮可直接复用，无需新协议类型。
- Rust 侧无需新 Tauri 命令（无 sidecar 语音）；`src/commands/ws_proxy.rs`、
  `src/commands/api_proxy.rs`、`src/commands/gateway.rs` 是 WS 移除对象（见 §7）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今日由 Python `hermes_cli/web_server.py` 暴露，桌面
`transport.ts`/`gateway-client.ts` 消费）：
- `GET /api/status` → `gateway_platforms.signal`（连接状态/错误码）——桌面 `useStatus`
  已消费；
- `GET /api/messaging/platforms` + `POST /api/messaging/platforms/signal/test`——
  protocol 已有 schema，桌面可按需消费；
- `GET/POST /api/config` + env 保存/重启（`SIGNAL_HTTP_URL`、`SIGNAL_ACCOUNT`、
  `SIGNAL_ALLOWED_USERS` 等）——settings 页已消费；
- `/api/im-onboarding/*` — 仅 feishu/weixin，Signal 无对应 onboarding。

迁移路径：
1. **今天（Bridge）**：桌面继续通过 REST 管理 Signal 配置、读取平台状态；adapter 只在
   托管 Python runtime 中运行。无变化。
2. **WS 移除对 Signal 的影响**：Signal 消息收发**从不经过桌面 WS**（由 Python gateway
   直连 signal-cli），因此 WS 移除只影响 `gateway_platforms.signal` 状态推送——改为
   REST 轮询（`useStatus` 已具备轮询能力）或删除该展示。
3. **如果桌面未来自托管 gateway（in-process TS agent）**：Signal adapter 才需要
   port（§3 设计）；届时删除 `ws_proxy.rs`/`api_proxy.rs` 中转发，改为
   `web/src/platforms/signal/*` 直连 signal-cli。本 plan 记录该 future-work，不在当前
   桌面路线图内。
4. **推荐**：Signal adapter 保持 gateway-side out of scope；WS 移除只影响状态展示，
   不影响功能归属。

## 8. Migration phases & task breakdown

- **Phase 0 — 记录决策（本 plan）**：标注 out of scope；`_INDEX.md` #73 已占位，本文件
  即交付物。无代码。
- **Phase 1 — 维持现状（桌面侧）**：确认 settings 的 `SIGNAL_*` env 保存/重启与
  `gateway_platforms.signal` 状态读取继续工作；若 WS 先行移除，补 `useStatus` 轮询
  降级（沿用 messaging-gateway-core Phase A 的 `GatewayServiceAdapter` façade）。
- **Phase 2（条件性 future work）— TS client**：仅当桌面自托管 gateway 立项时启动。
  `web/src/platforms/signal/{config,http,sse,envelope}.ts`（signal-cli HTTP 桥客户端、
  SSE 监听、事件解析）；parity 对 `test_signal_connect_cleanup.py`、
  `test_signal_inbound_message_type_classification.py`。
- **Phase 3（条件性）— send 全路径 + 限流**：`send.ts` + `formatting.ts` +
  `rate-limit.ts` + `attachments.ts`（含 ffmpeg remux）；parity 对
  `test_signal_send_multiple_images.py`、`test_signal_rpc_rate_limit.py`、
  `test_signal_send_timeout.py`、`test_signal_rate_limit_detection.py`。
- **Phase 4（条件性）— 互动 + 回声防护**：typing/reaction + `echo-filter.ts`；parity
  对 `test_signal_typing_backoff.py`、`test_signal_quote_extraction.py`、
  `test_signal_sync_message_handling.py`、`test_recent_sent_timestamp_ring.py`。
- 每个 phase 结束跑 `pnpm test` / vitest 全量，确保无回归。

## 9. Risks & open questions

- **风险 R1 — TS 无 Signal 原生协议实现（最高）**：kimi-code 无 `@signalapp/libsignal-client`
  或其他 Signal 客户端；官方 TS 路线需要 Rust/WASM 原生依赖 + 自行实现 Signal Server
  协议（WS、provisioning、prekeys、sealed sender、zkgroups），复杂度和维护成本远超
  适配器本身。**应对**：坚持 signal-cli HTTP 桥，signal-cli 负责协议；TS 侧永远只碰
  简单 HTTP/SSE。
- **风险 R2 — signal-cli 是外部 Java 依赖**：桌面用户需自行安装/守护 Java 17+ 与
  signal-cli（link device、`daemon --http`）。若未来要“开箱即用”，需打包 sidecar
  （Tauri sidecar 惯例），本 plan 不解决。
- **风险 R3 — 附件限流是私有逻辑**：token-bucket（容量 50/refill 4s/32 上限）+ 429
  错误形态识别（typed `-5`、`[429]`、`RATE_LIMIT_FAILURE`、`RetryLaterException`）无
  库可抄；signal-cli 版本差异（<v0.14.3 无 `retryAfterSeconds`）需要测试矩阵。
- **风险 R4 — 回声/Note-to-Self 细节**：`OrderedDict` LRU+TTL、sync echo 抑制、
  “回复自己消息”识别是 Hermes 私有逻辑，移植必须逐条对齐 Python 测试，否则产生
  死循环或漏答。
- **风险 R5 — 无消息编辑**：`SUPPORTS_MESSAGE_EDITING=False`，流式输出无法擦除光标；
  TS 侧流式 UX 必须沿用 Python 的“抑制 tool-progress 气泡”策略。
- **风险 R6 — 桌面 standalone 语义**：bot 必须 7×24 常驻才能回消息，违背桌面
  standalone 定位（本地 agent 交互），这是 out of scope 的核心理由。
- **Open question Q1**：是否需要在桌面增加 Signal “仅配置管理”页（HTTP URL + account +
  allowed users + 检测连接），还是继续用通用 env 编辑器？当前建议后者（零新 UI；
  “检测连接”可复用 `/api/messaging/platforms/signal/test`）。
- **Open question Q2**：移除 WS 后 `gateway_platforms.signal` 状态轮询频率与降级策略
  （沿用 `useStatus` 即可，待 messaging-gateway-core plan 确认）。
- **Open question Q3**：若未来 port，`markdown_to_signal` 的样式集是否完整保留
  （Signal 端 client 版本决定 bodyRanges 渲染）？建议与 Python 逐字符对齐后按
  signal-cli 版本做能力检测回退。

## 10. Test strategy

Python parity 源（`D:/hermes-agent-cn/tests/gateway/test_signal.py`，1,335 行）：
- 配置/连接：`TestSignalConfigLoading`、`TestSignalAdapterInit`、
  `TestSignalConnectCleanup`（失败清理 + scoped lock）
- 辅助/格式：`TestSignalHelpers`（扩展名嗅探、AAC→M4A remux、redaction、mentions）、
  `TestSignalSSEUrlEncoding`（E.164 `+` 必须 URL-encode）、`TestSignalSessionSource`
- 入站：`TestSignalInboundMessageTypeClassification`（VOICE/PHOTO/VIDEO/DOCUMENT）、
  `TestSignalContentlessEnvelope`（profile key 跳过）、`TestSignalSyncMessageHandling`
  （Note to Self / echo 抑制）、`TestSignalQuoteExtraction`
- 发送：`TestSignalSendImageFile`、`TestSignalSendVoice`、`TestSignalSendVideo`、
  `TestSignalSendDocumentViaHelper`（100MB 上限）、`TestSignalRecipientResolution`
  （`listContacts` UUID）、`TestSignalSendReturnsMessageId`（message_id=None）、
  `TestSignalSendResultValidation`、`TestSignalSendMultipleImages`（空列表/bad files/
  单批/429 retry）、`TestSignalRateLimitDetection`、`TestSignalSendTimeout`（按批次
  缩放）、`TestSignalRpcRateLimit`（默认吞 429 vs `raise_on_rate_limit`）
- 互动：`TestSignalTypingBackoff`、`TestSignalStopTyping`、`TestSignalStopTypingExplicitRPC`
- 其他：`TestSignalPhoneRedaction`、`TestSignalAuthorization`（allowlist maps）、
  `TestSignalAttachmentFetch`（`getAttachment` 参数必须 `id`）、
  `TestSignalMediaExtraction`、`TestSignalStreamingCapabilities`（无编辑）、
  `TestSignalRecentSentTimestampRing`（TTL 驱逐）

TS 测试策略（若 port）：
- **vitest unit**：`formatting.ts` 逐条复刻 `TestSignalHelpers` 的
  `markdown_to_signal` 输出（UTF-16 位置、样式正则、代码块）；`rate-limit.ts` 复刻
  `test_signal_send_multiple_images` 的批 32/容量 50/4s refill 断言；`echo-filter.ts`
  复刻 `test_recent_sent_timestamp_ring` 的 TTL/上限。
- **integration**：用 `vi.mock` 模拟 signal-cli HTTP 端点（SSE 流 + JSON-RPC 响应），
  对应 Python `MagicMock`/`_stub_rpc` 风格，覆盖 connect/health-check/SSE 退避/
  `send`/`sendReaction`/`sendTyping` 冷却。
- **Playwright E2E**：桌面 standalone 不包含 Signal，E2E 仅验证 settings 页 `SIGNAL_*`
  env 可编辑保存（沿用现有 settings e2e），不模拟 bot；可选：若未来加“检测连接”
  按钮，用 mock `/api/messaging/platforms/signal/test`。
- parity 判定：TS 行为与 Python `test_signal_*.py` 断言一一对应（RPC 参数名、错误
  形态、限流数值、echo 抑制路径）。

## 11. Reference links

- Core 实现：`D:/hermes-agent-cn/gateway/platforms/signal.py`、
  `gateway/platforms/signal_format.py`、`gateway/platforms/signal_rate_limit.py`、
  `gateway/platforms/base.py`、`gateway/platforms/media_cache.py`
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/signal.md`
- 测试：`D:/hermes-agent-cn/tests/gateway/test_signal.py`（1,335 行，~30 测试类）
- TS 参考（无 Signal 证据，有 SSE 证据）：`D:/kimi-code`——grep
  `signal-cli|libsignal|@signal` = 0；`pnpm-lock.yaml` 含 `eventsource@3.0.7` /
  `eventsource-parser@3.0.6`；`packages/agent-core/src/mcp/client-sse.ts`
- 桌面现状：`D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`、
  `web/src/lib/config-translations.ts`、`web/src/routes/im-onboarding.tsx`、
  `web/src/lib/im-onboarding-diagnostics.ts`、`packages/protocol/src/channels.ts`（L491）、
  `packages/protocol/src/hermes-api.ts`（L100-151）
- Core Web API：`D:/hermes-agent-cn/hermes_cli/web_server.py`（L10422
  `POST /api/messaging/platforms/{platform_id}/test`）
- 相关 plan：`D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md`（#68）、
  `plans/discord-platform.md`（#70）、`plans/slack-platform.md`（#71）、
  `plans/_INDEX.md`（#73 signal-platform）
