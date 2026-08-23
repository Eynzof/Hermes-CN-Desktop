# Context Usage Visibility — Python → TypeScript Rewrite Plan

## 1. Summary

Feature: 让用户看到「上下文窗口现在装了什么、装了多少」以及「会话/账号花了多少」。

- `/context` / `/ctx`：视觉化的 context-window 分解（system prompt 分档、工具 schema、rules、
  skills 索引、MCP、子代理定义、memory、conversation），CLI 用 5×20 glyph 网格，桌面端改成一个
  React 面板（分类色块 + 百分比 + `/context all` 的 per-skill / per-toolset 明细）。
- `/status`：会话信息（model、provider、session id、title、时间戳、token 合计、agent running）
  加本地 **Session recap**（`hermes_cli/session_recap.py` 的 `build_recap` 移植）。
- `/usage`：会话 token 明细 + 成本估算 + context 窗口状态 + 账号限额（provider 拉取）+
  Nous credits。目前桌面只通过 `session.usage` RPC + `SessionUsageResult` 拿到了部分数据。
- `/insights`：SessionDB 历史统计（sessions/tools/skills/models/platforms/activity），桌面端
  已有 Analytics 路由与 `/api/analytics/usage`，需要把 `InsightsEngine` 的全部 SQL 归一到
  TS 侧。

现状：Desktop 是 React + Rust (Tauri) 前端，通过 WS/REST 调用 Python managed runtime。
本计划的终态：这些命令全部在 TypeScript 进程内计算（不经过 Python backend / WS）。

## 2. Current Python implementation

### 2.1 `/context` — `agent/context_breakdown.py`（核心，360 行）

- `compute_session_context_breakdown(agent, messages) -> dict`（L89-156）：
  - 从 `agent.system_prompt.build_system_prompt_parts(agent)` 拿 stable/context/volatile 三段；
    用 `re` 提取 `<available_skills>` 块；从 `agent._memory_store` 拿 memory/user profile 块。
  - 把 tools 按名字分三类：`mcp_` 前缀 → MCP；`delegate_task` → subagent；其余 → builtin。
  - 8 个 category：`system_prompt / tool_definitions / rules / skills / mcp /
    subagent_definitions / memory / conversation`，每个有 `color`（CSS var `--context-usage-*`）、
    `label`、`tokens`。
  - token 估算：统一 chars/4 启发式 `_chars_to_tokens`（与 `agent.model_metadata.
    estimate_messages_tokens_rough` 对齐）；工具 schema 用 `orjson.dumps` 后按字节/4。
  - `context_used = compressor.last_prompt_tokens`（测得的真实值）否则 `estimated_total`；
    `context_percent = used / context_max`（`compressor.context_length`）。
- `compute_context_details(agent)`（L190-229）：`/context all` 的展开表。复用
  `hermes_cli/prompt_size._compute_skills_breakdown`（解析 `<available_skills>` 每行字节）和
  `_compute_toolsets_breakdown`（工具注册表 canonical tool→toolset 映射），输出
  `{skills: [{name, index_tokens, skill_md_tokens}], toolsets: [{toolset, tool_count, schema_tokens}]}`。
- 渲染器（纯文本，无 LLM 调用）：
  - `render_context_grid`（L232-257）：5×20=100 格，每格 ≈ 1% 窗口；glyph 表
    `■▣▩▤▥▦▧▨` + 空闲 `·`；非零但 <1% 的类别至少画 1 格。
  - `render_context_category_lines`（L260-284）：类别表 + Free space。
  - `render_context_details_lines`（L287-322）：per-skill/per-toolset 表，上限 15 行。
  - `render_context_breakdown_lines(payload, details=None, grid=True)`（L325-360）：
    CLI `grid=True`，gateway `grid=False`。

调用点：
- `cli.py` `_show_context_breakdown`（L11712）：`/context [all]`，打印 `🧠 Context Usage — model`。
- `gateway/slash_commands.py` `_handle_context_command`（L722）+ `_context_breakdown_block`（L4925）。
- `tui_gateway/methods_session.py` `session.context_breakdown` RPC（L1381-1408）：返回结构化 payload，
  是桌面 Composer popover 的数据来源（Desktop 已有 `context-usage.ts` 消费同源数据）。

### 2.2 `/status` — 会话信息 + recap

- `cli.py` `_show_session_status`（L7963-8014）：session id、path、title、model(provider)、
  created/updated、tokens、agent running。
- `gateway/slash_commands.py` `_handle_status_command`（L540-713）：从 live/cached agent、
  SessionDB、SessionStore 级联取 model/provider/context_used/context_total；加 connected platforms、
  queue depth；Matrix 专属 scope 块。
- `hermes_cli/session_recap.py` `build_recap(messages, session_title, session_id, platform)`（L244-319）：
  纯本地、无 LLM：可见 turn 计数、工具调用 top5、files touched、last ask / last reply 截断预览。
  CLI 与 gateway 共用。

### 2.3 `/usage` — 会话 token + 账号限额

- `cli.py` `_show_usage`（L11761-11860）：rate limits（`agent.rate_limit_tracker`）→ session token
  breakdown（input/output/reasoning/prompt/completion/total、api_calls）→ context window
  （`compressor.last_prompt_tokens/context_length/compression_count`）→ Nous credits 块
  （`agent.account_usage.nous_credits_lines`）→ Codex `/usage reset`。
- `gateway/slash_commands.py` `_handle_usage_command`（L5003-5175）：与 CLI 相同数据源，
  另加 `agent.account_usage.fetch_account_usage(provider, base_url, api_key)` →
  `render_account_usage_lines(...)`（Account limits），以及 `_context_breakdown_lines`（复用
  `compute_session_context_breakdown`，但按 `estimated_total` 算百分比，不依赖 `context_max`）。
- `agent/account_usage.py`：`AccountUsageWindow/AccountUsageSnapshot`（L27-48）、
  `render_account_usage_lines`（L96）、`nous_credits_lines`（L234）、`fetch_account_usage`（L885，
  按 provider 分派：openai-codex / anthropic / openrouter / nous portal，底层 httpx）。
- 桌面已消费的 RPC：`tui_gateway/methods_session.py` `session.usage`（L1370 附近）→
  `SessionUsageResult`（协议见 §4）。

### 2.4 `/insights` — `agent/insights.py`（1162 行）

- `InsightsEngine(db)`（L85）：`generate(days=30, source=None) -> report`，report 结构：
  `{days, source_filter, empty, generated_at, overview, models, platforms, tools, skills, activity,
  top_sessions}`。
- SQL：`_GET_SESSIONS_*`（sessions 表 18 列，避开大 blob）；`_GET_TOOL_CALLS_*`（assistant
  `tool_calls` JSON，`INDEXED BY idx_messages_assistant_calls_by_session` 硬依赖 + 缺失时回退）；
  `_GET_SKILL_CALLS_*`（`instr(tool_calls,'skill_view'|'skill_manage')` 预过滤）；
  `_get_message_stats`。
- 成本：`agent.usage_pricing`（`CanonicalUsage`、`estimate_usage_cost`、`format_duration_compact`、
  `has_known_pricing`）→ 每 session `estimated_cost_usd`。
- `get_usage_breakdown(days, source)`（L199）：仅 tools+skills，给 dashboard `/api/analytics/usage`。
- `format_terminal`（L958）/ `format_gateway`（L1098）：终端大表格 vs 消息短文本。
- CLI 入口 `cli.py` `_show_insights`（L11870-11904）：解析 `/insights [days] [--source X]`。

### 2.5 注册与文档

- `hermes_cli/commands.py`：`COMMAND_REGISTRY` 注册 `/insights`（L332，Info 类）、别名与
  `/context` 的 native-slot 说明（L1273-1285）。
- `website/docs/reference/slash-commands.md`：L64-65（`/status`、`/context [all]`）、L130-133
  （`/usage`、`/insights`）、L230/244/247/264（messaging 版）。
- `website/docs/user-guide/features/overview.md`：未直接列出该 feature 名（grep 无命中），
  以 slash-commands.md 为准。

### 2.6 Python 测试（parity 基准）

- `tests/agent/test_context_breakdown.py`：payload 类别、grid 行数、`grid=True/False` 差异。
- `tests/cli/test_cli_insights_command.py`：`/insights 7`、`--days 14 --source discord` 解析与
  `db.close()`。
- `tests/test_account_usage.py`：`fetch_account_usage` 解析（plan/windows/reset）、
  `render_account_usage_lines` 文案。
- `tests/gateway/test_status_command.py`、`tests/gateway/test_usage_command.py`：
  patch `context_breakdown` 后校验命令输出。
- `tests/hermes_cli/test_session_recap.py`：`build_recap` 纯函数测试。
- `tests/hermes_cli/test_active_sessions.py`：active-session 锁（`/status` 的 agent-running 状态
  依赖同一活性判定，非直接命令测试）。

## 3. Target TypeScript design

目标：四个命令都变成 TS 进程内模块，运行时不依赖 Python agent 对象。

### 3.1 模块布局（`web/src/`）

```
web/src/lib/context-breakdown.ts      # 移植 agent/context_breakdown.py（纯函数 + 类型）
web/src/lib/context-breakdown.test.ts # vitest 对照 tests/agent/test_context_breakdown.py
web/src/lib/session-recap.ts          # 移植 hermes_cli/session_recap.py build_recap
web/src/lib/insights.ts               # 移植 agent/insights.py InsightsEngine（TS 版 SQL）
web/src/lib/account-usage.ts          # 移植 agent/account_usage.py 的模型+渲染（fetch 走 Tauri IPC）
web/src/lib/usage-pricing.ts          # 成本估算表（agent/usage_pricing.py 的 TS 版）
web/src/hooks/use-context-breakdown.ts
web/src/hooks/use-session-recap.ts
web/src/hooks/use-usage.ts            # 合并现有 use-session-usage-polling + 本地估算
web/src/hooks/use-insights.ts         # 扩展现有 use-analytics.ts
web/src/components/context/context-breakdown-panel.tsx   # /context 面板（grid + 类别表 + all 明细）
web/src/components/context/status-panel.tsx              # /status 面板（session info + recap）
web/src/components/context/usage-panel.tsx               # /usage 面板
web/src/components/context/insights-panel.tsx            # /insights 面板（或复用 routes/analytics）
```

### 3.2 `/context` 数据流（in-process）

- 输入：`AgentContextSnapshot`（由现有 `useGateway` 的 runtime 事件 + 本地消息列表组成）：
  - `systemPromptParts {stable, context, volatile}`、`memoryBlock`、`userBlock`
  - `tools: ContextEstimateTool[]`（本地已有形态，见 `context-usage.ts`）
  - `conversationMessages`（UI messages 或 protocol messages）
  - `contextCompressor {lastPromptTokens, contextLength, compressionCount, thresholdTokens}`
  - `model`、`session` 元数据
- `computeSessionContextBreakdown(snapshot): ContextBreakdownPayload`：
  - 1:1 移植 §2.1 的 8 类别切分；token 用 `estimateTokens(text) = Math.ceil(chars/4)`，
    JSON 用 `JSON.stringify`（替代 orjson）。
  - `contextUsed = compressor.lastPromptTokens > 0 ? lastPromptTokens : estimatedTotal`。
- `computeContextDetails(tools, skillsBlock)`：per-skill index 行字节解析 + per-toolset schema
  字节归组（工具→toolset 映射来自本地 registry 而非 Python 注册表；见 §5/§9）。
- React 面板：`ContextBreakdownPanel` 渲染 CSS 网格（100 格，等价 5×20，用 flex/grid 布局）、
  类别表、`/context all` 明细；保留现有 `ContextIndicator` 小环作为入口（复用
  `goose-composer-context.tsx` 的交互模式）。

### 3.3 `/status` 数据流

- `useSessionInfo()`：合并现有 `useSession`、`useSessionResolution`、`useSessionTurnStats`、
  `ui-store` 数据 → `SessionStatusViewModel`（id/title/model/provider/created/updated/tokens/
  contextUsed/contextMax/agentRunning/queueDepth）。
- `buildSessionRecap(messages, {sessionTitle, sessionId})`：按 `build_recap` 逻辑：visible turn
  计数、top tools、files touched、last ask/last reply 截断。桌面端 messages 已是本地 Hermes UI
  消息，可直接复用 `attachTurnStatsMetadata` 后同一数组。

### 3.4 `/usage` 数据流

- 本地部分：`SessionUsageResult`（现有 RPC）+ 本地 `estimateRenderedContextTokens` 回退 +
  `ui-store` turn stats 聚合（token/cost 合计）→ `UsagePanel`。
- 账号部分：`fetchAccountUsage(provider, baseUrl, apiKey)` 通过 Tauri IPC 到 Rust
  （Rust 用 `reqwest`/`ureq` 发 provider API），返回 `AccountUsage`；Nous credits
  同路径（`nous_credits_lines` 移植）。offline/fail-open 语义与 Python 一致。
- `/usage reset`：Codex banked reset —— 需要 provider API，经 Rust IPC 调
  `redeem_codex_reset_credit` 等价逻辑（保留 HTTP 依赖，仅去除 Python）。

### 3.5 `/insights` 数据流

- 替代方案 A（推荐，短期）：保留 `/api/analytics/usage` 的 JSON 结构（Desktop 已定义
  `AnalyticsResponse` Zod schema），把 Python `InsightsEngine` 的 SQL 用 TS SQLite 重写，
  REST 路由直接换成 Tauri IPC 命令 `analytics_usage(days, source)`。
- 替代方案 B（渐进）：先让 Rust IPC 调 Python 返回同 JSON，冻结 `AnalyticsResponse` 契约
  （见 §7），再逐段替换 SQL。

## 4. Data models & persistence

### 4.1 新增 TS 类型（协议层 `packages/protocol/src/hermes-api.ts` 扩展）

```ts
export const ContextBreakdownCategory = z.object({
  id: z.enum(["system_prompt","tool_definitions","rules","skills","mcp",
              "subagent_definitions","memory","conversation"]),
  label: z.string(),
  tokens: z.number(),
  color: z.string().optional(),          // CSS var 名，桌面端由主题层解析
});
export const ContextBreakdownPayload = z.object({
  categories: z.array(ContextBreakdownCategory).default([]),
  context_max: z.number().default(0),
  context_percent: z.number().default(0),
  context_used: z.number().default(0),
  estimated_total: z.number().default(0),
  model: z.string().default(""),
});
export const ContextDetailsPayload = z.object({
  skills: z.array(z.object({ name: z.string(), index_tokens: z.number(),
                             skill_md_tokens: z.number().nullable() })).default([]),
  toolsets: z.array(z.object({ toolset: z.string(), tool_count: z.number(),
                               schema_tokens: z.number() })).default([]),
});
export const AccountUsageWindow = z.object({ label: z.string(), used_percent: z.number(),
                                             reset_at: z.string().nullable() });
export const AccountUsageSnapshot = z.object({ provider: z.string(), plan: z.string().optional(),
  windows: z.array(AccountUsageWindow).default([]), details: z.array(z.string()).default([]) });
```

- `SessionUsageResult` 已存在（hermes-api.ts L1336），无需改；`AnalyticsResponse` 已存在
  （L909），用于 `/insights` 数据契约。
- 现有 `HermesMessageMetadata.usage` / `UiTurnStats`（ui-store）继续作为会话级 token 事实源。

### 4.2 持久化

- **短期（仍有 Python backend）**：不新增表。会话 token 从 `SessionUsageResult`/`ui-store` 读，
  insights 从现有 `AnalyticsResponse` REST 读，账号数据仅内存缓存（poll 间隔 ≥ 60s）。
- **终态（in-process）**：复用 Rust `src/state.rs` 的 SQLite（或 IndexedDB 镜像）存
  `sessions`/`messages` 的 token 列（input/output/cache_read/cache_write/reasoning/
  estimated_cost_usd/billing_*）——这些列当前由 Python `run_agent.py` 写入，迁移时把写入点搬到
  Rust `commands`（`record_session_usage`），schema 与 Python `state.db` 列对齐以利平滑切换。
- `/insights` 需要的 partial index `idx_messages_assistant_calls_by_session` 在 Rust SQLite
  migration 中原样建立（避免 `INDEXED BY` 缺失导致的全表扫描回归，Python 有 fallback，TS 侧
  用 `CREATE INDEX IF NOT EXISTS` 保证存在）。

## 5. Third-party library strategy

| Python 依赖 | 用途 | TS 等价 | kimi-code 证据 |
|---|---|---|---|
| `orjson` | 工具 schema 序列化后按字节/4 | `JSON.stringify`（`estimateTokensForTools` 同款） | `packages/agent-core/src/utils/tokens.ts` L52-53 |
| `re`（DOTALL 提取 `<available_skills>`） | skills 块切分 | 原生 `RegExp` | —（kimi-code 用 XML 工具拼装，见 `agent/context/notification-xml.ts`，解析逻辑自己写） |
| `sqlite3` + SessionDB | insights 统计 | Rust SQLite（`rusqlite`/`sqlx`）经 Tauri IPC，或 `@hermes/protocol` Zod 校验 JSON 结果 | kimi-code 用 `@moonshot-ai/minidb`（embedded DB）做会话持久化，见 packages/minidb；Desktop 已有 Rust 侧 SQLite 基建（`src/state.rs`），优先复用 |
| `httpx` | 账号限额 / credits / codex reset | Rust `reqwest` via Tauri IPC（浏览器 CORS 不可靠 + 密钥不放前端） | kimi-code 的 managed usage 走 `harness.auth.getManagedUsage(providerKey)`（`tui/commands/info.ts` L236-250），HTTP 全在服务端层 |
| `datetime` / `time` | 时间窗口、duration 格式化 | JS `Date` + `Intl`；`format_duration_compact` 移植为 `formatDuration` | kimi-code 复用 `@moonshot-ai/kimi-code-oauth` 的 `formatDuration`（`usage-panel.ts` L9） |
| `collections.Counter/defaultdict` | tool/skill 计数聚合 | `Map`/普通对象 reduce | `UsageRecorder` 用 `Record<string, TokenUsage>` + `addUsage`（`packages/agent-core/src/agent/usage/index.ts` L13-41） |
| `agent.usage_pricing`（成本估算表） | `/usage`、`/insights` 的 cost | **实现 TS 模块** `usage-pricing.ts`（模型→价格表 + cache 折扣），**无 kimi-code 等价**：kimi-code 只展示服务端给的金额（booster wallet / managed usage），不做本地计价 | `usage-panel.ts` buildExtraUsageSection 只渲染 `cents` 字段（L207-261） |
| `xxhash` | gateway Matrix key 脱敏（次要） | Rust IPC 或 JS `crypto` 摘要；桌面可省略（非核心） | — |
| `prompt_size` 工具→toolset 映射 | `/context all` toolset 归组 | **部分等价**：Desktop 本地工具注册表已有 tool→toolset 归属（`model-usage-log`/工具列表）；schema 字节解析参考 `estimateTokensForTools` | `tokens.ts` L48-53 |
| CLI 富文本（rich/rich-markup） | 终端颜色/网格 | React + CSS（现成 `analytics.module.css` 主题变量） | kimi-code 用 pi-tui theme `fg/boldFg` + `ratioSeverity`（`usage-format.ts` L62-65、`usage-panel.ts`） |
| 图表 | insights 可视化 | **recharts（Desktop 已用）** | kimi-code 无（纯 TUI）；Desktop `routes/analytics.tsx` 已有 PieChart/ComposedChart |
| 网格 glyph 渲染 | 5×20 grid | CSS grid 100 格或 flexbox（glyph 字符可保留做无障碍文本） | kimi-code 用 `renderProgressBar('█'/'░')`（`usage-format.ts` L48-52）——可作面板内单行 bar 的等价物 |

**最核心的等价物**：kimi-code 的 `estimateTokens/estimateTokensForMessages/estimateTokensForTools`
（`packages/agent-core/src/utils/tokens.ts`）与 Python 的 chars/4 启发式语义相同——这是
`context-usage.ts` 已采用 `ESTIMATE_CHARS_PER_TOKEN=4` 的原因，TS 侧估算口径可 1:1 对齐。

## 6. Integration with existing Hermes-CN-Desktop frontend

复用/扩展：

- `web/src/lib/context-usage.ts`：`buildComposerContextUsage` 继续作为小环/Composer 数据源；
  新增 `computeSessionContextBreakdown` 返回 8 类别时复用其 `ContextEstimateTool/Message` 类型与
  `estimateRenderedContextTokens`（但按 Python 语义改为：conversation 用
  `estimate_messages_tokens_rough` 等价函数，而不是逐条 +8 overhead —— 两者都要，分 API 暴露）。
- `web/src/components/chat/goose-composer-context.tsx`：`ContextIndicator` 点击 popover 升级为
  完整 `ContextBreakdownPanel`（保留 ring/risk 视觉，新增类别色块表）。
- `web/src/hooks/use-session-usage-polling.ts`：继续 5s busy 轮询 + `message.complete` 事件；
  `/usage` 面板直接消费其 `SessionUsageResult`，本地估算作 fallback（现有 `estimated` 语义）。
- `web/src/hooks/use-session-turn-stats.ts` + `web/src/lib/ui-store.ts`：`/status` 的 tokens、
  `/insights` 的 performance 指标（TTFT/duration/tokens）来源。
- `web/src/hooks/use-analytics.ts` + `web/src/routes/analytics.tsx`：`/insights` 的 React 落地
  页。新增 `InsightsPanel` 复用其 view-model 构建函数（`buildAnalyticsViewModel` 等）与 recharts
  组件；把 `/insights [days] [--source]` 参数映射到现有 `analyticsPath(days, profileOverride)`。
- `web/src/routes/detail.tsx`：会话页头部加 `/status` 入口（session info + recap 摘要行），
  `/context` 面板可从 Composer 指示器打开，形成闭环。
- `web/src/lib/transport.ts` / `gateway-client.ts` / `tauri-bridge.ts`：终态时
  `getSessionUsage`、`dispatchCommand`、`analytics` REST 调用替换为 Tauri IPC，接口签名不变
  （见 §7 冻结面）。
- Rust `src/commands/*`：新增 `context_breakdown`、`session_status`、`usage_account`、
  `analytics_usage`、`session_recap` 命令（读 `src/state.rs` 的 SQLite + 内存运行时快照）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API 契约（migration 期间不能变，变则先升级协议层）：

1. `ContextBreakdownPayload`（`session.context_breakdown` RPC 返回体，methods_session.py L1381）。
2. `SessionUsageResult`（`session.usage`，hermes-api.ts L1336）。
3. `AnalyticsResponse`（`/api/analytics/usage`，hermes-api.ts L909）——`/insights` 与
   `/usage` 的账号块共用。
4. `/status` 需要新增一个结构化 `SessionStatusResult`（现 gateway 只输出文本）——先在 Python
   侧加 RPC/JSON 返回，再移植，避免先有 TS 后补 Python 契约。

阶段：

- **P0（现状）**：Desktop 全部走 WS/REST：`session.context_breakdown`、
  `session.usage`、`/api/analytics/usage`、`dispatchCommand("/status")` 文本。
- **P1（同接口本地化）**：`context-breakdown.ts` 等纯函数模块落地；REST/RPC 返回的 JSON 先经
  Zod 校验进模块再渲染（同一接口、新实现），Python 与 TS 双实现可 A/B 对照。
- **P2（IPC 替换 WS）**：WS JSON-RPC 调用改为 Tauri command：Rust 读 SQLite + 内存快照，返回
  冻结契约；`gateway-client.ts` 的四个调用点换到 `tauri-bridge.ts`。
- **P3（删 Python 路径）**：删除 `session.context_breakdown`、`session.usage`、`/api/analytics/
  usage` 的 WS/REST 转发代码；`dispatchCommand("/status")` 文本路径删除，改纯本地渲染；
  账号类 HTTP（provider quota / credits / codex reset）保留在 Rust（不属于 WS 依赖）。

## 8. Migration phases & task breakdown

1. **Phase 1 — 纯函数移植（无 UI）**
   - `context-breakdown.ts` + `context-breakdown.test.ts`（对照 `tests/agent/test_context_breakdown.py`）。
   - `session-recap.ts` + 测试（对照 `tests/hermes_cli/test_session_recap.py`）。
   - `usage-pricing.ts`（模型价格表，从 `agent/usage_pricing.py` 导出）。
   - `insights.ts`（TS SQL 查询层，输出与 `AnalyticsResponse` 对齐）。
2. **Phase 2 — 面板组件**
   - `ContextBreakdownPanel`（grid + 类别表 + all 明细），接入 `ContextIndicator` popover。
   - `StatusPanel`（session info + recap），挂 detail 页。
   - `UsagePanel`（本地 token + account limits + credits），挂 detail 页/命令面板。
   - `InsightsPanel` 复用 analytics 路由的 view-model + recharts。
3. **Phase 3 — 数据管道替换**
   - Rust 新增 4 个 Tauri command；协议层新增 `SessionStatusResult`（Python 先实现）。
   - `useSessionUsagePolling` / `useAnalytics` / `dispatchCommand` 切到 IPC。
4. **Phase 4 — 清理**
   - 删 WS 转发、Python 端 RPC（若无需跨版本兼容则保留一个版本窗口）。
   - Playwright E2E：四命令路径回归。

## 9. Risks & open questions

- **无 TS 等价物（最高风险）**：`usage-pricing.py` 的本地成本估算在 kimi-code 中无等价物
  （kimi-code 只渲染服务端金额）。需自建价格表，模型/价格更新需要发布机制；若接受不显示
  金额，可降级为只显示 token 与 provider 返回的 cost（`costUsd`），见 §9.1。
- **tool→toolset 映射不一致**：`compute_context_details` 依赖 Python 工具注册表的 canonical
  映射（PR #66656 机制）。Desktop 本地工具列表来自运行时 RPC，可能与 Python registry 不完全
  一致 → `/context all` 的 toolset 归组存在偏差；需定义本地映射源并写 parity 测试。
- **token 估算口径分裂**：Desktop `estimateRenderedContextTokens` 是逐条 chars/4 + 8 overhead，
  Python `estimate_messages_tokens_rough` 是整体 chars/4；`/context` conversation 类别必须用
  Python 语义（整体估算），否则百分比与 `/compress` 阈值不一致。
- **`/status` 目前只有文本**：gateway 输出是 i18n 文本，桌面复用需先冻结 `SessionStatusResult`
  结构化契约，Python 侧要先加 RPC（P1 前置依赖）。
- **account usage 的 provider 差异**：codex/anthropic/openrouter/nous 四套 fetch 逻辑 + 密钥
  管理；Rust 侧要复刻 `_resolve_codex_usage_credentials`、`_read_codex_tokens` 等（token 文件
  读取在 Tauri 环境路径不同）。
- **`/usage reset` 保持外部 HTTP**：不属 WS 依赖，但需要 Rust reqwest + Codex backend URL
  解析移植（`_codex_backend_urls`）。
- **性能**：`/insights` 的 SQL 扫描大 `tool_calls` JSON，TS 侧要复用 Python 的
  `INDEXED BY` 等价物（partial index），否则旧库全表扫描变慢。
- **open question**：`/context` 面板是否保留 100 格 glyph 网格，还是用单行 CSS bar +
  分类表格（kimi-code 是 bar）；建议桌面用 CSS grid 100 格保持视觉等价，同时提供可读表格。

对 `usage-pricing`：Phase 1 内置 `ModelPriceTable`（从 Python 数据导出 JSON 常量 + provider 覆盖），
并在 `UsagePanel` 上标注「估算」；价格表可做成 Rust config 文件，UI 只读 `costStatus`/`costUsd`
（Python 已在 SessionDB 持久化 `estimated_cost_usd`，迁移时可先经 IPC 读取，不重算）。

## 10. Test strategy

- **Vitest 单元（parity 对照 Python）**：
  - `context-breakdown.test.ts`：给定构造的 `AgentContextSnapshot`，断言 8 类别 tokens 与
    `tests/agent/test_context_breakdown.py` 的固定样例一致；`context_percent` 裁剪 [0,100]；
    grid 100 格、非零类别 ≥1 格。
  - `session-recap.test.ts`：对照 `tests/hermes_cli/test_session_recap.py`（turn 计数、top5
    tools、files、截断预览、空会话文案）。
  - `usage-pricing.test.ts`：对照 `tests/test_account_usage.py` 的金额/状态断言。
  - `insights.test.ts`：TS SQLite 内存库造 sessions/messages，对照
    `tests/cli/test_cli_insights_command.py` 的参数解析 + overview/tools 聚合。
- **Vitest 集成**：Zod 校验 `SessionUsageResult` / `AnalyticsResponse` / 新
  `ContextBreakdownPayload`；IPC 返回 fixture 的渲染测试。
- **Playwright E2E**：detail 页打开 `/context` 面板（网格 + all 明细）、`/status` 面板
  （info + recap）、`/usage` 面板（token + 估算成本）、Analytics 路由 `/insights` 参数切换
  （7/30/90 天）。
- **Parity 金丝雀**：CI 里同时跑 Python `test_context_breakdown.py` 与
  `context-breakdown.test.ts`，同一输入 fixture 断言输出一致，防止两套实现漂移。

## 11. Reference links

- Python：`D:/hermes-agent-cn/agent/context_breakdown.py`、`agent/insights.py`、
  `agent/account_usage.py`、`agent/usage_pricing.py`、`hermes_cli/session_recap.py`、
  `cli.py`（L7457/7919/10477/11712/11761/11870）、`gateway/slash_commands.py`（L540/722/4925/5003/5177）、
  `tui_gateway/methods_session.py`（L1370-1408）、`hermes_cli/commands.py`（L332、L1273-1285）。
- Docs：`D:/hermes-agent-cn/website/docs/reference/slash-commands.md`（L64-65、L130-133、
  L230、L244、L247、L264）。
- Tests：`D:/hermes-agent-cn/tests/agent/test_context_breakdown.py`、`tests/cli/test_cli_insights_command.py`、
  `tests/test_account_usage.py`、`tests/gateway/test_status_command.py`、`tests/gateway/test_usage_command.py`、
  `tests/hermes_cli/test_session_recap.py`、`tests/hermes_cli/test_active_sessions.py`。
- kimi-code TS 参考：`packages/agent-core/src/agent/usage/index.ts`（UsageRecorder）、
  `packages/agent-core/src/agent/context/index.ts`（ContextMemory）、
  `packages/agent-core/src/agent/context/types.ts`（PromptOrigin）、
  `packages/agent-core/src/utils/tokens.ts`（estimateTokens*）、
  `apps/kimi-code/src/utils/usage/usage-format.ts`（formatTokenCount/usagePercent/
  renderProgressBar/ratioSeverity）、
  `apps/kimi-code/src/tui/components/messages/usage-panel.ts`（UsagePanelComponent）、
  `apps/kimi-code/src/tui/commands/info.ts`（showUsage/showStatusReport）、
  `apps/kimi-code/src/tui/kimi-tui.ts` + `tui/controllers/session-event-handler.ts`
  （contextUsage/contextTokens/maxContextTokens appState 更新）、
  `apps/kimi-code/src/tui/utils/message-replay.ts`。
- Desktop 现有：`web/src/lib/context-usage.ts`、`web/src/lib/message-stats-cache.ts`、
  `web/src/hooks/use-session-usage-polling.ts`、`web/src/hooks/use-session-turn-stats.ts`、
  `web/src/hooks/use-analytics.ts`、`web/src/routes/analytics.tsx`、`web/src/routes/detail.tsx`、
  `web/src/components/chat/goose-composer-context.tsx`、`packages/protocol/src/hermes-api.ts`（L909、L1336）。
