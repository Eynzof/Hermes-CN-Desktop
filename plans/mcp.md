# MCP (Model Context Protocol) — Python → TypeScript Rewrite Plan

## 1. Summary

MCP 是 Hermes 连接外部工具服务器的通道：本地 stdio 子进程、远程 Streamable HTTP /
SSE 服务器（含 OAuth 鉴权：PKCE + loopback 回调 / 粘贴回退）、每服务器工具过滤
（`tools.include/exclude` glob）、Nous 审核的精选目录（`hermes mcp` / `optional-mcps/`
manifest）、`${ENV_VAR}` 运行时替换、`mcp-<server>` 动态工具集 + `mcp__<server>__<tool>`
命名、动态 `tools/list_changed` 刷新，以及把 Hermes 自身作为 MCP 服务器暴露
（`mcp_serve.py`）。本计划把 Python 侧 `tools/mcp_tool.py`（7798 行）及配套
oauth/watchdog/schema-cache/catalog/config/security 移植为 Desktop 内进程 TS 模块：
连接生命周期直接照搬 `D:/kimi-code/packages/agent-core/src/mcp/` 的
`McpConnectionManager` + `@modelcontextprotocol/sdk` 客户端（kimi-code 已是成熟 TS
实现），stdio 子进程 spawn 必须走 Rust `src/commands`（Tauri webview 无 child_process
权限）或 Node sidecar——这是本计划最大的架构决策（见 §5/§9）。最终移除
`/api/mcp/*` REST 与 WS `reload.mcp`，`/reload-mcp` 变为纯本地事件。

## 2. Current Python implementation

### 2.1 核心连接器 — `D:/hermes-agent-cn/tools/mcp_tool.py`（7798 行）

- `MCPServerTask`（L2102）：单个服务器的生命周期；专用后台 asyncio 事件循环
  （`_ensure_mcp_loop`）；`_run_stdio`（L2658）/ `_run_http`（L3041，Streamable
  HTTP + 旧 SSE）两种传输；自动重连 + jitter 退避（`_jittered`）、keepalive 探测、
  circuit breaker（`_record_connect_failure` / `_connect_cooldown_active`）、
  `reconnect_mcp_server`（L4153）信号机制、stdio recycle（`_stdio_recycle_reason`）。
- 公共 API：`register_mcp_servers(servers)`（L6762，幂等、`enabled:false` 跳过、
  并行 discover、`lazy:true` + schema cache 免 spawn 注册）、`discover_mcp_tools()`
  （L6976，读 `config.yaml` 的 `mcp_servers`）、`shutdown_mcp_servers()`（L7479）、
  `_kill_orphaned_mcp_children`（L7546，进程清理）。
- 工具注册 `_register_server_tools`（L6323）：`toolset_name = "mcp-{name}"`；
  `registry.register_toolset_alias(name, "mcp-{name}")` 让 `github` 这类原始服务器名
  可直接当工具集用；`tools.include`/`tools.exclude`（fnmatch glob，include 优先）；
  utility 工具 `list_resources`/`read_resource`/`list_prompts`/`get_prompt`
  （`_select_utility_schemas` L6243）；trust-tier 元数据（`_record_tool_trust_metadata`、
  `_trust_gate_check` L4045）；有损名称规范化冲突 fail-closed（多个原始名折叠到同一
  registry 名则全部跳过）。
- 命名：`mcp_prefixed_tool_name`（L6032）= `mcp__<server>__<tool>`；
  `sanitize_mcp_name_component`（L6010）：`[^A-Za-z0-9_]` → `_`（连字符转下划线）。
- schema 归一 `_normalize_mcp_input_schema`（L5856）：draft-07 `definitions`→`$defs`、
  nullable union 折叠、required 裁剪——保证 OpenAI/Anthropic/Gemini/Moonshot 兼容。
- 动态刷新：`notifications/tools/list_changed` → `_make_message_handler`（L2320）→
  `_schedule_tools_refresh` → `_refresh_tools`（L2363，nuke-and-repave）。
- `${ENV_VAR}`：`_interpolate_env_vars`（L5013，递归；`${VAR}` 与 `${env:VAR}` 同义，
  支持 Cursor 上下文变量 `${userHome}`/`${workspaceFolder}`/`${workspaceFolderBasename}`/
  `${pathSeparator}`/`${/}`）；`_load_mcp_config`（L5123）读 `mcp_servers` +
  `~/.hermes/.env`；`_build_safe_env`（L580）子进程环境白名单过滤；
  `_warn_hidden_whitespace`（L5050）粘帖空白告警。
- 安全：`_filter_suspicious_mcp_servers`（L5096）spawn 前调用
  `hermes_cli/mcp_security`；`_CREDENTIAL_PATTERN` 错误信息脱敏；`_resolve_client_cert`
  / `_resolve_identity_header` / `_apply_identity_header`（客户端证书 / 身份头模板）。
- 高级：`SamplingHandler`（L1544，MCP sampling 回环到 LLM）、`ElicitationHandler`
  （L1941）、`_cache_mcp_image_block`/`_cache_mcp_audio_block`/`_render_mcp_resource_block`
  （image/audio/resource 内容块落盘 + 渲染）。

### 2.2 OAuth — `tools/mcp_oauth.py`（1427 行）+ `tools/mcp_oauth_manager.py`（785 行）

- `HermesTokenStorage`（L429）：`HERMES_HOME/mcp-tokens/` 令牌持久化 + meta。
- 回调：`_reserve_callback_port`/`_make_redirect_handler`/`_make_callback_waiter`
  （loopback PKCE，端口预约防 TOCTOU）；`_paste_callback_reader`（L943）stdin 粘帖
  回退；`force_interactive_oauth`/`suppress_interactive_oauth`（ContextVar 交互门）。
- `build_oauth_auth`（L1364）：组装 SDK OAuth 提供者（DCR 动态注册、
  `_maybe_preregister_client`、`_invalidate_tokens_on_client_change`、
  `apply_oauth_provider_defaults`）。
- `MCPOAuthManager`（`mcp_oauth_manager.py` L446）：按 `(hermes_home, server_name)`
  缓存 provider；`HermesMCPOAuthProvider` 注入磁盘监视钩子（外部 cron/CLI 刷新对运行中
  会话可见）；401 自动刷新；`mcp_dashboard_oauth.py`（145 行）把回调搬进已登录的
  dashboard 会话（REST 驱动，桌面在用）。

### 2.3 配套模块

- `tools/mcp_stdio_watchdog.py`（157 行）：父进程死亡看门狗——
  `python3 -m tools.mcp_stdio_watchdog --ppid <pid> -- <real_cmd>...`，POSIX 进程组
  SIGTERM→SIGKILL，Windows 回退 terminate/kill。
- `tools/mcp_schema_cache.py`（121 行）：`HERMES_HOME/cache/mcp_schema_cache.json`，
  指纹 = sha256(command/args/url/transport/tools include|exclude)；`lazy:true` 服务器
  启动时免 spawn 注册（`_register_from_cache_sync` L6562）。
- `mcp_serve.py`（1050 行）：`FastMCP("hermes")` + `EventBridge`，暴露 ~10 个
  消息桥工具（`conversations_list`/`conversation_get`/`messages_read`/…，读 sessions
  索引 + SQLite），`run_mcp_server()` 走 stdio。
- `hermes_cli/mcp_catalog.py`（835 行）：`CatalogEntry`/`EnvVarSpec`/`AuthSpec`/
  `TransportSpec`/`InstallSpec`/`ToolsSpec`；`optional-mcps/<name>/manifest.yaml`
  （现仓 5 个：comfy-cloud/figma/linear/n8n/unreal-engine）；`install_entry`（git
  clone + bootstrap + env 提问写 `~/.hermes/.env` + 工具勾选清单写 `tools.include`）、
  `uninstall_entry`。
- `hermes_cli/mcp_config.py`（1135 行）：`hermes mcp add/remove/list/test/login/
  reauth/configure`；`_probe_single_server` 临时连接列工具（能力探测按
  `tools.prompts`/`tools.resources` + 服务器广告 gating）。
- `hermes_cli/mcp_picker.py`（322 行）：交互式 picker（`run_picker`/`install_by_name`）。
- `hermes_cli/mcp_security.py`（181 行）：`validate_mcp_server_entry`——shell 解释器 +
  网络外渗/持久化写入形状 + June 2026 `hermes-0day` IOC 硬编码黑名单；保存时与 spawn
  时双跑。
- 文档：`website/docs/user-guide/features/mcp.md`（896 行）：快速开始、目录安装与
  信任模型、工具选择、`${ENV_VAR}` 替换、stdio vs HTTP、OAuth（PKCE loopback、
  粘贴回退、provider 预注册坑：Google Drive / Figma）。

### 2.4 测试面（parity 来源）

`tests/tools/test_mcp_tool.py` + ~45 个 `test_mcp_*.py`（oauth、stdio watchdog、sse
transport、dynamic discovery、circuit breaker、trust gating、capability gating、
image/resource content、lazy start、401 处理、client cert、identity header、list
pagination、schema cache）；`tests/acp/test_mcp_e2e.py`；`tests/hermes_cli/
test_mcp_catalog.py` / `test_mcp_config.py` / `test_mcp_security.py` /
`test_mcp_reload_confirm_gate.py`；`tests/test_mcp_serve.py`；`tests/cron/
test_scheduler_mcp_init.py`。

## 3. Target TypeScript design

新建 `packages/agent-runtime/src/mcp/`（未来 CLI 复用；web 侧经 `web/src/lib/
agent-mcp.ts` 导出）：

```
packages/agent-runtime/src/mcp/
  types.ts               # McpServerConfig(stdio/http/sse), McpServerEntry, status
  config-loader.ts       # mcp_servers 分层加载 + ${ENV_VAR} 插值（§3.2）
  env-interpolate.ts     # ${VAR}/${env:VAR}/Cursor 上下文变量解析
  security.ts            # 移植 hermes_cli/mcp_security.py
  schema-cache.ts        # 指纹 + 工具清单 JSON 缓存（移植 mcp_schema_cache.py）
  connection-manager.ts  # 移植 kimi-code McpConnectionManager（§3.1）
  client-stdio.ts        # SDK StdioClientTransport → Rust IPC 字节流（§3.3）
  client-http.ts         # SDK StreamableHTTPClientTransport + headers/oauth
  client-sse.ts          # 旧 SSE（对齐 Python 兼容路径）
  client-shared.ts       # timeout/result/definition 转换
  tool-naming.ts         # 直接复用 kimi-code mcp/tool-naming.ts
  dynamic-refresh.ts     # tools/list_changed nuke-and-repave
  oauth/
    callback-server.ts   # loopback 监听（Rust 绑端口）或粘贴回退 UI
    provider.ts          # DCR/PKCE/state/verifier（SDK OAuthClientProvider）
    service.ts           # 单飞刷新 + 主动刷新定时器 + 事件
    store.ts             # 令牌 JSON 存储（profile 目录）
  catalog.ts             # optional-mcps manifest → catalog store + 安装流水线
  serve.ts               # Hermes 作为 MCP 服务器（§3.4）
  registry-bridge.ts     # 与动态工具集计划共用 ToolRegistry 的桥
```

### 3.1 连接生命周期（主移植对象）

直接移植 `D:/kimi-code/packages/agent-core/src/mcp/connection-manager.ts`：
`McpServerEntry { name, transport, status: pending|connected|failed|disabled|
needs-auth, toolCount, error, source, config(脱敏视图) }`；`connectAllNow` 并行、
`connect/remove/reconnect(name, config?)` + `configResolver`、`onStatusChange`、
`resolved(name)` → `{ client, tools, rawTools, enabledNames }`；启动/工具调用超时
（`startupTimeoutMs`/`toolCallTimeoutMs`，env 可覆盖）。工具注册侧复用
`dynamic-toolsets.md` 已设计的 `ToolRegistry`：`mcp__<server>__<tool>` 注册进
`mcp-<server>` 工具集并 `registerToolsetAlias(name, "mcp-"+name)`；`needs-auth` →
注册合成 `authenticate` 工具（对齐 kimi-code `agent/tool/index.ts` L118/L367）。

### 3.2 配置加载与 `${ENV_VAR}`

- `config-loader.ts`：读 profile 配置 `mcp_servers`（迁移期兼容 `config.yaml` 的
  `command/args/env` 与 `url/headers` 隐式 transport，对齐 kimi-code
  `McpServerConfigSchema` 的 preprocess 判别逻辑）；分层合并（user → project root →
  project local，kimi-code `config-loader.ts` 三文件层）。
- `env-interpolate.ts`：`${VAR}` 与 `${env:VAR}` 同义、Cursor 上下文变量；值来自
  profile secret scope（等价 Python `secret_scope.get_secret`）；未解析保留字面量；
  空白告警（`_warn_hidden_whitespace`）。

### 3.3 stdio 传输 — Rust 字节流桥（关键设计）

Tauri webview 无法 `child_process.spawn`。设计 Rust command 层（`src/commands/
mcp_stdio.rs`）暴露双向字节流：

```
#[tauri::command] mcp_stdio_spawn(name, command, args, env, cwd) -> ChildId
#[tauri::command] mcp_stdio_write(child_id, bytes: Vec<u8>) -> Result<(), String>
#[tauri::command] mcp_stdio_kill(child_id, grace_ms) -> Result<(), String>
#[tauri::event]  mcp_stdio_data(child_id, bytes)     // stdout 推送到 webview
#[tauri::event]  mcp_stdio_exit(child_id, code, stderr_tail)
```

JS 侧 `client-stdio.ts` 实现 `@modelcontextprotocol/sdk` 的 `Transport` 接口
（`start/send/close/onmessage/onclose/onerror`），把 Rust 事件流包装成
Readable/Writable 流喂给 `Client`——无需 Node sidecar 即可跑纯 SDK。备用方案：
打包 Node sidecar（`node_modules/@modelcontextprotocol/sdk` 直跑
`StdioClientTransport`，见 §9）。子进程 stderr 尾缓冲、unexpected-close 语义照搬
kimi-code `client-stdio.ts`（`stderrBuffer`/`pendingUnexpectedClose`）；父进程死亡清理
等价于 Python `mcp_stdio_watchdog` + `_kill_orphaned_mcp_children`（Rust 端
`Child` 由 IPC 层持有，app 退出/child 容器析构时 killpg）。

### 3.4 Hermes 作为 MCP 服务器

`serve.ts` 用 `@modelcontextprotocol/sdk` 的 `Server` 类在进程内建
`FastMCP("hermes")` 等价物：把本地 `ToolRegistry` 的启用工具动态导出为
`tools/list`/`tools/call`，stdio 传输经 Rust 桥（反向：本进程是 server，stdout/stdin
走 `mcp_stdio_spawn` 的反向通道），HTTP 传输用 Node `http`（经 Rust `api_proxy` 或
直接监听本地端口——与 OAuth callback 同权限问题，见 §9）。Python `mcp_serve.py`
的消息桥工具（`conversations_list` 等）依赖 Telegram/Discord 平台适配器，desktop
standalone 标记 out-of-scope，改为暴露本地 agent 工具；`tests/test_mcp_serve.py`
的 parity 只覆盖「server 握手 + tools/list + tools/call」协议形状。

## 4. Data models & persistence

- 进程内（不持久化）：`McpConnectionManager.entries`、`mcp-<server>` 工具集、
  `ToolRegistry` 注册表、动态刷新状态——随会话重建。
- 持久化：
  - `mcp_servers` 配置：profile JSON（`~/.hermes-desktop/profiles/<p>/mcp.json` 或
    Tauri `app-data`），沿用现有 `McpServer` Zod schema + 新增
    `tools.include/exclude/prompts/resources`、`lazy`、`auth: oauth`、
    `oauth.*`（client_id/scopes/timeout）、`bearerTokenEnvVar`、`timeout`/
    `connect_timeout`/`supports_parallel_tool_calls` 字段；迁移期可读写现有
    `config.yaml`（js-yaml 只读）。
  - OAuth 令牌：`<profile>/mcp-tokens/<server>.json`（对齐 `HermesTokenStorage`；
    kimi-code 存 `credentials/mcp/`，桌面沿用 Python 布局便于迁移）。
  - schema 缓存：`<profile>/cache/mcp_schema_cache.json`，指纹算法直译
    `mcp_schema_cache.config_fingerprint`（sha256 → 16 hex）。
  - catalog 安装态：`installed_servers` 索引（`optional-mcps` 安装目录 + 版本）。
- schema 迁移：复用 `packages/protocol` zod 校验 + `src/commands/config_migration.rs`
  思路，version 字段增量迁移。

## 5. Third-party library strategy

| Python 依赖/能力 | TS 等价 | kimi-code 证据 |
|---|---|---|
| `mcp` SDK 客户端（stdio/Streamable HTTP/SSE） | `@modelcontextprotocol/sdk`（`Client` + `StdioClientTransport` + `StreamableHTTPClientTransport`） | `packages/agent-core/package.json` L76 `"@modelcontextprotocol/sdk": "^1.29.0"`；`src/mcp/client-stdio.ts` L4-5、`client-http.ts` L2-4、`client-sse.ts` |
| 连接生命周期/注册/重连/状态机 | 移植 `McpConnectionManager` | `src/mcp/connection-manager.ts`（730 行，`connectAllNow`/`reconnect`/`resolved`/`onStatusChange`） |
| `fnmatch` glob（include/exclude、mcp__* 过滤） | `picomatch` | `packages/agent-core/src/agent/tool/index.ts` L3、L57-64（`mcpAccessPatterns`/`mcpDenyPatterns`） |
| MCP 工具名规范化 | 复用 kimi-code `tool-naming.ts`（sanitize + 64 字符 + FNV-1a hash） | `src/mcp/tool-naming.ts`（`qualifyMcpToolName`/`stableHash8`）——注意与 Python 有损规范化语义分叉，见 §9 |
| OAuth PKCE/DCR/401 刷新（`mcp_oauth*.py`） | SDK `OAuthClientProvider` + `auth()` 编排 + 自建 callback/provider/service/store | `src/mcp/oauth/provider.ts`（PKCE verifier、DCR client_name）、`oauth/service.ts`（单飞刷新/主动刷新/事件）、`oauth/store.ts`（JsonFileStore）；`oauth/callback-server.ts`（localhost 一次性监听） |
| OAuth device code（非 MCP 场景） | `packages/oauth/src/device.ts`（`requestDeviceAuthorization`/`pollDeviceToken`/`refreshAccessToken`，浏览器安全入口） | `packages/oauth/src/device.ts`（MCP 桌面主要用 PKCE loopback，device code 供无浏览器主机回退） |
| stdio 子进程（webview 沙箱内） | **无 webview 内 TS 等价**——Rust `src/commands/mcp_stdio.rs` 字节流桥或 Node sidecar | kimi-code 运行于 Node 直接 `child_process`（`client-stdio.ts` L65 `StdioClientTransport`）；Tauri webview 无此权限，见 §9 |
| OAuth loopback 端口绑定（webview 内） | **无 webview 内 TS 等价**——Rust command 绑定 127.0.0.1 一次性监听 + 粘贴回退 UI | kimi-code `callback-server.ts` 用 Node `http.createServer`；Python 另有 `mcp_dashboard_oauth.py` 把回调搬进 dashboard 会话 |
| `asyncio` 后台循环 / threading | 原生 async + 单线程事件模型 | `connection-manager.ts` 全生命周期即该模式 |
| `orjson`/json | JSON 内置 + `zod` | `packages/protocol` 已有 Zod schemas；agent-core 依赖 `zod@^4.3.6` |
| YAML（迁移期读旧 config.yaml） | `js-yaml`（只读；新格式 JSON） | 无 kimi-code 证据（kimi-code 用 JSON `mcp.json`）；仅迁移期使用 |
| `mcp_schema_cache` 指纹 | Node `crypto.createHash('sha256')` 直译 | 无直接 kimi-code 等价；接口照抄 Python |
| MCP server 侧（`mcp_serve.py` FastMCP） | `@modelcontextprotocol/sdk` `Server` + `McpServerTransport`（stdio 经 Rust 桥 / HTTP 本地监听） | kimi-code `packages/acp-server`/`acp-adapter` 用同一 SDK Server 类族（协议宿主）；MCP server 本身需按 SDK 自建 |
| MCP sampling / elicitation 回环 | **无 kimi-code 等价**（其 "sampling" 命中均为 LLM 采样参数，非 MCP sampling callback） | 需自研：`SamplingHandler`/`ElicitationHandler` 直译，见 §9 |

## 6. Integration with existing Hermes-CN-Desktop frontend

- 复用 UI：`web/src/routes/mcp.tsx` + `web/src/components/mcp/*`（`McpServerCard`、
  `McpAddDialog`、`McpInstallDialog`、`McpCatalogCard`、`McpDeleteDialog`、
  `mcp-dialog-shell`、`parse.ts`）——数据源从 REST 切到本地
  `McpConnectionManager` store，接口形状保持 `McpServer`/`McpTestResult`/
  `McpCatalog*` 不变。
- 复用 schema：`packages/protocol/src/hermes-api.ts` 已有 `McpServer`、
  `McpServersFullResponse`、`McpTestResult`、`McpCatalogEntry`/`McpCatalogResponse`/
  `McpCatalogInstallResponse`、`McpServerCreate`（+ `mcp-api.test.ts`）——本地模块
  直接产出同形对象。
- 替换 hook：`web/src/hooks/use-mcp.ts`（REST CRUD + `reloadMcp()` WS JSON-RPC）→
  新 `use-local-mcp.ts`（订阅 Jotai store + mutation 写 profile 配置）；
  `use-mcp-servers.ts` 只读端点改为本地连接状态派生。
- Rust 侧：新增 `src/commands/mcp_stdio.rs`（spawn/write/kill/事件）+ 可选
  `src/commands/mcp_oauth_callback.rs`（loopback 监听）；复用既有 child-process
  模式（`app_update.rs`/`restart.rs` 的 `std::process::Command`）与
  `web/src/lib/tauri-bridge.ts` IPC shim；`web/src/lib/transport.ts` /
  `gateway-client.ts` 在迁移后期退役。
- 与相邻计划：工具集注册/`mcp-<server>` 别名/`list_changed` nuke-and-repave 复用
  `dynamic-toolsets.md` 的 `ToolRegistry` + `ToolsetRegistry`；`/reload-mcp` 改为
  本地 `notifyMcpChanged()` 事件并触发现有工具快照刷新逻辑。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API 面（迁移期间保持契约不变，供 parity 对比）：
- `GET /api/mcp/servers`、`POST /api/mcp/servers`、`PUT /api/mcp/servers/{name}/enabled`、
  `POST /api/mcp/servers/{name}/test`、`GET /api/mcp/catalog`、
  `POST /api/mcp/catalog/install`
- WS JSON-RPC `reload.mcp`（`{session_id, confirm}` → `{status: "reloaded" |
  "confirm_required"}`）
- 只读 fork 端点 `GET /api/mcp-servers`（health 面板，可最先退役）

阶段：
1. **Phase A（只读镜像）**：实现 `McpConnectionManager` + 配置加载 + env 插值 +
   catalog 读取（manifest 解析）；UI 数据源切到本地镜像，REST 仍作校验基准。
2. **Phase B（连接本地化）**：Rust stdio 字节流桥 + `client-stdio.ts`；HTTP/SSE 纯
   TS；工具注册接 `ToolRegistry`；`reload.mcp` 暂时桥接（写操作仍走 WS 兜底）。
3. **Phase C（OAuth + 目录安装 + 动态刷新）**：Rust callback + 粘贴回退 UI；
   catalog 安装流水线本地化；`tools/list_changed` 本地 nuke-and-repave；
   `reload.mcp` 改为本地事件。
4. **Phase D（删除）**：删除 `/api/mcp/*`、`/api/mcp-servers` 调用与
   `gateway-client.ts` 相关 RPC；Rust 保留 `mcp_stdio.rs` / `mcp_oauth_callback.rs`。

## 8. Migration phases & task breakdown

1. **P0 配置与类型**：`types.ts`（McpServerConfig 三态传输判别，对齐 kimi-code
   `McpServerConfigSchema` preprocess）、`config-loader.ts`、`env-interpolate.ts`、
   `security.ts`（含 hermes-0day IOC 表——需安全团队确认是否原样保留）。
2. **P1 连接管理器**：移植 `McpConnectionManager`（状态机/重连/超时/事件）；单元
   测试镜像 `test_mcp_reconnect_*.py`、`test_mcp_circuit_breaker.py`。
3. **P2 stdio Rust 桥**：`mcp_stdio.rs` + `client-stdio.ts`（Transport 接口包装）；
   `schema-cache.ts`（lazy 注册）；镜像 `test_mcp_lazy_start.py`。
4. **P3 HTTP/SSE + 工具注册**：`client-http.ts`/`client-sse.ts`、tool-naming 接入
   `ToolRegistry` + alias + include/exclude（`picomatch`）；镜像
   `test_mcp_tool.py` 过滤/冲突/utility 工具用例。
5. **P4 动态刷新**：`dynamic-refresh.ts`（`list_changed`）；镜像
   `test_mcp_dynamic_discovery.py`。
6. **P5 OAuth**：Rust callback + `oauth/provider.ts`/`service.ts`/`store.ts` +
   粘贴回退 UI；401 自动刷新 + `needs-auth` 合成工具；镜像 `test_mcp_oauth*.py`。
7. **P6 目录安装**：`catalog.ts`（manifest 解析 + git clone/bootstrap/env 提问/
   工具勾选写 include）；镜像 `test_mcp_catalog.py`。
8. **P7 Hermes 作为 MCP 服务器**：`serve.ts`（SDK `Server` + 本地工具导出 + stdio
   反向 Rust 桥）；镜像 `tests/test_mcp_serve.py` 握手/tools/list/tools/call。
9. **P8 UI 接线 + 删除 WS/REST**：`use-local-mcp.ts`、`/reload-mcp` 本地化、退役
   `gateway-client.ts` 相关路径；全量 parity/E2E 回归。

## 9. Risks & open questions

- **stdio MCP 在 Tauri webview 无 TS 等价（首要风险）**：kimi-code 在 Node 环境用
  `child_process` + `StdioClientTransport`；Desktop webview 无该权限。必须 Rust
  `src/commands/mcp_stdio.rs` 字节流桥（JS 实现 SDK `Transport` 接口）或打包 Node
  sidecar（直跑 SDK stdio transport）。桥方案避免双运行时，但要求 Rust↔JS 流控/
  背压/stderr 尾缓冲自研；sidecar 方案复用 SDK 现成代码但多一个 Node 运行时依赖。
- **OAuth loopback 在 webview 内无法绑端口**：Python 用本地 `HTTPServer` +
  `mcp_dashboard_oauth.py` REST 桥；kimi-code 在 Node 用 `http.createServer`。桌面需
  Rust command 绑定一次性 127.0.0.1 监听 + 粘贴回退对话框（等价
  `_paste_callback_reader`），并处理 DCR `redirect_uris` 与随机端口不一致的坑
  （Python `_maybe_preregister_client` 已踩过）。
- **MCP 名称规范化语义分叉**：Python 有损规范化（连字符→下划线，冲突 fail-closed）；
  kimi-code sanitize + 64 字符 FNV-1a hash。建议跟 kimi-code（桌面新生态），但
  `test_mcp_tool_issue_948.py`/冲突用例的 parity 须显式记录差异；`mcp__` 前缀解码器
  需统一。
- **MCP sampling / elicitation 无 kimi-code 等价**：`SamplingHandler`（MCP server
  回调 Hermes LLM）与 `ElicitationHandler` 在 kimi-code 未见实现（其 sampling 均为
  LLM 采样参数）。需自研或降级为「不支持 sampling」；对多数工具服务器可接受。
- **`mcp_serve.py` 消息桥工具依赖平台适配器**：`conversations_list` 等读
  Telegram/Discord 会话，desktop standalone 无这些适配器——out of scope，改为暴露
  本地 agent 工具；协议形状（握手/tools/list/call）仍可 parity。
- **安全策略延续**：`mcp_security.py` 的 shell+egress/persistence 形状与
  hermes-0day IOC 黑名单是否原样进入 TS（黑名单属政策数据）需确认；`_build_safe_env`
  子进程环境白名单必须保留（防密钥泄漏）。
- **lazy schema cache 与 `check_fn`**：lazy 注册后首次调用才 spawn 的「假 alive」
  语义（`_make_check_fn`）需在 TS 端复刻；缓存文件权限 0o600。
- **HTTP server 侧（`serve.ts`）端口监听权限**：与 OAuth callback 同问题，desktop
  standalone 建议仅支持 stdio 方向的 MCP server 暴露，HTTP 方向标记 open question。
- **进程清理**：stdio 子进程孤儿问题（Python watchdog + `_kill_orphaned_mcp_children`
  解决）需 Rust 端进程组管理等价物（app 退出时 killpg），Windows 无 POSIX killpg，
  需 `taskkill /T` 或 Job Object。

## 10. Test strategy

- **vitest 单元**（镜像 Python 用例）：
  - `connection-manager.test.ts`：状态机/并行 connect/reconnect/`needs-auth`/超时
    （镜像 `test_mcp_reconnect_*.py`、`test_mcp_circuit_breaker.py`、
    `test_mcp_initial_connect_shutdown.py`）。
  - `client-stdio.test.ts`：Rust 桥 Transport 包装（mock IPC 事件）、stderr 尾缓冲、
    unexpected-close（镜像 `test_mcp_stdio_*.py`、`test_mcp_stdio_watchdog.py`）。
  - `client-http.test.ts` / `client-sse.test.ts`：headers/身份头/重定向头剥离/
    预检 content-type（镜像 `test_mcp_identity_header.py`、
    `test_mcp_preflight_content_type.py`、`test_mcp_sse_transport.py`）。
  - `tool-naming` + 注册：include/exclude glob、冲突 fail-closed、utility 工具
    （镜像 `test_mcp_tool.py`、`test_mcp_capability_gating.py`、
    `test_mcp_utility_capability_gating.py`）。
  - `oauth/*`：PKCE 回调/粘贴回退/令牌存储/单飞刷新/401 处理（镜像
    `test_mcp_oauth*.py`、`test_mcp_tool_401_handling.py`、
    `test_mcp_tool_session_expired.py`）。
  - `env-interpolate.test.ts`：`${VAR}`/`${env:VAR}`/Cursor 上下文变量/未解析保留
    （镜像 `test_mcp_config.py`、`test_mcp_config_whitespace_warning.py`）。
  - `security.test.ts`：外渗/持久化/IOC（镜像 `tests/hermes_cli/test_mcp_security.py`）。
  - `schema-cache.test.ts`、`catalog.test.ts`（镜像 `test_mcp_schema_cache.py`、
    `test_mcp_catalog.py`）。
- **集成**：`acp-e2e` 等价（镜像 `tests/acp/test_mcp_e2e.py`：stdio/http 配置转换、
  `reload.mcp` → 本地 `notifyMcpChanged`、`confirm` 门）；`serve.test.ts`（镜像
  `tests/test_mcp_serve.py`）。
- **Playwright E2E**：`mcp.tsx` 路由在本地 store 下增删改/启停/测试/目录安装/
  OAuth 粘贴回退全流程；`reload-mcp` 无 WS。
- **parity 脚本**：同一 fixture 配置在 Python 与 TS 下分别连 mock server，对比
  注册工具名/过滤结果/utility 工具集合（记录命名规范化差异清单）。

## 11. Reference links

- Python 源：`D:/hermes-agent-cn/tools/mcp_tool.py`、`tools/mcp_oauth.py`、
  `tools/mcp_oauth_manager.py`、`tools/mcp_dashboard_oauth.py`、
  `tools/mcp_stdio_watchdog.py`、`tools/mcp_schema_cache.py`、`mcp_serve.py`、
  `hermes_cli/mcp_catalog.py`、`hermes_cli/mcp_config.py`、`hermes_cli/mcp_picker.py`、
  `hermes_cli/mcp_security.py`、`optional-mcps/{comfy-cloud,figma,linear,n8n,
  unreal-engine}/manifest.yaml`
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/mcp.md`
- 测试：`D:/hermes-agent-cn/tests/tools/test_mcp_tool.py`、`tests/tools/test_mcp_*.py`、
  `tests/acp/test_mcp_e2e.py`、`tests/hermes_cli/test_mcp_{catalog,config,security}.py`、
  `tests/test_mcp_serve.py`、`tests/cron/test_scheduler_mcp_init.py`
- TS 参考：`D:/kimi-code/packages/agent-core/src/mcp/`（connection-manager.ts、
  client-stdio.ts、client-http.ts、client-sse.ts、config-loader.ts、registry.ts、
  tool-naming.ts、oauth/{callback-server,provider,service,store}.ts）、
  `packages/agent-core/src/agent/tool/index.ts`（attachMcpTools/registerMcpServer）、
  `packages/oauth/src/device.ts`、`packages/agent-core/src/config/schema.ts`
  （McpServerConfigSchema）
- Desktop：`D:/Hermes-CN-Desktop/web/src/routes/mcp.tsx`、
  `web/src/components/mcp/*`、`web/src/hooks/use-mcp.ts`、`use-mcp-servers.ts`、
  `packages/protocol/src/hermes-api.ts`（Mcp* schemas）、`packages/protocol/src/
  mcp-api.test.ts`、`src/commands/{app_update,restart}.rs`（child-process 先例）、
  `web/src/lib/{transport,gateway-client,tauri-bridge}.ts`
- 相邻计划：`D:/Hermes-CN-Desktop/plans/dynamic-toolsets.md`（ToolRegistry /
  mcp-<server> 工具集 / list_changed 刷新）
