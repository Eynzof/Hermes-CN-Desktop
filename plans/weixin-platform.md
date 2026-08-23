# Weixin (WeChat) Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

Weixin (微信) 是 Hermes messaging gateway 的**个人微信账号适配器**，通过腾讯
**iLink Bot API**（`ilinkai.weixin.qq.com`）把个人微信接入 Hermes（区别于 WeCom
企业微信，`website/docs/user-guide/messaging/wecom.md`）。Python 侧实现位于
`D:/hermes-agent-cn/gateway/platforms/weixin.py`（2,419 行）：入站用
`getupdates` HTTP **long-poll**（无公网 URL / webhook / WebSocket），出站必须回显
该 peer 最新的 `context_token`，媒体走 **AES-128-ECB 加密 CDN**，扫码登录走
`get_bot_qrcode` / `get_qrcode_status`。

**桌面 CN onboarding 范围内（重要）**：与 Feishu 一样，Weixin **已经在桌面接入向导
里完整落地**——`web/src/routes/im-onboarding.tsx` 有完整的 `WeixinRoute`
（`/im/weixin`），`web/src/lib/im-onboarding-diagnostics.ts` 有 weixin 诊断分支，
`src/commands/im_onboarding.rs`（2,483 行）有完整 QR 流程
（`begin_weixin` / `poll_weixin` / `refresh_weixin_qr`、
`resolve_weixin_scanned_user_id_token`、`normalize_weixin_allowed_users`），
`packages/protocol/src/channels.ts:491` 的 `ImPlatform = "feishu" | "weixin"` 已含
weixin。因此本 plan 与 `dingtalk-platform.md` 相同，**同时**覆盖 runtime 移植与
onboarding UI/诊断的 in-process 化。

**Adapter port decision（记录）**：把 Weixin adapter 以 in-process TS 模块移植到
`web/src/lib/platforms/weixin/`，实现与 Feishu/DingTalk 共享的 `PlatformAdapter`
接口。iLink 是**私有、非公开**的 HTTP JSON 协议，kimi-code 全树 **没有任何
weixin/wechat/wechaty TS 实现可作证据**（见 §5 实测），因此**不引入 wechaty**，
改为**从零实现薄协议 shim**（fetch + crypto，逐接口对齐 Python 行为）。运行时形态：
推荐 **Node sidecar**（Rust/Tauri 拉起常驻 Node 子进程，用 `node:crypto` 的
AES-128-ECB + 稳定 long-poll + 媒体文件 I/O）；纯 webview 内进程是备选，但需纯 JS
AES（WebCrypto 不支持 ECB）且 long-poll/后台保活与媒体写盘体验较差。

**WS-removal 影响（记录）**：Weixin 入站传输是 iLink HTTP long-poll，**从不经过本地
Dashboard `/api/ws`**；移除 WS 只影响会话事件通道（由 `messaging-gateway-core.md`
覆盖）与平台状态刷新（退化为 `useStatus` 轮询），对 Weixin 功能归属零影响。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/gateway/platforms/weixin.py` | 2,419 行 | 完整 adapter（见下） |
| `D:/hermes-agent-cn/website/docs/user-guide/messaging/weixin.md` | 333 行 | iLink 说明、env/配置表、媒体、context token、分块、长轮询、故障排查 |
| `D:/hermes-agent-cn/tests/gateway/test_weixin.py` | 830 行 | 格式化/分块/QR/媒体/去重/限流/游标抑制等 parity 基准 |

关键模块（按行号，实测）：
- **常量/端点**（L91–115）：`ILINK_BASE_URL`、`WEIXIN_CDN_BASE_URL`、`ILINK_APP_ID="bot"`、
  `CHANNEL_VERSION="2.2.0"`、`ILINK_APP_CLIENT_VERSION=0x20200=131584`（与 Rust
  `WEIXIN_CLIENT_VERSION=131584` 一致）、`EP_GET_UPDATES/SEND_MESSAGE/SEND_TYPING/GET_CONFIG/GET_UPLOAD_URL/GET_BOT_QR/GET_QR_STATUS`；
  `LONG_POLL_TIMEOUT_MS=35_000`、`SESSION_EXPIRED_ERRCODE=-14`、`RATE_LIMIT_ERRCODE=-2`、
  `MESSAGE_DEDUP_TTL_SECONDS=300`。
- **crypto/CDN 助手**（L204–388）：`_aes128_ecb_encrypt/decrypt`（PKCS#7）、
  `_parse_aes_key`（raw 16B 或 hex 32B）、`_cdn_download_url` / `_cdn_upload_url`、
  `_random_wechat_uin`、`_headers`（`X-WECHAT-UIN`、`iLink-App-Id`、`iLink-App-ClientVersion`、
  `Authorization: Bearer`）、`_assert_weixin_cdn_url`（CDN host allowlist，防 SSRF）。
- **持久化**（L254–346）：`save_weixin_account` / `load_weixin_account`（
  `~/.hermes/weixin/accounts/<id>.json`，0600 原子写）、`ContextTokenStore`
  （`<id>.context-tokens.json`，disk-backed）、`TypingTicketCache`（10 分钟 TTL）、
  `_sync_buf_path/_load_sync_buf/_save_sync_buf`（`<id>.sync.json` 游标）。
- **API 层**（L400–683）：`_api_post` / `_api_get`（`asyncio.wait_for` 超时而非
  aiohttp ClientTimeout）、`_get_updates`（超时返回空）、`_send_message`、
  `_send_typing`、`_get_config`（typing_ticket）、`_get_upload_url`、
  `_upload_ciphertext`（POST + `x-encrypted-param`）、`_download_and_decrypt_media`。
- **格式化/分块**（L697–956）：`_normalize_markdown_blocks`（压缩空行）、
  `_wrap_copy_friendly_lines_for_weixin`（120 列硬折行）、`_split_text_for_weixin_delivery`
  （compact 单气泡 / legacy per-line `split_multiline_messages`；`MAX_MESSAGE_LENGTH=2000`；
  代码围栏整块保留；`greedy_pack_blocks` 共享核心）、`_should_split_short_chat_block_for_weixin`。
- **入站**（L959–1035）：`_extract_text`（引用媒体前缀、voice STT 来源标记
  `[Voice transcription provided by Weixin]`）、`_message_type_from_media`。
- **QR 登录**（L1037–1169）：`qr_login()` 状态机
  `wait → scaned → scaned_but_redirect → expired(≤3 次刷新) → confirmed`。
- **WeixinAdapter**（L1172–2318）：`SUPPORTS_MESSAGE_EDITING=False`（流式游标抑制）、
  `connect/disconnect`（依赖检查 → token lock `weixin-bot-token` → 双 session →
  `_poll_loop`）、`_poll_loop`（long-poll + sync buf 持久化 + 退避 + `errcode=-14`
  暂停 10 分钟）、`_process_message`（id 去重 + **content-fingerprint xxhash 去重** +
  DM/group policy gating + 媒体下载 + 文本 debounce 批处理
  `text_batch_delay_seconds=3.0/5.0`）、`send`（extract MEDIA → 文本分块，
  `client_id=hermes-weixin-<uuid>` 幂等）、`_send_text_chunk_locked`（每块重试 +
  session-expired 无 token 重试一次 + 限流熔断 `_rate_limit_circuit_*`）、
  `send_image(_file)/send_document/send_video/send_voice`（voice 走
  `force_file_attachment` 文件回退）、`_send_file`（AES 加密 → getUploadUrl → CDN
  POST → 发送，`aes_key` 必须是 **base64(hex)** 不是 base64(raw)）、
  `_outbound_media_builder`（image/video/file/voice item 形状）、`format_message`、
  `send_weixin_direct`（send_message/cron 一次性发送，可复用 live adapter 或自建 session）。

桌面侧现状（`D:/Hermes-CN-Desktop`）：
- `src/commands/im_onboarding.rs`：`ImPlatform::Weixin`（L96）、`WEIXIN_ALLOWED_KEYS`（L79–90，
  含 `WEIXIN_ACCOUNT_ID/TOKEN/BASE_URL/CDN_BASE_URL/DM_POLICY/ALLOW_ALL_USERS/ALLOWED_USERS/GROUP_POLICY/GROUP_ALLOWED_USERS/HOME_CHANNEL`）、
  `WEIXIN_SECRET_KEYS=["WEIXIN_TOKEN"]`（L61）、`WeixinFlow`（L279–296）、
  `begin_weixin`（L962，bot_type=3）、`refresh_weixin_qr`（L943）、`poll_weixin`
  （L1011，状态归一 `scaned→scanned`、`expired_refreshed`、`confirmed` 取
  `ilink_bot_id/bot_token/baseurl/ilink_user_id`）、`resolve_weixin_scanned_user_id_token`
  （L615，`__HERMES_SCANNED_WEIXIN_USER_ID__` 占位符替换）、
  `normalize_weixin_allowed_users`（L635，去重+占位符）。
- `web/src/routes/im-onboarding.tsx`（1,321 行）：`WeixinRoute`（L1024–1296）扫码步骤、
  allowlist/pairing/open 策略、`WEIXIN_SCANNED_USER_ID_TOKEN` 自动写入
  `WEIXIN_ALLOWED_USERS`/`WEIXIN_HOME_CHANNEL`、高级设置手动填
  account/token/base_url/cdn_base_url、`useMessagingPlatform("weixin")` +
  `useTestMessagingPlatform("weixin")` 检测。
- `web/src/lib/im-onboarding-diagnostics.ts`（450 行）：weixin 分支
  `explainMessagingFailure`（过期/组件缺失 aiohttp|cryptography/token 失效/iLink 网络）、
  `DIAGNOSTIC_REQUIRED_KEYS=["WEIXIN_ACCOUNT_ID","WEIXIN_TOKEN"]`、
  `DIAGNOSTIC_POLICY_KEYS`（L112）。
- `web/src/hooks/use-im-onboarding.ts`：`useBeginImOnboarding/usePollImOnboarding/useApplyImOnboarding/useMessagingPlatform/useTestMessagingPlatform`。

## 3. Target TypeScript design

模块布局（in-process，WS 移除后运行于 Tauri 环境）：

```
web/src/lib/platforms/
  types.ts               # 共享 PlatformAdapter / MessageEvent / SendResult（与 dingtalk/feishu 计划共用）
  weixin/
    constants.ts         # iLink 常量/端点/errcode（迁移 weixin.py L91–115）
    crypto.ts            # AES-128-ECB + PKCS#7、_parseAesKey、base64(hex) 编码（node:crypto 或纯 JS）
    cdn.ts               # CDN allowlist / _assertWeixinCdnUrl / download/upload URL 构造（SSRF 防护）
    api.ts               # _apiPost/_apiGet/_getUpdates/_sendMessage/_sendTyping/_getConfig/_getUploadUrl/_uploadCiphertext（fetch + AbortSignal.timeout）
    format.ts            # markdown normalize / 120 列折行 / _splitTextForWeixinDelivery / 短聊天块拆分
    store.ts             # AccountStore / ContextTokenStore / SyncBufStore（JSON 文件，Tauri IPC 或 sidecar fs）
    poll.ts              # _pollLoop：long-poll + 游标持久化 + 退避 + 会话过期暂停 + 限流熔断
    media.ts             # 入站下载解密 cache / 出站加密上传 builder（image/video/file/voice item）
    adapter.ts           # WeixinAdapter implements PlatformAdapter
    qr.ts                # getBotQrcode / getQrcodeStatus 状态机（取代 Rust begin/poll/refresh）
    index.ts             # factory + register()
web/src/lib/im-onboarding/        # 通用 onboarding 状态（后续把 WeixinRoute 内联逻辑抽到 lib）
```

关键接口（pseudocode，非实现）：

```ts
interface PlatformAdapter {
  connect(cfg: WeixinConfig): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  onMessage(cb: (ev: MessageEvent) => void): void;
  send(chatId: string, content: string, metadata?: SendMeta): Promise<SendResult>; // 分块 + formatMessage + context_token
  sendImage/sendDocument/sendVideo/sendVoice(chatId, pathOrUrl, caption?): Promise<SendResult>;
  sendTyping(chatId, on: boolean): Promise<void>;
  test(): Promise<{ ok: boolean; state?: string; message?: string }>;
}

interface WeixinConfig {
  accountId: string; token: string;
  baseUrl: string; cdnBaseUrl: string;
  dmPolicy: "open" | "allowlist" | "disabled" | "pairing";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowedUsers: string[]; groupAllowedUsers: string[];
  splitMultilineMessages?: boolean;
  textBatchDelaySeconds?: number; textBatchSplitDelaySeconds?: number;
}
```

数据流（in-process 目标）：
1. 桌面 settings store 持有 `WEIXIN_*` 配置（Phase 1 仍写 `.env`；Phase 2 迁移到 TS
   store，从 `.env` seed）。
2. `WeixinAdapter.connect()` 校验 token/account → 获取 token lock → restore
   `ContextTokenStore` + `SyncBufStore` → 启动 `_pollLoop`（35s long-poll fetch）。
3. 入站消息归一为 `MessageEvent`（text/媒体/引用/voice），id + content-fingerprint 去重，
   DM/group policy gating，文本走 debounce 批处理，然后交给本地 agent loop（in-process）。
4. 出站 `send()`：`extractMedia` → 文本 `_splitText` 分块（`client_id` 幂等）→
   `_sendTextChunk`（重试 + 限流熔断 + session-expired 无 token 重试）→ 返回 `SendResult`。
5. 媒体出站：AES-128-ECB 加密 → `getUploadUrl` → CDN POST → 发送 item（`aes_key` =
   base64(hex)）。入站媒体：下载 → 解密 → 缓存到 app data。
6. `test()` 做轻量凭证/连接检查（对齐 `MessagingPlatformTestResponse`），供 onboarding
   "检测连接"。

运行形态：**推荐 Node sidecar**（`src/commands/weixin_runtime.rs` spawn
`web/src/lib/platforms/weixin/runtime.mjs`），理由：`node:crypto` 原生 AES-128-ECB、
35s long-poll 不受 webview 后台节流、媒体文件 I/O 在进程内、token lock 可持久化。
备选：纯 webview TS（用 `@noble/ciphers` 纯 JS AES + `fetch` + Tauri IPC 写文件），
把 long-poll 后台保活与媒体大小列为已知限制。

## 4. Data models & persistence

| 数据 | Python 位置 | 结构 | TS 策略 |
|---|---|---|---|
| 账号凭据 | `~/.hermes/weixin/accounts/<id>.json` | `{token, base_url, user_id, saved_at}` | 迁移到 app data `weixin/accounts/<id>.json`（0600）；Phase 2 由 TS store 读写，Rust/Tauri IPC 或 sidecar fs；`WEIXIN_ACCOUNT_ID/TOKEN` 仍可 override |
| context token | `~/.hermes/weixin/accounts/<id>.context-tokens.json` | `{user_id: token}` | 同布局 JSON；`ContextTokenStore`（restore/get/set/persist）1:1 移植 |
| 同步游标 | `~/.hermes/weixin/accounts/<id>.sync.json` | `{get_updates_buf}` | `SyncBufStore`；重启续拉位置 |
| 入站去重 | 内存 `MessageDeduplicator` 5 分钟 | in-memory LRU | `Map<key, ts>` + 5 分钟窗口（id + `content:<sender>:<hash>`） |
| typing ticket | 内存 `TypingTicketCache` 10 分钟 | in-memory | 同上；`getconfig` 刷新 |
| 限流熔断 | 内存 `_rate_limit_events/_rate_limit_circuit_until` | in-memory | 滑动窗口 + 熔断（`WEIXIN_RATE_LIMIT_*` env） |
| 配置键 | Rust `WEIXIN_ALLOWED_KEYS`（L79–90）+ docs env 表 | env/config | Phase 2 TS settings store；`WEIXIN_SPLIT_MULTILINE_MESSAGES`、`WEIXIN_HOME_CHANNEL_NAME` 一并保留（docs L307–314） |

Schema migration：与 Python 字段级兼容（JSON 文件名/键不变，便于 Phase 2 直接 seed）；
不引入 SQLite（`packages/minidb` 可选，仅当需要统一 settings 时评估）。密钥全程
`ImRedactedValue` + fingerprint（复用 `im_onboarding.rs:redacted()` 语义，TS 侧已有
`packages/protocol` 类型）。

## 5. Third-party library strategy

**kimi-code 实测结果**：`D:/kimi-code` 全树 grep `weixin|wechat|wechaty`
（apps/packages 源码 + 全部 package.json + pnpm-lock.yaml + node_modules 顶层）**0 命中**；
`pnpm-lock.yaml` 中 `wechaty/wechat/weixin` 计数均为 0；`node_modules` 下不存在任何
`wechaty*` / `wechat*` 包。**结论：kimi-code 无任何 Weixin/WeChat TS 实现可作证据。**

| Python 依赖 | TS 等价 | kimi-code 证据 / 设计 |
|---|---|---|
| `aiohttp`（long-poll + REST + CDN） | Node `fetch`/`undici`（`AbortSignal.timeout` 替代 `asyncio.wait_for`；POST 原始 body + 自定义 header） | kimi-code `packages/agent-core` 依赖 `undici`（见 dingtalk plan 证据）；桌面 `web/src/lib/transport.ts` 已用 fetch |
| `cryptography`（AES-128-ECB + PKCS#7） | **Node sidecar：`node:crypto` `createCipheriv("aes-128-ecb")`**；纯 webview：**`@noble/ciphers`**（纯 JS、审计）或 `crypto-js` | kimi-code 无 AES-ECB 先例（WebCrypto **不支持 ECB**，必须显式选择）；这是本 feature 最关键的 TS 依赖决策 |
| `pybase64` | Node `Buffer.from(...).toString("base64")` / `atob/btoa` | 内置 |
| `xxhash`（content 去重指纹） | 内置 `crypto.createHash`（如 sha1）或 `xxhashjs`；去重仅进程内，**无需跨运行时 parity** | 非关键；保持 id 去重 + content 去重两个防线即可 |
| `orjson` | 内置 `JSON.parse/stringify` | 内置 |
| `re` / `textwrap`（markdown 归一/折行/分块） | JS `RegExp` + 自写 `wrapText`（120 列、不折代码围栏/表格行） | Hermes 私有逻辑，从零移植；parity 见 §10 |
| `mimetypes` | `mime-types` npm 或手写 map | 非关键 |
| `qrcode`（终端渲染） | `qrcode` npm（桌面已依赖，`im-onboarding.tsx:3` `QRCode.toDataURL`） | 现成 |
| `secrets` / `uuid` | `node:crypto.randomBytes/randomUUID` | 内置 |
| `certifi`/ssl connector（iLink CA 怪癖） | Node/undici 默认 CA；如遇 macOS 验证失败，加 `NODE_EXTRA_CA_CERTS` 或 undici CA 覆盖 | 记录为风险；kimi-code 无先例 |
| `tools.url_safety.is_safe_url`（SSRF） | `_assertWeixinCdnUrl`（CDN host allowlist 已有）| 内置 URL 解析 + 白名单即可 |

**wechaty 调研（决定不用）**：npm 生态的 `wechaty` + `wechaty-puppet-wechat`
（非官方 Web WeChat/iPad 协议）存在且活跃，但它面向**个人微信 Web 协议**，与 Python
adapter 使用的 **iLink Bot API**（`ilinkai.weixin.qq.com` 私有 HTTP JSON、context_token、
AES-128-ECB CDN、`getupdates` long-poll）**协议不同、行为不同**；即使引入 wechaty
也仍需从头实现 iLink 请求/加密/分块逻辑，还会引入其自带 puppet/扫码/封号风险与
大依赖面。**结论：不引 wechaty，从零实现薄 iLink 协议 shim（约 600–900 行 TS）**，
与 Python 行为逐接口对齐。

**"No TS equivalent found" 风险（显式）**：
1. iLink 协议私有且无官方 TS SDK——shim 必须从 Python 行为逆向，协议漂移时只能靠
   fixture 测试 + 桌面内错误诊断兜底。
2. kimi-code 整体缺席 WeChat——本 feature 是桌面首次引入 WeChat 协议层，需依赖评审。
3. AES-128-ECB 不在 WebCrypto——若选纯 webview 方案，必须引纯 JS AES 库并做密钥
   处理评审；推荐 Node sidecar 规避。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（Weixin 已在 onboarding 范围，集成点全部现成）：
- **复用**：`web/src/routes/im-onboarding.tsx` `WeixinRoute`（L1024–1296）、
  `web/src/hooks/use-im-onboarding.ts`（begin/poll/apply/messagingPlatform/test）、
  `web/src/lib/im-onboarding-diagnostics.ts`（weixin 分支已完整）、
  `qrcode` npm 依赖、`packages/protocol` 的 `ImPlatform`/`ImOnboarding*`/
  `MessagingPlatformTestResponse` 类型、Rust `src/commands/im_onboarding.rs`
  Weixin 流程（Phase 1 保持为唯一实现）。
- **Phase 2 替换**：Rust `begin_weixin`/`poll_weixin`/`refresh_weixin_qr` 的 HTTP
  逻辑移到 `web/src/lib/platforms/weixin/qr.ts`（Tauri 命令保留壳或直接删除）；
  `apply` 的 `.env` 写入迁移到 TS settings store（保留 Rust fs 写 `.env` 仅作 seed）。
- **Phase 3 退休**：`im_onboarding_begin/poll/apply` 的 weixin 分支、`api_proxy.rs`/
  `ws_proxy.rs` 相关转发；`im-onboarding-diagnostics.ts` 的 `aiohttp|cryptography`
  依赖检查文案改为 TS 运行时诊断（sidecar 是否就绪、AES 可用性）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今天桌面消费、迁移期间不得破坏）：
- `GET /api/status` → `gateway_platforms.weixin`（连接状态/错误码）——`useStatus` 已消费；
- `im_onboarding_begin` / `im_onboarding_poll` / `im_onboarding_apply`（Tauri 命令，
  REST 透传 `.env` + 重启网关）；
- `GET/POST /api/messaging/platforms/weixin[/test]`——平台无关检测端点（hooks 已用）。

迁移路径：
1. **今天**：桌面继续经 Rust 命令 + Python runtime 管理 Weixin；无变化。
2. **WS 移除对 Weixin 的影响**：Weixin 消息**从不经过桌面 WS**（iLink long-poll
   入站 → gateway agent → 桌面经 session JSON-RPC 看结果）；移除 `/api/ws` 后桌面需要
   新的会话事件通道（`messaging-gateway-core.md` 定义），平台状态展示降级为
   `useStatus` 轮询。对 Weixin 传输零影响。
3. **Phase 2 in-process**：`web/src/lib/platforms/weixin/` 直接持有 long-poll；
   删除 Rust 侧 weixin QR HTTP 与 `.env` 重启链路；`test()` 变为本地连接检查。
4. **Phase 3**：删除 `ws_proxy.rs` / `api_proxy.rs` 中 weixin 相关转发；保留
   `ImPlatform` 类型与诊断 UI（读 in-process 状态）。
5. **token lock 注意**：迁移期 Python gateway 与 TS runtime **不能同时轮询同一
   token**——沿用 `weixin-bot-token` lock 文件语义，Phase 2 起由 TS 侧独占。

## 8. Migration phases & task breakdown

- **Phase 0 — 记录决策（本 plan）**：adapter port decision + WS-removal 影响已记录。
- **Phase 1 — 维持现状 + 协议层抽取（可并行）**：
  - 抽取 `constants.ts` / `crypto.ts` / `format.ts` 纯函数（无 I/O），与
    `test_weixin.py` 纯函数用例逐条对齐（§10）。
  - 保持 Rust onboarding 不变；桌面 UI 不变。
- **Phase 2 — in-process runtime**：
  - `api.ts` + `poll.ts` + `media.ts` + `store.ts` + `adapter.ts`（fetch + crypto +
    JSON store）；QR 流程迁到 `qr.ts`；settings store 落地（`.env` seed）。
  - Node sidecar（推荐）或 webview 纯 JS AES 方案落地；`PlatformAdapter` 接入 agent loop。
  - onboarding 检测/诊断切到 in-process 状态；token lock 移交。
- **Phase 3 — 删除 WS/REST 桥**：
  - 删除 Rust weixin HTTP 命令与 `.env` 重启路径、`ws_proxy.rs`/`api_proxy.rs` 转发；
  - 更新诊断文案（移除 aiohttp/cryptography 提示）；`_INDEX.md` #83 保持。

## 9. Risks & open questions

1. **iLink 私有协议**：无官方文档/TS SDK，行为只能以 `weixin.py` + `test_weixin.py`
   为准；协议漂移（header、errcode、CDN 响应）需 fixture 测试 + 错误诊断兜底。
2. **AES-128-ECB 运行时选择**：WebCrypto 不支持 ECB → 必须 Node sidecar 或纯 JS
   库；选型影响包体、审计与密钥处理。**开放问题：桌面团队确认 runtime 形态**。
3. **wechaty 不使用**（理由见 §5）：wechaty 面向 Web 微信协议而非 iLink；若未来要
   支持"真·个人微信协议"（非 iLink bot 身份），应另立 feature 再评估 wechaty。
4. **group 能力受 iLink 限制**：iLink bot 身份通常收不到普通微信群事件（docs L15–24），
   `WEIXIN_GROUP_POLICY` 可能无效——TS 移植保持该限制与启动 WARNING，不扩大承诺。
5. **long-poll 后台保活**：webview 方案下 35s fetch 可能被节流；sidecar 方案无此问题。
6. **token lock**：Python/TS 双运行时并存期只能有一个 poller；需 lock 语义与
   迁移期互斥文档。
7. **媒体大小/缓存**：入站媒体解密写盘、出站加密上传；webview 方案受文件系统
   权限与内存限制，sidecar 方案更稳。
8. **CA 怪癖**：`ilinkai.weixin.qq.com` 在部分系统 CA store 验证失败（Python 用
   certifi 兜底）；Node 侧需对应 `NODE_EXTRA_CA_CERTS` 或 undici CA 覆盖。

## 10. Test strategy

- **vitest 单元（parity with Python）**，逐条对齐 `test_weixin.py`：
  - `TestWeixinFormatting`：markdown 表格保留、120 列折行、code block 内 link 保留；
  - `TestWeixinChunking`：四行结构化块不拆、完整代码围栏保留、`split_multiline_messages`
    legacy per-line、空串 → `[]`；
  - `TestWeixinStreamingCursorSuppression`：`SUPPORTS_MESSAGE_EDITING === false`；
  - `TestIsStaleSessionRet`：`-2+"unknown error"` = stale、`-2+"freq limit"` = 限流、
    `-14` 不在此 helper；
  - crypto：AES-128-ECB round-trip、`_parseAesKey` raw/hex、`aes_key` 编码
    base64(hex)、`_send_file` 用 POST + `x-encrypted-param`、voice .silk 元数据
    （encode_type=6/sample_rate=24000/bits=16）；
  - 去重：id 去重 + content-fingerprint 不同 message_id 同内容去重；
  - 限流熔断：`test_repeated_rate_limits_open_circuit_for_followup_sends` 语义；
  - QR：`qr_login` 超时用 monotonic 时钟、`expired` ≤3 次刷新、`scaned_but_redirect`
    切 host、`confirmed` 取 credential。
- **集成（mock iLink HTTP）**：`fetch` mock 返回 `getupdates`（含
  `longpolling_timeout_ms` / `get_updates_buf` / `msgs`）、`sendmessage`（-14 无 token
  重试、-2 退避）、`getconfig`（typing_ticket）、`getuploadurl` + CDN POST/PUT 分支；
  token lock 冲突；sync 游标持久化恢复。
- **Playwright E2E**：`/im/weixin` 路由 QR 全流程（begin/poll/apply）在 mock Tauri
  命令下跑通；`useMessagingPlatform` 检测按钮。
- **迁移期集成**：Python/TS 双实现跑同一组 fixture 断言（golden JSON），确保 Phase 3
  删除 Python 前行为一致。

## 11. Reference links

- `D:/hermes-agent-cn/gateway/platforms/weixin.py`（2,419 行，实现源）
- `D:/hermes-agent-cn/website/docs/user-guide/messaging/weixin.md`（333 行，docs）
- `D:/hermes-agent-cn/tests/gateway/test_weixin.py`（830 行，parity 基准）
- `D:/Hermes-CN-Desktop/src/commands/im_onboarding.rs`（Weixin 流程 L34–39/L61/L79–90/L96/L615–652/L943–1170）
- `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`（WeixinRoute L1024–1296）
- `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`（weixin 分支 L215–252/L105–113/L357–368）
- `D:/Hermes-CN-Desktop/web/src/hooks/use-im-onboarding.ts`
- `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`（`ImPlatform = "feishu" | "weixin"` L491）
- `D:/Hermes-CN-Desktop/plans/dingtalk-platform.md` / `plans/whatsapp-platform.md`（同风格先例）
- `D:/kimi-code`（weixin/wechat/wechaty 全树 0 命中，见 §5）
