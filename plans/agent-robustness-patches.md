# Agent Robustness Patches — Python → TypeScript Rewrite Plan

## 1. Summary

本计划覆盖 7 个"agent 运行时健壮性补丁"，它们都位于 Python 后端的 agent 回合执行核心
（`run_agent.py` / `agent/*.py` / `tui_gateway/server.py`），目标是迁入 Desktop 未来的
**进程内 TypeScript agent loop**，并保持桌面端现有 WS 事件/流协议（`packages/protocol` +
`gateway-delta-coalescer.ts`）不变作为冻结契约：

| 补丁 | Fork Notes | Python 现象 | TS 设计要点 |
|---|---|---|---|
| 重复工具调用循环断路器 | P-017 | 跨 API 迭代反复调用相同工具+参数 → 无限循环 | 端口 kimi-code `ToolCallDeduplicator`（同步去重 + 跨步 streak 提示，3/5/8 提示、12 强制停） |
| 空 API key 保护 | P-018 | 空 key 触发底层 SDK 认证 panic、无堆栈 | 构造客户端前统一 `apiKeyRequired()` 校验，抛可操作错误；无 key 豁免 provider 白名单 |
| 空消息过滤 | P-024 | 压缩/截断留下 `content=""` 消息 → 严格网关 400 | 端口 `sanitize_api_messages` 的空内容丢弃规则（保留 tool_calls/reasoning 载荷） |
| 流式 stale-stream kill | P-022 | 静默断连 provider 永久卡死回合 | `AbortController` + 分块 watchdog + 有界 kill（grace/max-kills）+ 跨回合熔断 |
| 迟到 /steer 重投递 | P-023 | 晚到 steer 被网关丢弃（桌面 #193） | 采纳 kimi-code `turn.steer()` 缓冲语义；WS 期保留 `pending_steer` 契约 |
| 工具参数键自动修复 | P-013 | LLM 参数名漂移 → "unknown parameter" | **无 TS 等价物**，从零实现 schema 驱动的别名表 + 模糊匹配（见 §5/§9） |
| `model.extra_body` 合并 | P-031 | 内建 provider 忽略用户 `model.extra_body`（GitHub #336） | `requestOverrides.extraBody` 深合并，优先级 caller > custom > model.extra_body |

**关键决策**：7 个补丁拆成"纯函数层"（sanitize/repair/merge/guard，可直接 vitest parity 对拍
Python 测试）与"loop 集成层"（dedup tracker、steer buffer、stream watchdog）。kimi-code 已为
**循环断路器**和 **steer 缓冲**提供了可直接采用的 TS 实现；其余 5 个补丁在 kimi-code 中只有
部分/零等价物，需要从零实现薄层。

## 2. Current Python implementation

源文件与数据流（均在 `D:/hermes-agent-cn`）：

- **P-017 循环断路器** — `agent/tool_dedup.py`（`ToolDedupTracker`）：
  `_canonical_tool_arguments()`（orjson 递归排序）→ `_normalize_call_key(tool_name, args)`；
  生命周期 `begin_step(previous_calls, step_no, turn_id)`（每次 API 调用前）→
  `check_and_register(tool_name, arguments)`（每次工具执行时，`threading.Lock()` 保护）→
  `end_step()`（返回本步调用列表）。重复计数达到 3/5/8 时向工具结果追加逐级升级的
  `<system-reminder>`（5/8 级明确给出工具名、次数、参数）。接入点：
  `agent/agent_init.py`（`agent._tool_dedup_tracker = ToolDedupTracker()`）、
  `agent/conversation_loop.py`（begin/end 生命周期）、`agent/tool_executor.py`
  （`execute_tool_calls_concurrent/sequential` 注入）。同轮精确去重由既有
  `_deduplicate_tool_calls` 处理，本补丁只补跨迭代。

- **P-018 空 API key 保护** — `agent/agent_init.py::_api_key_required(provider, api_key, base_url)`：
  key 非空 → False；callable token（Azure Entra ID）、`"aws-sdk"`/`"no-key-required"`、
  `provider == "bedrock"` → False（豁免）；OAuth provider 由 `resolve_provider_client` 解析，
  返回 None 时保护触发。在 `anthropic_messages` 分支 `build_anthropic_client()` 前、
  `chat_completions` 分支 `_create_openai_client()` 前调用，空 key 抛
  `RuntimeError("no API key (param empty, env vars unset)")`。测试：
  `tests/run_agent/test_init_fallback_on_exhausted_pool.py`。

- **P-024 空消息过滤** — `agent/agent_runtime_helpers.py::sanitize_api_messages` 融合单遍扫描，
  步骤 (b) 调 `agent/message_utils.py::is_empty_content_droppable(msg, role)`：角色 ∈
  `EMPTY_CONTENT_ROLES = {assistant, user, function}`、`content == ""`（**严格等于 `""`，不是
  `None`**）、assistant 无 `_ASSISTANT_PAYLOAD_FIELDS = (tool_calls, codex_reasoning_items,
  codex_message_items, reasoning_content)` 载荷才丢弃；`system` 与无 `content` 键的消息保留。
  同一融合遍还处理 `tool_calls: []` 归一化、空 name → `invalid_tool_call` sentinel、孤儿
  tool result 删除、缺失 result 注入 stub、tool_call_id 去重。测试：
  `tests/run_agent/test_agent_guardrails.py`、`test_session_meta_filtering.py`、
  `test_sanitize_single_pass.py`（与参考多遍实现差分 fuzz）。

- **P-022 stale-stream kill** — `agent/chat_completion_helpers.py` 流式调用 watchdog：
  阈值 `HERMES_STREAM_STALE_TIMEOUT`（默认 180s，provider 配置优先）；本地端点上限
  `HERMES_LOCAL_STREAM_STALE_TIMEOUT`/`agent.local_stream_stale_timeout`（默认 900s）；
  大上下文 scaling（>100k tokens → 300s，>50k → 240s）；reasoning 下限
  `agent/reasoning_timeouts.get_reasoning_stale_timeout_floor`。P-022 新增：
  `HERMES_STREAM_STALE_KILL_GRACE`（默认 10s）、`HERMES_STREAM_STALE_MAX_KILLS`（默认 3）——
  (1) 超时后中止**活的** transport：`anthropic_messages` 跨线程
  `shutdown(SHUT_RDWR)` Anthropic 客户端 socket（#29507 安全）并重建；(2) 有界升级：grace 间隔
  max-kills 次中止后仍存活 → 合成 `TimeoutError` 写入 `result["error"]` 放弃 daemon worker。
  跨回合熔断 `_consecutive_stale_streams`（`HERMES_STREAM_STALE_GIVEUP` 默认 5），命中后直接
  快速失败。涉及 `agent/anthropic_adapter.py`、`agent/httpx_clients.py`、`run_agent.py`。
  测试：`tests/run_agent/test_streaming_stale_timeout.py`、`test_stream_stale_circuit_breaker.py`、
  `test_stream_stale_breaker_reset.py`、`test_stream_interrupt_retry.py`、`test_streaming.py`。

- **P-023 迟到 /steer 重投递** — `tui_gateway/server.py`：`run_conversation()` 只能把 steer 注入
  后续工具结果；落在最后一个工具批次后或纯文本回合的 steer 以 `result["pending_steer"]` 返回
  （`cli.py` 已重投，网关此前丢弃）。修复：turn finalizer 的 `finally` 释放
  `session["running"]` 后，若 `steer_followup` → 嵌套 `_run_prompt_submit(rid, sid, session,
  steer_followup)`（`running` 保护，真实用户输入优先，优先级高于 goal 续跑）；另有
  `_leftover_steer = result.get("pending_steer")` → `_enqueue_prompt` 重排队（排在既有 queued
  prompt 之前，因 queued prompt 持久、steer 一次性）。测试：
  `tests/cli/test_cli_steer_busy_path.py`（inline 检测 + busy 路径分发）。

- **P-013 工具参数键自动修复** — `model_tools.py`：`repair_tool_arg_keys()` +
  `_repair_nested_args()`；`TOOL_FIELD_ALIASES`（全局分组：general/file/shell/web/task/todo/
  input/search/memory/cron/skill…，如 `file→path`、`cmd→command`、`instruction→prompt`）；
  `TOOL_SPECIFIC_ALIASES` 工具级覆盖（如 `delegate_task: task→goal`、`cronjob: command→action`）；
  未命中时 `difflib.get_close_matches` 模糊匹配（长度 ≥4、相似度 0.75–0.80）；按 schema
  `properties`/`items` 递归修复嵌套对象/对象数组；`set_arg_repair_callback` 通知 TUI/ACP。
  在 `handle_function_call()` 中 `coerce_tool_args()` **之前**调用，修复后仍走类型强转。
  测试：`tests/run_agent/test_repair_tool_arg_keys.py`、`test_repair_tool_call_name.py`、
  `test_repair_tool_call_arguments.py`、`test_streaming_tool_call_repair.py`、
  `test_canon_args_memo_parity.py`、`performance/test_tool_dispatch.py`。

- **P-031 model.extra_body 合并** — `agent/agent_init.py::_merge_model_extra_body(agent,
  model_cfg)`：读取 `model_cfg["extra_body"]`（dict），与 `agent.request_overrides["extra_body"]`
  合并（已存在值在键冲突时获胜，即 caller > custom_providers > model.extra_body）；走
  chat-completions transport 既有的 `request_overrides` 最后合并通道，因此还能盖过 provider
  profile 自身键（如 DeepSeek `thinking`）。测试：`tests/agent/test_model_extra_body.py`、
  `test_custom_provider_extra_body.py`、`test_custom_provider_extra_body_matching.py`、
  `test_model_extra_type_guard.py`。

## 3. Target TypeScript design

进程内模块布局（未来 `web/src/agent/`，迁移期可先放 `web/src/lib/agent-patches/`）：

```
web/src/agent/
  loop/
    run-turn.ts            # 回合循环（端口 kimi-code run-turn.ts 思路）
    turn-step.ts           # 单步执行：buildMessages → LLM.chat → tool 分发
    tool-dedup.ts          # 端口 kimi-code ToolCallDeduplicator（§5）
    stream-watchdog.ts     # 新增：stale-stream kill watchdog（fetch/SSE）
    steer-buffer.ts        # 端口 kimi-code turn.steer 缓冲 + P-023 pending_steer 兼容
  messages/
    sanitize-messages.ts   # 端口 sanitize_api_messages（空消息过滤等）
    repair-tool-arg-keys.ts# 新增：schema 驱动别名修复
  providers/
    api-key-guard.ts       # 新增：apiKeyRequired()
    merge-extra-body.ts    # 新增：requestOverrides.extraBody 合并
  types.ts                 # 冻结事件/流契约（见 §7）
```

核心接口（伪签名）：

```ts
// loop 集成层
interface AgentLoop {
  beginStep(): void;                          // 每步 API 调用前
  endStep(): Promise<void>;                   // 工具结果收齐后
  runStep(input: StepInput): Promise<StepResult>; // 含 pendingSteer 输出
}
interface StreamWatchdogOptions {
  staleTimeoutMs: number;            // 180s 默认；local/provider 配置覆盖
  killGraceMs: number;               // 10s
  maxKills: number;                  // 3
  giveUpStreak: number;              // 5（跨回合熔断）
  signal: AbortSignal;               // 宿主取消（真实用户中断）优先于 stale kill
}
interface SteerInput { input: ContentPart[]; origin: PromptOrigin; }

// 纯函数层（无副作用，可单测）
function sanitizeApiMessages(messages: UiMessage[]): { messages: UiMessage[]; dropped: number };
function repairToolArgKeys(toolName: string, args: unknown, schema: JSONSchema): { args: unknown; repaired: RepairRecord[] };
function apiKeyRequired(provider: string, apiKey: unknown, baseUrl: string): boolean;
function mergeModelExtraBody(requestOverrides: RequestOverrides, modelCfg: ModelConfig): RequestOverrides;
```

数据流（进程内，无 Python）：`use-gateway` 的 `prompt.submit` → in-process `runTurn` →
`turn-step` 用 `buildMessages`（内部先 `sanitizeApiMessages`）→ `LLM.chat({signal, onTextDelta,
onToolCallDelta})`（`stream-watchdog` 包装 signal）→ 工具分发（`tool-dedup.checkSameStep` →
`repairToolArgKeys` → execute）→ `endStep` → 循环或终态。`steer` 输入在 `activeTurn` 时进
`steerBuffer`（kimi-code 语义），回合结束后作为下一轮用户输入启动，替代 P-023 的网关级
`pending_steer` 重投递。

## 4. Data models & persistence

- **消息模型**：沿用 `packages/protocol` 的 `HermesUIMessage`/`HermesMessagePart` 形状；进程内
  使用 kimi-code `@moonshot-ai/kosong` 的 `Message`/`ContentPart`（`TextPart`/`ThinkPart`/工具块）。
  `sanitizeApiMessages` 是**请求前内存变换**，不改持久化会话（与 Python 一致：只修请求投影像）。
- **dedup 状态**：`ToolCallDeduplicator` 实例状态（stepDeferreds/stepCalls/consecutiveKey/
  consecutiveCount）全部**进程内、每回合生命周期**，不持久化；telemetry 事件 `tool_call_repeat`
  可上报（对齐 kimi-code）。
- **stale 熔断状态**：`_consecutiveStaleStreams` 进程内计数器；若需跨重启保持（Python 不持久化，
  建议同样不持久化，重启即重置），可选 IndexedDB 键 `agent.robustness.staleStreak`，迁移期默认关闭。
- **pending_steer**：WS 迁移期是 `TurnResult.pendingSteer?: string` 瞬态字段（不落库）；进程内
  版本改为 `steerBuffer: SteerInput[]` 内存队列，回合结束清空。
- **model.extra_body**：属配置层，`packages/protocol` 的模型配置 Zod schema 增加
  `extra_body: Record<string, unknown>`（沿用后端 `model.extra_body` 键名），Rust `src/state.rs`
  存储原样透传；合并结果只进请求，不写库。

## 5. Third-party library strategy

| Python 依赖/机制 | TS 等价物 | kimi-code 证据 | 决策 |
|---|---|---|---|
| `threading.Lock` + 跨线程 tracker | 单线程 JS 事件循环，类实例状态即天然互斥 | `agent/turn/tool-dedup.ts` `ToolCallDeduplicator`（deferred Map + streak 状态） | **直接采用** kimi-code 实现；注意它比 P-017 多出同步去重、12 次强制停（§9 决策点） |
| orjson 递归排序 canonical args | 端口 `canonical-args.ts` 的 `canonicalTelemetryArgs` | `agent/turn/canonical-args.ts` + `tool-dedup.ts makeKey()` | 采用（已存在） |
| `difflib.get_close_matches` 模糊匹配 | **无**；用 Levenshtein（`fast-levenshtein` 或 30 行自实现），阈值对齐 0.75–0.80、长度 ≥4 | 无（kimi-code 只做 `JSON.parse`，`loop/tool-args-parse.ts`） | 从零实现 `repair-tool-arg-keys.ts`；别名表按 schema 驱动 |
| asyncio daemon worker + `shutdown(SHUT_RDWR)` | `AbortController` + fetch/SSE `reader.cancel()`；浏览器/Node fetch 无法关底层 socket | `loop/llm.ts` `LLMChatParams.signal: AbortSignal`；`agent/turn/kosong-llm.ts:121` 把 signal 传 provider | **部分等价**：abort 通道现成，watchdog 从零实现；Anthropic socket 级 shutdown 无直接等价（§9 风险） |
| anthropic SDK / httpx clients | OpenAI/Anthropic TS SDK 或 fetch 直连（依赖未来 in-process adapter 选型） | `kosong-llm.ts` 适配层 | 设计抽象 `LLM.chat`（§3），SDK 细节后续 plan |
| 空 key 运行时保护 | `nonEmptyString(provider.apiKey)` 散点校验 | `session/provider-manager.ts:452`、`services/config/configService.ts:76`、`modelCatalogService.ts:228` | 无统一守卫；从零实现 `api-key-guard.ts`（集中式，对齐 P-018 错误消息） |
| 空消息过滤 | **无** | 无（`loop/llm.ts:41` 的 `droppedCount` 仅 compaction 场景） | 从零实现，按 P-024 规则逐条对拍 |
| `model.extra_body` 合并 | provider 配置 `withExtraBody()` | `config/kimi-env-params.ts:118` `provider.withExtraBody({ thinking: { keep } })` | 从零实现 `merge-extra-body.ts`（普通深合并 + 优先级），可复用 withExtraBody 形态 |
| /steer 重投递 | `turn.steer()` 缓冲 + compaction 结束回放 | `agent/turn/index.ts:182-199`（`activeTurn || isCompacting` → `steerBuffer`，否则 `launch`） | **采用 kimi-code 缓冲语义**，WS 期保留 `pending_steer` 兼容层 |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **冻结的事件/流契约**：`packages/protocol/src/hermes-api.ts`（`message.delta` L1570、
  `message.complete` L1575、`status: streaming|complete|error` L401）与
  `web/src/lib/gateway-delta-coalescer.ts`（纯文本 delta 合帧）是 UI 与 runtime 的唯一接口。
  进程内 loop 必须**逐字节兼容**这套 `GatewayEvent` 流，UI 层（`stores/chat.ts`、
  `hooks/use-gateway.ts`）零改动。
- **复用**：`web/src/lib/gateway-client.ts` 的 WS 客户端在迁移期继续驱动；`use-gateway.ts`
  的 `prompt.submit`/`session.create` 调用点成为 in-process runtime 的入口 facade；
  `stores/chat.ts` 的 `applyGatewayEventAtom` 保持消费方。
- **/steer**：协议里没有独立 steer RPC（`hermes-api.ts` 只有 `focus_topic` 注释）；桌面通过
  `prompt.submit` 发 `/steer` 文本，后端 `tui_gateway/server.py` 按 `_current_session_steer_authority`
  + `steer` 模式路由到 `agent.steer()`。进程内版本把这条 slash 解析移到 loop facade
  （`parseSlashInput`），`steer-buffer.ts` 承接，UI 输入框/快捷键行为不变。
- **Rust 侧**：无新 Tauri 命令；`src/state.rs` 仅需透传 `model.extra_body` 配置项（§4）。

## 7. Removing the WebSocket dependency (migration path)

1. **冻结 API 面**：`packages/protocol` 的 `GatewayEvent` 判别联合、`prompt.submit` 参数、
   `TurnResult` 形状（含 `pending_steer`）作为迁移期间**不可变契约**（现有 E2E 全绿后打 tag）。
2. **阶段 A（纯函数层，仍在 WS 后）**：`sanitize-messages.ts`、`repair-tool-arg-keys.ts`、
   `api-key-guard.ts`、`merge-extra-body.ts` 落地为 `web/src/lib/agent-patches/`，vitest 与 Python
   测试对拍；后端行为不变。
3. **阶段 B（进程内 loop 雏形）**：`run-turn.ts` + `tool-dedup.ts` + `steer-buffer.ts` 在
   `web/src/agent/` 运行，通过同一个 `GatewayEvent` 流接入 `stores/chat.ts`；保留 WS 路径做
   A/B 对照（桌面 skill `desktop-dual-repo-test` 已有路线 A/B 验证框架）。
4. **阶段 C（流式直连）**：`LLM.chat` 走 fetch/SSE，`stream-watchdog.ts` 生效；WS 事件由
   in-process 模块本地生成，`gateway-client.ts` 的 `message.delta` 路径与之一致。
5. **删除 WS/REST**：`packages/protocol` 移除 `gateway-client.ts` 依赖面后，删除
   Dashboard `/api/ws` + REST 调用路径；`pending_steer` 兼容层删除，`steerBuffer` 成为唯一路径。

## 8. Migration phases & task breakdown

- **Phase 0 — 契约冻结**（0.5 周）：`packages/protocol` 快照；补 `model.extra_body` Zod 字段；
  `GatewayEvent` 加 `tool_call_repeat` telemetry 事件类型（可选）。
- **Phase 1 — 纯函数层 + parity 测试**（1.5 周）：sanitize / repair / guard / merge 四个模块；
  vitest 用例逐一映射 §2 列出的 Python 测试（`test_agent_guardrails.py` 11 例、
  `test_repair_tool_arg_keys.py` 全类、`test_model_extra_body.py`、`test_init_fallback_on_exhausted_pool.py`）。
- **Phase 2 — loop 集成（无流式）**（1 周）：端口 kimi-code `ToolCallDeduplicator`；
  `steer-buffer.ts`；`run-turn.ts`/`turn-step.ts` 骨架；WS 后端仍为真源，进程内 loop 跑 parity 夹具。
- **Phase 3 — 流式 adapter + watchdog**（1.5 周）：`LLM.chat` fetch/SSE 实现；`stream-watchdog.ts`
  实现 stale timeout / kill grace / max kills / give-up；`kosong-llm.ts` 对照单测。
- **Phase 4 — 切换**（1 周）：in-process loop 作为默认运行时，`gateway-client.ts` 退居测试夹具；
  桌面 E2E（Playwright）全绿。
- **Phase 5 — 拆除**（0.5 周）：删除 WS/REST 路径、`pending_steer` 兼容层、`gateway-delta-coalescer.ts`
  的 WS 分支（保留合帧逻辑供本地流使用）。

## 9. Risks & open questions

1. **dedup 行为差异（最高优先决策）**：kimi-code `ToolCallDeduplicator` 在 streak 12 时
   `{stopTurn: true}` 强制停轮，P-017 只到 8 级提示（无强制停）；且 kimi-code 有同 step 去重
   （重复调用复用首个结果）。建议**直接采用 kimi-code 语义**（更强健壮性）并写 parity 测试钉住，
   但需产品确认 12 次强制停是否符合预期。
2. **arg-key 修复无 TS 等价物**：kimi-code `loop/tool-args-parse.ts` 只做 JSON 解析（parseFailed →
   `{}`），`tool-call.ts:453` 有 `updatedArgs` hook 可改参数但无别名表。风险：别名表 + 模糊匹配
   是**产品级启发式**，TS 侧需维护与 Python 等价的 `TOOL_FIELD_ALIASES`/`TOOL_SPECIFIC_ALIASES`；
   建议 schema 驱动生成，避免双份手写漂移。
3. **stale-stream 无 socket 级 kill**：Python 靠 `shutdown(SHUT_RDWR)` 强制打断 recv；浏览器
   fetch 只能 `AbortController.abort()`（Node 下可 `undici`/`http` 层关闭 socket，但 webview 内
   不可用）。风险：个别 provider 忽略 abort 会导致 watchdog 需在 `maxKills` 后强制放弃并合成
   超时（Python 已如此设计，TS 语义可对拍）。
4. **空消息过滤边界**：`content == ""` vs `None` 区分、`system` 保留、无 `content` 键保留——
   TS 端对 `undefined`/`null`/`""` 的判别必须逐条与 `message_utils.py` 对拍，防止类型宽松把
   `null` 误删（`null` 常携带 tool_calls）。
5. **API-key guard 的 provider 豁免清单**：`bedrock`/`aws-sdk`/`no-key-required`/Azure callable/
   OAuth 列表需从 `agent_init.py` 复制并随 provider 目录更新；kimi-code 的散点 `nonEmpty` 校验
   不能直接复用。
6. **`model.extra_body` 优先级**：`caller > custom_providers > model.extra_body` 是 Python 契约，
   TS 侧必须保持"已存在值在键冲突时获胜"的 update 顺序（而非浅覆盖），否则 DeepSeek `thinking`
   等 profile 键会被用户块意外覆盖。
7. **open question**：进程内 loop 的 LLM adapter 选型（OpenAI TS SDK / Anthropic TS SDK / fetch
   直连）未定，`stream-watchdog` 依赖该抽象，属后续 `agent-loop-llm-adapters.md` plan 的输入。

## 10. Test strategy

- **vitest 单元（parity）**：
  - `sanitize-messages.test.ts` ← `test_agent_guardrails.py`（11 例：assistant/user/function 空
    内容丢弃、tool_calls/reasoning 保留、system 保留、多连续空消息、幂等）、
    `test_session_meta_filtering.py`（MiMo "text is not set" 场景）、`test_sanitize_single_pass.py`
    差分 fuzz 的 TS 侧等价实现（随机消息序列对拍 Python 参考实现输出）。
  - `repair-tool-arg-keys.test.ts` ← `test_repair_tool_arg_keys.py` 全类（passthrough/alias/
    normalization/nested/array/schema-driven/fuzzy threshold/tool-specific override）+
    `test_repair_tool_call_name.py`、`test_repair_tool_call_arguments.py`。
  - `api-key-guard.test.ts` ← `test_init_fallback_on_exhausted_pool.py`（chat_completions +
    anthropic_messages 两条空 key 路径、豁免 provider）。
  - `merge-extra-body.test.ts` ← `test_model_extra_body.py`（优先级、嵌套合并、非 dict 忽略）。
  - `tool-dedup.test.ts` ← `test_streaming_tool_call_repair.py` + kimi-code 自身单测（streak
    3/5/8 提示、12 强制停、同 step 去重、registerSkipped）。
  - `stream-watchdog.test.ts` ← `test_streaming_stale_timeout.py`（fake timers：stale 触发 kill、
    grace 间隔、maxKills 后合成 TimeoutError）、`test_stream_stale_circuit_breaker.py`（give-up
    快速失败）、`test_stream_stale_breaker_reset.py`（完成响应后重置）。
- **集成**：`run-turn.test.ts` 用 WS 夹具模拟 `GatewayEvent` 流，验证 loop 输出与 Python
  `run_conversation()` 事件序列一致。
- **Playwright E2E**：steer 场景——运行中发引导 → 回合结束后新消息追加（对拍 P-023 #193）；
  tool loop 场景——连续相同工具调用后 UI 出现 system-reminder；断流场景——mock provider 静默
  后 UI 收到 `message.complete`/error 而非永久 streaming。

## 11. Reference links

- Python 实现：`D:/hermes-agent-cn/agent/tool_dedup.py`、`agent/agent_init.py`
  （`_api_key_required`、`_merge_model_extra_body`、`_tool_dedup_tracker`）、
  `agent/agent_runtime_helpers.py`（`sanitize_api_messages`）、`agent/message_utils.py`
  （`EMPTY_CONTENT_ROLES`/`is_empty_content_droppable`）、`agent/chat_completion_helpers.py`
  （stale watchdog）、`agent/anthropic_adapter.py`、`agent/httpx_clients.py`、
  `model_tools.py`（`repair_tool_arg_keys`/别名表）、`run_agent.py`、`tui_gateway/server.py`
  （P-023 重投递）、`agent/conversation_loop.py`、`agent/tool_executor.py`。
- Python 文档：`D:/hermes-agent-cn/FORK_NOTES.zh-CN.md`（P-013/P-017/P-018/P-022/P-023/P-024/P-031）。
- Python 测试：`tests/run_agent/test_repair_tool_arg_keys.py`、`test_repair_tool_call_name.py`、
  `test_repair_tool_call_arguments.py`、`test_streaming_tool_call_repair.py`、
  `test_streaming_stale_timeout.py`、`test_stream_stale_circuit_breaker.py`、
  `test_stream_stale_breaker_reset.py`、`test_agent_guardrails.py`、`test_session_meta_filtering.py`、
  `test_sanitize_single_pass.py`、`test_init_fallback_on_exhausted_pool.py`、
  `tests/test_empty_model_fallback.py`、`tests/agent/test_model_extra_body.py`、
  `tests/gateway/test_streaming_tts_consumer.py`、`tests/gateway/test_streaming_tts_gateway_regression.py`、
  `tests/cli/test_cli_steer_busy_path.py`。
- TS 参考：`D:/kimi-code/packages/agent-core/src/agent/turn/tool-dedup.ts`、
  `src/agent/turn/index.ts`（`steer()` 缓冲）、`src/agent/turn/canonical-args.ts`、
  `src/loop/llm.ts`（`AbortSignal` 契约）、`src/loop/tool-args-parse.ts`、
  `src/loop/tool-call.ts`（`updatedArgs`）、`src/loop/run-turn.ts`、`src/loop/turn-step.ts`、
  `src/agent/turn/kosong-llm.ts`、`src/config/kimi-env-params.ts`（`withExtraBody`）、
  `apps/kimi-code/src/tui/controllers/editor-keyboard.ts`、`apps/kimi-code/src/tui/kimi-tui.ts`
  （`session.steer`）。
- Desktop 集成点：`D:/Hermes-CN-Desktop/web/src/lib/gateway-delta-coalescer.ts`、
  `web/src/lib/gateway-client.ts`、`web/src/stores/chat.ts`、`web/src/hooks/use-gateway.ts`、
  `packages/protocol/src/hermes-api.ts`、`src/state.rs`。
