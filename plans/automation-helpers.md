# Automation Helpers — Python → TypeScript Rewrite Plan

> Feature bundle: `/suggestions` (suggested automations), `/blueprint` (automation
> templates), `hermes webhook` (dynamic webhook subscriptions), `hermes send`
> (one-shot message CLI for scripts/CI/cron).
> Slug: `automation-helpers` · Design only — no implementation.

## 1. Summary

- 本计划把 Core 的“自动化助手”四件套从 Python 迁移到 Desktop 的 TS 前端/进程内运行时：
  ① `/suggestions` 建议自动化（cron/suggestions.py + suggestion_catalog.py + suggestions_cmd.py）；
  ② `/blueprint` 自动化模板（cron/blueprint_catalog.py + hermes_cli/blueprint_cmd.py）；
  ③ `hermes webhook` 动态 webhook 订阅（hermes_cli/webhook.py + gateway/platforms/webhook.py + REST 端点）；
  ④ `hermes send` 一次性消息 CLI（hermes_cli/send_cmd.py + tools/send_message_tool.py）。
- 范围切分（诚实标注）：
  - **in-scope（完整移植）**：blueprints 目录数据/槽位填充/匹配/人类化；suggestions 存储/受理/忽略/目录播种；
    webhook 订阅管理面（store + REST + UI）；send 的共享投递抽象（仅 Desktop 实际支持的目标：local/feishu/weixin/email）。
  - **out-of-scope（desktop standalone）**：`hermes send` 的完整 CLI 参数面（stdin/--file/--list/exit-code 语义）、
    Telegram/Discord/Slack/Signal 平台适配器、webhook **入站 HTTP 监听器**（需要公网 URL / 隧道 + gateway 常驻，
    standalone 桌面端无此部署形态）。这些按 plans/README.md 惯例记录决策，仍给方案但标注为不实施或延迟。
- 现状核对（读源码后确认）：Desktop 目前 **没有** blueprint/suggestions/webhook 任何前端；`routes/cron.tsx` 仅管理
  cron job；`lib/builtin-commands.ts` 只有 `/compress`；`packages/protocol` 只有 CronJob/CronRun schema。
  `/suggestions`、`/blueprint` 目前作为聊天文本经 gateway WS 由 Python 端处理；webhook 仅 CLI + Dashboard REST。
- 迁移主线：先接现有 REST（`/api/cron/blueprints`、`/api/webhooks`）+ gateway 文本命令，再在进程内实现同名
  TS 服务（相同接口），最后删除 WS/REST 路径。

## 2. Current Python implementation

| 子特性 | 源码（D:/hermes-agent-cn） | 职责 |
|---|---|---|
| Blueprint 目录 | `cron/blueprint_catalog.py` | `BlueprintSlot`（time/enum/text/weekdays）、`AutomationBlueprint`、`CATALOG`（13 条）、`WEEKDAY_PRESETS`、`blueprint_form_schema` / `blueprint_slash_command` / `blueprint_deeplink` / `blueprint_catalog_entry`、`fill_blueprint`（校验 + `_resolve_schedule` 填 cron + 渲染 prompt）、`_humanize_schedule` |
| /blueprint 命令 | `hermes_cli/blueprint_cmd.py` | `handle_blueprint_command`：bare=列目录；`<name>`=`match_blueprint`（exact→prefix→substring→rapidfuzz 60/40）并返回 `agent_seed`；`<name> slot=val…`=shlex 解析 KV → `fill_blueprint` → `create_job_with_scheduler_registration`。返回 `BlueprintCommandResult{text, agent_seed}` |
| Blueprint REST | `hermes_cli/web_routers/cron.py:199-260` | `GET /api/cron/blueprints`（返回 `{blueprints:[blueprint_catalog_entry…]}`，deliver 选项按已配置平台重写）；`POST /api/cron/blueprints/instantiate`（body: blueprint + values，422 校验错误，424 调度注册错误） |
| Suggestions 存储 | `cron/suggestions.py` | `~/.hermes/cron/suggestions.json`（atomic + 0600 + 线程锁）；`MAX_PENDING=5`；`add_suggestion` 按 `dedup_key` 防重复、dismissed/accepted 永不再提供；`accept_suggestion` 直通 `cron.scheduler.create_job_with_scheduler_registration`；`clear_resolved` 只清 accepted |
| Suggestions 目录 | `cron/suggestion_catalog.py` | 4 条 curated 目录（daily-briefing / important-mail / weekly-review / standup），`seed_catalog_suggestions` 幂等播种 |
| /suggestions 命令 | `hermes_cli/suggestions_cmd.py` | `handle_suggestions_command(args, origin=…)`：list / accept N|id / dismiss N|id / catalog / clear，CLI 与 gateway 共享；`origin` 从 session env 解析 |
| Webhook CLI | `hermes_cli/webhook.py` | `hermes webhook {subscribe|list|remove|test}`；`~/.hermes/webhook_subscriptions.json`（0600、atomic、每路由 HMAC secret）；`_get_webhook_base_url`（默认端口 8644）；未启用时打印 setup 提示 |
| Webhook REST | `hermes_cli/web_server.py:13663-13812` | `GET /api/webhooks`（secret 掩码、`secret_set`）、`POST /api/webhooks`（创建时一次性返回 secret）、`DELETE /api/webhooks/{name}`、`PUT /api/webhooks/{name}/enabled`、`POST /api/webhooks/enable`（启用平台+尽力重启 gateway） |
| Webhook 适配器 | `gateway/platforms/webhook.py` | `WebhookAdapter(BasePlatformAdapter)`：动态路由热加载（文件 mtime）、HMAC 校验（GitHub V1 / generic V1+V2 时间戳 / Svix / GitLab token）、`deliver_only` 直发（零 LLM）、`--script` 过滤/转换、静默响应 `[SILENT]` |
| Send CLI | `hermes_cli/send_cmd.py` | argparse `send` 子命令；消息体解析 positional→`--file`→非 TTY stdin；`MEDIA:<path>` / `[[as_document]]`；`--list` 走 `gateway.channel_directory`；`_load_hermes_env` 桥接 `.env` + `config.yaml` 标量；退出码 0/1/2 |
| Send 底层 | `tools/send_message_tool.py` | bot-token 平台免 gateway 直发（Telegram/Discord/Slack/Signal/SMS/WhatsApp）；plugin 平台需 gateway 常驻 |

**文档**：`website/docs/reference/slash-commands.md` L112-113、L272-273、L297（两个命令 CLI+gateway 双端）；
`website/docs/reference/cli-commands.md` L389-438（`hermes send`）、L738-771（`hermes webhook`）。
**测试**：`tests/cron/test_blueprint_catalog.py`（目录/槽位/时间→cron/day→dow/preset/校验/renderer/命令处理/文档生成器）、
`tests/hermes_cli/test_send_cmd.py`（stdin/file/--list/env 桥接/BOM）、`tests/hermes_cli/test_webhook_cli.py`；
gateway 侧 `tests/gateway/test_webhook_*.py` 共 6 个（adapter / deliver_only / dynamic_routes / integration /
session_close / signature_rate_limit），另有 `test_cron_fire_webhook.py`、`test_msgraph_webhook.py`、
`test_telegram_webhook_secret.py`（任务描述中的“9 个”应含这些）。目前 **无** `/api/cron/suggestions` REST 端点。

## 3. Target TypeScript design

模块布局（`web/src/lib/automations/`，进程内服务，全部无 Python 依赖）：

```text
web/src/lib/automations/
  blueprints.ts        # 目录数据（port CATALOG）+ BlueprintSlot/AutomationBlueprint 类型 + WEEKDAY_PRESETS
  blueprints-form.ts   # blueprint_form_schema 等价物（fields 数组）
  blueprints-fill.ts   # fill_blueprint 等价物：校验 → {prompt,schedule,name,deliver,skills?,origin?}
  blueprints-match.ts  # match_blueprint 等价物：exact→prefix→substring→fuzzy
  blueprints-humanize.ts # _humanize_schedule 等价物（可复用 kimi-code cronToHuman）
  suggestions.ts       # SuggestionsStore：load/list_pending/add/get/accept/dismiss/clear
  suggestions-seed.ts  # catalog 4 条 + seed_catalog_suggestions 等价物
  webhooks.ts          # WebhooksService：list/create/delete/enable/test（secret 一次性返回+掩码）
  send.ts              # SendService 接口 + feishu/weixin/email 适配器 + channel-directory 缓存（仅供 cron deliver 复用）
  commands.ts          # /suggestions、/blueprint 客户端命令处理（parse/execute 返回 text + 可选 agent_seed）
packages/protocol/src/hermes-api.ts   # + Blueprint/BlueprintField/BlueprintsResponse/InstantiateRequest/
                                      #   Suggestion/SuggestionsResponse/WebhookRoute/WebhooksResponse/
                                      #   WebhookCreateRequest/SendTarget/SendResult (zod)
src/commands/automations.rs           # Tauri: suggestions/webhook store 读写（路径+chmod 0600）
src/commands/webhook_server.rs        # (可选/延迟) hyper 入站监听器
```

数据流（进程内，去掉 Python）：composer `/blueprint` → `commands.ts` 列出目录或解析 `name slot=val…` →
`blueprints-fill.ts` 产出 create-job spec → 进程内 cron 模块（kimi-code `CronManager`/`SessionCronStore` 为参照，
Hermes 侧为全局 per-profile 调度）→ UI 刷新。`/suggestions` → `suggestions.ts` 读 `<profileHome>/cron/suggestions.json`
→ accept 时调用同一 cron 模块；catalog 播种走 `suggestions-seed.ts`。webhook 管理 → `webhooks.ts` 读写
`<profileHome>/webhook_subscriptions.json`（迁移期经 REST，之后经 Rust 命令）。

## 4. Data models & persistence

- **suggestions.json**（逐字对齐 Python，`cron/suggestions.py` 现状）：
  `{"suggestions":[{id,title,description,source(catalog|blueprint|usage|integration),job_spec,dedup_key,
  status(pending|accepted|dismissed),created_at,resolved_at?}], updated_at}`；`MAX_PENDING=5`；
  dismissed/accepted 由 `dedup_key` 记忆，永不再提供；`clear` 仅删 accepted。
- **webhook_subscriptions.json**（对齐 `hermes_cli/webhook.py` 现状）：
  `{name:{description,events[],secret,prompt,skills[],deliver,created_at,deliver_only?,script?,
  deliver_extra?{chat_id},enabled}}`；读时 secret 掩码为 `secret_set`，创建时一次性返回明文；文件 0600。
- **blueprints**：静态 TS 常量（无持久化）；`fill_blueprint` 产出的 job spec 进入现有 cron job 存储。
- **位置与迁移**：迁移期保持 Python 文件路径/格式（`<profileHome>/cron/suggestions.json`、
  `<profileHome>/webhook_subscriptions.json`），Desktop 与 managed runtime 共享同一份文件；进程内化后仍写同路径
  （Rust 负责 mkdir + chmod 0600，JS fs 无法保证权限）。profile 解析复用现有 Rust `path_resolver.rs`。
- 迁移：`packages/protocol` zod 加 `.passthrough()` 容忍 Python 侧未来新增字段；无需 DB schema 迁移。

## 5. Third-party library strategy

| Python 依赖 | TS 等价物（kimi-code 证据） | 决策 |
|---|---|---|
| `orjson` + `utils.atomic_replace` | 原生 `JSON.stringify` + kimi-code `packages/agent-core/src/utils/fs.ts` 的 `atomicWrite`（write-tmp→fsync→rename；`per-id-json-store.ts` 同模式） | 直接复用/移植 `atomicWrite` |
| `secrets.token_urlsafe` / `uuid` | `node:crypto` `randomBytes`/`randomUUID`（证据：`agent-core/src/mcp/oauth/store.ts`、`tools/cron/session-store.ts`、`loop/turn-step.ts`） | 直接使用 |
| `hmac`/`hashlib`（webhook 签名） | `node:crypto` `createHmac`/`createHash`（证据：`agent-core/src/tools/support/image-originals.ts`、`agent-core/src/mcp/oauth/provider.ts`） | 直接使用；迁移期仅用于 `test` 端点，入站校验在 Rust `ring`/`hmac` 或延迟 |
| `rapidfuzz`（blueprint 模糊匹配） | **无 agent-core 等价**；`apps/vscode/package.json` 有 `fuse.js ^7.1.0` | 先实现 exact/prefix/substring（与 Python 前三级一致），模糊级用 fuse.js（评分阈值需重定，见 §9）或内置小 Levenshtein |
| `shlex`（KV 解析） | kimi-code 无 shell-quote 依赖 | 自写 ~30 行 `slot=value` 解析器（支持双引号转义），不引第三方 |
| `croniter`（校验/测试） | **自有实现** `agent-core/src/tools/cron/cron-expr.ts`：`parseCronExpression`/`computeNextCronRun`/`cronToHuman` | 复用该解析/人类化逻辑（hydration 2h 间隔回归测试直接用它验证） |
| FastAPI/Pydantic（REST） | `packages/protocol` zod + 现有 `web/src/lib/transport.ts` | 已有 |
| aiohttp/urllib（webhook 入站/测试） | Rust `hyper`（`Cargo.toml` L52-53 已有 `hyper` server feature）；TS 侧证据为 `packages/kap-server` 用 Fastify | 入站监听器若实现 → Rust hyper（桌面端 webview 无法监听端口）；否则 out-of-scope |
| python-dotenv + config 桥接（send） | 无 | out-of-scope（CLI）；如未来需要 `dotenv` npm |

**无 TS 等价物（from scratch）**：①blueprint 目录语义（typed slots、form schema、fill→job spec、humanize 文案）；
②suggestions 同意优先/去重闩存；③动态 webhook 订阅（热加载路由表 + V1/V2/Svix/GitHub/GitLab 多签名方案）；
④消息平台 send 适配器。kimi-code 只提供 cron 解析/调度基础设施，其余全部需新写。

## 6. Integration with existing Hermes-CN-Desktop frontend

- **复用**：`web/src/lib/transport.ts`（`fetchJSON/postJSON/putJSON/deleteJSON`，REST 阶段）；`hooks/use-cron.ts`
  的 TanStack Query 模式 → 新增 `hooks/use-blueprints.ts`、`hooks/use-suggestions.ts`、`hooks/use-webhooks.ts`；
  `routes/cron.tsx`（job 列表/详情/运行记录 + `DELIVERY_OPTIONS`：local/feishu/weixin/email）→ 加“从模板创建”画廊与
  suggestions 条带；`routes/settings.tsx` 的 Section 结构 → 新增 Webhooks Section（当前无 webhook UI，已确认）；
  `lib/builtin-commands.ts` + `lib/composer-skills.ts` → 注册 `/suggestions`、`/blueprint` 客户端命令（复用
  `parseLeadingSlashCommand` 与 palette 排名）；`lib/command-palette.ts` → 加 `/suggestions`、`/blueprint`、Webhooks 条目；
  Rust `commands/api_proxy.rs` 模式 → 新增 `commands/automations.rs`。
- **改造点**：`packages/protocol/src/hermes-api.ts` 追加 4 组 zod schema；`builtin-commands.ts` 的
  `BuiltinCommandName` 从 `"compress"` 扩展为可含 `"suggestions" | "blueprint"`（`/blueprint` 实际走 namespace+表单）。
- **迁移期**：`gateway-client.ts` 仍是 `/suggestions` `/blueprint` 的传输（把命令当文本发后端）；进程内命令完成后再切换。

## 7. Removing the WebSocket dependency (migration path)

- **Phase A（现状保持）**：webhook/blueprint 走 REST（`/api/cron/blueprints*`、`/api/webhooks*`）；`/suggestions`
  无 REST 端点，经 gateway WS 文本命令执行（`handle_suggestions_command` / `handle_blueprint_command`）。
- **Phase B（进程内同接口）**：实现 `BlueprintsService` / `SuggestionsStore` / `WebhooksService` TS 模块，UI 直接调用；
  REST 端点保留给外部工具/CLI 互操作。**冻结 API**：`blueprint_catalog_entry` JSON 形状（key/title/description/
  category/tags/fields/schedule/scheduleHuman/command/appUrl）、suggestion 记录形状、webhook route summary 形状
  （name/description/events/deliver/deliver_only/prompt/script/skills/created_at/url/secret_set/enabled）、
  send 目标格式 `platform[:channel[:thread]]`。
- **Phase C（删除）**：`/suggestions` `/blueprint` 由 `commands.ts` 客户端处理，不再依赖 gateway；webhook 入站监听器
  移至 Rust hyper 或明确不提供（standalone）；删 WS/REST 路径。
- 若 Desktop 需要 suggestions 的 UI 但不想走 gateway 文本，**跨仓变更**：给 Core `web_routers/cron.py` 增加
  `/api/cron/suggestions`（list/accept/dismiss/catalog/clear）——属 Core 改动，桌面计划只冻结接口契约。

## 8. Migration phases & task breakdown

- **P0 协议层**：`packages/protocol` 新增 4 组 zod schema；`hooks/use-blueprints.ts` / `use-webhooks.ts`（纯 REST，
  立刻可用）。
- **P1 Blueprint UI**：`routes/cron.tsx` 加“从模板创建”画廊（`GET /api/cron/blueprints` → 表单 → `POST
  /api/cron/blueprints/instantiate`，422 字段级错误内联展示）。
- **P2 Suggestions**：先经 gateway 文本命令做最小面板（list/accept/dismiss/catalog/clear）；同时与 Core 约定
  `/api/cron/suggestions` REST 契约或直接由 Rust 读 JSON store。
- **P3 Webhooks UI**：`settings.tsx` 新 Section：启用平台（`POST /api/webhooks/enable`）、list/create/delete/
  enable-toggle/test；secret 创建时一次性展示（复制按钮）。
- **P4 进程内化**：移植 `blueprints.ts/fill/match/humanize`、`suggestions.ts`（atomicWrite + 锁）、`webhooks.ts`；
  hooks 切到本地服务（接口不变）。
- **P5 命令客户端化**：`builtin-commands.ts` / `commands.ts` 处理 `/suggestions`、`/blueprint`；palette + composer
  补齐；删除这两命令的 WS 依赖。
- **P6（out-of-scope / 延迟）**：Rust `webhook_server.rs`（hyper 入站）与 `hermes send` CLI 对齐——仅文档化决策，
  不排期。

## 9. Risks & open questions

1. **无 TS 等价物**：catalog/fill/suggestions/webhook/send 五块均 from scratch（kimi-code 只证明 cron 基础设施）。
   TS 目录 13 条与 Python 目录在迁移期必须双维护，用 `pnpm typecheck` + 对拍测试防漂移。
2. **Suggestions 无 REST 端点**：桌面 UI 若不经 gateway 文本，需新增 Core 端点（跨仓）或 Rust 直读 JSON store；
   建议 P2 与 Core 团队先冻结契约。
3. **Webhook 入站监听在 standalone 桌面不可行**：无公网 URL/隧道，GitHub/GitLab 等无法回调 localhost（除非隧道）；
   该能力大概率留在 CLI/gateway 面，桌面只做管理 UI。
4. **send 平台覆盖差**：Desktop cron 仅 local/feishu/weixin/email（`cron.tsx` DELIVERY_OPTIONS），
   Telegram/Discord/Slack/Signal 适配器属于 Core/gateway；“Desktop 版 hermes send”只能覆盖自家平台，需明示。
5. **权限/路径**：suggestions/webhook 文件 0600 必须由 Rust 命令保证（JS fs 不能 chmod）；profile home 解析复用
   `path_resolver.rs`，勿在 webview 硬编码路径。
6. **fuzzy 评分差异**：rapidfuzz score_cutoff 60/40 vs fuse.js 评分体系不同，匹配结果可能不一致；若严格对拍，
   建议内置 Levenshtein 并复制阈值。
7. **cron 调度器范围差异**：kimi-code `CronManager` 是 session 级；Hermes cron 是 per-profile 全局。只复用
   `cron-expr.ts`（解析/next-fire/人类化），不复用其 session 生命周期。
8. **secret 生命周期**：webhook secret 进 webview 内存（创建时一次性），日志/telemetry 必须脱敏（参考
   `agent-core-v2/src/app/telemetry/privacy.ts` 的 Slack token 模式）。

## 10. Test strategy

- **vitest 单元（进程内模块）**：`blueprints-fill.test.ts` 对拍 `test_blueprint_catalog.py`：time→cron、day→dow、
  preset→dow、默认值填充、非法 time/未知槽位拒绝、deliver 非 strict、hydration `interval_hours=2` 用移植的
  cron-expr 验证 7200s 间隔、`schedule` 槽位透传、origin 透传；`blueprints-match.test.ts`（exact/prefix/substring/
  fuzzy）；`suggestions.test.ts`：dedup 闩存、MAX_PENDING=5、accept→create、clear 只清 accepted、0600/atomic（Rust
  集成测试侧）；`webhooks.test.ts`：CRUD、secret 掩码、name 正则、deliver_only 需真实目标校验。
- **Rust 集成（`tests/`）**：store 文件读写 0600 + atomic（对齐 AGENTS.md 约定：`tempfile::TempDir`、
  `serial_test`）；若实现 `webhook_server.rs`：HMAC V1/V2/Svix/GitHub/GitLab 校验、deliver_only 直发 502、
  动态路由热加载、session close——逐条移植 `tests/gateway/test_webhook_*.py` 不变量。
- **前端集成/E2E**：hooks 用 msw 或真实 Core；Playwright E2E：blueprint 画廊创建 job（断言 `/api/cron/jobs` 出现）、
  suggestions accept/dismiss、webhooks CRUD + enable；遵循 `web-e2e.yml` 真实后端 + fake model 模式。
- **回归门禁**：`pnpm typecheck`、`pnpm test:unit`、`cargo check`；改动跨仓时同步 Core 侧
  `test_blueprint_catalog.py` / `test_send_cmd.py` 相关夹具。

## 11. Reference links

- Python 源码：`D:/hermes-agent-cn/cron/blueprint_catalog.py`、`cron/suggestion_catalog.py`、`cron/suggestions.py`、
  `hermes_cli/blueprint_cmd.py`、`hermes_cli/suggestions_cmd.py`、`hermes_cli/webhook.py`、`hermes_cli/send_cmd.py`、
  `hermes_cli/web_server.py`（L13663-13812）、`hermes_cli/web_routers/cron.py`（L199-260）、`gateway/platforms/webhook.py`、
  `gateway/channel_directory.py`、`tools/send_message_tool.py`
- Python 文档：`D:/hermes-agent-cn/website/docs/reference/slash-commands.md`（L112-113/L272-273）、
  `website/docs/reference/cli-commands.md`（L389-438/L738-771）
- Python 测试：`tests/cron/test_blueprint_catalog.py`、`tests/hermes_cli/test_send_cmd.py`、`tests/hermes_cli/test_webhook_cli.py`、
  `tests/gateway/test_webhook_{adapter,deliver_only,dynamic_routes,integration,session_close,signature_rate_limit}.py`、
  `tests/gateway/test_cron_fire_webhook.py`、`test_msgraph_webhook.py`、`test_telegram_webhook_secret.py`
- TS 参照（kimi-code）：`packages/agent-core/src/tools/cron/{cron-expr,scheduler,session-store,persist,types}.ts`、
  `src/agent/cron/manager.ts`、`src/utils/fs.ts`（atomicWrite）、`src/mcp/oauth/store.ts`（node:crypto）、
  `packages/kap-server/package.json`（Fastify）、`apps/vscode/package.json`（fuse.js）
- Desktop 集成点：`web/src/lib/transport.ts`、`web/src/lib/builtin-commands.ts`、`web/src/lib/composer-skills.ts`、
  `web/src/lib/command-palette.ts`、`web/src/hooks/use-cron.ts`、`web/src/routes/cron.tsx`、`web/src/routes/settings.tsx`、
  `packages/protocol/src/hermes-api.ts`（L937-1004）、`Cargo.toml`（hyper）、`src/commands/api_proxy.rs`、`src/path_resolver.rs`
