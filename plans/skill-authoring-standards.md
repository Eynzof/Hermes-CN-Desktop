# Skill Authoring Standards (CI-Enforced SKILL.md Lint) — Python → TypeScript Rewrite Plan

## 1. Summary

本 feature 把 Core 仓库的「Skill authoring standards enforced by CI」从 Python 迁移到
TypeScript：目前 SKILL.md 格式与规范检查由 Core 侧两条路径承担 —— `tools/skill_linter.py`
（advisory 约定 linter，`python -m tools.skill_linter`）和 `tests/skills/test_authoring_standards.py`
（pytest 硬性 CI 门禁，扫描 `skills/**` 与 `optional-skills/**`）。迁移目标：

1. 在 Desktop 仓库内实现一个纯 TS 的 SKILL.md linter（`packages/skill-lint`），
   规则表与 Python 实现逐条对齐；
2. 提供命令行入口 `pnpm skills:lint`（等价物：`node scripts/skill-lint.mjs`），
   可对 Core 源码目录（`../Hermes-CN-Core/skills`、`optional-skills`）或 Desktop 打包阶段
   `static/bundled-skills` 递归扫描；
3. 接入 CI：`web-test.yml`（PR 双仓场景对 Core skills 树做门禁）与
   `release-desktop.yml`（在 "Stage bundled skills" 之后对 staged 副本做门禁）；
4. 可选（Phase 4）：Skills 页面内嵌「authoring check」面板，直接复用 TS linter，
   无需 `/api/skills`（WS/REST）。

该 feature 是 build-time/offline 工具链，**不依赖 WebSocket**；运行时技能列表
（`web/src/hooks/use-skills.ts` → `/api/skills`）不在本计划范围内，只会在 Phase 4
可选面板中作为被替代对象提及。kimi-code 只提供了 SKILL.md **解析期硬校验**（缺 fence、
缺 name/description、非法 YAML、不支持 type），**没有**约定式 lint（营销词、shell 工具引用、
metadata 块、platforms gating 等）——这些规则必须从 Python 移植为 TS 模块，是本节
最重要的「no TS equivalent」风险（详见 §5、§9）。

## 2. Current Python implementation

### 2.1 核心实现

- `D:/hermes-agent-cn/tools/skill_linter.py`（462 行，已通读）：
  - 设计契约：findings **advisory**（severity = ERROR | WARNING），由调用方决定是否阻塞；
    `lint_content(content, skill_dir=None)` 纯函数；`lint_skill(skill_md_path)` 读盘版本；
    `format_findings()` / `has_errors()` 输出与判定；`_main()` CLI
    `python -m tools.skill_linter <SKILL.md | dir> ...`，WARNING-only 退出 0，有 ERROR 退出 1。
  - 规则表（rule id → severity → 判定）：
    | rule id | severity | 说明 | 是否需要磁盘 |
    |---|---|---|---|
    | `name-format` | ERROR | 小写字母/数字/`-`/`_` | 否 |
    | `name-dir-mismatch` | ERROR | frontmatter name == 目录名 | 是 |
    | `description-length` | WARNING | 超过 `SKILL_PROMPT_DESC_LIMIT`(60) | 否 |
    | `description-marketing` | WARNING | 营销词表 `_MARKETING_WORDS` | 否 |
    | `missing-metadata` | WARNING | 缺 version/author/license/metadata.hermes.tags | 否 |
    | `author-caps` | WARNING | author 大小写规范 | 否 |
    | `shell-utility-reference` | WARNING | prose 中反引号包裹 `grep`/`cat`/`sed` 等 → 原生工具名（`_SHELL_UTIL_TO_TOOL`，先 `_strip_code_blocks`） | 否 |
    | `missing-section` | WARNING | 缺 `## When to Use`（`_EXPECTED_SECTIONS`） | 否 |
    | `dangling-reference` | WARNING | body 引用的 `references|templates|assets/...` 磁盘不存在（跳过 `*`/尾 `/`；`scripts/` 排除） | 是 |
    | `platforms-gating` | WARNING | `scripts/` 里出现 POSIX-only 原语（`_POSIX_PRIMITIVES`）但无 `platforms:` | 是 |
    | `forbidden-file` | WARNING | 存在 README.md/CHANGELOG.md/install.sh/.env 等 `_FORBIDDEN_FILES` | 是 |
    | `platforms-value` | WARNING | platforms 取值 ∉ {linux, macos, windows, darwin} | 否 |
  - 依赖 `agent.skill_utils.parse_frontmatter`（BOM/平台匹配/60 字预算集中处）与
    `SKILL_PROMPT_DESC_LIMIT`。
- `D:/hermes-agent-cn/tools/skill_manager_tool.py`（line ~989-991）：`skill_manage`
  create 路径对候选内容调用 `lint_skill`，把 findings 作为 guidance 展示——**advisory，不阻塞**
  （硬校验在 `_validate_frontmatter`）。

### 2.2 CI 硬门禁

- `D:/hermes-agent-cn/tests/skills/test_authoring_standards.py`（149 行，已通读）：
  - 参数化扫描 `skills/**/SKILL.md` + `optional-skills/**/SKILL.md`（`_skill_paths()`）；
  - 硬规则：必须以 `---` 开头且 frontmatter 闭合、YAML mapping；必需字段
    `name, description, version, author, license, platforms` + tags（`metadata.hermes.tags` 或顶层）；
    name == 目录名；description ≤ 60 字符、以 `.` 结尾、无营销词；`related_skills` 必须解析到
    同树技能名（两遍扫描 `_all_names()`）；无 machine-local 路径
    （`/home/<user>/`、`C:\Users\<user>\`，排除 runner）；正文 ≤ 100k 字符；
  - `GRANDFATHER` 字典当前为空（Aug 2026 sweep 清零），约定只缩不增。
- 相关但非 lint 的测试（用于边界理解，不直接移植）：
  - `tests/test_plugin_skills.py`：插件技能命名空间 `plugin:name`、`parse_qualified_name`、
    `skill_view` 限定名分发、平台 gate —— TS linter 需对 `:` 限定名保持感知（name-format 校验
    与目录名匹配时要容忍合法 namespace 前缀）。
  - `tests/test_session_skill_previews.py`：/skill 展开消息的 preview 塑造 —— 纯会话展示行为，
    与 authoring 无关，**out of scope**。

### 2.3 相关脚本与文档

- `D:/hermes-agent-cn/scripts/build_skills_index.py`（459 行，已通读）：Hub 目录爬虫
  （skills.sh/GitHub taps/clawhub/lobehub 等，写 `website/static/api/skills-index.json`，含健康阈值
  `EXPECTED_FLOORS`）。**不是 lint**，TS 侧不移植（见 §5）；计划仅引用它作为「skills 生态工具链」
  上下文，避免误以为 `hermes skills lint` 与索引构建同源。
- `D:/hermes-agent-cn/CONTRIBUTING.md`（line 568-618）"Skill authoring standards (HARDLINE)"
  规则 1-5 是 linter 规则的来源（60 字符、原生工具引用、platforms 审计、author 署名、现代 section 顺序）。
- `D:/hermes-agent-cn/website/docs/user-guide/features/skills.md`（line 161-213）：
  SKILL.md Format 规范（frontmatter 字段、platforms 值表、`metadata.hermes.*`）与目录结构
  （references/templates/scripts/examples/assets）。

### 2.4 数据流（现状）

```
PR → Core pytest: tests/skills/test_authoring_standards.py
        └─ 读 skills/**、optional-skills/**/SKILL.md
           ├─ 硬校验（frontmatter/字段/名称/描述/related/size/路径）
           └─ 失败即 fail（GRANDFATHER 白名单豁免）
skill_manage create → tools/skill_manager_tool._validate_frontmatter（硬拒绝）
                    + lint_skill（advisory guidance）
本地/CI → python -m tools.skill_linter <dir>  （exit 1 if ERROR）
```

## 3. Target TypeScript design

### 3.1 模块布局（新增 workspace 包）

```
packages/skill-lint/
├── package.json          # name: @hermes/skill-lint, deps: js-yaml
├── src/
│   ├── types.ts          # LintFinding / LintSeverity / SkillFrontmatter / LintOptions / LintResult
│   ├── frontmatter.ts    # parseFrontmatter（js-yaml，BOM/CRLF 处理，对齐 agent.skill_utils）
│   ├── rules.ts          # 规则表 + 每规则纯函数（对齐 skill_linter.py 的 _check_* 系列）
│   ├── lint.ts           # lintSkillContent / lintSkillFile / lintTree / hasErrors / formatFindings
│   └── cli.ts            # CLI 入口（或独立 scripts/skill-lint.mjs 薄包装）
└── test/                 # vitest，逐规则 fixture + 奇偶校验用例
```

### 3.2 关键接口（signature 级，非实现）

```ts
type LintSeverity = "error" | "warning";
interface LintFinding { severity: LintSeverity; rule: string; message: string; }

interface SkillFrontmatter { name?: string; description?: string; version?: string;
  author?: string; license?: string; platforms?: unknown;
  metadata?: { hermes?: { tags?: unknown; related_skills?: unknown[] } }; [k: string]: unknown; }

interface LintOptions { skillDir?: string; }   // 传目录启用磁盘类检查，与 Python skill_dir 语义一致

function lintSkillContent(content: string, opts?: LintOptions): LintFinding[];
function lintSkillFile(skillMdPath: string): LintFinding[];                 // 读盘 + 磁盘检查
function lintTree(roots: string[], opts?: { json?: boolean }): LintResult;  // 递归 SKILL.md
function hasErrors(findings: LintFinding[]): boolean;
function formatFindings(findings: LintFinding[]): string;                   // "✗ [rule] msg" 兼容
```

### 3.3 规则注册表（TS 版，与 §2.1 表 1:1）

每条规则实现为 `(frontmatter|body|skillDir) → LintFinding[]` 的纯函数，集中在一张
`RULE_TABLE: Array<{ id: string; severity: LintSeverity; check: CheckFn; needsDisk: boolean }>`，
便于 CI JSON 输出、奇偶测试与未来扩展（kimi-code 风格：解析错误走 throw/onWarning，
约定 findings 走返回值——保留 Python 的 advisory 语义）。

### 3.4 CLI 与 CI 数据流

```
node scripts/skill-lint.mjs --source ../Hermes-CN-Core/skills ../Hermes-CN-Core/optional-skills
  → lintTree(roots) → 两遍扫描（先收集全部 name 供 related_skills 解析，再逐文件 lint）
  → stdout 人类可读 / --json 机器可读
  → exitCode = hasErrors ? 1 : 0      （与 python -m tools.skill_linter 契约一致）

CI:
  web-test.yml（PR）：   若 ../Hermes-CN-Core 存在（双仓 worktree/checkout），
                        对 skills/** + optional-skills/** 跑 pnpm skills:lint
  release-desktop.yml： 在 "Stage bundled skills" 之后对 static/bundled-skills 跑同一命令
```

## 4. Data models & persistence

- **无持久化**：lint 是纯离线计算。进程内模型只有
  - `skillNameByDir: Map<string, string>`（两遍扫描构建，供 `related_skills` 解析，
    等价于 `test_authoring_standards.py::_all_names()`）；
  - `LintFinding[]` 结果列表。
- `--json` 输出结构建议：`{ version: 1, roots: string[], skills: [{ path, name, findings: LintFinding[] }], totals: { errors, warnings } }`，供 CI annotations。
- 若 Phase 4 做页内 authoring check：最近一次 lint 结果放 Jotai atom（`web/src/stores/` 现有
  模式），不落 SQLite/IndexedDB，无 schema migration。`packages/protocol` 的 Zod schema 可
  复用来声明 JSON 报告类型（可选，非必须）。

## 5. Third-party library strategy

| Python 依赖/能力 | TS 等价 | kimi-code 证据 |
|---|---|---|
| PyYAML `yaml.safe_load` | `js-yaml`（^4.1.1） | `D:/kimi-code/packages/agent-core/src/skill/parser.ts` line 4 `import { load as loadYaml } from 'js-yaml'`；`packages/agent-core/package.json` line 88 |
| `re`（正则） | 原生 `RegExp` | kimi-code parser.ts 多处正则（fence、mermaid/d2 提取） |
| `pathlib.Path` | `node:path`/`node:fs`（或 `pathe` ^2.0.3） | kimi-code parser.ts/scanner.ts 用 `pathe` |
| dataclass `LintFinding` | TS `interface` | kimi-code types.ts 同类模式 |
| 字符串转义 | `regexp.escape`（^2.0.1） | kimi-code parser.ts line 6 |
| pytest 参数化 | vitest `it.each`/describe | kimi-code `packages/agent-core/test/skill/parser-frontmatter.test.ts` |
| SKILL.md frontmatter 解析 | 移植 kimi-code `parseFrontmatter`（parser.ts line 82-105），再对齐 Core `agent.skill_utils.parse_frontmatter` 的 BOM/CRLF 细节 | parser.ts |
| 解析期硬校验（缺 name/description、非法 YAML、unsupported type） | 直接复用 kimi-code `SkillParseError`/`FrontmatterError`/`UnsupportedSkillTypeError` 语义 | parser.ts line 11-41, 107-145；scanner.ts line 421-434 |
| **约定式 lint 规则（营销词、shell 工具引用、metadata 块、section 顺序、platforms gating、forbidden files、dangling references、name-dir）** | **无 TS 等价 —— 从 skill_linter.py 从零移植**（js-yaml + RegExp + node:fs 足够，无需新第三方库） | kimi-code 无此类实现：`apps/kimi-code/scripts/` grep `skill|lint` 0 命中；`apps/kimi-code/src` 仅 `tui/components/messages/skill-activation.ts` 涉及 SKILL.md/frontmatter（UI 展示，非校验） |
| `scripts/build_skills_index.py`（Hub 爬虫） | **out of scope**：需要 GitHub API 客户端与并发抓取；kimi-code 无 skills hub。若未来要，用原生 `fetch` + 现有 `web/src/lib/transport.ts` 风格，不引入新依赖 | kimi-code 无对应物 |

**结论**：TS 侧只需要一个新增运行时依赖 `js-yaml`（kimi-code 已验证生态），其余全部为
node 内建能力 + 自研规则模块。

## 6. Integration with existing Hermes-CN-Desktop frontend

- `static/bundled-skills/`：当前仅 `.gitkeep`（生成目录）。内容由
  `scripts/stage-bundled-skills.mjs` 从 `../Hermes-CN-Core/skills` 复制并写
  `README.generated.txt`。**lint 应插在 release-desktop.yml 的 "Stage bundled skills" 步骤之后**，
  对 staged 副本执行（源树由 CI checkout `hermes-agent-cn-source` 提供）。
- `package.json`（root）：新增脚本 `"skills:lint": "node scripts/skill-lint.mjs"`，
  与既有 `"skills:stage-bundled"` 相邻；可在 `bundle:stage-*` 链中前置。
- CI：
  - `.github/workflows/web-test.yml`：在 typecheck/vitest 之外新增 lint step
    （双仓 PR 时 `--source ../Hermes-CN-Core`；找不到 Core 时 lint staged fixture 树或 skip）；
  - `.github/workflows/release-desktop.yml`：staging 后、bundling 前执行，ERROR 即 fail，
    防止坏 SKILL.md 进入安装包。
- `web/src/hooks/use-skills.ts`：运行时技能列表（`/api/skills`，WS/REST）——**不改**。
  Phase 4 可选：Skills 页面新增「Authoring check」按钮，用
  `useSkillMarkdown` 拿到单技能内容后直接调 `@hermes/skill-lint` 的
  `lintSkillContent`（纯前端，无 WS 往返）。
- Rust 侧：CI lint 不需要 Tauri command。Phase 4 若想对 `static/bundled-skills` 做原生
  扫描，可加一个轻量 `skills_lint` command（`src/commands/skills/`），复用 `src/state.rs`
  路径解析；本计划不强制。

## 7. Removing the WebSocket dependency (migration path)

- 本 feature 天生离线：lint 在 build-time 对仓库/文件系统执行，零 WS/REST 依赖。
- 周边唯一 WS 依赖是运行时 `/api/skills`（use-skills.ts）。迁移路径分三阶段：
  1. **保留后端**：Core pytest 门禁 + `python -m tools.skill_linter` 继续存在；TS lint 并行
     实现同样规则（奇偶校验保证行为一致），双轨互不阻塞；
  2. **桌面独立**：Desktop CI 完全由 `pnpm skills:lint` 覆盖（PR 门禁 + release staging 门禁），
     `hermes skills lint` 场景由 Node CLI 取代（见 §8 Phase 3）；
  3. **删除 WS 路径后**：in-process 直接扫描 bundled skills（Phase 4 面板/未来本地技能页），
     `/api/skills` 列表消失。
- 迁移期间需冻结的接口契约：
  - 规则 id + severity（`name-format`、`shell-utility-reference` 等，CI 报告/白名单依赖）；
  - CLI 退出码（有 ERROR 退出 1；WARNING-only 退出 0）；
  - `--json` 报告结构（若采用 §4 建议版本，在 Phase 2 定型）。

## 8. Migration phases & task breakdown

| Phase | 任务 | 产出/验收 |
|---|---|---|
| 1 | 建 `packages/skill-lint`：types、frontmatter（移植 kimi-code parseFrontmatter + BOM/CRLF 对齐）、12 条规则、lint/lintTree/hasErrors/formatFindings | vitest 逐规则通过；`lintSkillContent` 对 Python `lint_content` 相同输入输出相同 rule id |
| 2 | `scripts/skill-lint.mjs` CLI：`--source <dirs...>`、`--json`、递归扫 SKILL.md、exit code 契约；root package.json 加 `skills:lint` | `pnpm skills:lint --source ../Hermes-CN-Core/skills ../Hermes-CN-Core/optional-skills` 对当前 Core 树 0 ERROR；`--json` 结构稳定 |
| 3 | CI 接线：web-test.yml 新增 lint step（双仓场景）；release-desktop.yml 在 Stage bundled skills 后 lint staged 副本 | PR 含坏 SKILL.md 时 CI 红；release 流程坏 SKILL.md 时在 bundling 前 fail |
| 4（可选） | Skills 页面「Authoring check」面板（useSkillMarkdown + @hermes/skill-lint 前端调用）；可选 Tauri `skills_lint` command | Playwright E2E：页面点击后展示 findings 数量，无 WS 请求 |

建议顺序 Phase 1 → 2 → 3（CI 门禁是主价值），Phase 4 单独排期。

## 9. Risks & open questions

1. **No TS equivalent found（主风险）**：kimi-code 只有解析期硬校验，没有约定式 lint。
   12 条规则需从 `skill_linter.py` 从零移植；风险是与 Python 行为漂移（正则细节、BOM/CRLF、
   `_strip_code_blocks` 边界、`_POSIX_PRIMITIVES` 字符串匹配）。缓解：奇偶测试
   （§10）+ 规则表集中 + 注释引用 CONTRIBUTING.md 条款。
2. **`static/bundled-skills` 不提交**（仅 .gitkeep）：PR 期无法 lint 已提交技能文件。
   PR 门禁必须双仓 checkout Core（如 web-e2e.yml 已有先例）或 lint staged fixture；
   release 门禁天然 lint staged 副本。需与 CI owner 确认双仓 checkout 成本。
3. **`hermes skills lint` 在 Core 目前不存在**：只有 `python -m tools.skill_linter` 和 pytest。
   命名/入口需拍板——本计划建议桌面侧以 `pnpm skills:lint` 为唯一入口（等价 CLI），
   不在 Core 侧新增子命令；若产品要求 `hermes skills lint`，需 Core 侧另行规划（本计划不阻塞）。
4. **平台正则差异**：Python `MACHINE_LOCAL` 正则（`/home/<user>/`、`C:\Users\<user>\`）与
   TS 反斜杠转义不同，需单测覆盖 Windows 路径。
5. **GRANDFATHER 语义**：Python 侧当前为空、只缩不增。TS 移植不应默认引入白名单，
   避免双仓两套豁免清单漂移；如需豁免必须通过 CI 断言反向校验（对应
   `test_grandfather_entries_still_needed`）。
6. **`build_skills_index.py` 勿误读**：它是 Hub 爬虫不是 lint；TS 计划不移植，避免范围膨胀。
7. **两遍扫描成本**：`related_skills` 校验需要先收集全树 name；`lintTree` 对几千个
   SKILL.md 的 IO 需控制（单次 readText 逐文件 + 并行/串行权衡），release CI 上 < 30s 为目标。

## 10. Test strategy

- **vitest 单元（奇偶校验）**：逐规则 fixture，输入复制 Python
  `tests/tools/test_skill_linter.py` 的样例，断言相同 rule id/severity/message 关键字段；
  覆盖 `lintSkillContent`（无磁盘）与 `lintSkillFile`（有磁盘）两种模式。
- **集成（对齐 pytest 门禁）**：CI（或本地双仓）对 Core `skills/**` + `optional-skills/**`
  跑 `pnpm skills:lint`，断言 0 ERROR —— 镜像
  `tests/skills/test_authoring_standards.py` 的 `test_required_frontmatter_fields`、
  `test_name_matches_directory`、`test_description_hardline`、`test_related_skills_resolve`、
  `test_no_machine_local_paths`、`test_size_limit` 全部硬规则；保留 population sanity
  （至少一个 optional-skills 命中）。
- **CLI 测试**：exit code（0/1/2 usage）、`--json` schema、目录递归与 `SKILL.md` 文件参数、
  非 SKILL.md 输入 skip 行为。
- **kimi-code 侧对照**：`packages/agent-core/test/skill/parser-frontmatter.test.ts` 作为
  frontmatter 解析基线；TS 移植版必须保持其通过语义。
- **Playwright E2E**：Phase 1-3 不需要（无 UI）；Phase 4 面板加一条：打开技能页 → 点
  Authoring check → 显示 findings，且 Network 面板无 `/api/skills` 依赖。

## 11. Reference links

- Core 实现：`D:/hermes-agent-cn/tools/skill_linter.py`、
  `D:/hermes-agent-cn/tools/skill_manager_tool.py`（lint 调用点 line ~989）、
  `D:/hermes-agent-cn/agent/skill_utils.py`（parse_frontmatter / SKILL_PROMPT_DESC_LIMIT）
- Core 门禁测试：`D:/hermes-agent-cn/tests/skills/test_authoring_standards.py`、
  `D:/hermes-agent-cn/tests/tools/test_skill_linter.py`、
  `D:/hermes-agent-cn/tests/test_plugin_skills.py`、
  `D:/hermes-agent-cn/tests/test_session_skill_previews.py`（out of scope 参照）
- Core 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/skills.md`、
  `D:/hermes-agent-cn/CONTRIBUTING.md`（line 568-618 HARDLINE）
- kimi-code TS 参照：`D:/kimi-code/packages/agent-core/src/skill/{parser,scanner,registry,types,index}.ts`、
  `D:/kimi-code/packages/agent-core/test/skill/parser-frontmatter.test.ts`、
  `D:/kimi-code/apps/kimi-code/scripts/`（无 skill lint，确认不存在）
- Desktop 现状：`D:/Hermes-CN-Desktop/static/bundled-skills/`（仅 .gitkeep）、
  `D:/Hermes-CN-Desktop/scripts/stage-bundled-skills.mjs`、
  `D:/Hermes-CN-Desktop/web/src/hooks/use-skills.ts`、
  `D:/Hermes-CN-Desktop/package.json`（skills:stage-bundled）、
  `D:/Hermes-CN-Desktop/.github/workflows/{web-test,release-desktop}.yml`
