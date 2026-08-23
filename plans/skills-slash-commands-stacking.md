# Skills as Slash Commands & Stacking — Python → TypeScript Rewrite Plan

## 1. Summary

本特性把三件事从 Python 后端搬到 TS 前端（最终 in-process，去掉 WS 依赖）：

1. **每个已安装 skill 都是一个裸的 `/<name>` 斜杠命令**（Python 已实现；桌面端目前只有 `/skill <name>` 命名空间写法，需要改为顶层裸命令）。
2. **Skill stacking**：一条消息开头最多 5 个连续 `/skill` token 会被全部加载，其余文本作为用户指令（如 `/github-pr-workflow /test-driven-development fix issue #123 and open a PR`）；解析在第一个非 skill token 处停止，避免吞掉 `/tmp/xxx` 这类参数。
3. **Skill bundles（`/bundles`）**：`~/.hermes/skill-bundles/*.yaml` 里声明的 bundle 变成 `/<bundle-slug>` 命令，一条命令加载 N 个 skill；bundle 与 skill 撞名时 bundle 优先。

迁移期间保持现有 WS 契约（`command.dispatch` 返回 `{type:"skill", message, name, display}`）不变，最终由 TS 侧 `SkillLoader` + `SkillCommandRegistry` 在进程内完成同样的扫描、展开、堆叠与 bundle 消息构造。核心设计决策：**注册表统一**（builtin > bundle > skill 的优先级）、**解析与展开分离**（parser/resolver 纯函数 + loader 负责读盘/模板/安全）、**scaffold 消息字节级兼容 Python 标记**（保证迁移期 memory/replay/投影逻辑不断）。

## 2. Current Python implementation

### 2.1 源文件与职责

- `D:/hermes-agent-cn/tools/skills_tool.py`
  - `HERMES_HOME/skills/` 为唯一事实源；`_skills_dir()` 按活动 profile 解析；`_find_all_skills()` 递归扫描 `SKILL.md`（`iter_skill_index_files`），过滤 `platforms:`、`skill_matches_environment`、disabled 集合；带 mtime signature + 30s TTL 缓存；`_skill_origin` 区分 builtin/user/external。
  - `skills_list()` / `skill_view()`：渐进披露 tier1/tier2；`skill_view` 做路径穿越校验（`tools.path_security`）、注入模式扫描、setup/secret capture（`_secret_capture_callback`）。
- `D:/hermes-agent-cn/agent/skill_commands.py`（核心）
  - `scan_skill_commands()` 生成 `{"/slug": {name, description, skill_md_path, skill_dir}}`；slug 归一化（小写、空格/下划线→连字符、去非法字符）；用 `hermes_cli.commands.resolve_command` 做 core-command 冲突跳过；同名 slug 首胜。
  - `get_skill_commands()`：平台作用域（`HERMES_PLATFORM` / `HERMES_SESSION_PLATFORM`）变化即重扫。
  - `resolve_skill_command_key()`：用户输入下划线/连字符互换。
  - `build_skill_invocation_message()` → `_build_skill_message()`：模板变量 `${HERMES_SKILL_DIR}`、inline shell、`[Skill directory: …]`、config 注入、setup note、支持文件列表、`append_user_instruction` + `register_stable_prefix`。
  - `_MAX_STACKED_SKILLS = 5`；`split_stacked_skill_commands(rest)` 消费前导 `/skill` token（最多 4 个额外），停在第一个不可解析 token；`build_stacked_skill_invocation_message()` 复用 bundle 标记（header 含 `" skill bundle,"`，每个 block 以 `[Loaded as part of the ` 开头）以便 `extract_user_instruction_from_skill_message()` 无新标记即可提取。
  - `_SKILL_INVOCATION_PREFIX` 等标记常量与 `describe_skill_invocation()`（展示层投影）、`build_preloaded_skills_prompt()`（`-s` / `HERMES_TUI_SKILLS`）。
- `D:/hermes-agent-cn/agent/skill_bundles.py`
  - `HERMES_HOME/skill-bundles/*.yaml`（或 `HERMES_BUNDLES_DIR` 覆盖）；字段 `name/description/skills/instruction`；`_slugify` 与 skill 相同；mtime 缓存。
  - `resolve_bundle_command_key()`；`build_bundle_invocation_message()` → `(message, loaded_names, missing)`；缺失/平台 disabled 的 skill 跳过但保留在 header 注明；`save/delete/reload/list`。
  - 冲突规则：bundle 优先于 skill（dispatch 先查 bundle）。
- `D:/hermes-agent-cn/hermes_cli/commands.py`
  - `COMMAND_REGISTRY`（`CommandDef`）：`/skills`（hub，`cli_only=True` + gateway gate）、`/bundles`（`execute="bundles"`）、`/reload-skills` 等；`resolve_command()` 被 skill 扫描用作冲突检测；`GATEWAY_KNOWN_COMMANDS`。
- `D:/hermes-agent-cn/hermes_cli/skills_hub.py`、`hermes_cli/bundles.py`：`/skills` 子命令（search/browse/inspect/install/audit…）与 `hermes bundles` CLI（list/show/create/delete/reload）——管理侧，桌面已有 Skills 页面，本计划只做命令调用面。
- 调度面（重要，三者行为不完全一致）：
  - `cli.py` ≈10840：先 bundle，再 skill（含 stacking），再做前缀匹配（`set(COMMANDS)|set(skill_commands)|set(skill_bundles)`）。
  - `gateway/run.py` ≈16356：bundle 优先 → skill + `split_stacked_skill_commands` → 对 stacked 成员逐项做 per-platform disabled 复查（#58888）。
  - `tui_gateway/methods_tools.py` `command.dispatch`（≈433）：桌面当前唯一入口——只支持**单 skill**（`key = f"/{name}"` 命中 `scan_skill_commands()`）与单 bundle，**尚不支持 stacking**；返回 `{type:"skill"|"send", message, name, display}`，`display` 用 `_skill_scaffold_projection()` 投影。
  - `tui_gateway/server.py`：`_skill_scaffold_projection()` / `_expand_skill_invocation_for_replay()`——用户行只存/只显示调用文本，body 留在服务端，rewind 时再展开。

### 2.2 数据流

`用户输入 /a /b instr` → CLI/gateway dispatch：bundle 命中？→ bundle 消息；否则 `resolve_skill_command_key` 命中？→ `split_stacked_skill_commands` 取额外 keys → `build_stacked_skill_invocation_message([/a,/b], instr)`（或单 skill）→ 展开后的 scaffold 消息进入 agent loop → 持久化时用 `describe_skill_invocation` 投影为 `display_kind=skill_invocation` 的用户行。

## 3. Target TypeScript design

### 3.1 模块布局（web/src/lib/slash-commands/）

```
web/src/lib/slash-commands/
├── types.ts        # SlashCommandEntry / CommandIntent / SkillCommandInfo / BundleInfo
├── registry.ts     # 统一注册表：builtin ∪ skill ∪ bundle，含优先级与冲突解析
├── parse.ts        # parseLeadingSlashToken / splitStackedSkillCommands（max 5）
├── resolve.ts      # resolveSlashCommandIntent —— kimi-code 风格 intent 联合
├── skill-commands.ts  # buildSkillSlashCommands / slugify / collision guard
├── skill-loader.ts    # SkillLoader：读盘、frontmatter、模板、scaffold 构造
├── stacks.ts          # buildStackedSkillInvocationMessage（复用 bundle 标记）
├── bundles.ts         # BundleStore：YAML 扫描/缓存/消息构造
└── dispatcher.ts      # SkillCommandDispatcher 接口 + BackendDispatcher / LocalDispatcher
```

### 3.2 核心接口（签名级伪代码）

```ts
type SlashCommandKind = "builtin" | "skill" | "bundle";
interface SlashCommandEntry {
  kind: SlashCommandKind;
  name: string;            // 不含前导 "/" 的规范化 slug
  aliases: readonly string[];
  description: string;
  argsHint?: string;
  // skill/bundle 专属
  skillName?: string;      // 原始 frontmatter name（与 slug 可能不同）
  skillDir?: string;
  bundle?: BundleInfo;
}
type CommandIntent =
  | { kind: "not-command" }
  | { kind: "builtin" | "bundle" | "skill"; command: SlashCommandEntry; args: string }
  | { kind: "stack"; entries: SlashCommandEntry[]; instruction: string } // 2..5 个
  | { kind: "message"; input: string };

function splitStackedSkillCommands(
  rest: string,
  isKnownSkill: (token: string) => boolean,
  maxTotal = 5,               // 镜像 _MAX_STACKED_SKILLS
): { extra: SlashCommandEntry[]; instruction: string };

interface SkillLoader {
  load(slugOrName: string): Promise<LoadedSkill | undefined>; // {content, skillDir, name, frontmatter}
  buildMessage(loaded: LoadedSkill, opts: { instruction: string; activationNote: string }): string;
  invalidate(): void;                                          // /reload-skills 对应
}
interface SkillCommandDispatcher {
  dispatch(input: { entries: SlashCommandEntry[]; instruction: string }):
    Promise<{ message: string; display: string; notice?: string }>;
}
```

### 3.3 数据流（最终态，in-process）

1. `SkillCommandRegistry` 启动时由两个来源构建：`useSkills()`（REST `/api/skills`，管理面暂留）返回的 `SkillInfo[]` + `BundleStore.scan()`（读 `~/.hermes/skill-bundles/*.yaml`）；slug 用 Python 相同规则计算，冲突按 **builtin > bundle > skill** 取优先级（镜像 Python `resolve_command` 冲突跳过与 bundle-first）。
2. Composer 输入 → `parse.ts` 取首 token → `resolve.ts`：builtin 命中走客户端命令；否则 bundle 命中走 bundle；否则 skill 命中 → `splitStackedSkillCommands` 消费后续前导 token（≤5，首个非 skill token 起为 instruction）→ `stack` 或单 `skill`。
3. `SkillLoader.load()` 经 Tauri IPC（Rust 读 `HERMES_HOME/skills/<dir>/SKILL.md` 与支持文件）或迁移期 `fetchJSON("/api/skills/content")` 拿正文；`js-yaml` 解析 frontmatter；做 platform/environment/disabled 过滤与路径穿越校验；模板替换 `${HERMES_SKILL_DIR}`。
4. `stacks.ts` / `bundles.ts` 按 Python 字节格式构造 scaffold 消息（`[IMPORTANT: The user has invoked the "a /b" stacked skill bundle, …]` + `[Loaded as part of the "…" skill.]` block + skill dir + 支持文件 + instruction）。
5. 消息进入 TS agent loop（`agent.turn.prompt`，对应 kimi-code `SkillManager.activate` → `recordActivation` → telemetry `skill_invoked`）；会话持久化只存调用文本 + `display_kind: "skill_invocation"`，展开体由 `describeSkillInvocation` 投影、rewind 时由 `expandSkillInvocationForReplay` 重新展开。

### 3.4 Composer / palette 变化

- `composer-skills.ts`：`SKILL_NAMESPACE` 写法退役为兼容别名；顶层候选 = 全部 skill（`filterComposerSkills` 排名逻辑保留）+ bundle + `/compress`。
- 堆叠编辑：选中 `/skill-a` 后继续输入 `/` 仍弹候选；`replaceLeadingSlashToken` 复用；chip 显示每个已加载 skill。
- `command-palette.ts`：`buildSkillItems` 由"跳转管理页"扩展为"可执行命令 + 管理跳转"双动作；新增 `bundles` 组。

## 4. Data models & persistence

- `SkillInfo`（`@hermes/protocol` 已有：name/description/category/origin/enabled/usage/provenance/source_path/skill_file）——本特性需要派生字段 `slug`（TS 计算，不落库）、`platform`（frontmatter `platforms`）、`disabled`（已有 `enabled` 反义）。
- 命令注册表内存态：`SlashCommandEntry[]` + `Map<slug, entry>`；重建时机 = skills query 失效、`/reload-skills`、bundle 目录 mtime 变化。不持久化（从 `SKILL.md`/YAML 派生）。
- Bundle：`~/.hermes/skill-bundles/*.yaml`（文件即存储，镜像 Python `save_bundle/delete_bundle`）；字段 `{name, slug, description, skills[], instruction, path}`；TS `BundleStore` 缓存 + `(dir mtime, file mtimes)` 签名失效（镜像 `get_skill_bundles`）。
- 会话消息：沿用 Python 约定——**持久化用户行是调用文本**（`/a /b instr`）与 `display_kind=skill_invocation`；scaffold body 只存在于 agent 收到的展开消息中；`describe_skill_invocation`/`extract_user_instruction_from_skill_message` 的 TS 版保持与 Python 标记字节一致（memory provider 仍按 `_SKILL_INVOCATION_PREFIX` 等标记工作）。

## 5. Third-party library strategy

| Python 依赖/能力 | TS 等价（kimi-code 证据） | 备注 |
|---|---|---|
| PyYAML frontmatter 解析 | `js-yaml`（`D:/kimi-code/packages/agent-core/src/skill/parser.ts` `import { load as loadYaml } from 'js-yaml'`） | 桌面 package.json 目前无 YAML 依赖，需新增；frontmatter fence 解析自写（镜像 parser.ts）。 |
| pathlib 路径处理 | `pathe`（kimi-code `scanner.ts`/`registry.ts` 大量使用）或 Node `node:path` + 现有 `@/lib` 工具 | Windows 反斜杠注意；Tauri FS 走 Rust 侧绝对路径。 |
| 技能扫描/缓存（mtime signature） | 自写 `SkillLoader`（TS Map + stat mtimes via Tauri IPC）；kimi-code `src/skill/scanner.ts` `resolveSkillRoots/discoverSkills` 可参考 root 优先级与首胜策略 | 无第三方库。 |
| slug 归一化 + 正则 | JS `RegExp` 自写（`_SKILL_INVALID_CHARS`/`_SKILL_MULTI_HYPHEN` 同规则） | 无第三方库。 |
| 斜杠命令解析/分发 | 直接参考 kimi-code `apps/kimi-code/src/tui/commands/{parse,resolve,registry,dispatch}.ts`（`parseSlashInput`、`resolveSlashCommandInput` intent 联合、`buildSkillSlashCommands` + `commandMap`） | 自写 TS 模块，无第三方库；kimi-code 提供了 registry 模式（builtin 数组 + `findBuiltInSlashCommand` + availability）。 |
| **Stacking（前导 ≤5 个 skill token）** | **无 1:1 TS 等价**。最接近：kimi-code `dispatch.ts::dispatchInlineSkillCombo`（≥2 个已知 skill token 的 bundle 提交）+ `tui/utils/inline-skill-tokens.ts`（token 扫描/去重） | 必须自写并移植 Python 语义：停在第 1 个非 skill token、≤5、其余为 instruction。kimi-code bundle 规则是"每个 token 无参激活、剩余全文为 prompt"，与 Hermes 不同——parity 测试兜底。 |
| **Skill bundles（/bundles）** | **无 TS 等价**——kimi-code 无 bundle 特性 | 自写 `BundleStore`：YAML 解析（js-yaml）+ `buildBundleInvocationMessage` 镜像 `agent/skill_bundles.py`。 |
| scaffold 消息渲染 | 参考 kimi-code `agent/skill/prompt.ts`（`renderUserSlashSkillPrompt`/`<kimi-skill-loaded name dir args trigger>`） | Hermes 标记格式不同且必须字节兼容 Python（迁移期投影/内存提取），自写。 |
| 技能目录读取 | kimi-code 经 `ISkillService` RPC（`skillService.ts` `list/activate`）；桌面最终态走 Tauri Rust 命令（`src/commands/*` 现有 60 个命令，需新增 `skill_read`/`bundles_list` 之类） | 自写 Rust IPC 薄层或复用现有 fs 命令（实现时核对）。 |
| 文件监听/重扫 | 自写 mtime 签名 + 轮询；Python 是 `reload_bundles`/`reload_skills` diff | 无第三方库。 |

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/lib/builtin-commands.ts`：保留 `/compress`；`isBuiltinComposerCommandToken` 语义升级为"命中注册表 builtin 层"；新增 `ComposerCommandCandidate.kind: "bundle"`。
- `web/src/lib/composer-skills.ts`：核心改造点——`SKILL_NAMESPACE` 降级为兼容别名；`resolveComposerSkillCommand` → 新的 `resolveComposerSlashIntent`（支持裸命令 + stacking）；`getSkillNamespaceToken` 保留给 `/skill <name>` 旧写法；新增 `splitStackedSkillCommands` 纯函数。
- `web/src/hooks/use-skills.ts`：`useSkills` 结果作为注册表 skill 源；新增 `useBundles`（迁移期需后端补 REST：`hermes_cli/web_routers/skills.py` 目前只有 `/api/skills`、`/toggle`、`/content`、`/api/skills/hub/*`，**没有 bundles 端点**，需加 `GET /api/skills/bundles` + `POST/DELETE` 或经 `command.dispatch` `/bundles` 执行器）。
- `web/src/hooks/use-gateway.ts` `dispatchCommand`：迁移期扩展——先单次调用 `command.dispatch`（现状），stacking 需后端 `methods_tools.py` 支持（把 `split_stacked_skill_commands` + `build_stacked_skill_invocation_message` 接入 `command.dispatch`，返回 `{type:"stack"}` 或复用 `type:"send"`）；最终态换成 `LocalDispatcher`。
- `web/src/hooks/use-create-and-send-session.ts` / `web/src/routes/detail.tsx`：把 `resolveComposerSkillCommand(payload.text, …)` 换成新 resolver；stack 时把整条指令交给 dispatcher 一次展开。
- `web/src/lib/command-palette.ts`：`buildSkillItems` 增加"运行 `/name`"动作；`COMMAND_PALETTE_COMMANDS` 增加 `/bundles` 入口；新增 `bundles` 组（复用现有 `CommandPaletteGroupId` 机制）。
- `web/src/components/command-palette/command-palette.tsx`：渲染新组与"执行命令"动作。
- Rust `src/commands/*`：新增 `skill_read_file(path)`、`skill_list_files(dir)`、`bundles_read_dir()` 等只读 Tauri 命令（最终态替换 `/api/skills/content` 与 `command.dispatch`）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API 契约（迁移期不变）：`CommandDispatchResult = {type:"skill"|"send"|"stack", message, name?, display?, notice?}`；skill scaffold 标记串；`display_kind="skill_invocation"`；`describe/expand` 投影行为。

- **Phase A（现状 → 保持 WS）**：桌面 composer 先改为裸命令 + stacking 编辑体验；`command.dispatch` 后端补 stacking（`methods_tools.py` 接入 `split_stacked_skill_commands`/`build_stacked_skill_invocation_message`，与 `cli.py`/`gateway/run.py` 对齐）；加 `GET /api/skills/bundles`。
- **Phase B（同接口换实现）**：TS 侧实现 `SkillLoader` + `BundleStore` + `LocalDispatcher`，通过 `SkillCommandDispatcher` 接口注入；`BackendDispatcher` 与 `LocalDispatcher` 输出做字符串级 parity 测试后灰度切换；`sendPrompt` 仍走 WS/`prepareComposerPrompt`（agent loop 尚未入进程）。
- **Phase C（去 WS）**：agent loop 迁入进程后删除 `command.dispatch` 调用；REST `/api/skills*` 仅保留给管理页；`_skill_scaffold_projection`/`_expand_skill_invocation_for_replay` 的 TS 版接管展示与 rewind。

## 8. Migration phases & task breakdown

| Phase | 任务 | 依赖 | 验收 |
|---|---|---|---|
| 0 | 建立 TS parity fixtures：从 Python 测试提取输入/期望（stacking 4 例、bundle 5 例、slug 冲突、平台禁用）；`describe/expand` 往返例 | — | vitest 先行用例红/绿基线 |
| 1 | 注册表 + parser + resolver + palette/composer 裸命令 UI（仍走 backend `command.dispatch`） | Phase 0 | 单 `/name` 可用；`/compress` 不回归 |
| 1b | 后端 `command.dispatch` 支持 stacking + bundles REST 端点 | Phase 1 | 桌面端 `/a /b instr` 与 CLI 展开一致 |
| 2 | `SkillLoader`（js-yaml、模板、安全校验、缓存）+ `BundleStore` + `LocalDispatcher` | Phase 1b | 双 dispatcher 输出相等（vitest 字符串 diff） |
| 3 | stacking autocomplete/chip 完整体验；`/reload-skills`、`/bundles` UI | Phase 2 | Playwright E2E |
| 4 | 切 `LocalDispatcher` 默认，删 WS `command.dispatch` 调用；`describe/expand` TS 化 | Phase 3 | 会话回放/rewind 不丢 skill |

## 9. Risks & open questions

- **无 TS 等价（最大风险）**：stacking 与 bundle 在 kimi-code 都没有 1:1 实现（详见 §5）。必须自写并逐条移植 Python 语义；parity 测试覆盖边界（停在第 1 个非 skill token；`/ocr-and-documents /tmp/scan.pdf …`；5 上限；缺失/禁用成员跳过）。
- **scaffold 标记字节兼容**：迁移期 Python memory provider（openviking 等）与 `_skill_scaffold_projection` 仍按 Python 标记解析；TS 生成的展开消息必须字节一致，否则会话投影/内存污染/rewind 展开断裂。`SKILL_INVOCATION_SQL_LIKE` 等常量需在协议层对齐。
- **bundles REST 缺失**：`web_routers/skills.py` 无 bundles 端点，Phase 1b 需要后端配合；若无法改后端，bundles 只能经 `command.dispatch`（`/bundles` 执行器）或 Rust 直读 YAML。
- **平台/disabled 过滤**：Python 区分全局 disabled 与 per-platform disabled（gateway 多平台场景）；桌面是单平台，但 in-process 也要保留 `platform` 参数语义，避免将来 gateway 化回归。
- **安全面**：`name → path` 的路径穿越（`tools.path_security`）、注入模式扫描、symlink 跟随必须在 TS/Rust 复制，不能只靠 Tauri 沙箱。
- **skill usage/Curator 集成**：`bump_use` 目前在 Python 侧；TS 化后埋点放哪（telemetry `skill_invoked` 已有 kimi-code 先例）未定。
- 开放问题：`/skills` hub 管理子命令是否纳入本计划（建议：不纳入，桌面 Skills 页面已覆盖）；`build_preloaded_skills_prompt`（`-s`）桌面端是否需要。
- 路径差异确认：规格中的 `tests/tools/test_skill_bundles.py` **不存在**，实际为 `D:/hermes-agent-cn/tests/agent/test_skill_bundles.py`。

## 10. Test strategy

- **vitest 单元（镜像 Python）**：
  - `parse/resolve`：`test_skill_commands.py::TestStackedSkillCommands` 全部用例（split 停在非 skill token、7 个里取 4 extra 上限 5、stacked message 缺 skill 跳过）；`test_split_stops_at_non_skill_token`、`test_split_caps_at_five_total` 直接改名移植。
  - `skill-commands`：slug 归一化、core-command 冲突跳过（镜像 `resolve_command`）、同名 slug 首胜（`test_slug_collision_keeps_first_skill`）、平台重扫（`test_get_skill_commands_rescans_when_platform_scope_changes` 等 3 例）。
  - `bundles`：`test_skill_bundles.py` 的 slugify/scan/cache/resolve/build（缺失跳过、platform-disabled 跳过、save/delete/reload）。
  - `loader`：frontmatter 解析、`${HERMES_SKILL_DIR}` 替换、路径穿越拒绝、注入模式告警。
- **集成（React Testing Library）**：composer 裸 `/name` 候选、stack 候选、`/skill` 旧写法兼容；`use-create-and-send-session` dispatch mock 断言 `transportText` 为 scaffold。
- **Playwright E2E**：`/a /b instr` 提交 → 后端/本地展开一致；`/bundles` 列表；`/<bundle>` 加载 N skills；rewind 后 skill 仍在。
- **parity 工具**：同一组 fixture 分别喂 `BackendDispatcher` 与 `LocalDispatcher`，断言 message 字符串完全相等（含标记）。
- **Python 侧回归**：`tests/agent/test_skill_commands.py`、`tests/agent/test_skill_bundles.py`、`tests/hermes_cli/test_skills_*.py`（5 个）；`tests/skills/` 37 个为各内置 skill 内容级测试，仅抽样 2–3 个与本特性交互的（如含 scripts/supporting files 的），不逐条移植。

## 11. Reference links

- Python：`D:/hermes-agent-cn/tools/skills_tool.py`、`agent/skill_commands.py`、`agent/skill_bundles.py`、`agent/skill_preprocessing.py`、`hermes_cli/commands.py`、`hermes_cli/skills_hub.py`、`hermes_cli/bundles.py`、`hermes_cli/web_routers/skills.py`、`cli.py`（≈10840）、`gateway/run.py`（≈16356）、`tui_gateway/methods_tools.py`（command.dispatch ≈433）、`tui_gateway/server.py`（投影/replay ≈7251）。
- Docs：`website/docs/user-guide/features/skills.md`（"Every installed skill is automatically available as a slash command"、Stacking、Skill Bundles 小节）、`website/docs/reference/slash-commands.md`（`/bundles`、registry 说明）。
- Tests：`tests/agent/test_skill_commands.py`、`tests/agent/test_skill_bundles.py`、`tests/hermes_cli/test_skills_{config,hub,install_flags,skip_confirm,subparser}.py`、`tests/skills/`（37 文件）。
- kimi-code TS 参考：`packages/agent-core/src/agent/skill/{index,prompt,types}.ts`、`packages/agent-core/src/skill/{scanner,parser,types}.ts`、`packages/agent-core/src/services/skill/{skill,skillService}.ts`、`apps/kimi-code/src/tui/commands/{parse,resolve,registry,dispatch,skills,types}.ts`、`apps/kimi-code/src/tui/utils/inline-skill-tokens.ts`。
- Desktop 现有：`web/src/lib/composer-skills.ts`、`web/src/lib/builtin-commands.ts`、`web/src/lib/command-palette.ts`、`web/src/hooks/use-skills.ts`、`web/src/hooks/use-gateway.ts`（dispatchCommand）、`web/src/hooks/use-create-and-send-session.ts`、`web/src/routes/detail.tsx`、`web/src/components/command-palette/command-palette.tsx`、`web/src/lib/composer-skills.test.ts`。
