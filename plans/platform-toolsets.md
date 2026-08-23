# Platform Toolsets — Python → TypeScript Rewrite Plan

> Feature: 平台工具集 (Platform toolsets) — `hermes-cli` (full), `hermes-acp`,
> `hermes-api-server`, `hermes-cron`, per-platform `hermes-<platform>` sets,
> `hermes-webhook` (restricted safe subset), `hermes-gateway` (union), plus the
> toolset registry/composition engine and per-platform selection that decides
> which tool schemas a session sees.

## 1. Summary

Python 侧把工具按 **toolset（工具集）** 分组：核心分类工具集（`web`/`file`/`terminal`
…）、场景复合工具集（`debugging`/`coding`）、以及以 `hermes-*` 命名的**平台工具集**
（CLI/ACP/API server/cron/每个消息平台/webhook/gateway）。会话创建时由
`hermes_cli/tools_config.py::_get_platform_tools` + `tui_gateway/server.py::_load_enabled_toolsets`
解析出“该平台 + 该会话 surface 启用哪些 toolset”，再转成工具 schema 列表交给模型。

本次改写把**注册表 + 解析/组合引擎 + 平台选择逻辑 + 分布采样**全部搬进 TS，
在桌面端以 in-process 模块运行（`packages/toolsets`），最终由 React 设置页直接编辑
`platform_toolsets`/`disabled_toolsets`，不再依赖 Python `/api/config` + WS 下发。
kimi-code 没有“平台工具集”概念，但它的 `ToolManager`（`setActiveTools`/`loopTools`
过滤）与 `select_tools` 渐进披露是 TS 侧最接近的 gating 原语，本方案以其为宿主接口。

## 2. Current Python implementation

**注册表与解析引擎 — `D:/hermes-agent-cn/toolsets.py`（1039 行）**

- 常量：`_HERMES_CORE_TOOLS`（约 60 个核心工具：web、terminal/process、file、
  vision/image_gen、BFL FLUX3、skills、browser_*、tts、todo/memory、session_search、
  clarify、execute_code/delegate_task、cronjob、ha_*、kanban_*、computer_use；
  注释明确 `desktop_ui`/`project` 工具**故意不在此列**，只由 GUI gateway 按会话 source 折叠）；
  `_HERMES_WEBHOOK_SAFE_TOOLS = ["web_search", "web_extract", "vision_analyze", "clarify"]`
  （webhook 默认受限子集，防 prompt injection 触达文件/终端/浏览器）。
- `TOOLSETS` dict：每个条目 `{description, tools, includes}`，个别带 `posture`
  （`coding`）或 `module`（`hermes-yuanbao`）。平台工具集：
  - `hermes-cli` = `_HERMES_CORE_TOOLS`（全量，默认 CLI）；
  - `hermes-acp` = 编码聚焦（去掉 clarify/cronjob/image_gen/tts/computer_use/ha_*/kanban）；
  - `hermes-api-server` = 全量去掉 clarify/tts/computer_use/kanban；
  - `hermes-cron` = `_HERMES_CORE_TOOLS`（与 cli 同集，注释：先同集再被
    `hermes tools` 按平台配置过滤）；
  - `hermes-telegram/whatsapp/slack/signal/bluebubbles/homeassistant/email/mattermost/
    matrix/dingtalk/weixin/qqbot/wecom/wecom-callback/sms` = 核心集；
  - `hermes-discord` = 核心集 + `discord` + `discord_admin`；
  - `hermes-feishu` = 核心集 + 5 个 `feishu_doc_read`/`feishu_drive_*`；
  - `hermes-yuanbao` = 核心集 + 5 个 `yb_*`；
  - `hermes-webhook` = `_HERMES_WEBHOOK_SAFE_TOOLS`；
  - `hermes-gateway` = `tools: []` + `includes: [全部 hermes-* 平台工具集]`（union）。
- 函数：`get_toolset(name, include_registry=True/False)`（registry 合并视图 vs
  静态视图，issue #49622）、`resolve_toolset`（递归 includes + visited 环检测、
  `all`/`*` 通配、plugin 平台 `hermes-<name>` 自动工具集）、`resolve_multiple_toolsets`、
  `get_all_toolsets`/`get_toolset_names`/`validate_toolset`、`create_custom_toolset`、
  `get_toolset_info`、`bundle_non_core_tools`（禁用 bundle 时只剥平台 extras、
  不连带剥掉核心集，issue #33924）。

**平台选择 — `D:/hermes-agent-cn/hermes_cli/tools_config.py`（5581 行）**

- `CONFIGURABLE_TOOLSETS`（`hermes tools` 可开关的分类工具集列表）、`PLATFORMS`
  （平台 → `default_toolset`，如 cli → hermes-cli）。
- `_get_platform_tools(config, platform, include_default_mcp_servers)`：
  读 `config["platform_toolsets"][platform]`；无配置时回退平台默认复合工具集；
  反向映射（把复合工具集解析成单个工具名，再对每个可配置工具集做静态子集判断，
  `include_registry=False` 防插件注册工具误伤）；`has_explicit_config` 分支、
  `_DEFAULT_OFF_TOOLSETS`、`_TOOLSET_PLATFORM_RESTRICTIONS`、
  `_exempt_explicit_platform_native`（#35527）、`_enable_recently_shipped_toolsets`、
  凭据自动启用（`x_search` 当 xAI creds、`homeassistant` 当 HASS_TOKEN）。

**会话 surface 折叠 — `D:/hermes-agent-cn/tui_gateway/server.py`（~4285-4457）**

- `_gui_surface_toolsets(platform)`：按 **session 的 `source`**（非进程 env）返回
  `{"project"}`，`source=="desktop"` 时加 `{"desktop_ui"}` —— 桌面客户端连
  local/SSH/URL/cloud 后端结果一致（test_gui_surface_toolsets.py 的核心回归）。
- `_load_enabled_toolsets(platform)`：`HERMES_TUI_TOOLSETS` env 显式 pin 优先 →
  `coding_selection()` 编码姿态（返回早时也折叠 surface）→ 否则
  `_get_platform_tools(cfg, "cli")` + `_gui_surface_toolsets`。

**分布采样 — `D:/hermes-agent-cn/toolset_distributions.py`（358 行）**

- `DISTRIBUTIONS`（default/image_gen/research/science/development/safe/balanced/
  minimal/terminal_only/terminal_web/creative/reasoning/browser_use/browser_only/
  browser_tasks/terminal_tasks/mixed_tasks），`sample_toolsets_from_distribution`
  按概率独立抽样、空结果保底最高概率项。仅 batch runner（数据生成）使用。

**测试（parity 基准）**

- `D:/hermes-agent-cn/tests/test_toolsets.py`（注：任务书写的
  `tests/tools/test_toolsets.py` 实际不存在，正确路径是 `tests/test_toolsets.py`）：
  结构键、复合解析、环检测、registry 合并/静态视图拆分、`hermes-*` 共享核心集、
  webhook/web_search 覆盖。
- `D:/hermes-agent-cn/tests/tui_gateway/test_gui_surface_toolsets.py`：desktop_ui
  精确集合、与核心集不相交、无平台 bundle 携带、按 session source 解析、env pin 优先。
- `D:/hermes-agent-cn/tests/test_toolset_distributions.py`：结构/概率区间/抽样。

## 3. Target TypeScript design

新包 **`packages/toolsets`**（monorepo 内，供 `web/` 与未来 agent-core 复用），
模块布局：

```text
packages/toolsets/src/
  types.ts            # ToolsetDefinition / ToolsetInfo / PlatformToolsetsConfig
  registry.ts         # 静态 TOOLSETS 注册表（1:1 移植）+ getToolset/validate/getAll
  resolve.ts          # resolveToolset / resolveMultipleToolsets / bundleNonCoreTools / all 通配 / 环检测
  platform.ts         # resolveEnabledToolsetsForPlatform(config, platform, sessionSource)
  surface.ts          # guiSurfaceToolsets(sessionSource)（desktop_ui/project 折叠）
  distributions.ts    # DISTRIBUTIONS + sampleToolsetsFromDistribution
  tool-set-manager.ts # in-process ToolSetManager（kimi-code ToolManager 形态宿主）
```

关键设计：

- **ToolsetDefinition**：`{ name, description, tools: string[], includes: string[],
  posture?: boolean, module?: string }`；核心常量 `HERMES_CORE_TOOLS`、
  `HERMES_WEBHOOK_SAFE_TOOLS` 原样移植（含注释里的“desktop_ui/project 不入核心集”
  约束）。
- **Registry 双视图**：`getToolset(name, { includeRegistry: boolean })` 保留
  Python 的静态/合并拆分语义；TS 插件/MCP registry 先以 `Map<string, ToolsetEntry>`
  接口占位（插件/MCP 移植是独立 feature，本方案只定义 merge 点）。
- **解析引擎**：递归 includes + visited 环检测 + `all`/`*` 通配，行为与
  `resolve_toolset` 对齐（返回排好序、去重的工具名数组）。
- **平台选择**：`resolveEnabledToolsetsForPlatform(config, platform, sessionSource)`
  合并 `_get_platform_tools` + `_gui_surface_toolsets` 语义，输出启用 toolset 名列表
  （`string[]`），再交给 ToolSetManager 转 schema。
- **in-process 运行**：`ToolSetManager` 仿 kimi-code `ToolManager`
  （`packages/agent-core/src/agent/tool/index.ts`）：`setActiveTools(names, disallowed)`
  维护 `enabledTools`/`disabledTools` 集合，`loopTools` getter 每次读取时按
  allow/deny 过滤并排序输出可执行工具表；`desktop_ui`/`project` 通过 surface
  折叠进入 enabled 集合（对应 Python `_gui_surface_toolsets` 的“唯一闸门”）。

数据流（无 Python）：

```text
React Settings (tools 配置) ──> TS config store (Rust IPC 持久化)
      └─> resolveEnabledToolsetsForPlatform(config, "cli", "desktop")
            └─> ToolSetManager.setActiveTools(enabled) ──> loop 内 get tools()
                  └─> 模型请求工具 schema（json-schema 由 tools/ 各实现注册）
```

## 4. Data models & persistence

- **`packages/protocol` 新增 Zod schema**（风格沿用 `hermes-api.ts`）：
  `ToolsetInfo`（`get_toolset_info` 等价：name/description/direct_tools/includes/
  resolved_tools/tool_count/is_composite）、`ToolsetListResponse`、
  `PlatformToolsetsConfig = z.record(z.string(), z.array(z.string()))`。
- **持久化 key（冻结的配置面）**：
  - `platform_toolsets.<platform>`（string[]，如 `cli: ["hermes-cli"]`）—— `hermes
    tools` 保存的目标；
  - `agent.disabled_toolsets`（string[]，禁用列表）；
  - `toolsets` / `custom_toolsets`（会话级/自定义工具集）；
  - `mcp_servers`（MCP 动态工具集来源，另见 MCP feature 计划）。
- **存储策略**：端态下配置由 Rust 侧持久化（app data 下 JSON/SQLite，沿用
  `src/commands/*` 现有 config 命令）；迁移期仍走 `GET/PUT /api/config`
  （`use-config.ts`），`ConfigResponse = z.record(z.unknown())` 允许透传上述 key。
- **迁移/校验规则**：未知 toolset 名忽略并告警（对齐 `_load_enabled_toolsets` 的
  unresolved 处理）；YAML 数字 key（如 `12306:`）归一化为 string（对齐
  `_get_platform_tools` 的 `str(ts)`）；`all`/`*` 展开后忽略同列表其它项。

## 5. Third-party library strategy

| Python 依赖 | TS 等价 | 证据（kimi-code） |
|---|---|---|
| 无（stdlib `typing`/`random`） | TS 接口 + `Math.random` | 平凡移植 |
| `orjson`/YAML 配置解析 | **`js-yaml`** | `packages/agent-core/package.json` 依赖 `js-yaml ^4.1.1` |
| 配置/协议 schema 校验（dataclass→schema） | **`zod`** | `packages/agent-core/package.json` `zod ^4.3.6`；`tools/builtin/select-tools.ts` 用 `z.object().strict()` 定义工具输入 |
| MCP 工具名 glob 门控（`mcp__*` 模式） | **`picomatch`** | `packages/agent-core/package.json` `picomatch ^4.0.4`；`agent/tool/index.ts` `isMcpToolEnabled` 用 `picomatch.isMatch` |
| `toolsets.py` 组合/解析引擎 | **从零移植**（无现成 TS 库） | kimi-code `ToolManager`（`agent/tool/index.ts`：`setActiveTools`(L532)/`loopTools`(L956)/`initializeBuiltinTools`(L775)）提供 allow/deny + 条件构造宿主，但无 toolset 组合语义 |
| `hermes tools` curses UI | **React 设置组件**（无 curses 等价） | 参照 `web/src/routes/mcp.tsx`、`settings.tsx::ConfigSection` 的既有表单模式 |
| `toolset_distributions.py` 采样 | 小型 TS 模块 `distributions.ts` | 仅 batch runner 消费（batch runner 本身 out-of-scope），可后置 |

kimi-code gating 对照（第 3 节宿主接口的依据）：

- 能力/flag 三闸门：`agent/index.ts` `toolSelectEnabled` =
  `modelCapabilities.dynamically_loaded_tools && tool_use && experimentalFlags('tool-select')`；
- 条件构造工具：`initializeBuiltinTools` 里 `goalToolsEnabled = agent.type==='main'`、
  `modelCapabilities.image_in/video_in && new ReadMediaFileTool(...)`、
  `toolServices?.webSearcher && new WebSearchTool(...)` —— 对应 Python 的
  check_fn 门控（browser CDP/computer_use cua-driver/HASS_TOKEN/xAI creds/kanban）；
- 渐进披露：`select_tools`（`tools/builtin/select-tools.ts`）按名字加载动态 schema ——
  未来 MCP/插件工具集的 TS 侧披露可复用此原语，本 feature 只保留接口。

## 6. Integration with existing Hermes-CN-Desktop frontend

- **`web/src/lib/runtime.ts`**：`RuntimePlatform = "web"|"electron"|"tauri"`（L47）、
  `runtime.platform`（L580，`__TAURI_INTERNALS__` 检测）、`detectHostOS()`（L562，
  macos/windows/linux）、`connectionMode`（managed/local/remote）—— 作为
  “会话 source/平台”映射输入（desktop 会话 → `source:"desktop"`）。
- **`web/src/hooks/use-config.ts`**：`useConfig`/`useConfigSchema`/`useSaveConfig`
  复用为迁移期读写 `platform_toolsets` 的通道；端态切到本地 config store 时替换
  queryFn 即可。
- **`web/src/routes/settings.tsx`**：现状**没有专用工具配置区**——`toolsets`/
  `agent.disabled_toolsets` 只是经 `ConfigSection`（L730 起 schema 驱动通用表单）
  与 `web/src/lib/config-translations.ts`（`"toolsets": "工具集"`、
  `"agent.disabled_toolsets": "禁用的工具集"`）透出。新增 `ToolsSection`
  （仿 `SkillsSection`/`mcp.tsx`）：平台下拉（cli/desktop/acp/api-server/cron/
  webhook…）+ 可配置 toolset 开关卡片 + 只读 `ToolsetInfo` 列表。
- **`packages/protocol`**：`hermes-api.ts` 增加 ToolsetInfo/列表 schema；
  `ConfigResponse`（L436）与 `ConfigUpdateRequest`（L439）已足够透传配置 key。
- **Rust 侧**：`src/commands/*` 现有 config 命令持久化；`tauri-bridge.ts` 提供
  端态 config 读写 IPC 封装。

## 7. Removing the WebSocket dependency (migration path)

1. **冻结 API 面**（迁移期不变）：`platform_toolsets`/`disabled_toolsets`/
   `toolsets`/`custom_toolsets` 配置 key；工具 schema 的 JSON 形状；会话 source
   取值（desktop/tui/cli/…）；`desktop_ui`/`project` 只按 source 折叠的规则。
2. **Phase A（今天，保留后端）**：桌面仍通过 WS/REST 拿到 Python 解析出的启用
   toolset/schema；`packages/toolsets` 在 TS 侧并行实现并跑 parity 测试（golden
   快照对比 `resolve_toolset`）。
3. **Phase B（同接口并行）**：`ToolSetManager` 提供
   `toolsForSession({platform, sessionSource, config}) → ToolsetInfo[]`，与
   `/api/ws` 工具下发同接口；React 设置页切到本地解析结果；attached
   （local/remote）模式仍回退后端结果。
4. **Phase C（managed 删除 WS 路径）**：managed 模式下 ToolSetManager 是唯一事实
   来源，工具 schema 完全 in-process；删除 WS 工具集消息与 `/api/toolsets`；
   attached 模式保留后端下发的兼容路径。

## 8. Migration phases & task breakdown

- **P0 — 注册表 + 解析引擎**：移植 `types.ts`/`registry.ts`/`resolve.ts`
  （静态 TOOLSETS 1:1、hermes-* 平台集、webhook 安全子集、gateway union、
  环检测、all 通配、include_registry 双视图）；vitest parity。
- **P1 — 平台选择 + surface 折叠**：`platform.ts`/`surface.ts`（反向映射、
  default_off/平台限制、x_search/homeassistant 凭据自动启用、
  desktop_ui/project 按 source 折叠、env pin 优先）。
- **P2 — 协议 + 设置 UI**：protocol Zod schema；`ToolsSection` 设置页；
  config-translations 补充。
- **P3 — in-process ToolSetManager**：接 kimi-code 形态宿主；managed 模式启用。
- **P4 — 移除 WS**：删 WS 工具集下发路径 + 后端 `/api/toolsets`（managed 下）。
- **P5（可选/后置）**：`distributions.ts` 移植（batch runner out-of-scope，仅保
   行为记录）。

## 9. Risks & open questions

- **“平台”歧义**：Python 的 `platform` 指会话部署上下文（cli/telegram/…），TS 侧
  `runtime.platform` 指 web/electron/tauri 宿主 —— 命名冲突需在 `platform.ts`
  用 `sessionSource`/`deploymentContext` 明确区分，避免混淆。
- **`_DEFAULT_OFF_TOOLSETS`/`_TOOLSET_PLATFORM_RESTRICTIONS`/
  `_enable_recently_shipped_toolsets` 隐式表**：必须从 `tools_config.py` 逐条抄录
  并加快照测试，否则新平台/新工具上线后“为什么这个工具没出现”难排查。
- **check_fn 运行时门控（约 9 处）**：browser CDP、computer_use cua-driver、
  HASS_TOKEN、xAI creds、kanban 等需 TS 等价能力/凭据检查，且与 kimi-code 的
  `modelCapabilities` 门控语义不同（一个是部署能力、一个是模型能力），不可混用。
- **plugin/MCP 动态工具集**：依赖插件 registry 与 MCP 移植（独立 feature），本方案
  只定义 merge 接口，plugin 自动 `hermes-<name>` 工具集暂无法完整验证。
- **`hermes-gateway` union**：Python 网关编排器专用；桌面 standalone 可能用不到，
  但注册表必须保留以保 parity（`bundle_non_core_tools` 测试依赖它）。
- **`toolset_distributions.py`**：仅 batch runner 消费，桌面无对应运行面 —— 建议
  记录为 out-of-scope（分布数据结构仍移植，采样器可后置）。

## 10. Test strategy

- **vitest 单元（parity 移植）**：registry 结构（每项有 description/tools/includes）；
  `hermes-*` 平台共享核心子集且非平凡（>20 工具）；`resolveToolset` 叶/复合/环检测/
  去重；`includeRegistry=false` 静态视图排除插件注册工具（#49622）；`all`/`*`
  通配；`bundleNonCoreTools` 不剥核心。
- **surface 回归（移植 `test_gui_surface_toolsets.py`）**：desktop_ui 精确集合、
  与 `HERMES_CORE_TOOLS` 不相交、无平台 bundle 携带；desktop 会话无 env 也得到
  desktop_ui/project；tui 会话不得；`HERMES_TUI_TOOLSETS` pin 优先；coding 姿态
  早退也折叠 surface。
- **平台选择 parity**：显式 `platform_toolsets` vs 复合回退 vs 混合配置；
  default_off/平台限制；x_search/homeassistant 凭据自动启用；webhook 安全子集
  与核心集不相交。
- **golden 快照**：用 Python `resolve_toolset("<每个平台工具集>")` 生成 JSON
  快照，vitest 逐名比对（工具增删时快照 diff 暴露漂移）。
- **Playwright E2E**：设置页 ToolsSection 开关 → 保存 → 重载后持久化；
  managed 模式工具列表与本地解析一致。

## 11. Reference links

- Python: `D:/hermes-agent-cn/toolsets.py`,
  `D:/hermes-agent-cn/toolset_distributions.py`,
  `D:/hermes-agent-cn/hermes_cli/tools_config.py`,
  `D:/hermes-agent-cn/tui_gateway/server.py` (`_load_enabled_toolsets`/
  `_gui_surface_toolsets`), `D:/hermes-agent-cn/website/docs/reference/toolsets-reference.md`
- Tests: `D:/hermes-agent-cn/tests/test_toolsets.py`（注意：不是
  `tests/tools/test_toolsets.py`）、`tests/tui_gateway/test_gui_surface_toolsets.py`、
  `tests/test_toolset_distributions.py`
- kimi-code: `packages/agent-core/src/agent/tool/index.ts`,
  `packages/agent-core/src/agent/index.ts` (`toolSelectEnabled`),
  `packages/agent-core/src/tools/builtin/select-tools.ts`,
  `packages/agent-core/src/agent/config/types.ts`,
  `packages/agent-core/package.json`（js-yaml/picomatch/zod）,
  `apps/kimi-code/src/constant/app.ts`、`apps/kimi-code/src/utils/process/*`
- Desktop: `web/src/lib/runtime.ts`, `web/src/hooks/use-config.ts`,
  `web/src/routes/settings.tsx`（`ConfigSection`）, `web/src/lib/config-translations.ts`,
  `packages/protocol/src/hermes-api.ts`, `packages/protocol/src/channels.ts`
