# Raft Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front (per `plans/README.md`): **Raft is a gateway-side
> messaging platform adapter and is marked "out of scope for desktop standalone" for v1** —
> same convention already used by `plans/telegram-platform.md` and
> `plans/bluebubbles-platform.md`. The Desktop keeps talking to the Core managed-runtime
> gateway over REST (`/api/status`, `/api/messaging/platforms`) and WS (`/api/ws`) and does
> **not** host the Raft adapter in-process in v1. Sections 3–10 still design the in-process
> TS port so the decision is recorded and a future standalone build can pick it up.

## 1. Summary

Raft 是 Hermes messaging gateway 的 **外部 Agent 通道适配器**：适配器在本机起一个
**loopback HTTP wake endpoint**，接收 Raft bridge（`raft agent bridge` 子进程）推送的
**content-free wake hints**，再以 `internal=True` 的 `MessageEvent` 注入 Hermes gateway
会话流水线；**消息体与投递游标由 Raft CLI / bridge 负责**，适配器从不持有 Raft 凭据，
出站 `send()` 是 no-op（agent 自行 `raft message check` / `raft message send`）。
另外适配器提供 **activity 遥测队列**（`/activity` + `/activity/drain`），把 session/tool
钩子事件回传给 bridge。

Python 实现位于 `D:/hermes-agent-cn/plugins/platforms/raft/adapter.py`（853 行），
文档 `D:/hermes-agent-cn/website/docs/user-guide/messaging/raft.md`（70 行），测试
`D:/hermes-agent-cn/tests/gateway/test_raft_adapter.py`（220 行）+ 静默 check_fn 回归
`tests/plugins/test_raft_check_fn_silent.py`（33 行）。

**Adapter port decision（记录）**：v1 保持 Python gateway（managed runtime）持有该适配器；
桌面端只消费现有的 REST 状态面（`useStatus` 的 `gateway_platforms.raft`）。**不引入任何
Raft TS SDK**（kimi-code 无证据，且适配器协议面根本不调 Raft 服务端 API）。若未来做
standalone，才按 §3 把适配器以 in-process TS 模块移植到 `web/src/lib/platforms/raft/`，
入站 wake listener 只能由 **Rust/Tauri 或 Node sidecar** 提供（webview 不能绑定 TCP 端口）。

**WS-removal 影响（记录）**：Raft 的入站（wake HTTP）与出站（CLI）**从不经过桌面
Dashboard `/api/ws`** —— WS 只承载会话事件流与平台状态。移除 WS 对 Raft 功能归属零影响；
只需按 `messaging-gateway-core.md` 提供新的 in-process 会话事件通道，并把平台状态展示
降级为 `useStatus` 轮询（今天 `settings.tsx` 的 debug 卡片已是读 `/api/status` 的轮询结果）。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/plugins/platforms/raft/adapter.py` | 853 行 | `RaftAdapter` 完整实现 + 全局钩子 + 注册 |
| `D:/hermes-agent-cn/plugins/platforms/raft/__init__.py` | 3 行 | 导出 `register` |
| `D:/hermes-agent-cn/plugins/platforms/raft/plugin.yaml` | 19 行 | 平台元数据 + `requires_env: RAFT_PROFILE` |
| `D:/hermes-agent-cn/website/docs/user-guide/messaging/raft.md` | 70 行 | 安装/分工/wake 流程图/env 表 |
| `D:/hermes-agent-cn/tests/gateway/test_raft_adapter.py` | 220 行 | wake/activity/body-cap/config parity 基准 |
| `D:/hermes-agent-cn/tests/plugins/test_raft_check_fn_silent.py` | 33 行 | check_fn 静默回归（#49234） |
| `D:/hermes-agent-cn/hermes_cli/web_server.py` | — | 平台目录 entry（L8760–8763） |

关键实现块（按行号，实测读取）：

- **常量/契约**（L54–98）：`DEFAULT_HOST=127.0.0.1`、`DEFAULT_PORT=0`（**每次启动取
  ephemeral 端口，无固定端口绑定**）、`DEFAULT_PATH=/wake`、`DEFAULT_RUNTIME_SESSION=default`、
  `DEFAULT_MAX_BODY_BYTES=16_384`、`ACTIVITY_QUEUE_CAP=500`、`ACTIVITY_CONTENT_CAP=4096`、
  `ACTIVITY_EVENT_SCHEMA="raft-activity.v1"`、`ACTIVITY_DRAIN_SCHEMA="raft-activity-drain.v1"`、
  `BRIDGE_TOKEN_HEADER="x-raft-bridge-token"`；内容字段黑名单 `_CONTENT_FIELD_NAMES`
  （body/content/message/messages/preview/snippet/text，L65–73）；activity 允许字段白名单
  `_ACTIVITY_ALLOWED_FIELDS`（L77–92，unknown 字段拒绝）。
- **被动探测**（L101–117）：`check_raft_requirements()` 检查 `aiohttp` 可用 + `shutil.which("raft")`
  非空，**静默返回**（check_fn 每次 load_gateway_config 都会调用，见 #49234）。
- **内容安全**（L127–136）：`_has_content_field` **递归**检查 dict/list 中任意嵌套
  content 字段名（大小写不敏感、strip 后小写）。
- **安全标量**（L143–150）：`_safe_scalar` 用 `^[a-zA-Z0-9._:@/ -]+$` 白名单 + 120 字符上限，
  用于 sessionId/toolName/eventId 等注入防护。
- **Activity 事件构造/校验**（L183–266）：`_make_activity_event`（uuid4 eventId、ISO Z 时间、
  content cap 4096 + `truncated` 标记）、`_validate_activity_event`（schema 检查、unknown
  field 拒绝、必填 safe 标量、status ok|error、bool 字段）。
- **ActivityQueue**（L269–299）：bounded **at-most-once** 队列（cap 500，popleft 丢弃并计数
  `dropped_since_drain`）；`drain(max=200)` 返回 `{schema, events, dropped}` 并清零计数。
- **Raft 上下文追踪**（L302–333）：模块级 `_RAFT_SESSION_IDS/_RAFT_TURN_IDS/
  _RAFT_PROMPT_TURN_IDS`（`threading.Lock` 保护）——`_is_raft_context` 命中 `platform=="raft"`
  或已记住的 session/turn id；prompt 去重（每个 turn 只报一次 UserPromptSubmit）。
- **全局钩子**（L343–444）：`on_session_start`（顺带注册 `RAFT_PROFILE` env passthrough）、
  `pre_llm_call`、`pre_tool_call`、`post_tool_call`、`post_llm_call`、`on_session_end`、
  `on_session_finalize` —— 全部经 `_report_activity` 写入所有 active adapter 的 queue
  （`weakref.WeakSet` 管理，L93/L336–341）。
- **`RaftAdapter` 生命周期**（L447–527）：`connect()` 自动生成 `secrets.token_hex(32)`
  bridge token → 起 aiohttp app（**`client_max_size` 强制 chunked body 上限**，L481）注册
  `GET /health`、`POST /wake`、`POST /activity`、`GET /activity/drain` → 显式端口占用探测
  （L487–500）→ `TCPSite` 绑定 → `_mark_connected` → `_spawn_bridge(bound_port)`。
- **Bridge 子进程**（L529–569）：`shutil.which("raft")` + `RAFT_PROFILE` 检查；命令
  `raft --profile <profile> agent bridge --wake-adapter wake-channel --wake-channel-endpoint http://127.0.0.1:<port>/wake`，
  env 注入 `RAFT_CHANNEL_TOKEN`；`_stop_bridge` terminate→5s→kill。bridge 不可用时只告警，
  **wake-only polling 模式**继续运行。
- **HTTP 处理器**（L584–691）：wake/activity 均先 `hmac.compare_digest` 校验
  `x-raft-bridge-token`（401）；`Content-Length` 头检查 + 实际字节数双重 413；wake 用
  `orjson.loads`（invalid_json 400）；**不校验 payload schema**（bridge 拥有 schema 演进），
  只做 content-free 检查（`content_not_allowed` 400）；未挂 handler 时 `not_ready` 503。
- **wake 注入**（L700–760）：`_accept_wake` 取 `eventId/attemptId/messageId/...` 作为
  `message_id` → `build_source(chat_id=runtime_session, chat_name="Raft channel",
  chat_type="dm", user_id="raft-bridge", user_name="Raft Bridge")` → `MessageEvent(text=
  _wake_prompt(), internal=True)`；`handle_message` 对 busy session 走
  `merge_pending_message_event` 排队（L736–752）；wake prompt 提示先读 Raft CLI manual。
- **注册**（L769–853）：`register(ctx)` 注册 platform `raft`（emoji 🔔、`required_env=
  ["RAFT_PROFILE"]`、`env_enablement_fn=_env_enablement` —— **设置 RAFT_PROFILE 即自动启用**）、
  `interactive_setup()`（`hermes gateway setup` 流程，保存 `.env` 的 `RAFT_PROFILE`）、以及
  7 个 session/tool 钩子。

数据流（docs raft.md L45–49）：

```
Raft Server → Bridge (wake-hints SSE) → POST /wake → Hermes Adapter → Agent context
Agent → raft message check → Raft Server (message bodies)
Agent → raft message send → Raft Server (replies)
Hooks (session/tool) → ActivityQueue → GET /activity/drain → Bridge → Raft
```

REST 状态面：`GET /api/status` 的 `gateway_platforms.raft`（state/error_code/error_message）、
`GET /api/messaging/platforms` 目录 entry（web_server.py L8760–8763，description
"Join a Raft workspace as an external agent." + docs_url）、`PUT/POST .../test` 检测端点。

## 3. Target TypeScript design

**Port decision（记录）**：v1 保持 Python gateway；下面是 in-process 移植的目标设计（仅在
未来 standalone 时启用）。

模块布局（复用 `plans/messaging-gateway-core.md` 定义的 `PlatformAdapter` 接口）：

```
web/src/lib/platforms/
  types.ts               # 共享 PlatformAdapter / MessageEvent / SendResult / SessionSource
  raft/
    constants.ts         # DEFAULT_PATH=/wake、MAX_BODY_BYTES=16384、CAP=500、CONTENT_CAP=4096、
                         #   schema 常量、_CONTENT_FIELD_NAMES、_ACTIVITY_ALLOWED_FIELDS、
                         #   BRIDGE_TOKEN_HEADER、_SAFE_SCALAR_RE、_MAX_SCALAR_LENGTH
    content.ts           # hasContentField（递归 dict/list）、safeScalar、makeActivityEvent、
                         #   validateActivityEvent、nowIso（纯函数，可直接 parity 测试）
    activity-queue.ts    # ActivityQueue：bounded deque + dropped 计数 + drain(max)
    http.ts              # wake/activity/activity-drain/health 处理器（Node http 或 Rust 转发）
    bridge.ts            # spawnBridge/stopBridge：which("raft") + RAFT_PROFILE + 子进程生命周期
    context.ts           # RaftContextTracker：session/turn 记忆 + prompt 去重（替代模块级 set）
    adapter.ts           # RaftAdapter implements PlatformAdapter（connect/disconnect/send/…）
    index.ts             # factory + register()
```

关键接口（pseudocode，非实现）：

```ts
interface RaftConfig {
  host?: string;            // 默认 "127.0.0.1"
  port?: number;            // 默认 0（ephemeral；无固定端口）
  path?: string;            // 默认 "/wake"（自动补前导 /）
  bridgeToken?: string;     // 空则 connect 时 crypto.randomBytes(32).toString("hex")
  runtimeSession?: string;  // 默认 "default"
  maxBodyBytes?: number;    // 默认 16384
  groupSessionsPerUser?: boolean;
  threadSessionsPerUser?: boolean;
}

interface RaftAdapterLike extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: SendMeta }): Promise<SendResult>; // no-op success
  getChatInfo(chatId: string): Promise<{ name: string; type: "raft" }>;
  onWake(handler: (ev: MessageEvent) => Promise<void>): void;      // 注入 agent loop
  reportActivity(event: ActivityEvent): void;                       // 钩子写入 queue
  drainActivity(max?: number): ActivityDrainResponse;               // bridge 轮询
  health(): HealthResponse;                                         // /health
}
```

数据流（in-process 目标）：

1. `connect()` 读配置 → 生成 bridge token（若空）→ 起本地 HTTP 服务（**Rust/Tauri 本地
   HTTP 或 Node sidecar `node:http`；webview 不能 bind 端口**，见 §5）→ `spawnBridge(port)`。
2. 入站：bridge POST `/wake` → token 校验（`crypto.timingSafeEqual`）→ 内容字节上限双重
   检查（chunked 也要卡）→ `hasContentField` 拒绝 → 构造 `MessageEvent`（`internal=true`、
   `message_id` 取 eventId/attemptId/messageId/…）→ 交给本地 agent loop；busy session 排队。
3. Activity 遥测：agent loop 钩子（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/
   PostToolUseFailure/Stop/SessionEnd）→ `reportActivity` → bounded queue；bridge 轮询
   `GET /activity/drain?max=N` 取走（at-most-once + dropped 计数）。
4. 出站 `send()`：直接 `{success: true, message_id: null}` no-op（与 Python L571–579 一致）；
   agent 用 `raft` CLI 收/发消息。
5. 钩子接线：`on_session_start` 时注册 `RAFT_PROFILE` 到工具环境透传（对齐 Python L346–351）。

运行形态：**推荐 Rust/Tauri 本地 HTTP 服务（`tiny_http`/`axum`）或 Node sidecar**，把
请求体转交 TS 处理函数；纯 webview 方案不可行（无 TCP listen + 后台保活风险），记录为
已知限制（同 bluebubbles plan）。

## 4. Data models & persistence

| 数据 | Python 位置 | 结构 | TS 策略 |
|---|---|---|---|
| wake 提示 | 无持久化（bridge 是事实源） | content-free metadata | 不落库；会话由 gateway session 层管理（`messaging-gateway-core.md`） |
| activity 队列 | `ActivityQueue`（L269–299） | bounded deque cap 500 + dropped 计数 | in-memory `Array`/`Deque` cap 500；`drain(max=200)` 取走并清零 |
| bridge token | `secrets.token_hex(32)`（L474） | 每 session 生成，仅 localhost 共享 | `crypto.randomBytes(32).toString("hex")`；存内存/配置 store，redacted |
| Raft 上下文 | 模块级 set（L96–98） | session/turn id 集合 + prompt 去重 | in-memory `Set`；`context.ts` 封装 |
| 配置 | `.env` `RAFT_PROFILE`（plugin.yaml requires_env）+ `extra.*` | 字符串 profile slug | Phase 1 仍写 `.env`；Phase 2 迁移 TS settings store，密钥 `ImRedactedValue` + fingerprint |
| 消息 | 无（Raft CLI 是事实源） | — | 不落库 |

Schema migration：无 SQLite；仅需与 Python 字段级兼容的配置键迁移（`RAFT_PROFILE` +
`extra.host/port/path/bridge_token/runtime_session/max_body_bytes/group_sessions_per_user/
thread_sessions_per_user`）。activity/wake 契约常量（schema 字符串、内容字段黑名单、
activity 白名单）**必须 1:1 移植**并做 golden fixture（§10）。

## 5. Third-party library strategy

**kimi-code 实测结果**：
- 全树大小写不敏感 `raft` 命中全是子串（draft/craft 等）；**词边界 `\braft\b` = 0 命中**。
- `node_modules` 目录与 `pnpm-lock.yaml` 检查：**无任何 `raft` 包**；仅有 `@open-draft/*`
  （deferred-promise/logger/until，OpenAPI/TypeBox 基础设施）与 `ajv-draft-04`
  （ajv draft 支持）——与 Raft 无关。
- `package.json` 全树无 `"raft"` 依赖。
**结论：kimi-code 无任何 Raft TS 实现/依赖可作证据（"no TS equivalent found"，见风险 §9）。**

| Python 依赖 | TS 等价 | kimi-code 证据 / 设计 |
|---|---|---|
| `aiohttp`（loopback HTTP 服务 + `client_max_size`） | **无 webview 等价**：Rust/Tauri 本地 HTTP（`tiny_http`/`axum`）或 Node sidecar `node:http`，把请求体转交 TS 处理函数；chunked body 上限需在读取层手动 enforce | kimi-code `packages/kap-server` 是 HTTP 服务器实现（服务端，非 webview 内 TCP listen）；webview 本身无法 bind 端口 → 本 feature 最关键的运行形态决策 |
| `httpx`/`fetch`（非本 adapter 直接依赖，bridge 用 CLI） | `fetch` / `undici`（`AbortSignal.timeout`） | kimi-code `packages/agent-core/package.json:102` 依赖 `"undici": "^7.27.1"` |
| `orjson` | `JSON.parse/stringify` | 内置 |
| `hmac.compare_digest`（header token） | `crypto.timingSafeEqual`（Buffer 比较；先比长度） | Node 内置 `node:crypto`；kimi-code 有 `node:crypto` 广泛使用 |
| `secrets.token_hex(32)` | `crypto.randomBytes(32).toString("hex")` | Node 内置 |
| `subprocess.Popen` + terminate/kill + `shutil.which` | `node:child_process` `spawn`（stdio `"ignore"`）+ `which` 探测（`spawnSync("raft", ["--version"])` 或 PATH 扫描） | kimi-code `apps/kimi-code/src/utils/process/`（resolve-command.ts / shell-env.ts 等）+ `cli/run-shell.ts` 等大量 `child_process` 用例 |
| `threading.Lock` / `weakref.WeakSet` | 单线程 JS：模块级 `Set` + 同步队列（无锁）；adapter 弱引用可用 `WeakRef`/显式注册表 | 从零移植；`_ACTIVE_ADAPTERS` 语义简化 |
| `re`（SAFE_SCALAR 白名单、递归 content 检查） | JS `RegExp` + 递归函数 | 从零移植；`constants.ts` 保留同一正则与 120 上限 |
| `uuid.uuid4()` | `crypto.randomUUID()` | Node 内置 |
| `asyncio` | `async`/`Promise` | 内置 |
| `datetime`/`time` | `Date.now()` → ISO（`new Date().toISOString().replace("Z","Z")` 保持 `occurredAt` 以 `Z` 结尾） | 内置 |

**Raft API SDK 调研结论与推荐**：Raft（raft.build）是外部产品，kimi-code 的 node_modules
中**不存在 Raft API SDK**（已实测）。更重要的是，**本适配器协议面不需要 Raft API**——
wake-channel 的 SSE 消费、消息体/投递游标全部由 `raft agent bridge` CLI 拥有，Hermes 侧
只暴露 localhost HTTP + 子进程管理。**决定：不引入任何 Raft TS SDK**，从零实现薄
HTTP/bridge shim（约 300–500 行 TS，含常量/queue/context 纯逻辑）；若未来 standalone 需要
直接调 Raft API，另行评估（无 kimi-code 验证包，倾向 CLI 或手写 REST shim）。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（Raft 不在桌面 onboarding 范围，集成点全部是"读"）：

- **复用（无需改动）**：
  - `web/src/routes/settings.tsx` L1478–1484：`status.gateway_platforms` debug 卡片自动展示
    `raft` 名称/state/error_message（一旦 gateway 启用该平台）。
  - `web/src/hooks/use-status.ts`（轮询 `/api/status`）、`web/src/lib/transport.ts`。
  - `packages/protocol/src/hermes-api.ts`：`StatusResponse.gateway_platforms`（L47）、
    `MessagingPlatformInfo`（L127–151）——平台无关，raft 作为字符串 key 直接可用。
  - `web/src/hooks/use-im-onboarding.ts`：`useMessagingPlatform("raft")` /
    `useTestMessagingPlatform`（若未来加平台卡片，可读 `/api/messaging/platforms/raft[/test]`）。
  - Rust `src/commands/api_proxy.rs` / `ws_proxy.rs`：对上述 REST 的透传（managed 模式）。
- **不涉及（本 feature 范围外）**：`web/src/routes/im-onboarding.tsx` 的
  `sectionFromPath`（L70–76）只有 feishu/weixin/dingtalk；`packages/protocol/src/channels.ts:491`
  的 `ImPlatform = "feishu" | "weixin"`；`im-onboarding-diagnostics.ts` 的
  `DIAGNOSTIC_REQUIRED_KEYS`（L105–113）只有 feishu/weixin；`im-onboarding-diagnostics.ts`
  的 `explainMessagingFailure` 无 raft 分支。若团队要加 Raft 向导，需扩展这些点（见 §9）；
  v1 维持 `hermes gateway setup`（Core CLI）为唯一配置入口。
- **env 翻译缺口**：`web/src/lib/env-translations.ts` 无 `RAFT_PROFILE` label（现有
  `BLUEBUBBLES_*` 在 L351–365）；高级 `.env` 编辑器会显示原始 key 名。Phase 1 可补一行
  翻译，不阻塞。
- **Phase 2 替换（若做 standalone）**：`useMessagingPlatform("raft")` 检测切到本地 adapter
  的 `test()`；诊断分支加 raft 文案（raft CLI 未安装、bridge 未 spawn、token 401、wake
  503 not_ready）；`settings.tsx` 可加 Raft 平台卡片（读 in-process 状态）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今天桌面消费、迁移期间不得破坏）：
- `GET /api/status` → `gateway_platforms.raft`（state/error_code/error_message）——`useStatus` 已消费；
- `GET /api/messaging/platforms` → raft 目录 entry（web_server.py L8760–8763）+ 
  `PUT/POST /api/messaging/platforms/raft[/test]` 检测端点；
- `.env` `RAFT_PROFILE`（plugin.yaml requires_env）；gateway session/tool 钩子事件流。

迁移路径：
1. **今天**：桌面继续经 Rust 命令 + Python runtime 管理 Raft；无变化。
2. **WS 移除对 Raft 的影响**：Raft 入站（wake HTTP）与出站（CLI）**从不经过桌面
   `/api/ws`**；移除 WS 只影响：会话事件流（由 `messaging-gateway-core.md` 的 in-process
   `GatewayService`/`IEventBus` 接管）与平台状态刷新（降级为 `useStatus` 轮询，已是现状
   兜底）。对 Raft 传输零影响。
3. **Phase 2 in-process（未来 standalone）**：`web/src/lib/platforms/raft/` 直接持有本地
   HTTP 服务 + bridge 子进程；`test()` 变本地连接检查（raft CLI 存在 + bridge 可 spawn）；
   删除 Rust 侧 raft 相关 REST 透传；`.env` 写入迁移到 TS settings store。
4. **Phase 3**：删除 `ws_proxy.rs`/`api_proxy.rs` 中 raft 转发；保留 `MessagingPlatformInfo`
   类型与诊断 UI（读 in-process 状态）。
5. **端口注意**：Raft `DEFAULT_PORT=0`（每次 ephemeral），**无固定端口**，与
   `wecom_callback` 8645 / bluebubbles 8645 不存在静态冲突；但 bridge 需要拿到实际绑定端口
   拼 endpoint，in-process 实现必须把 `site.address().port` 回传给 spawn 参数（对齐
   Python L507–516）。

## 8. Migration phases & task breakdown

- **Phase 0 — 记录决策（本 plan）**：adapter port decision（out of scope for v1）+
  WS-removal 影响已记录；`_INDEX.md` #90 保持。
- **Phase 1 — 维持现状 + 纯函数抽取（可并行，不接 runtime）**：
  - 抽 `constants.ts`（schema 常量、内容字段黑名单、activity 白名单、安全标量正则、各默认值）；
  - 抽 `content.ts`（`hasContentField` 递归、`safeScalar`、`makeActivityEvent`、
    `validateActivityEvent`）与 `activity-queue.ts`（bounded deque + dropped + drain）；
  - 与 `test_raft_adapter.py` 纯函数用例逐条对齐（§10）。
- **Phase 2 — in-process runtime（仅当 standalone 立项）**：
  - `http.ts`（Node `node:http` 或 Rust/Tauri 本地 HTTP：token 校验、body 上限含 chunked、
    413/401/400/503 状态映射）+ `bridge.ts`（spawn/kill、`RAFT_CHANNEL_TOKEN` env）+ 
    `context.ts` + `adapter.ts`；
  - 钩子接线到 agent loop 事件总线；`PlatformAdapter` 接入本地会话；配置 store（`.env` seed）；
    `env-translations.ts` 补 `RAFT_PROFILE`；onboarding/诊断 UI 扩展（若要做 Raft 向导）。
- **Phase 3 — 删除 WS/REST 桥（仅当 standalone 落地）**：
  - 删除 Rust 侧透传、`ws_proxy.rs`/`api_proxy.rs` 相关转发；诊断文案移除 Python 依赖提示。

## 9. Risks & open questions

1. **无 TS SDK / 无 kimi-code 等价（"no TS equivalent found"）**：Raft wake 契约只能以
   `adapter.py` + `test_raft_adapter.py` 为准从零移植；bridge 侧协议（SSE、wake payload
   形态）由 Raft 产品演进，Hermes 只做 content-free + 白名单校验，协议漂移需 fixture 兜底。
2. **入站 listener 运行形态**：webview 不能绑定 TCP 端口；必须 Rust/Tauri 本地 HTTP 服务
   或 Node sidecar。**开放问题：桌面团队确认 runtime 形态**（影响 §3 模块边界与 §5 依赖）。
3. **Bridge 子进程生命周期**：Python gateway 常驻管理 bridge；standalone 桌面常驻性弱，
   需处理窗口退出/崩溃时的子进程回收（terminate→5s→kill，对齐 L556–569）与"bridge 缺失
   时 wake-only polling"降级。
4. **body 上限语义**：`test_raft_adapter.py::TestBodySize` 专门回归 **chunked
   Transfer-Encoding 绕过 Content-Length 上限**（aiohttp `client_max_size`）；Node/Rust
   listener 必须在读取层同样卡 16 KiB 并返回 413，否则安全回归。
5. **content-free 契约漂移**：`_CONTENT_FIELD_NAMES` 递归检查必须 1:1（含嵌套 list/dict、
   大小写不敏感）；任何漏字段会导致消息内容进入 Hermes 上下文（安全边界）。
6. **Activity 队列 at-most-once 语义**：cap 500 popleft + `dropped_since_drain` 计数 +
   `drain(max=200)` 清零；TS 必须镜像，否则 bridge 侧投递统计漂移。
7. **会话 key 字节一致性**：in-process 与 Python gateway 共存期，`build_source` 产出的
   session key 必须与 Python `agent:main:raft:<chatType>:<chatId>[:<userId>]` 布局一致
   （chat_id=runtime_session，默认 "default"；参照 `messaging-gateway-core.md` §4 parity guard）。
8. **日志/密钥安全**：bridge token 只走 localhost header；不得进 Tauri 日志/telemetry；
   token 比较用 `timingSafeEqual`（先比字节长度），对齐 Python 的
   `hmac.compare_digest(token.encode(), self._bridge_token.encode())`。
9. **`RAFT_PROFILE` env passthrough**：Python 在 `on_session_start` 注册
   `tools.env_passthrough`；TS agent loop 若没有等价 env 透传机制，`raft` CLI 子进程拿不到
   profile —— Phase 2 必须显式接入。

## 10. Test strategy

- **vitest 单元（parity with Python）**，逐条对齐 `test_raft_adapter.py`：
  - `TestRaftWakePayload`：`hasContentField` 顶层/嵌套 dict/list 命中；metadata-only 不命中；
  - `TestRaftWakeHttp`：`send()` 返回 `{success:true, messageId:null}` no-op；content-bearing
    payload → 400 `content_not_allowed` 且不 dispatch；
  - `TestRaftActivityHttp`：无 token → 401；unknown 字段 → 400；cap=2 队列 push 3 条 →
    drain `max=10` 返回 schema/dropped=1/events 顺序 `evt-2,evt-3`（对齐 L124–157）；
  - `TestBodySize`：chunked 500B → 413 `payload_too_large`（node http 读取层 enforce，
    对齐 L167–193）；
  - `TestRaftConfig`：`RAFT_PROFILE` 设置 → auto-enable；interactive setup 保留既有
    profile（对齐 L196–219，TS 侧等价于 settings store 写入守卫）；
  - `test_raft_check_fn_silent`：raft CLI 缺失 → check 返回 false 且不抛（对齐
    `tests/plugins/test_raft_check_fn_silent.py`）。
- **集成（mock bridge 与本地 HTTP）**：token 校验（401/200）；port=0 ephemeral 绑定并把
  端口传给 spawn；`which("raft")` 缺失 → 不 spawn、wake-only 模式；bridge spawn 参数与
  env（`RAFT_CHANNEL_TOKEN`）断言；busy session 时 wake 排队（`mergePendingMessageEvent`）；
  断开时 terminate→kill 子进程。
- **Playwright E2E（若加 onboarding）**：`/im/raft`（未来）配置表单 + 检测按钮在 mock
  Tauri 命令下跑通；现有 E2E 只断言 `settings.tsx` debug 卡片出现 `gateway_platforms.raft`
  状态。
- **迁移期集成**：Python/TS 双实现跑同一组 golden fixture（wake payload 样例、activity
  事件、drain 响应、413 chunked 样例），确保 Phase 3 删除 Python 前行为一致。

## 11. Reference links

- `D:/hermes-agent-cn/plugins/platforms/raft/adapter.py`（853 行，实现源）
- `D:/hermes-agent-cn/plugins/platforms/raft/__init__.py` / `plugin.yaml`（注册与 requires_env）
- `D:/hermes-agent-cn/website/docs/user-guide/messaging/raft.md`（70 行，docs）
- `D:/hermes-agent-cn/tests/gateway/test_raft_adapter.py`（220 行，parity 基准）
- `D:/hermes-agent-cn/tests/plugins/test_raft_check_fn_silent.py`（33 行，check_fn 回归）
- `D:/hermes-agent-cn/hermes_cli/web_server.py`（平台目录 L8760–8763、/api/messaging/platforms L10256+）
- `D:/hermes-agent-cn/gateway/platforms/base.py`（`BasePlatformAdapter` L2884、`MessageEvent` L2294、
  `SendResult` L2460、`build_source` L7032、`merge_pending_message_event` L2693）
- `D:/hermes-agent-cn/gateway/config.py`（`Platform` L317、`PlatformConfig` L639）
- `D:/hermes-agent-cn/gateway/session.py`（`build_session_key` L1091）
- `D:/hermes-agent-cn/gateway/platform_registry.py`（`create_adapter` L600、check_fn/env_enablement 机制）
- `D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`（L1478–1484 debug 卡片）
- `D:/Hermes-CN-Desktop/web/src/lib/env-translations.ts`（无 RAFT key；`BLUEBUBBLES_*` L351–365）
- `D:/Hermes-CN-Desktop/web/src/lib/im-onboarding-diagnostics.ts`（L105–113 required keys 仅 feishu/weixin）
- `D:/Hermes-CN-Desktop/web/src/routes/im-onboarding.tsx`（L70–76 `sectionFromPath`，当前无 raft）
- `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`（L491 `ImPlatform = "feishu" | "weixin"`）
- `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts`（L47 `gateway_platforms`、L127–151 平台 info）
- `D:/Hermes-CN-Desktop/src/commands/api_proxy.rs` / `ws_proxy.rs` / `im_onboarding.rs`
- `D:/Hermes-CN-Desktop/plans/messaging-gateway-core.md`（`PlatformAdapter` 接口、WS 移除总路线）
- `D:/Hermes-CN-Desktop/plans/bluebubbles-platform.md`（同风格先例：port decision + WS 影响记录）
- `D:/kimi-code`（`\braft\b` 全树 0 命中；node_modules/pnpm-lock.yaml 无 raft 包；
  `packages/agent-core/package.json:102` `undici ^7.27.1`；`apps/kimi-code/src/utils/process/` 子进程先例）
