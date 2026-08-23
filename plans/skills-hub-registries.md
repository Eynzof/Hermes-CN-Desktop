# Skills Hub / Registries — Python → TypeScript Rewrite Plan

## 1. Summary

Skills Hub 是 Hermes 的技能注册表层：浏览/搜索多个在线注册表（GitHub taps、skills.sh、well-known endpoints、ClawHub、LobeHub、browse.sh）、官方 optional-skills 目录（`hermes skills install official/<category>/<skill>`）、以及集中式 `hermes-index.json` 索引；安装时经过 quarantine → 安全扫描 → 确认 → 写入 `~/.hermes/skills/`，并用 `skills/.hub/lock.json` 记录 provenance（来源、标识符、信任级别、内容哈希、安装路径、扫描结果），支持 check/update/audit/uninstall。

本计划把该能力从 Python（`D:/hermes-agent-cn`）迁移为 Desktop 进程内 TypeScript 模块：在 `web/src/lib/skills-hub/` 下实现与 Python 同构的 `SkillSource` 适配器集合 + `HubLockFile` 状态存储 + 安装流水线，复用现有 Skills 页面（`routes/skills.tsx` 的 market tab 从「外链列表」升级为真正的「浏览/搜索/安装/更新」UI），并保留 `lock.json` 的磁盘格式兼容，使未来完全去掉 Python runtime / WebSocket 后数据可无缝迁移。CLI 语义（`hermes skills install official/...` 等）映射为 UI 动作，slash 调用沿用现有 `/skill <name>` composer。

范围外（记入本计划以便决策留痕）：`tools/skills_sync_client.py` 的跨设备 Skill Sync plane（推/拉用户自建技能）是独立特性；`tools/skills_guard.py` 安全扫描器是另一独立特性，本计划只定义其调用接口；`publish`（向 GitHub 提 PR / ClawHub 提交）、`snapshot export/import`、`tap add/remove`、`opt-out/opt-in` 属于 CLI/运维面，desktop standalone v1 不实现，仅保留数据模型兼容。

## 2. Current Python implementation

- 核心库 `D:/hermes-agent-cn/tools/skills_hub.py`（~4625 行）：
  - 数据模型：`SkillMeta`（name/description/source/identifier/trust_level/repo/path/tags/extra）、`SkillBundle`（name + files: rel_path→str|bytes + source/identifier/trust_level/metadata）。
  - `SkillSource` ABC（`search` / `fetch` / `inspect` / `source_id` / `trust_level_for`），适配器：
    - `OptionalSkillSource` — 读取仓库 `optional-skills/` 本地目录（`official/<category>/<skill>`，trust=builtin），缺失时回退 GitHub live repo（`NousResearch/hermes-agent` tree）。
    - `HermesIndexSource` — `https://hermes-agent.nousresearch.com/docs/api/skills-index.json`（6h TTL 磁盘缓存），搜索零 API 调用；可用时 `parallel_search_sources` 跳过外部 API 源。
    - `GitHubSource` — Contents API + Git Trees API（带 403/429 rate-limit 重试回退），`GITHUB_TAP_PROVIDERS` 标记 NVIDIA/OpenAI/Anthropic/HuggingFace 等 provider；`TRUSTED_REPOS` → trusted。
    - `WellKnownSkillSource` / `UrlSource` / `SkillsShSource`（skills.sh 搜索 API + sitemap 爬取 + 详情页正则）/ `ClawHubSource`（ZIP 下载，community trust，ClawHavoc 事件后强制 community）/ `LobeHubSource` / `BrowseShSource`。
  - 聚合：`create_source_router()`、`parallel_search_sources()`（DaemonThreadPoolExecutor、30s overall timeout、慢源跳过）、`unified_search()`（按 identifier 去重、trust 优先排序、provider 过滤）。
  - 状态：`HubLockFile`（`skills/.hub/lock.json`，`{version:1, installed:{name:{source,identifier,trust_level,scan_verdict,content_hash,install_path,files,metadata,scan_provenance,installed_at,updated_at}}}`）、`TapsManager`（`taps.json`）、quarantine/audit.log/index-cache 目录、`ensure_hub_dirs()`。
  - 安装流水线：`quarantine_bundle` → `tools/skills_guard.scan_skill_cached` → `should_allow_install` → 用户确认 → `install_from_quarantine`（路径/symlink/嵌套校验，写入 lock + audit + `skill_usage.record_installed`）→ 蓝图建议检测 → `prompt_builder.clear_skills_system_prompt_cache`。
  - 更新：`check_for_skill_updates`（按 lock 记录的 source 固定解析，禁止跨注册表 fallback）+ `bundle_content_hash`（sha256 前 16 hex，POSIX 分隔符排序）。
- CLI `D:/hermes-agent-cn/hermes_cli/skills_hub.py`：`do_search/do_browse/do_install/do_inspect/do_list/do_check/do_update/do_audit/do_uninstall/do_reset/do_opt_out|in/do_repair_official/do_publish/do_snapshot_export|import/do_tap`；`skills_command()` argparse 路由 + `/skills` slash 入口；`browse_skills()` / `inspect_skill()` 是给 TUI/gateway 的程序化入口。
- 目录同步 `D:/hermes-agent-cn/tools/skills_sync.py`：bundled skills 的 `.bundled_manifest`（v2 `name:hash`）增量同步（跳过用户修改、尊重删除/opt-out marker）、`optional_skill_index()`/`restore_official_optional_skill()`、`.no-bundled-skills` marker。
- 跨设备同步 `D:/hermes-agent-cn/tools/skills_sync_client.py`：blob/tree/commit 对象 + `/v1/sync/` plane（`refs/user/<owner>/HEAD`、CAS、409 三路合并、`sync-manifest` 对象、`.sync_state`）。**与注册表安装无直接依赖**，仅约束「hub-installed skills 不参与 sync 资格判定」（`is_sync_eligible`）。
- 文档：`website/docs/user-guide/features/skills.md`（Skills Hub 章节）、`website/docs/reference/optional-skills-catalog.md`（`install official/<category>/<skill>` 目录）。
- 测试：`tests/hermes_cli/test_skills_hub.py`（list 分类、跨注册表更新 hijack 回归、`--json` 输出）、`tests/tools/test_skills_hub*.py`（适配器/安装）、`tests/website/test_extract_skills.py`（source_url/分类逻辑）、`tests/website/test_generate_skill_docs.py`（目录页生成）。

## 3. Target TypeScript design

模块布局（全部在 `web/src/lib/skills-hub/` 下，运行时在 Tauri webview 进程内）：

```
web/src/lib/skills-hub/
  types.ts          # SkillMeta/SkillBundle/SkillSource/SourceRouterResult（Zod，与 protocol 对齐）
  frontmatter.ts    # SKILL.md YAML frontmatter 解析（js-yaml；与 kimi-code frontmatter.ts 同思路）
  source.ts         # SkillSource 接口 + createSourceRouter() + parallelSearchSources() + unifiedSearch()
  sources/
    official.ts     # 只读 optional-skills 目录扫描（builtin trust）+ live-repo 回退
    hermes-index.ts # hermes-index.json 下载+6h 缓存；is_available 控制外部源跳过
    github.ts       # GitHub→codeload zip 解析（树/分支/tag/commit），provider 标签，TRUSTED_REPOS
    well-known.ts   # /.well-known/skills/index.json
    url.ts          # 直接 SKILL.md URL + allowlisted 支持文件
    skills-sh.ts    # skills.sh API + sitemap（v1 先只做搜索 API，sitemap 延后）
    clawhub.ts      # ZIP 下载（Rust zip 解包，v1 可延后）
  store.ts          # HubLockFile/TapsManager/audit 端口：读写 HERMES_HOME/skills/.hub/*
  install.ts        # install/uninstall/update/check 流水线（quarantine→scan 接口→确认→落盘）
  scan-interface.ts # SkillScanner 接口（由 skills_guard 独立迁移实现）
  paths.ts          # HERMES_HOME/skills 路径解析（经 Rust/Tauri IPC 或 runtime.ts）
```

核心接口（伪代码，非实现）：

```ts
interface SkillSource {
  sourceId(): string;
  search(query: string, limit: number): Promise<SkillMeta[]>;
  inspect(identifier: string): Promise<SkillMeta | null>;
  fetch(identifier: string): Promise<SkillBundle | null>;
  trustLevelFor(identifier: string): TrustLevel; // 'builtin'|'trusted'|'community'
}
interface SkillsHubService {
  search(q, opts): Promise<{results, source_counts, timed_out}>;   // = Python unified_search
  inspect(id): Promise<SkillMeta | null>;
  install(identifier, opts: {category?, force?, skipConfirm?}): Promise<InstallResult>;
  uninstall(name): Promise<{ok, message}>;
  list(): Promise<InstalledSkill[]>;                                // 合并 lock + builtin + local
  check(name?): Promise<UpdateStatus[]>;
  update(name?): Promise<UpdateResult[]>;
}
```

数据流（进程内）：React Skills Hub tab → `useSkillsHubSearch()`（v2 改为直接调 `skillsHubService`，不再走 `/api/skills/hub/search` REST）→ `unifiedSearch()` 并行查各 source（`Promise.allSettled` + 30s timeout，模拟 Python 的慢源跳过）→ 结果表/详情面板 → `install()`：`fetch` → quarantine 临时目录（`HERMES_HOME/skills/.hub/quarantine/`）→ `SkillScanner.scan()`（接口由 skills_guard 迁移提供）→ 非 official 显示确认对话框（对齐 Python `should_allow_install` + 用户确认）→ `installFromQuarantine()` 写入 `HERMES_HOME/skills/<category>/<name>/` 并更新 `lock.json` + `audit.log` → 通知 `useSkills` 刷新（技能出现在 `/skill <name>` palette）。

官方 optional-skills 目录随安装包以只读资源分发：新增 `static/optional-skills/`（镜像 Core `optional-skills/` 结构，仅含 `SKILL.md` 目录），Rust 侧扩展 `src/process/runtime.rs::sync_runtime_resources_from_resource` 把它 staging 到 runtime 资源区；`official.ts` 扫描该目录（不拷贝到 `HERMES_HOME/skills`，除非用户安装）——语义等同 Python `OptionalSkillSource`（非默认激活、browse 时 official 置顶、trust=builtin）。

`hermes skills install official/...` 的 desktop 等价物是 Hub tab 里的「安装」按钮（identifier 就是 `official/<category>/<skill>`）；过渡期仍可经 managed runtime 调 `hermes skills`（见 §7 阶段 1）。

## 4. Data models & persistence

- `SkillMeta` / `SkillBundle`：TypeScript 接口，字段与 Python dataclass 一一对应（`files: Record<string, string | Uint8Array>`，键一律 POSIX 分隔符）。
- `HubLockFile`（`HERMES_HOME/skills/.hub/lock.json`）：**保持与 Python 完全相同的 JSON shape**（`{version:1, installed:{...}}`），这样同一磁盘上 TS/Python/Rust 可互读，未来删除 Python 后无需迁移。写盘用原子替换（temp + rename，对齐 Python `atomic_replace`）。
- `audit.log`：行式追加 `ACTION name source trust_level verdict hash`；`taps.json`：`{taps:[{repo,path}]}`；`index-cache/*.json`：1h TTL（hermes-index 6h），缓存文件写 `.ignore`（防 ripgrep 扫进 prompt）。
- 安装技能本体：`HERMES_HOME/skills/<category>/<name>/`（category 可为空=flat），与 Python `install_from_quarantine` 相同的路径校验规则（拒绝 `..`/绝对路径/冒号/NTFS ADS/symlink/junction/嵌套进已有 skill 目录/覆盖 category bucket）。
- `.bundled_manifest`（v2 `name:hash`）：随 bundled-sync 端口（本计划只定义格式兼容，内容由 skills_sync 特性或 Rust staging 负责写入）。
- 可选持久化策略：desktop 不需要 IndexedDB——文件即真相（Python 也是如此）；仅内存缓存 index/搜索结果（`new Map` + TTL），与 Python `_index_cache_dir` 语义一致。

## 5. Third-party library strategy

| Python 依赖 | TS 等价 | kimi-code 证据 |
|---|---|---|
| `httpx`（所有网络） | 原生 `fetch`（WebView/Node） | `packages/agent-core-v2/src/app/plugin/marketplace.ts` `readMarketplaceText` 用 `fetchImpl`；`archive.ts` `downloadZip` 用 `fetch`；`github-resolver.ts` 用 `fetch` + `AbortSignal.timeout` |
| `orjson`/`json` | `JSON.parse` / `JSON.stringify` | `marketplace.ts` 直接 `JSON.parse` |
| `yaml`（frontmatter） | `js-yaml`（npm `js-yaml@^4.1.1`，agent-core-v2 `package.json:74`）；解析封装参考 `packages/agent-core-v2/src/_base/text/frontmatter.ts` | `plugin/commands.ts` import `parseFrontmatter` |
| `zipfile`（ClawHub ZIP） | webview 内用 `fflate`（纯 JS unzip）；或 Rust `zip` crate 经 Tauri IPC。kimi-code 用 Node `yauzl`（`archive.ts:6`）并做 path-traversal 拒绝 | `plugin/archive.ts` `fromBuffer(yauzl)` + `destPath.startsWith(destDirResolved + sep)` 守卫 |
| `hashlib`/`xxhash`（content_hash、索引缓存 key） | `crypto.subtle.digest('SHA-256')` / `@noble/hashes`；**需按 Python `content_hash` 算法自实现**（sha256 前 16 hex、POSIX 路径排序、path+`\0`+content） | 无直接等价 → 自研 + parity 测试 |
| `semver`（skills.sh 版本/更新） | `semver`（npm `semver@^7.7.4`，agent-core-v2 `package.json:81`） | `marketplace.ts` `computeUpdateStatus` 用 `gt/valid`；Python 用 `bundle_content_hash` 比较，TS 可保留 hash 比较为主、semver 为辅 |
| GitHub Contents/Trees API | 走 kimi-code 路线：GitHub URL → `codeload.github.com/{owner}/{repo}/zip/{ref}`（`releases/latest` 重定向解析 tag → `HEAD` 探测），安装时整目录 zip 下载，避免逐文件 Contents API（省 rate limit） | `plugin/source.ts` `resolveInstallSource`（tree/commit/releases-tag 解析）；`github-resolver.ts` `resolveGithubSource`/`codeloadUrl` |
| 集中式索引 | `HermesIndexSource` 直接移植：JSON catalog 下载 + TTL 缓存 | 模型参照 `marketplace.ts` `PluginMarketplaceEntry{id, displayName, source, tier, version, description, homepage, keywords}` |
| `PyJWT`（GitHub App auth） | 过渡期仅支持 PAT（env/settings）；GitHub App 路径用 `jsonwebtoken` 或 Rust 侧实现（可选） | kimi-code 无 GitHub App auth（`github-resolver.ts` 只用公开 URL）；`gh auth token` 子进程 → Rust `Command` 可调 |
| `rich`（CLI 表格/面板） | 不需要库——React 组件（Table/Panel/确认对话框） | kimi-code TUI 用 `@moonshot-ai/pi-tui` 组件（`tui/commands/plugins.ts`），desktop 是 GUI，用现有 shared-ui |
| `concurrent.futures`（并行搜索） | `Promise.allSettled` + 30s `Promise.race` 超时、慢源跳过 | kimi-code 用 `Promise.all`（`marketplace.ts withLatestVersions`） |
| trust 级别（builtin/trusted/community） | 枚举 + UI badge；安装前确认对话框（非 official 必须确认） | `plugin-source-label.ts` `PluginTrustLabel='official'|'curated'|'third-party'`、`isOfficialPluginSource`、`plugins.ts` `confirmInstallTrust`；`tier: 'official'|'curated'` 即 kimi 版信任分层 |

无 TS 等价、需自研/另行迁移的（详见 §9 风险）：`tools/url_safety.py` SSRF 防护与 `website_policy.check_website_access`（kimi-code 对 fetch 无 SSRF 校验）、`tools/skills_guard.py` 扫描器（kimi 只做 tier 信任确认，不做内容扫描）。

## 6. Integration with existing Hermes-CN-Desktop frontend

- 复用：
  - `web/src/hooks/use-skills.ts` — `useSkills`、`useSkillMarkdown`、`useToggleSkill`（安装后刷新技能列表）；`useSkillsHubSearch` 在阶段 1 继续走 REST，阶段 2 切换为进程内 service。
  - `web/src/routes/skills.tsx` — 现有 `builtin/market/stats/user` tabs；`market` tab 目前只是 4 个外链卡片（虾评/SkillHub.cn/Skills.sh/SkillsMP），升级为真实 Hub 浏览/搜索/详情/安装 UI（外链保留为「更多注册表」区）。
  - `web/src/lib/composer-skills.ts` — 已支持 `/skill <name>` 命名空间调用；新安装技能自动进入 palette，无需改动（`useSkills` 刷新即生效）。
  - `web/src/lib/transport.ts` + `web/src/lib/tauri-bridge.ts` — 阶段 1 用 transport，阶段 2 换 tauri-bridge / 进程内模块。
  - `packages/protocol/src/hermes-api.ts` — `SkillInfo`、`SkillHubResult`、`SkillsHubSearchResponse` 已存在；扩展 `InstallSkillResponse`、`UpdateStatusResponse` 等 Zod schema。
  - `static/bundled-skills`（目前仅 `.gitkeep`，Rust `runtime.rs` 已实现 staging）— 新增 `static/optional-skills` 只读目录，扩展 `src/process/runtime.rs::sync_bundled_skills_from_resource` 复制逻辑。
  - `src/process/runtime.rs` — `current_bundled_skills_dir()` / `HERMES_BUNDLED_SKILLS` 环境变量注入模式可复用到 optional-skills 目录。
- 新增：
  - Tauri 命令（或复用现有 fs 命令）：写整个技能目录树到 `HERMES_HOME/skills/`、原子写 lock.json、追加 audit.log、读取 optional-skills 目录清单。Rust 侧保持「OS 能力」定位。
  - 设置页：`GITHUB_TOKEN`（可选）— 对应 Python `GitHubAuth` PAT 路径。
  - 组件：`TrustBadge`（官方/受信任/社区）、`InstallConfirmDialog`（第三方确认文案对齐 Python Panel）、`HubSearchPanel`。
  - `web/src/stores/`：Jotai atom 存 hub 浏览状态（当前 source 过滤、分页、安装进度）。

## 7. Removing the WebSocket dependency (migration path)

- 冻结的 API 表面（迁移期间前后端保持同一接口，进程内实现逐步替换）：
  - `GET /api/skills/hub/search?q=&source=&limit=&profile=`（已存在）
  - 新增并冻结：`POST /api/skills/hub/install`、`POST /api/skills/hub/uninstall`、`GET /api/skills/hub/check`、`POST /api/skills/hub/update`
  - 既有：`GET /api/skills/content?name=`、`PUT /api/skills/toggle`
- 阶段 1（保留后端）：前端全部走现有 transport（managed Python runtime 调 `hermes skills` 或网关 REST）；同时把 `SkillsHubService` 接口设计成与这些端点一一对应。
- 阶段 2（进程内替换）：`useSkillsHubSearch`/新 hooks 改为直接调 `skillsHubService`（webview 内 fetch + Tauri fs），同一接口签名；`HERMES_HOME` 路径由 Rust 解析注入；默认切到进程内（feature flag 可回退）。
- 阶段 3（删除 WS/REST 路径）：删 `/api/skills/hub/*` 后端实现与 transport 分支；只保留 Rust `src/commands/*` 提供 OS 级能力。桌面 standalone 不再需要 `/api/ws` 链接来浏览/安装技能。
- 注意：`/skill <name>` 调用、技能加载/上下文注入属于「技能运行时」特性，不在本计划；本计划只管 hub 的浏览/安装/更新/卸载数据面。

## 8. Migration phases & task breakdown

1. **P0 数据/路径基础**：port `paths.ts` + `frontmatter.ts` + `types.ts`；Rust 侧 optional-skills staging（`static/optional-skills` + `runtime.rs` 扩展）；Zod schema 扩展。验收：vitest frontmatter/path 校验用例过。
2. **P1 状态与安装流水线**：port `store.ts`（HubLockFile/Taps/audit/原子写）、`install.ts`（quarantine→`SkillScanner` 接口桩→确认→落盘→lock 更新）、`scan-interface.ts`。验收：能对本地 fixture 执行 install/uninstall，lock.json 与 Python 输出逐字段一致。
3. **P2 官方源 + 集中式索引**：`official.ts`（本地 optional-skills 扫描 + `official/<category>/<skill>` identifier）、`hermes-index.ts`；`unifiedSearch` 合并排序（official 置顶、trust 排序、identifier 去重）。验收：`useSkillsHubSearch` 进程内实现返回与 REST 相同形状。
4. **P3 外部源**：`github.ts`（codeload zip 路线 + provider 标签 + TRUSTED_REPOS）、`well-known.ts`、`url.ts`、`skills-sh.ts`（先搜索 API）。验收：安装 `github`/`well-known`/直接 URL 技能成功。
5. **P4 UI 集成**：skills.tsx market tab → Hub tab（搜索/详情/安装/更新/卸载/审计），TrustBadge + 确认对话框；hooks 切换进程内 service；设置页 GITHUB_TOKEN。验收：Playwright E2E 走通 `official/...` 安装→`/skill` palette 出现。
6. **P5 清理**：删 `/api/skills/hub/*` REST/WS 路径与 transport 分支；删除 Python CLI 依赖（过渡期保留 `hermes skills` 供 CLI 用户）；回归全量测试。验收：无 `/api/ws` 依赖下 Hub 全功能可用。

## 9. Risks & open questions

- **SSRF/URL 安全无 TS 等价（高）**：Python `tools/url_safety.py`（私网 IP 拦截、redirect 目标校验）与 `website_policy.check_website_access` 在 kimi-code 无对应实现（其 fetch 不校验）。TS 必须自研：URL scheme/host allowlist + DNS 解析到私网 IP 时拦截（经 Rust 侧 DNS 解析命令），否则直接 URL 安装源可被滥用。
- **安全扫描器依赖（高）**：安装前置的 `skills_guard` 扫描（危险模式启发式、AST audit）没有 TS 等价物，且是安装的强制 gate。若扫描器迁移滞后，hub 安装必须保持经 managed runtime 调用或 Rust 侧实现；`SkillScanner` 接口要先行冻结。
- **lock.json 哈希 parity（中）**：Python `content_hash`（`sha256:<16hex>`，POSIX 排序、`path+\0+content`）与 `bundle_content_hash` 必须逐字节一致，否则 Windows 上会出现「永远 update_available」（Python 踩过 #62310）。需用 Python fixture 做 parity 测试。
- **跨设备 Skill Sync 交互（中）**：`skills_sync_client.py` 判定 `is_hub_installed` 排除 hub 技能；本计划写入的 lock.json 必须被未来 sync 特性识别（同格式即可），但 sync 特性本身不在本计划。
- **ClawHub ZIP 在 webview 的提取（低）**：`yauzl` 是 Node API；webview 内需 `fflate` 或走 Rust `zip`。建议 P3 延后 ClawHub。
- **GitHub rate limit（中）**：无 PAT 时匿名 60 req/h；codeload zip 路线能显著减少调用，但 `releases/latest` 重定向仍占配额；UI 需显示 rate-limit 提示（Python `do_install` 已有该提示文案）。
- **中文外链市场（低）**：虾评/SkillHub.cn 无公开 API，仅保留外链，不做抓取。
- **optional-skills 目录体积/更新（中）**：Core `optional-skills/` 持续增长；desktop 安装包需定期同步该目录，并提供「live repo 回退」路径（对齐 Python `_fetch_from_live_repo`），否则新上架技能在旧安装上不可见。

## 10. Test strategy

- **vitest 单元**：
  - `frontmatter.ts`：与 Python `_parse_frontmatter_quick` 对同一批 SKILL.md fixture 输出一致（含 BOM、无 frontmatter、非法 YAML）。
  - `store.ts`：lock.json 往返、`record_install/record_uninstall`、原子写、`.ignore` 写入；**hash parity**：用 Python 生成的 `content_hash` fixture 断言一致（Windows POSIX 分隔符用例）。
  - `install.ts`：路径校验矩阵（`../`、绝对路径、冒号 ADS、symlink、嵌套进已有 skill、覆盖 category bucket）——直接翻译 Python 测试 + `tests/hermes_cli/test_skills_hub.py` 的跨注册表更新回归（update 不得改变 source）。
  - `unifiedSearch.ts`：合并去重/trust 排序/慢源跳过/provider 过滤；对照 `browse_skills()` 期望输出。
- **integration**：MSW mock `hermes-index.json`、GitHub codeload、`.well-known`、skills.sh API；临时 `HERMES_HOME` 下跑完整 install/uninstall/check/update 流程。
- **Playwright E2E**：Skills 页 Hub tab 搜索 → inspect 预览 → 安装 `official/...`（确认对话框）→ `useSkills` 刷新 → composer `/skill <name>` 可选 → uninstall。
- **parity 参考**：`tests/hermes_cli/test_skills_hub.py`、`tests/tools/test_skills_hub*.py`、`tests/website/test_extract_skills.py` 作为期望行为清单；`website/docs/reference/optional-skills-catalog.md` 作为官方源 identifier 的 golden 数据源。

## 11. Reference links

- Python 源：`D:/hermes-agent-cn/tools/skills_hub.py`、`hermes_cli/skills_hub.py`、`tools/skills_sync.py`、`tools/skills_sync_client.py`、`tools/skills_guard.py`、`tools/url_safety.py`
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/skills.md`、`website/docs/reference/optional-skills-catalog.md`
- 测试：`D:/hermes-agent-cn/tests/hermes_cli/test_skills_hub.py`、`tests/tools/test_skills_hub*.py`、`tests/website/test_extract_skills.py`、`tests/website/test_generate_skill_docs.py`
- TS 参考（kimi-code）：`D:/kimi-code/packages/agent-core-v2/src/app/plugin/marketplace.ts`、`source.ts`、`github-resolver.ts`、`manager.ts`、`archive.ts`、`commands.ts`、`packages/agent-core-v2/src/_base/text/frontmatter.ts`、`apps/kimi-code/src/tui/commands/plugins.ts`、`apps/kimi-code/src/tui/utils/plugin-source-label.ts`、`packages/agent-core-v2/package.json`（js-yaml/semver）
- Desktop 现状：`D:/Hermes-CN-Desktop/web/src/hooks/use-skills.ts`、`web/src/routes/skills.tsx`、`web/src/lib/composer-skills.ts`、`packages/protocol/src/hermes-api.ts`、`web/src/lib/transport.ts`、`web/src/lib/tauri-bridge.ts`、`src/process/runtime.rs`、`static/bundled-skills/`
