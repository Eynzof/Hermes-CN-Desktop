# Dynamic Toolsets — Python → TypeScript Rewrite Plan

## 1. Summary

动态工具集（Dynamic toolsets）是 Hermes 工具可用性模型的核心：静态 `TOOLSETS`
目录之外，运行时还会出现三类动态工具集 —— `mcp-<server>`（每个已连接 MCP 服务器
自动生成，工具名 `mcp__<server>__<tool>`）、插件通过 `ctx.register_tool()` 注册的
工具集、以及 `config.yaml` 中 `custom_toolsets` 定义的用户自定义组合；同时支持
`all` / `*` 通配符展开全部工具集。本计划把 Python 侧的解析引擎（`toolsets.py` +
`tools/registry.py`）、MCP 动态注册（`tools/mcp_tool.py`）、插件注册
（`hermes_cli/plugins.py`）移植为 Desktop 内进程 TypeScript 模块，最终移除
`/api/tools/toolsets`、`/api/mcp/*`、`reload.mcp` 等 WebSocket/REST 依赖。核心设计
直接参照 `D:/kimi-code` 的 `ToolManager` + `McpConnectionManager`（动态工具注册/
生命周期/通配符过滤已是成熟 TS 实现），桌面端只补上 kimi-code 没有的「工具集
(toolset) 组合/解析」层。

## 2. Current Python implementation

### 2.1 静态目录与解析引擎 — `D:/hermes-agent-cn/toolsets.py`（1039 行）

- `TOOLSETS`：静态 dict，每条 `{description, tools, includes}`；分三类：
  core（`web`/`search`/`file`/`terminal`/`vision`/`image_gen`/`browser`/`skills`/
  `todo`/`memory`/`clarify`/`code_execution`/`delegation`/`cronjob`/
  `session_search`/`desktop_ui`/`project`/`computer_use`/`homeassistant`/
  `kanban`/`context_engine`/`x_search`/`video_gen`/`bfl`/`tts`/`spotify` 等）、
  composite（`debugging`、`safe`、`coding`(posture)）、platform
  （`hermes-cli`、`hermes-telegram`、…、`hermes-gateway`，多数为
  `_HERMES_CORE_TOOLS + [平台附加]`）。
- `get_toolset(name, include_registry=True)`：静态定义 + `registry.get_tool_names_for_toolset`
  合并；对 registry-only 名称合成动态定义——插件工具集
  `"Plugin toolset: {name}"`，MCP 原始服务器名别名
  `"MCP server '{name}' tools"`（经 `registry.get_toolset_alias_target`）。
- `resolve_toolset(name, visited)`：递归展开 `includes`、环检测；`all`/`*` 展开全部
  工具集名；`include_registry=False` 静态视图用于平台反向映射（#49622）。
- `resolve_multiple_toolsets`、`get_all_toolsets`（静态+插件）、`get_toolset_names`、
  `validate_toolset`、`create_custom_toolset`（运行时写 `TOOLSETS`）、
  `get_toolset_info`、`bundle_non_core_tools`。
- 动态来源：`_get_plugin_toolset_names()` / `_get_registry_toolset_aliases()` 从
  `tools/registry.py` 读。

### 2.2 工具注册中心 — `D:/hermes-agent-cn/tools/registry.py`（1737 行）

- `ToolRegistry`：`register(name, toolset, schema, handler, check_fn, requires_env,
  is_async, description, emoji, override, scope)`；`deregister`；
  `get_registered_toolset_names()`；`register_toolset_alias(alias, toolset)`；
  `get_registered_toolset_aliases()`；`get_tool_names_for_toolset()`；
  `get_entry` / `get_all_entries` / `get_definitions(tool_names)`；
  `snapshot_registration` / `restore_registration`（插件卸载还原）；
  scope_key = profile（多 profile 隔离）。
- 内置工具发现：AST 静态扫描 `registry.register(...)` 生成懒加载索引
  `build_tool_index`（`tool_to_module` / `tool_to_toolset` / `toolset_to_modules`），
  磁盘缓存指纹 `xxhash.xxh64`（`tool_index.json`）。

### 2.3 MCP 动态注册 — `D:/hermes-agent-cn/tools/mcp_tool.py`（98560 字节）

- 可选依赖 `mcp` SDK（懒加载 `_ensure_mcp_sdk`）；stdio / Streamable HTTP / SSE
  传输；专用后台 asyncio 事件循环；自动重连+退避、keepalive、circuit breaker；
  `register_mcp_servers()` / `discover_mcp_tools()` / `shutdown_mcp_servers()`。
- `_register_server_tools(name, server, config)`（L6323）：
  - 工具注册名为 `mcp__<server>__<tool>`（有损规范化，`read-file`→`read_file`，
    冲突 fail-closed 跳过）；`toolset_name = f"mcp-{name}"`；
  - 注册 alias：`registry.register_toolset_alias(name, f"mcp-{name}")`，使
    `validate_toolset("github")` / `resolve_toolset("github")` 直接可用；
  - `tools.include` / `tools.exclude`（fnmatch glob）过滤；
  - 生成 utility 工具（`list_resources` / `read_resource` / `list_prompts` /
    `get_prompt`）；trust-tier 元数据。
- 动态刷新：`MCPServerTask._make_message_handler()` 响应
  `notifications/tools/list_changed` → `_schedule_tools_refresh()` →
  `_refresh_tools()` nuke-and-repave（deregister 旧工具 + register 新工具）。

### 2.4 插件工具集注册 — `D:/hermes-agent-cn/hermes_cli/plugins.py`

- `PluginContext.register_tool(name, toolset, schema, handler, check_fn,
  requires_env, is_async, description, emoji, override)`（L1393）：写入全局
  registry（scope=profile），ownership ledger 支持 unload/reload 还原；
  `override=True` 需 `plugins.entries.<id>.allow_tool_override` 信任门。
- `PluginManager`（L3049）：bundled / `~/.hermes/plugins` / 项目 `.hermes/plugins` /
  pip entry_points / Nix 五来源；`plugins.enabled` allow-list 门控；`ctx.call_mcp`
  （`mcp_allowlist` 能力门）。

### 2.5 会话级选择 — `D:/hermes-agent-cn/tui_gateway/server.py::_load_enabled_toolsets`

- `HERMES_TUI_TOOLSETS` env 显式列表 → `validate_toolset` 过滤 → 插件发现后再验证
  → `all`/`*` 返回 None（全部）；coding posture（`agent/coding_context.py`）；
  `_gui_surface_toolsets` 按 session source 折叠 `project` / `desktop_ui`。

### 2.6 配置与 API 面

- `hermes_cli/tools_config.py`：`CONFIGURABLE_TOOLSETS` checklist、按平台
  `platform_toolsets` 持久化、`_get_platform_tools` 反向映射。
- `hermes_cli/web_routers/tools.py::get_toolsets/toggle_toolset/...`；桌面现有
  `/api/mcp/servers` CRUD + `reload.mcp`（WS JSON-RPC：全局 shutdown + discover +
  会话工具快照刷新）。

### 2.7 文档

- `website/docs/reference/toolsets-reference.md`：三类动态工具集 + wildcards；
  `custom_toolsets` YAML 示例（**注意：文档存在但 Python 代码并未消费该配置键**，
  见 §9 风险）。
- `website/docs/user-guide/features/plugins.md`：`ctx.register_tool` API、插件来源、
  opt-in 门控。

## 3. Target TypeScript design

新建 `web/src/lib/agent-tools/`（或 `packages/agent-runtime/src/toolsets/`，
建议后者，未来被 CLI 侧复用）：

```
web/src/lib/agent-tools/
  types.ts                 # ToolsetDef, ToolEntry, ToolDefinition, McpServerEntry
  toolset-registry.ts      # ToolsetRegistry — 静态目录 + 解析引擎（§3.1）
  tool-registry.ts         # ToolRegistry — 动态工具注册/别名/快照（§3.2）
  mcp/
    connection-manager.ts  # 生命周期（移植 kimi-code McpConnectionManager）
    client-stdio.ts        # @modelcontextprotocol/sdk stdio 包装
    client-http.ts         # Streamable HTTP 包装
    client-sse.ts          # SSE 包装
    tool-naming.ts         # mcp__ 名称规范化 + 64 字符截断 + FNV-1a hash
    dynamic-refresh.ts     # notifications/tools/list_changed nuke-and-repave
  plugin/
    manager.ts             # 插件发现 + enabled allow-list + ownership ledger
    context.ts             # 等价 ctx.registerTool/registerToolset
  custom-toolsets.ts       # 读取 custom_toolsets 配置并注册
  wildcard.ts              # all/* 展开
```

### 3.1 ToolsetRegistry（解析引擎，Python toolsets.py 直译）

```ts
interface ToolsetDef { description: string; tools: string[]; includes: string[]; posture?: boolean }
class ToolsetRegistry {
  staticToolsets: Map<string, ToolsetDef>;      // 移植后的精简静态目录
  getToolset(name, opts?: { includeRegistry?: boolean }): ToolsetDef | undefined;
  resolveToolset(name, visited?: Set<string>): string[];   // 环检测 + includes 递归
  getAllToolsets(): Map<string, ToolsetDef>;    // 静态 + registry + plugin + mcp
  getToolsetNames(): string[];
  validate(name): boolean;                       // 含 all/*、mcp 别名、plugin、custom
  createCustomToolset(name, description, tools, includes): void;
  getToolsetInfo(name): ToolsetInfo | undefined; // 对齐 ToolsetInfo schema
}
```

- `all`/`*` 展开遍历 `getToolsetNames()` 并 union 全部已解析工具；`kanban` 与
  capability-gated 工具默认排除（对齐文档 §Wildcards）。
- 与 kimi-code 的关键差异：kimi-code `ToolManager` 只有扁平 `enabledTools` +
  `mcpAccessPatterns`（无组合/别名）；本层补上 Python 的组合语义，但复用 kimi-code
  的「动态注册 + glob 过滤」模式。

### 3.2 ToolRegistry（动态注册，Python registry.py 直译）

```ts
class ToolRegistry {
  private tools = new Map<string, ToolEntry>();
  private toolsetAliases = new Map<string, string>();  // "github" -> "mcp-github"
  register(entry: ToolEntry, opts?: { override?: boolean; scope?: string }): void;
  deregister(name: string): void;
  getToolNamesForToolset(toolset: string): string[];
  getRegisteredToolsetNames(): string[];
  registerToolsetAlias(alias: string, canonical: string): void;
  getToolsetAliasTarget(alias: string): string | undefined;
  getDefinitions(toolNames: ReadonlySet<string>): ToolDefinition[]; // 供 agent loop
  snapshotRegistration(name): RegistrationSnapshot | undefined;     // 插件卸载还原
  restoreRegistration(snapshot): boolean;
}
```

### 3.3 MCP 动态工具集（移植 kimi-code，替换 Python mcp_tool.py）

- `McpConnectionManager`（对齐 `kimi-code/.../mcp/connection-manager.ts`）：
  entries Map + status（`pending|connected|failed|disabled|needs-auth`）、
  `connectAllNow` 并行、`reconnect(name, config?)` + `configResolver`、
  `onStatusChange`、`resolved(name)` 返回 `{client, tools, rawTools, enabledNames}`。
- `ToolManager.attachMcpTools()`（对齐 `kimi-code/.../agent/tool/index.ts` L111）：
  订阅 status change；`connected` → `registerMcpServer(serverName, client, tools,
  enabledNames)` 把每个工具以 `mcp__<server>__<tool>` 注册进 ToolRegistry，并写入
  `mcpToolsByServer`；`failed/disabled` → `unregisterMcpServer`（等效 Python
  nuke-and-repave）；`needs-auth` → 注册合成 `mcp__authenticate` 工具。
- 动态刷新：MCP `notifications/tools/list_changed` 通知 → 重新 `listTools()` →
  全量 deregister + register（对齐 Python `_refresh_tools` 与
  `test_mcp_dynamic_discovery.py` 语义）。
- 工具集派生：注册时 `toolsetName = "mcp-" + serverName`，并
  `registerToolsetAlias(serverName, toolsetName)` —— 复刻 Python
  `_register_server_tools` 的「原始服务器名别名」行为。
- 名称规范化：采用 kimi-code `mcp/tool-naming.ts`（sanitize + `MAX_QUALIFIED_LENGTH=64`
  + FNV-1a hash 截断），并在 `tool-registry.ts` 做同源/跨源冲突 fail-closed
  （对齐 Python 有损规范化冲突策略，见 §9 风险）。

### 3.4 插件工具集（TS PluginManager）

- manifest 驱动（`plugin.yaml` 移植为 TS/JSON 配置）：`name`、`version`、
  `description`、`tools`（schema 数组或引用）、`mcpServers`、`skills`、`hooks`；
  对齐 kimi-code `plugin/manager.ts`（manifest 贡献 MCP server、命令、hooks、
  systemPrompt）。
- 动态 JS 工具注册：`ctx.registerTool({name, toolset, schema, handler, ...})`
  等价 Python `PluginContext.register_tool` → 写入 ToolRegistry（scope=profile），
  ownership ledger 支持 disable/unload 时还原；`override` 需配置信任门。
- `plugins.enabled` allow-list 门控；bundled 插件自动加载，用户/项目插件 opt-in。

### 3.5 custom_toolsets + wildcards

- `custom-toolsets.ts`：读取 profile 配置 `custom_toolsets: { name: string[] }`
  （数组短写 = includes，兼容文档示例）或
  `{ name: { tools: [...], includes: [...] } }` → `createCustomToolset`。
  由于 Python 未实现该配置键，TS 端定义为规范实现（见 §9）。
- `wildcard.ts`：`all`/`*` 是 `resolveToolset` 的内置分支。

## 4. Data models & persistence

- 进程内状态：`ToolsetRegistry` / `ToolRegistry` / MCP entries 为内存 Map
  （非持久化，随连接生命周期重建）；Jotai store 暴露 UI 视图快照
  （`toolsetInfosAtom`、`mcpServersAtom`）。
- 持久化（用户配置，替代 Python `config.yaml`）：
  - `platform_toolsets`：每平台启用/禁用工具集列表（对齐
    `hermes_cli/tools_config.py`），存 profile JSON（`~/.hermes-desktop/profiles/<p>/toolsets.json`
    或 Tauri `app-data` 目录；迁移期可读写现有 `config.yaml`）。
  - `custom_toolsets`：新增 schema（`z.record(z.union([z.array(z.string()),
    z.object({tools: z.array(z.string()), includes: z.array(z.string())})]))`）。
  - `mcp_servers`：服务配置（name/transport/command/args/env(脱敏)/enabled/
    tools.include|exclude/timeout），复用现有 `McpServer` Zod schema。
  - schema version 字段 + 迁移器（复用 `lib/config-migration-assistant.ts` 思路）。
- 不持久化：`mcp-<server>` 工具集本身（从 live connection 推导）、plugin 注册表
  （从 manifest 重新加载）。

## 5. Third-party library strategy

| Python 依赖/能力 | TS 等价 | kimi-code 证据 |
|---|---|---|
| `mcp` SDK（stdio/Streamable HTTP/SSE 客户端） | `@modelcontextprotocol/sdk`（`Client` + `StdioClientTransport` + streamable http） | `packages/agent-core/src/mcp/client-stdio.ts` L4-5（`@modelcontextprotocol/sdk/client/index.js`、`.../stdio.js`）；`client-http.ts`、`client-sse.ts` 同包 |
| `fnmatch` glob（tools.include/exclude、mcp__* 过滤） | `picomatch` | `packages/agent-core/src/agent/tool/index.ts` L3、L561-564（`mcpAccessPatterns`/`mcpDenyPatterns` 用 picomatch） |
| `asyncio` 后台循环 / threading | 原生 async + 无锁单线程事件模型 | `mcp/connection-manager.ts` 全部生命周期即该模式 |
| `orjson`/`json` 序列化 | JSON 内置 + `zod` schema 校验 | `packages/agent-core/package.json` 依赖 `zod@^4.3.6`；`packages/protocol` 已有 Zod schemas |
| `xxhash` 工具索引指纹 | Node `crypto.createHash('sha1')` 或自实现 FNV-1a | `mcp/tool-naming.ts` 已实现 FNV-1a（MCP 名称 hash） |
| YAML 配置读取（迁移期） | `js-yaml`（仅读旧 `config.yaml`；新格式用 JSON） | 无 kimi-code 证据；Desktop 协议层走 JSON |
| 通配符 `all`/`*` 展开 | 自实现（递归 union，Python `resolve_toolset` 直译） | kimi-code 无 toolset 组合概念；无直接等价 |
| stdio 子进程（webview 沙箱内） | **无 webview 内 TS 等价** —— 需 Rust `src/commands` 或 sidecar Node 进程执行 `spawn` | kimi-code 运行于 Node（`client-stdio.ts` 直接 `child_process`）；Tauri webview 无此权限，见 §9 |

## 6. Integration with existing Hermes-CN-Desktop frontend

- 复用 UI：`web/src/routes/mcp.tsx` + `web/src/components/mcp/*`（`McpServerCard`、
  `McpAddDialog`、`McpCatalogCard`、`McpInstallDialog`、`McpDeleteDialog`）——数据源从
  `use-mcp.ts` 切换到本地 `McpConnectionManager` store，接口形状保持
  `McpServer`/`McpTestResult` 不变。
- 复用 schema：`packages/protocol/src/hermes-api.ts` 已有 `ToolsetInfo`
  （`/api/tools/toolsets` 响应）、`McpServer`、`McpServersFullResponse`、
  `McpTestResult`、`McpCatalog*` —— 本地 registry 直接产出同形对象，UI 零改动。
- 替换 hook：`web/src/hooks/use-mcp.ts`（REST CRUD + `reloadMcp()` WS）→ 新
  `use-toolsets.ts` / `use-local-mcp.ts`（订阅 Jotai store）；`use-mcp-servers.ts`
  只读端点改为本地连接状态派生。
- Rust 侧：`src/commands/*` 新增/复用 child-process 类命令
  （stdio MCP spawn/信号/退出码采集，参考现有 process 类命令与 `tauri-bridge.ts`
  的 IPC shim）；`lib/transport.ts`/`lib/gateway-client.ts` 在迁移后期退役。
- 会话入口：`_load_enabled_toolsets` 的等价物放在 agent loop 前的
  `selectEnabledToolsets(platform, config)` 模块（含 coding posture 折叠
  `project`/`desktop_ui` 的 `_gui_surface_toolsets` 规则）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API 面（迁移期间保持契约不变，便于 parity 测试）：
- `GET /api/tools/toolsets`（`ToolsetInfo[]`）、`PUT .../toggle`
- `GET /api/mcp/servers`、`POST /api/mcp/servers`、`PUT /{name}/enabled`、
  `POST /{name}/test`、`GET /api/mcp/catalog`
- WS `reload.mcp`（`{session_id, confirm}` → `{status: "reloaded"|"confirm_required"}`）

阶段：
1. **Phase A（只读镜像）**：TS 端实现 ToolsetRegistry/ToolRegistry 并加载静态目录；
   UI 的 toolsets 视图切到本地镜像，`/api/tools/toolsets` 仍作校验基准（对比测试）。
2. **Phase B（MCP 本地化）**：实现 `McpConnectionManager` + `@modelcontextprotocol/sdk`
   客户端；Rust IPC 提供 stdio spawn；`use-mcp.ts` 写操作改为本地 store +
   `reload.mcp` 桥接（仍走 WS，仅作兼容）。
3. **Phase C（插件+配置）**：插件 manager 加载 manifest 并注册工具集；`custom_toolsets`
   本地持久化；`reload.mcp` 改为纯本地 `notifyToolsetsChanged()` 事件。
4. **Phase D（删除）**：删除 `/api/mcp/*`、`/api/tools/toolsets` 调用与
   `gateway-client.ts` 中相关 RPC；Rust 端保留 child-process 命令。

## 8. Migration phases & task breakdown

1. **P0 移植解析引擎**：`toolset-registry.ts` + 精简静态目录（desktop 场景子集：
   web/search/file/terminal/vision/image_gen/browser/skills/todo/memory/clarify/
   code_execution/delegation/cronjob/session_search/desktop_ui/project/coding/
   debugging/safe；平台 bundles 标 out-of-scope）+ `getToolsetInfo`/`resolve`/`validate`。
2. **P1 ToolRegistry**：register/deregister/别名/快照/scope；单元测试镜像
   `test_toolsets.py`。
3. **P2 MCP 客户端**：connection-manager + stdio/http/sse client + tool-naming；
   Rust stdio spawn 命令。
4. **P3 动态刷新**：`tools/list_changed` nuke-and-repave（镜像
   `test_mcp_dynamic_discovery.py`）。
5. **P4 插件**：manifest 加载、`ctx.registerTool`、ownership ledger、allow-list、
   override 信任门。
6. **P5 custom_toolsets + wildcard**：配置 schema、`custom-toolsets.ts`、`all/*`。
7. **P6 UI 接线**：routes/mcp.tsx 切本地 store；新增 toolsets 管理页
   （复用 `ToolsetInfo`）；`reload.mcp` → 本地事件。
8. **P7 删除 WS/REST 路径** + 全量 parity/E2E 回归。

## 9. Risks & open questions

- **`custom_toolsets` 文档与代码不一致**：`toolsets-reference.md` 示例展示该配置键，
  但 `grep` 全仓无 Python 消费代码（`create_custom_toolset` 仅测试/`__main__` 用）。
  TS 端将实现为规范版本（数组=includes 短写 + `{tools,includes}` 对象两种形态）；
  需产品确认最终格式。
- **Tauri webview 无法直接 spawn stdio 子进程**（no TS equivalent found）：kimi-code
  在 Node 环境用 `child_process`，而 Desktop webview 只能经 Rust IPC。MCP stdio
  传输必须走 `src/commands`（或打包 Node sidecar），是本节最大架构决策；HTTP/SSE
  传输可纯 TS。
- **MCP 名称规范化语义分叉**：Python 用有损规范化（`read-file`→`read_file`，
  冲突跳过）；kimi-code 用 sanitize + 64 字符 hash（冲突极少）。移植需二选一——
  建议跟 kimi-code（桌面新生态），但 parity 测试须显式记录差异。
- **`check_fn` 能力门**（env/凭据探测）在 TS 侧需 Rust 或配置探测等价物；`kanban`
  opt-in 与 `all/*` 排除规则必须保留。
- **平台 bundles（`hermes-*`）out of scope**：桌面 standalone 不含消息平台适配器；
  `hermes-gateway` union 语义以「当前平台集」代替。
- **progressive disclosure（select_tools）**：Python 无此机制，kimi-code 有；
  建议桌面保留 Python inline 行为（parity 优先），disclosure 作为后续可选增强。

## 10. Test strategy

- **vitest 单元**（镜像 `tests/test_toolsets.py`）：
  `resolveToolset` 组合/环检测/diamond、`getAllToolsets` 含 plugin+mcp、
  `validateToolset` 别名、`createCustomToolset`、`all/*` 展开、`includeRegistry:false`
  静态视图。
- **vitest MCP 动态**（镜像 `tests/tools/test_mcp_dynamic_discovery.py`）：
  用 `@modelcontextprotocol/sdk` 内存/Test transport 模拟服务器；断言
  `mcp__srv__tool` 注册、`validateToolset("srv")`、`resolveToolset("srv")`；
  `list_changed` → nuke-and-repave；deregister no-op。
- **插件测试**（对应 `tests/hermes_cli/test_plugins.py`、
  `test_plugin_ownership_ledger.py`）：`ctx.registerTool` 注册/卸载还原、override
  信任门、allow-list。
- **parity 测试**：本地 registry 输出与冻结 REST 响应逐字段对比（Phase A 起持续）。
- **Playwright E2E**：MCP 页新增服务器后「我的 MCP 服务」列表 + 工具计数；
  toolsets 页显示 `mcp-<server>` 动态工具集；启用 wildcard 后模型工具数增加。

## 11. Reference links

- Python source: `D:/hermes-agent-cn/toolsets.py`、`tools/registry.py`、
  `tools/mcp_tool.py`、`hermes_cli/plugins.py`、`hermes_cli/tools_config.py`、
  `hermes_cli/web_routers/tools.py`、`tui_gateway/server.py::_load_enabled_toolsets`
- Docs: `D:/hermes-agent-cn/website/docs/reference/toolsets-reference.md`（§Dynamic
  Toolsets）、`website/docs/user-guide/features/plugins.md`
- Tests: `D:/hermes-agent-cn/tests/test_toolsets.py`、
  `tests/tools/test_mcp_dynamic_discovery.py`（注：`tests/plugins/test_plugin_toolset*.py`
  不存在，最近似为 `tests/hermes_cli/test_plugins.py` 与
  `tests/hermes_cli/test_plugin_ownership_ledger.py`）
- TS reference: `D:/kimi-code/packages/agent-core/src/agent/tool/index.ts`、
  `agent/tool/types.ts`、`mcp/connection-manager.ts`、`mcp/registry.ts`、
  `mcp/tool-naming.ts`、`mcp/types.ts`、`plugin/manager.ts`、`session/rpc.ts`
  （`registerTool`/`unregisterTool`）、`package.json`（`picomatch`、`zod`、
  `@modelcontextprotocol/sdk`）
- Desktop: `D:/Hermes-CN-Desktop/web/src/hooks/use-mcp.ts`、
  `hooks/use-mcp-servers.ts`、`routes/mcp.tsx`、`components/mcp/*`、
  `packages/protocol/src/hermes-api.ts`（`ToolsetInfo`、`McpServer`、
  `McpTestResult`）、`lib/transport.ts`、`lib/gateway-client.ts`
