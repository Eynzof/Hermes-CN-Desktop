# QQ / QQ Bot Messaging Platform — Python → TypeScript Rewrite Plan

## 1. Summary

QQ Bot（官方 QQ Bot API v2，WebSocket 收 + REST 发）是 Hermes 网关的 30+ 消息平台适配器之一。Python 实现是 `D:/hermes-agent-cn/gateway/platforms/qqbot/`（约 4,841 行，其中 `adapter.py` 3,277 行），完成：AppID/Secret → access token → `/gateway` URL → `wss://api.sgroup.qq.com` 长连接（op 10 Hello / op 2 Identify / op 6 Resume / op 1 心跳 / op 0 事件分发）→ 归一化为 `MessageEvent` → agent 回话 → REST 发送（文本/markdown/媒体/内联键盘/输入态）。

**端口决策（先记录）**：消息平台适配器属于 **gateway 侧**，不是桌面 webview 内能力。当前 roadmap 里桌面端继续通过 managed Python runtime 的 REST（`/api/messaging/platforms`、`/api/status`）与 env 面板管理 QQ Bot；**不在本轮把 QQ 适配器搬进 webview**。本文件仍按 README 模板给出未来 in-process TypeScript 设计，并记录 WS 移除影响（关键结论：QQ↔QQ 服务器之间的出站 WS 与桌面↔gateway 的 `/api/ws` 是两条独立的连接；移除后者不影响前者，且浏览器 WebSocket 无法携带 QQ 网关要求的 `User-Agent` 头/无法读 `HTTPS_PROXY`，因此 in-process 后 QQ WS 必须放在 Node/Rust 侧，QQ 适配器很可能长期留在 gateway 进程）。

TS 侧结论：**kimi-code 中不存在任何 QQ Bot / qqbot 参考实现，`qq-bot-sdk` 也未出现在其 package.json 与 node_modules**（详见 §5）。官方 TS SDK 不建议作为核心依赖，按 Python 行为直接移植最稳。

## 2. Current Python implementation

源文件（`D:/hermes-agent-cn/gateway/platforms/qqbot/`）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `adapter.py` | 3,277 | `QQAdapter`（继承 `gateway/platforms/base.py:2884 BasePlatformAdapter`）：token 单飞缓存、`/gateway` 获取、WS 生命周期（`_open_ws`/`_listen_loop`/`_heartbeat_loop`/`_reconnect`/`_dispatch_payload`）、C2C/群/Guild/DM 入站处理、引用消息（`message_type=103`）、附件处理（图片缓存/语音 STT/文件）、出站文本/markdown/媒体、内联键盘审批流、ACL 策略、去重 |
| `constants.py` | 74 | `API_BASE=https://api.sgroup.qq.com`、`TOKEN_URL=https://bots.qq.com/app/getAppAccessToken`、`GATEWAY_URL_PATH=/gateway`、`PORTAL_HOST=q.qq.com`、超时/退避 `[2,5,10,30,60]`、`MAX_MESSAGE_LENGTH=4000`、消息类型 `MSG_TYPE_TEXT=0/MARKDOWN=2/MEDIA=7/INPUT_NOTIFY=6`、媒体类型、QR onboard 端点 |
| `utils.py` | 71 | `build_user_agent()`、`get_api_headers()`（q.qq.com 需要 `Accept: application/json`）、`coerce_list()` |
| `crypto.py` | 45 | `generate_bind_key()` / `decrypt_secret()`：AES-256-GCM（IV 12B ‖ ciphertext ‖ tag 16B）解密扫码返回的 `client_secret` |
| `onboard.py` | 220 | QR 扫码绑定流：`create_bind_task` → 打印二维码/URL → `poll_bind_result` → 本地解密（`qr_register()`） |
| `keyboards.py` | 461 | `InlineKeyboard`/按钮 dataclass、`build_approval_keyboard`（3 键）、`build_update_prompt_keyboard`、`parse_approval_button_data`/`parse_update_prompt_button_data`、`ApprovalRequest`/`ApprovalSender`、`parse_interaction_event` |
| `chunked_upload.py` | 602 | 三步入盘上传（`upload_prepare` → COS PUT parts → `upload_part_finish` → `/files` 带 `upload_id`）；biz_code `40093001` 可重试 / `40093002` 日限额；md5/sha1/md5_10m 哈希 |
| `__init__.py` | 91 | 兼容性 re-export（`QQAdapter`、`check_qq_requirements`、onboard、crypto、utils、chunked_upload、keyboards 全部符号） |

注册/接线：
- `gateway/run.py:14473-14478` — `_create_adapter`：`Platform.QQBOT` → `QQAdapter(config)`（先 `check_qq_requirements()`）。
- `gateway/config.py:346` `QQBOT = "qqbot"`；`config.py:901-903` 配置门（`app_id` + `client_secret`）；`config.py:2486-2522` env 默认（`QQBOT_HOME_CHANNEL`、`QQBOT_HOME_CHANNEL_NAME`、废弃 `QQ_HOME_CHANNEL`）。
- `gateway/pairing.py:87` — `"qqbot": "QQ_ALLOWED_USERS"`。
- `gateway/platforms/__init__.py:36` — 延迟 import。
- `gateway/platforms/base.py` — 接口：`MessageEvent`(2294)、`SendResult`(2460)、`BasePlatformAdapter`(2884)、`handle_message`(5967)、`build_source`(7032)、`format_message`/`truncate_message`(7142/7154)。

数据流（inbound）：QQ WS 帧 → `_dispatch_payload`（op 0 + `t`）→ `_on_message`（C2C/GROUP_AT/GUILD*/DIRECT）→ 附件/引用处理 → ACL（`_is_dm_intake_allowed`/`_is_group_allowed`，默认 `pairing`）→ `MessageEvent` → `handle_message`（base 会走 agent 会话路由）。
数据流（outbound）：`send()` → `format_message()`/`truncate_message()` 分块 → `_send_chunk`（按 `_chat_type_map` 猜 `c2c/group/guild`）→ `_api_request` REST；媒体走 URL 直传或 `ChunkedUploader`；审批/更新提示走 `send_with_keyboard` + `INTERACTION_CREATE` 回调（`_default_interaction_dispatch` → `tools.approval.resolve_gateway_approval` / 写 `~/.hermes/.update_response`）。

文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/qqbot.md`（123 行；env 表、config.yaml `platforms.qqbot.extra`、STT 两级策略、排障）。
测试：`D:/hermes-agent-cn/tests/gateway/test_qqbot.py`（1,224 行，约 40 个用例）——覆盖 §10 的 parity 清单。

## 3. Target TypeScript design

建议新 workspace 包 `packages/gateway/`（镜像 kimi-code 的 `packages/agent-core` 风格；桌面 monorepo 现有 `packages/protocol` + `packages/shared-ui`，`pnpm-workspace.yaml` 已就绪），未来 in-process runtime 使用；webview 管理面只放配置/诊断（§6）。

```
packages/gateway/src/platforms/qqbot/
├── constants.ts            // URL、timeout、退避、op/close code、消息/媒体类型
├── token.ts                // TokenManager：单飞刷新、expiresAt 提前 60s
├── ws-client.ts            // QqWebSocketClient：open/identify/resume/heartbeat/dispatch
├── adapter.ts              // QqBotAdapter：实现 PlatformAdapter 接口 + 重连/去重/chat_type_map
├── inbound.ts              // C2C/group/guild/DM 归一化、引用消息、附件/STT 编排
├── outbound.ts             // send/分块/媒体/input_notify（REST）
├── keyboards.ts            // InlineKeyboard、approval/update_prompt 构造+解析、InteractionEvent
├── chunked-upload.ts       // prepare → PUT parts → finish → complete；biz_code 语义
├── stt.ts                  // SttClient 接口：QQ asr_refer_text → zai/GLM/OpenAI 兼容
├── policies.ts             // dm_policy/group_policy/allowlist 解析
└── types.ts                // Zod schema（与 packages/protocol 共享 wire 类型）
```

核心接口（伪代码签名，不实现）：

```ts
interface PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
  send(chatId: string, content: string, replyTo?: string, metadata?: unknown): Promise<SendResult>;
  sendWithKeyboard(chatId: string, content: string, kb: InlineKeyboard, replyTo?: string): Promise<SendResult>;
  sendImage / sendImageFile / sendVoice / sendVideo / sendDocument(chatId, source, caption?, replyTo?): Promise<SendResult>;
  sendTyping(chatId: string): Promise<void>;
  sendExecApproval(chatId, command, sessionKey, description?, metadata?, allowPermanent?): Promise<SendResult>;
  sendUpdatePrompt(chatId, prompt, default?, sessionKey?): Promise<SendResult>;
  setInteractionCallback(fn: ((ev: InteractionEvent) => Promise<void>) | null): void;
  getChatInfo(chatId: string): Promise<{ name: string; type: "dm" | "group" }>;
}
```

运行形态：适配器跑在 **Node 进程（或 Rust sidecar）** 而非 webview —— 因为 QQ WS 网关需要自定义 `User-Agent` 头并要读 `WSS_PROXY/HTTPS_PROXY`（浏览器 WebSocket 做不到，见 §9）。Node 侧用 `ws` + undici `EnvHttpProxyAgent`；若走 Rust，则在 `src/commands/` 暴露 Tauri IPC（类似 `ws_proxy.rs` 的形态）但线协议是 QQ 协议而非 `/api/ws`。

## 4. Data models & persistence

- **配置**：无独立 DB。Python 侧是 `config.yaml` 的 `platforms.qqbot.extra`（`app_id`/`client_secret`/`markdown_support`/`dm_policy`/`allow_from`/`group_policy`/`group_allow_from`/`stt`）＋ env 变量（`QQ_APP_ID`、`QQ_CLIENT_SECRET`、`QQ_ALLOWED_USERS`、`QQ_GROUP_ALLOWED_USERS`、`QQ_ALLOW_ALL_USERS`、`QQBOT_HOME_CHANNEL[_NAME]`、`QQ_PORTAL_HOST`、`QQ_STT_*`、`QQ_SANDBOX`）。TS 侧用 `packages/protocol` 里的 Zod schema 定义 `QqBotConfig`（镜像上述键，含 `profile-scoped secrets` 语义 —— Python `_resolve_qq_secret` 支持多 profile 隔离，TS 需同源）。
- **运行时状态（内存即可）**：`_seen_messages`（去重，300s 窗口、上限 1000）、`_chat_type_map`（chat_id → c2c/group/guild/dm）、`_last_msg_id`/`_typing_sent_at`（输入态）、token 缓存（`expires_at`）、`_upload_cache`（content_hash → file_info）。
- **持久化**：会话/消息历史复用现有 agent session store（SQLite/IndexedDB，见 `sqlite-fts5-session-search` 计划）；`QQBOT_HOME_CHANNEL` 用于 cron 投递，只作为配置持久化。无需表迁移；若以后要跨重启去重，可在 SQLite 加 `qq_dedup(message_id PK, ts)`，非必须。
- **密钥**：不落库明文；沿用 Desktop 的 `ImRedactedValue`（fingerprint + redacted）模式。

## 5. Third-party library strategy

| Python 依赖 | TS 等价 | kimi-code 证据 / 说明 |
|---|---|---|
| `aiohttp`（WS 客户端 + trust_env 代理） | **`ws` npm（Node 侧）** | kimi-code 自身包未直接声明 `ws`，但 node_modules 中存在 `ws@8.18.0`（经 `@modelcontextprotocol/sdk`、`@agentclientprotocol/sdk` 传递引入）。QQ WS 需要自定义 `User-Agent` 头与代理 → 必须 Node `ws` 或 Rust `tungstenite`，**不能**用 webview 原生 WebSocket |
| `httpx`（REST + SSRF 防护） | **`undici`（fetch/request + `EnvHttpProxyAgent`）** | `packages/agent-core/package.json` 声明 `undici ^7.27.1`；`packages/agent-core/src/utils/proxy.ts`（`Agent`/`EnvHttpProxyAgent`/SOCKS）与 `tools/providers/local-fetch-url.ts` 即证据。SSRF 防护需自研 `isSafeUrl` + redirect guard（Python `_ssrf_redirect_guard` 行为对齐） |
| `orjson` | 原生 `JSON.parse/stringify`（+ `zod` 校验） | kimi-code 全仓使用 `zod ^4.3.6`（agent-core/apps 声明） |
| `cryptography` AESGCM | Node 内置 `crypto`（`aes-256-gcm`，IV 12B ‖ ct ‖ tag 16B） | Node stdlib，无需第三方 |
| `pybase64` | `Buffer.from(x, "base64")` | Node stdlib |
| `qrcode`（终端渲染） | `qrcode` npm（纯 JS）或 webview `<img>`（Desktop 用 `qrUrl` 展示） | kimi-code 未含；Desktop 飞书 onboarding 是 webview 展示 URL，QQ 可复用该模式，终端渲染非必需 |
| `pilk`（SILK→WAV） | **无 TS 等价（真实缺口）** | 全仓检索无 silk/pilk 类包。缓解：优先 QQ `asr_refer_text` 与 `voice_wav_url`（预转 WAV）；否则调 ffmpeg（managed runtime 已内置，features_report §7）或后续 WASM SILK 解码 |
| `ffmpeg`（子进程） | Rust Tauri `Command` / Node `child_process` | kimi-code `apps/kimi-code/src/native`（node-pty 等原生集成）证明子进程模式可行；Desktop `src/process/` 已有子进程管理 |
| `websockets`/aiohttp 多路并发 | `Promise.allSettled` + 信号量（镜像 `_run_with_concurrency`） | 原生 async，无需依赖 |
| **qq-bot-sdk（官方 TS SDK）** | **不采用（见下）** | `node_modules/qq-bot-sdk` **不存在**；kimi-code 全部 `package.json` 无 `qq-bot-sdk/@qqbot` 引用 |

**SDK 建议与理由**：`qq-bot-sdk` / 官方 QQ Bot SDK 不在 kimi-code 中（已核实 `package.json` 与 `node_modules` 均无）。不推荐作为核心实现：① Python 适配器是自研行为集（重连 close-code 表、快速断连阈值、去重窗口、chunked upload、interaction ACK、审批按钮路由），SDK 无法提供 parity；② SDK 自带 HTTP/WS 栈会与 in-process 架构和 undici/ws 冲突；③ 官方 SDK 迭代慢于适配器已固化的生产行为。结论：**实现 in-tree `QqBotClient`**（对齐 `adapter.py`），SDK 仅作 future 评估项。这是本计划最重要的“无 TS 等价”风险：整条适配器行为需从 Python 逐行移植，而非换库。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（桌面侧没有 QQ 实例化代码；QQ 适配器跑在 Python gateway 里）：
- `web/src/routes/im-onboarding.tsx`（1,321 行）：消息平台接入向导，`ImSection = "feishu" | "weixin" | "dingtalk"`，主内容目前飞书为完整实现，weixin/dingtalk 仅有 rail/骨架。
- `web/src/lib/im-onboarding-diagnostics.ts`（450 行）：`DIAGNOSTIC_REQUIRED_KEYS`/`DIAGNOSTIC_POLICY_KEYS` 是 `Record<ImPlatform, string[]>`（105-113 行，目前只有 feishu/weixin），`buildImDiagnosticBundle`/`explainMessagingFailure` 只有 feishu/weixin 分支。
- `packages/protocol/src/channels.ts:491`：`export type ImPlatform = "feishu" | "weixin"`。
- `src/commands/im_onboarding.rs:92-98`：Rust `ImPlatform { Feishu, Weixin, Dingtalk }`，QR onboarding 只有 feishu/weixin 有完整实现。
- `web/src/lib/env-translations.ts:367-398`：**已存在** `QQ_APP_ID`/`QQ_CLIENT_SECRET`/`QQ_ALLOWED_USERS`/`QQ_GROUP_ALLOWED_USERS`/`QQ_ALLOW_ALL_USERS`/`QQBOT_HOME_CHANNEL`/`QQBOT_HOME_CHANNEL_NAME`/`QQ_SANDBOX` 的 label。
- `web/src/hooks/use-im-onboarding.ts` / `useMessagingPlatform` / `useTestMessagingPlatform`：通过 `window.hermesDesktop.imOnboarding*` 与 `/api/messaging/platforms` 工作，平台参数化后可复用。
- `web/src/routes/settings.tsx`：无 IM 配置（只有社区飞书二维码），不用动。

接入点设计：把 `ImPlatform` 扩成 `"feishu" | "weixin" | "dingtalk" | "qqbot"`（protocol + Rust 同步）；诊断模块加 `qqbot` 分支（required: `QQ_APP_ID`,`QQ_CLIENT_SECRET`；policy: `QQ_ALLOWED_USERS`,`QQ_GROUP_ALLOWED_USERS`,`QQ_ALLOW_ALL_USERS`,`QQBOT_HOME_CHANNEL`）；onboarding 页加 QQ tab —— 建议 v1 只做**手动凭据 + 检测连接**（复用 `/api/messaging/platforms/qqbot/test` 与 `/api/status#gateway_platforms.qqbot`），扫码绑定（Python `onboard.py`）如要做需在 Rust `im_onboarding.rs` 镜像飞书 QR 流（q.qq.com `/lite/create_bind_task` + AES-GCM 解密），放 P2。

## 7. Removing the WebSocket dependency (migration path)

先厘清两条 WS：
- **A. 桌面 webview ↔ managed Python gateway `/api/ws`**（JSON-RPC，`web/src/lib/gateway-client.ts` + `gateway-socket-path.ts`）——这是 roadmap 要移除的链路。
- **B. QQ gateway ↔ QQ 服务器 `wss://api.sgroup.qq.com`**（QQ Bot API v2 WS 模式的事件入站）——这是适配器自有的出站连接，**与 A 无关**；除非改用 QQ 的 HTTP 回调模式（当前适配器与文档均未采用），否则 B 无法移除。

影响结论：
1. 移除 A 时，B 继续留在 gateway 进程内运行，桌面 UI 通过 REST 状态面（`/api/status`、`/api/messaging/platforms`）观测即可 —— 因此**短期端口决策 = 不搬**，QQ 适配器维持 gateway-side。
2. 若未来 runtime 完全 in-process（无 Python），B 的连接点必须落在 Node `ws` 或 Rust `tungstenite`，且通过 Tauri IPC 暴露给 webview —— 这使 QQ 适配器成为“最后一个留在进程外/sidecar”的候选（webview 限制见 §9）。
3. 迁移中需冻结的接口面：`QQAdapter` 公开方法集（§3 PlatformAdapter + `send_approval_request`/`send_with_keyboard`/`get_chat_info`）、`MessageEvent`/`SendResult` 形状、UI 消费的 REST 端点（`/api/messaging/platforms`、`/api/messaging/platforms/{id}/test`、`/api/status#gateway_platforms.qqbot`）以及 env 变量名。

阶段化：Phase 0（现状）桌面继续 Python gateway；Phase 1 冻结接口 + 建 TS `QqBotClient` 在 Node harness 跑 parity；Phase 2 in-process runtime 落地后用 TS 适配器替换 Python 实例（同一接口）；Phase 3 删除 `/api/ws` JSON-RPC 与 `/api/messaging/*` 直通代理；Phase 4 删 Python `gateway/platforms/qqbot/`。

## 8. Migration phases & task breakdown

| 阶段 | 任务 | 产出/验证 |
|---|---|---|
| P0 现状梳理 | 核对 Python 行为与测试（本计划已做）；给 Desktop 加 QQ 配置入口（env-translations 已具备，补 protocol `ImPlatform` + 诊断分支） | `pnpm typecheck`、`pnpm test:unit`；手工在 `/im` 手动填 AppID/Secret → `/api/status` 显示 qqbot 状态 |
| P1 接口冻结 + TS 骨架 | `packages/gateway` 建立 `PlatformAdapter` 接口、Zod 类型、constants；port `utils`/`policies`/`keyboards` 纯函数 | vitest 单测：`coerce_list`、键盘解析/构造、ACL、button_data 解析 |
| P2 传输层 | `TokenManager` + undici REST 客户端（SSRF 守卫）+ Node `ws` 客户端（identify/resume/heartbeat/close-code 表） | vitest 用本地 mock `ws` server 验证 Hello/Identify/心跳/close 语义；代理 env 测试（`WSS_PROXY`/`HTTPS_PROXY`） |
| P3 消息管线 | inbound 归一化（C2C/群/Guild/DM、引用 103、附件、STT 编排）+ outbound（分块、markdown、媒体、chunked upload、input_notify）+ interaction 审批流 | parity 测试对照 `test_qqbot.py`（§10 清单）；chunked upload 用本地 presigned-URL mock |
| P4 桌面接线 | `im-onboarding.tsx` QQ tab（手动凭据 + 检测）；`im-onboarding-diagnostics.ts` qqbot 分支；Rust 枚举扩 `Qqbot`；可选 QR 扫码流 | Playwright E2E（fake model + 真实 Core）验证配置保存/状态；`cargo test`（若 Rust WS/QR 落地） |
| P5 切换与删除 | in-process runtime 就绪后，TS 适配器替换 Python 实例；删 `/api/ws` 链路与 `/api/messaging/*` 直通；删 `gateway/platforms/qqbot/` | 全量 typecheck/unit/E2E；回归测试对比 Python 行为（保留 `test_qqbot.py` 作为 parity 参考直到删除） |

## 9. Risks & open questions

1. **无 TS 等价缺口（已核实）**：`pilk`（SILK 解码）在 TS 生态无直接等价；语音 STT 只能依赖 QQ `asr_refer_text`/`voice_wav_url` 或 ffmpeg 子进程（Windows 需隐藏窗口 flag，对齐 `_subprocess_compat.windows_hide_flags`）。风险：SILK-only 场景转录失败率上升。
2. **webview WebSocket 限制**：浏览器 WS 不能设自定义头、不读代理 env → QQ WS 必须放 Node/Rust；否则无法满足 QQ 网关 `User-Agent` 要求与国内代理场景。这直接支撑“适配器保持 gateway-side”的端口决策。
3. **无现成 TS 适配器可参考**：kimi-code 中检索 `qqbot|qq-bot|qq|bot.qq.com` 仅命中 Perl `qq()` 语法、lockfile 哈希与 dist 压缩产物（均为误报）；`qq-bot-sdk` 不存在。整个行为集需逐行移植，成本高、易漏边角（close-code 表、biz_code、去重窗口）。
4. **QQ API 变动**：时间戳曾在 int-ms 与 ISO 字符串间切换（`_parse_qq_timestamp` 双格式）、网关 close code 语义（4009 可续、4914/4915 停连）——parity 测试必须固化成快照。
5. **凭据/多 profile**：`_resolve_qq_secret` 的 profile-scoped secret 语义（`UnscopedSecretError` 回退 os.environ）需在 TS 复刻，否则多 profile 下会串凭据。
6. **协议类型扩展面**：`ImPlatform` 收紧为 `"feishu"|"weixin"`，加 `"qqbot"` 要同步 protocol、Rust、诊断模块、onboarding 页四处；Rust `ImPlatform` 枚举还有 `Dingtalk`，需决定是否一并收编。
7. **开放问题**：① v1 是否只做手动凭据、扫码绑定放 P2？② QQ WS 用 Node `ws` 还是 Rust `tungstenite`（后者更贴近 Tauri 侧，但 REST 仍需 HTTP client）？③ `QQ_SANDBOX`/`QQ_PORTAL_HOST` 的沙箱路由是否纳入 TS 配置 schema？④ 是否保留 `qq-bot-sdk` 作为可选后端（不推荐）？

## 10. Test strategy

- **vitest 单元（parity 对照 `tests/gateway/test_qqbot.py` 的类）**：
  - 配置/初始化：env 回退、`dm_policy`/`group_policy` 默认 `pairing`、`allow_from` 逗号解析、`markdown_support` 默认 true、`coerce_list`、`_is_voice_content_type`（`ct=voice`、`.silk/.amr` 扩展名兜底、`ct=file` 不算 voice）。
  - 连接语义：`connect` 缺依赖/缺凭据返回 false 且写 fatal；`_open_ws` 读 `WSS_PROXY`/`HTTPS_PROXY`；SSRF redirect guard 挂在 HTTP client；`_read_events` 对“已关闭但非 null”的 ws 抛错防空转。
  - 分发：未知 op 忽略、seq 递增、READY 存 session、op7 关 ws、op9 非可续清 session、op11 ack、`_parse_json` 容错。
  - 策略：DM `open+opt-in`、allowlist、pairing 默认放行 DM 但封群、group allowlist/disabled/open。
  - 出站：`send` 未连接时等重连（`_RECONNECT_WAIT_SECONDS`）、分块仅首块带 reply_to、markdown/text body 构造、4004 清 token、永久错误不重试。
  - chunked upload：prepare 解析（含 `data` 包裹）、双 part 成功、group 路径、短读抛错、biz_code `40093002`→日限额、`40093001`→按 retry_timeout 重试。
  - 键盘/交互：`approve:<session_key>:<decision>` 贪婪匹配、`update_prompt:y|n`、三键单行、授权校验（operator 匹配 session）、未授权点击拒绝、`_default_interaction_dispatch` 安装、update_prompt 写 `.update_response`。
  - 引用/附件：非 103 短路、引用语音触发 STT、多元素拼接、图片-only 引用给 marker、视频附件路径进入 quote_block。
  - 其他：intents 位（25|30|12|26）、`_strip_at_mention`、`_parse_qq_timestamp` 双格式、去重窗口、4009 保留 session、`send_with_keyboard`/`send_exec_approval` 委托。
- **集成（Node harness）**：本地 `ws` mock 网关（Hello→Identify→事件→关连接）验证重连/退避/resume；undici mock REST（`MockAgent`）验证 token 刷新、发送、媒体上传、interaction ACK。
- **Playwright E2E（P4 才需要）**：`/im/qqbot` 手动凭据 → 保存 → `/api/status` 出现 qqbot 状态 → 检测连接；沿用现有 fake-model 后端（`e2e/`）。
- **Rust**（若 WS/QR 在 Rust 侧）：`wiremock` 测 REST；`tungstenite` mock 测 close-code；`#[serial_test]` 处理 env 依赖测试（AGENTS.md 约定）。

## 11. Reference links

- QQ Bot API v2 wiki：https://bot.q.qq.com/wiki/develop/api-v2/ ；网关协议：`.../dev-prepare/interface-framework/reference.html`（Hello/Identify/Resume/心跳/close code）
- Python：`D:/hermes-agent-cn/gateway/platforms/qqbot/*.py`；注册 `gateway/run.py:14473`、`gateway/config.py:346,901,2486`、`gateway/pairing.py:87`；接口 `gateway/platforms/base.py`
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/qqbot.md`
- 测试：`D:/hermes-agent-cn/tests/gateway/test_qqbot.py`
- kimi-code 证据：`packages/agent-core/package.json`（`undici`、`zod`）、`packages/agent-core/src/utils/proxy.ts`、`packages/agent-core/src/tools/providers/local-fetch-url.ts`；node_modules 中 `ws@8.18.0`（经 MCP SDK 引入）；**无 qqbot/qq-bot-sdk**
- Desktop：`web/src/routes/im-onboarding.tsx`、`web/src/lib/im-onboarding-diagnostics.ts`、`web/src/lib/env-translations.ts:367-398`、`web/src/hooks/use-im-onboarding.ts`、`packages/protocol/src/channels.ts:491`、`src/commands/im_onboarding.rs:92-98`、`web/src/lib/gateway-client.ts`（桌面↔gateway WS，与 QQ 出站 WS 区分）
