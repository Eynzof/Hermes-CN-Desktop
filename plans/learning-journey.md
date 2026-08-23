# Learning Journey — Python → TypeScript Rewrite Plan

## 1. Summary

`/journey`（别名 `/learning`、`/memory-graph`，CLI 为 `hermes journey`）把 Hermes 学到的内容
渲染成一条时间线：**学到/用过的 profile skills + MEMORY.md / USER.md 记忆块**作为图节点，
skill `related_skills` 声明 + 词法重叠推导出的 memory↔skill 边作为图边，并提供“回放式”时间轴
（radial constellation + timeline scrubber）以及 node 级 edit/delete。

本计划把该功能从 Python 后端（`D:/hermes-agent-cn`）移植进 Desktop TS 前端，最终在进程内
直接扫描 `<hermes_home>/skills`、`<hermes_home>/memories`、`.usage.json` 构建图，去掉对
`GET /api/learning/graph`、`/api/learning/node` 的依赖。

**关键发现（降低风险）**：`kimi-code` 没有 journey/learning/memory-graph 等价功能（已 grep
`packages/` 与 `apps/kimi-code/src`，仅 `dist-web` 里有 mermaid `journeyDiagram-*.js` 静态图
DSL bundle，与本功能无关）。但 **Python 的终端渲染器本身就是从 Core 自带 TS 桌面端
`apps/desktop/src/app/starmap/*` 移植过来的**（`learning_graph_render.py` 头注释明确写明
“ported from the desktop source”），因此本计划直接复用/搬运这份 TS 源码作为图形渲染主参考，
TS 侧并非从零设计；真正需要“从零设计”的只有：in-process 图构建器（`learning_graph.py` 移植）、
mutation 直写（`learning_mutations.py` 移植）、以及 Python 侧不存在的可选 **LLM 摘要条目**。

## 2. Current Python implementation

### 2.1 数据流（三个数据源 → 一张派生图）

1. **技能节点**：扫描 base skills（Core 仓库 `skills/`）与 profile skills
   （`<hermes_home>/skills`）下的所有 `SKILL.md`，读取 frontmatter（`name`、`category`、
   `related_skills`、`metadata.hermes`），合并 `.usage.json` 里的 `use_count/state/created_by/pinned`
   与活动时间戳（`last_activity_at`/`last_used_at`/`last_viewed_at`/`last_patched_at`/`created_at`）。
   **只保留非 base 且 `created_by == "agent"` 或 `use_count > 0` 的“学到”技能**。
2. **记忆节点**：`<hermes_home>/memories/MEMORY.md`（source=`memory`）与 `USER.md`
   （source=`profile`）按 `"\n§\n"` 切块，每块一个 card/node，id 为 `memory:<source>:<index>`，
   timestamp 取 `file_mtime + chunk_idx`（保证块内单调递增）。
3. **边**：skill↔skill 用 `related_skills`（两端都存在才连、去重、无向）；
   memory↔skill 用词法重叠打分（skill 名出现 +6，token 交集计数，每卡最多连 4 个）。

### 2.2 模块与入口（精确路径）

| 模块 | 职责 |
|---|---|
| `agent/learning_graph.py` | 图构建：`SkillNode` dataclass、`build_skill_nodes()`、`build_edges()`、`density_stats()`、`_memory_cards()`、`_memory_skill_edges()`、`build_learning_graph()`（返回 `{nodes, edges, clusters, memory, stats}`） |
| `agent/learning_graph_render.py` | 终端时间线渲染（纯 stdlib）：`compute_recency()`、`category_color_map()`（黄金角配色）、`_build_chart_buckets()`、`render_graph()`、`render_frames()`、`build_summary()`；**是从 Core `apps/desktop/src/app/starmap/*` 移植的**（LEAD_IN、AGE_GRADIENT、recencyInk、palette 全部对应 time-axis.ts/constants.ts/geometry.ts/color.ts） |
| `agent/learning_mutations.py` | node 级 edit/delete：`parse_node_kind()`、`node_detail()`、`delete_node()`（skill=archive，memory=删块）、`edit_node()`；`_write_memory()` 用 `MemoryStore._write_file` 原子写 |
| `agent/learn_prompt.py` | `/learn` 生成 skill 的 prompt（`build_learn_prompt()`）——journey 展示的正是 `/learn` 产出的技能，属同一学习闭环（移植范围外的参考） |
| `hermes_cli/journey.py` | `hermes journey`（show `--play/--fps/--width/--height/--no-color/--json`）+ `list/delete/edit` 子命令 |
| `hermes_cli/web_server.py:4226-4290` | REST：`GET /api/learning/graph`、`GET/DELETE/PUT /api/learning/node`（`_profile_scope` 按 profile 切换 HERMES_HOME） |
| `tui_gateway/methods_tools.py:1668-1722` | Gateway RPC：`learning.frames`、`learning.detail`、`learning.delete`、`learning.edit`（TUI `/journey` overlay 用，Desktop 不消费） |
| `tests/hermes_cli/test_journey_render.py` | CLI 输出契约测试（`--force-color` 出 ANSI；默认捕获无转义） |

### 2.3 文档契约

`website/docs/user-guide/features/memory.md` §“Learning Journey (`/journey`)”（L213-229）：
三端同源（CLI `hermes journey` / TUI `/journey` / Desktop Star Map panel），
`list/delete/edit` 三子命令同源，技能删除=归档（`hermes curator restore` 可恢复），记忆删除=改写文件。

## 3. Target TypeScript design

### 3.1 模块布局（web/src + src/）

```
web/src/routes/journey.tsx                 # 新路由页（SectionShell + SettingsHero 风格，同 memory.tsx）
web/src/hooks/use-journey.ts               # TanStack Query hooks（图、node detail、delete、edit、summary）
web/src/lib/journey/types.ts               # StarmapGraph/StarmapNode/StarmapEdge/…（搬 Core types/hermes.ts:665-704）
web/src/lib/journey/source.ts              # JourneyDataSource 接口 + Rest / InProcess 两个实现
web/src/lib/journey/graph.ts               # buildJourneyGraph() —— learning_graph.py 的 TS 移植
web/src/lib/journey/frontmatter.ts         # parseSkillFrontmatter() 轻量 shim
web/src/lib/journey/mutations.ts           # nodeDetail/deleteNode/editNode —— learning_mutations.py 移植
web/src/lib/journey/summarizer.ts          # （可选新能力）LLM 摘要条目
web/src/components/journey/constants.ts    # 以下 8 个文件 = Core starmap 逐文件搬运（路径一一对应）
web/src/components/journey/color.ts
web/src/components/journey/geometry.ts
web/src/components/journey/time-axis.ts
web/src/components/journey/simulation.ts
web/src/components/journey/text.ts
web/src/components/journey/render.ts
web/src/components/journey/star-map.tsx
web/src/components/journey/timeline.tsx
web/src/components/journey/node-context-menu.tsx
src/commands/journey.rs                    # （Phase 2）Rust fs 命令：读原始源 + 写回 mutations
```

### 3.2 核心接口（伪代码）

```ts
// source.ts —— 冻结的 payload 契约 = Core 的 StarmapGraph（types/hermes.ts:698-704）
interface JourneyDataSource {
  getGraph(profile: string): Promise<StarmapGraph>;          // 后端: GET /api/learning/graph
  getNode(profile: string, id: string): Promise<LearningNodeDetail>;
  deleteNode(profile: string, id: string): Promise<{ ok: boolean; message: string }>;
  editNode(profile: string, id: string, content: string): Promise<{ ok: boolean; message: string }>;
}
// InProcess 实现内部：
buildJourneyGraph({ baseSkillRoot, homeSkillsRoot, memoriesRoot, usageJson }): StarmapGraph
// graph.ts 保持与 learning_graph.py 相同的算法顺序：
// 1. buildSkillNodes() → 过滤 learned（source!=base && (createdBy==='agent' || useCount>0)）
// 2. buildEdges()（related_skills，两端存在、去重）
// 3. memoryCards()（"\n§\n" 切块，timestamp=fileMtime+idx）
// 4. memorySkillEdges()（词法打分，top4）
// 5. stats = densityStats() + { memory_nodes, memory_skill_edges, learned_skills }
```

### 3.3 图形渲染（直接搬运 Core starmap，非重写）

- `simulation.ts`：`d3-force`（`forceSimulation/forceRadial/forceCollide/forceLink/forceManyBody`）
  环形径向布局，recency 决定 ring 距离（`computeRecency`/`recForRatio` 来自 `time-axis.ts`）。
- `star-map.tsx`：Canvas 绘制（skill=circle、memory=diamond，`NODE_SHAPE`），
  age-gradient ink（`recencyInk`）、缩放/平移（`fitViewport`）、playback scrubber。
- `timeline.tsx`：顶部时间轴 scrubber（`buildTimeAxis`、`dateAtReveal`）。
- `node-context-menu.tsx`：右键 edit/delete（edit 打开 content modal；delete 确认后调 deleteNode）。
- 空态文案沿用 Python：`"no learning yet — keep using Hermes and it maps out here"`。

### 3.4 LLM 摘要条目（新能力，设计要点）

Python 没有摘要逻辑（memory card 原样展示）。TS 侧可选提供 `JourneySummarizer`：

```ts
interface JourneySummarizer {
  summarize(nodes: StarmapNode[], opts: { profile: string; force?: boolean }): Promise<JourneySummary>;
}
```

- 输入：graph 的 nodes+memory cards；输出：按时间分桶的“journey digest”条目
  （日期、主题、1-2 句中文/英文摘要、关联 node id）。
- 走进程内 model client（复用 kimi-code `packages/agent-core` 的 model catalog / chat 接口形态，
  见 §5）；离线/无模型时静默降级为纯时间线（不阻塞页面）。
- 结果缓存：IndexedDB（key=`journey:summary:{profile}:{contentHash}`），**绝不写用户记忆文件**。

## 4. Data models & persistence

### 4.1 图数据模型（派生式，不落库为主）

与 Python 一致：图是**每次读取时从磁盘派生**的，不是持久化 graph DB。冻结的契约：

```ts
interface StarmapNode {                       // types/hermes.ts:666-677（原文照搬）
  id: string;                                 // skill name 或 memory:<source>:<index>
  label: string; kind: 'memory' | 'skill';
  memorySource?: 'memory' | 'profile';
  timestamp?: null | number;                  // Unix 秒
  category: string; useCount: number;
  state: string; createdBy: null | string; pinned: boolean;
}
interface StarmapEdge { source: string; target: string; }
interface StarmapGraph {
  nodes: StarmapNode[]; edges: StarmapEdge[];
  clusters: { category: string; count: number }[];
  memory: { source: 'memory'|'profile'; timestamp?: null|number; title: string; body: string }[];
  stats: Record<string, unknown>;
}
```

磁盘源（InProcess 阶段直接读）：

| 源 | 路径 | 用途 |
|---|---|---|
| base skills | 打包 skills 目录（`static/skills` 或 managed runtime 内 skills 目录） | 判定 `source !== 'base'` 排除 |
| profile skills | `<hermes_home>/skills/<category>/<skill>/SKILL.md` | skill 节点 |
| usage 台账 | `<hermes_home>/skills/.usage.json` | useCount/state/createdBy/pinned/timestamp |
| 记忆 | `<hermes_home>/memories/MEMORY.md`、`USER.md` | memory 节点 |

### 4.2 持久化策略

- **主路径：不新增 SQLite/图数据库**。图数据量小（几十节点），派生成本低；
  与 Python 行为对齐（每次打开重扫），避免双写一致性难题。
- **可选缓存**：IndexedDB 存最近一次 `StarmapGraph`（key=`journey:graph:{profile}`，
  schemaVersion=1，存 source mtimes）；mutations 成功后失效；mtimes 变化时失效。
- **Mutation 直写（写穿透到同一批文件，保证与后端/CLI 互操作）**：
  - 记忆 delete/edit：读文件 → `split("\n§\n")` → 删/改 chunk → `join("\n§\n")` 原子写回
    （复用 `memory.rs` 的 `parse_memory_entries/serialize_entries/write_file_safe` 逻辑）。
  - skill delete（归档）：`<home>/skills/<category>/<skill>` → `<home>/skills/.archive/<name>`
    （扁平化；重名加时间戳）；护栏照搬 `skill_usage.py:1071-1116`：pinned 拒绝、
    hub-installed 拒绝、protected built-in（`plan`）拒绝、bundled 需 `curator.prune_builtins`。
  - skill edit：重写该 skill 的 `SKILL.md`（校验规则与 `skill_manage` 对齐，见 §9 风险）。
- **LLM 摘要缓存**：IndexedDB（见 §3.4），不触碰用户文件。

## 5. Third-party library strategy

**先明确结论：`kimi-code` 无等价功能**。已 grep `D:/kimi-code/packages` 与
`apps/kimi-code/src`（pattern `journey|learning|memory-graph|learningGraph|learning_graph`）：
0 命中。唯一“journey”出现在 `apps/kimi-code/dist-web/assets/journeyDiagram-*.js` ——
mermaid 的静态 journey 图 DSL，与本功能无关。因此本功能在 kimi-code 侧**没有可借鉴实现**，
设计依据是 **Core 自带 TS 桌面端 `apps/desktop/src/app/starmap/*`**（Python 渲染器正是它的移植），
以及 kimi-code 的模型客户端（用于 §3.4 摘要）。

| Python 依赖 | TS 等价 | 证据 |
|---|---|---|
| `orjson`（序列化） | 原生 `JSON.parse/stringify`，无需依赖 | `learning_graph.py` 仅用它做 dump/load；kimi-code 无 orjson 特需 |
| `rich`（CLI Group/Text/Live 渲染） | **无需**：Desktop 用 React + Canvas；Python 的 `learning_graph_render.py` 本身就是 Core `apps/desktop/src/app/starmap/*` 的移植，TS 侧直接搬原件 | `learning_graph_render.py:1-13` 注释；Core `star-map.tsx`/`timeline.tsx` 自绘 canvas，无第三方渲染库 |
| `d3-force`（径向布局 sim） | **新增依赖** `d3-force@^3` + `@types/d3-force` 到 `web/package.json` | Core `apps/desktop/src/app/starmap/simulation.ts:1` `import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation } from 'd3-force'`；kimi-code `pnpm-lock.yaml:5415,4321` 已有 `d3-force@3.0.0`/`@types/d3-force@3.0.10`（传递依赖，证明该包在本生态可用） |
| `parse_frontmatter`（agent/skill_utils，含 malformed-YAML 容错） | **从零写轻量 shim** `parseSkillFrontmatter(text)`：正则提取 `name/category/related_skills/metadata.hermes.tags`，容忍 string 化 frontmatter（对齐 Python 回退行为） | kimi-code 无等价；若后续要严格 YAML 可换 `gray-matter`，但本功能只需 4 个字段，不引入 |
| `skill_usage.archive_skill` 归档护栏 | **从零写** TS `archiveSkill()`：读 `.usage.json` + `.bundled_manifest` + `.hub/lock.json` 判定可归档性，`fs.rename` 到 `.archive/` | kimi-code 无等价；parity 参照 `tools/skill_usage.py:1071-1116` |
| LLM 摘要（Python 无） | **从零设计** `JourneySummarizer`，复用 in-process model client 接口形态 | kimi-code `packages/agent-core`（`src/services/modelCatalog/`、`src/loop`）证明 chat/model client 存在；摘要器本身无等价物 |
| mermaid journey diagram | **明确不使用** | Desktop `web/package.json:23` 已有 `@streamdown/mermaid`，kimi-code dist-web 也只有 mermaid journey bundle；静态 DSL 图无径向时间轴、无交互/edit-delete，不符合本功能 |

## 6. Integration with existing Hermes-CN-Desktop frontend

复用/改造点：

- **路由**：新增 `web/src/routes/journey.tsx`，按 `web/src/app.tsx:31-48` 的 lazy route + `SectionShell`
  模式注册（新增一个 `JourneyRoute` lazy import + `<Route path="journey">`），并在导航/设置页加入口
  （记忆页旁边，“学习旅程 / Memory Graph”）。
- **数据 hooks**：仿 `web/src/hooks/use-memory.ts`（TanStack Query + `raceAbort` + `useActiveProfileName`）
  写 `use-journey.ts`：`useJourneyGraph()`（queryKey `["journey","graph",profile]`）、
  `useJourneyNodeDetail(id)`、`useDeleteJourneyNode()`、`useEditJourneyNode()`；
  mutations `onSuccess` 里 `invalidateQueries({ queryKey: ["journey"] })` + 失效 IndexedDB 缓存。
- **传输层**：Phase 1 走 `web/src/lib/transport.ts` 的 `fetchJSON/putJSON`（DELETE 用 fetchJSON+method，
  同 `use-skills.ts` 的 `scopedPath` 加 `?profile=`）；auth 注入由 transport 保证（AGENTS.md 铁律）。
- **Rust 命令**：`src/commands/journey.rs`（Phase 2）仿 `src/commands/memory.rs`：
  `active_hermes_home` 判定（remote 模式拒绝写操作）、`spawn_blocking` fs IO、
  `write_file_safe` 原子写；memory 文件的 parse/serialize 可直接复用 `memory.rs` 私有函数（提取成共享 helper）。
- **技能编辑复用**：skill edit modal 参考 `web/src/routes/skills.tsx` 的 `useSkillMarkdown` +
  MarkdownText 编辑体验；`web/src/hooks/use-skills.ts` 提供 REST 技能 API（Phase 1 用）。
- **状态管理**：图数据属于“服务端状态”→ TanStack Query；scrubber reveal / 播放进度属“本地实时态”→
  Jotai atom（对齐 `apps/desktop/src/store/starmap.ts` 的 `$starmapGraph/$starmapLoading/$starmapError` 拆分）。
- **样式**：CSS Modules + `packages/shared-ui/src/tokens/*.css` 变量，禁止硬编码颜色
  （Core starmap 的 `color.ts:computePalette` 已从 `--theme-primary`/`--background` 取色，正好适配）。

## 7. Removing the WebSocket dependency (migration path)

**本功能当前就不依赖 WS**：Desktop 未来要拿掉的 `/api/ws` 只承载会话/网关事件流；journey 走
REST（`/api/learning/*`）与 gateway RPC（`learning.*`，仅 TUI 用）。因此本节是
“去掉 REST 调用”而非“去掉 WS”。

冻结的 API 契约（迁移期不可变）：

1. `GET /api/learning/graph` → `StarmapGraph`（§4.1 的形状，含 stats 字段名不变）。
2. `GET /api/learning/node?id=` → `{ ok, kind, id, label, content }`。
3. `DELETE /api/learning/node`（body `{id, profile}`）→ `{ ok, message }`；skills 归档语义不变。
4. `PUT /api/learning/node`（body `{id, content, profile}`）→ `{ ok, message }`。

阶段：

- **P1（保留后端调用）**：`JourneyDataSource.RestJourneySource` 直接打上面 4 个端点，
  与今天的行为完全一致；Desktop 立即获得可用的 journey 页面。
- **P2（进程内模块，同一接口）**：Rust 命令读原始源 → TS `buildJourneyGraph()` + `mutations.ts`
  实现 `InProcessJourneySource`；hook 层经 feature flag 切换，payload 仍是冻结契约。
- **P3（删除 REST 路径）**：默认 `InProcessJourneySource`；删除 `RestJourneySource` 与
  `/api/learning` 客户端代码；Core 侧该端点保留给官方桌面端/TUI，不强制删除。

## 8. Migration phases & task breakdown

- **Phase 0 — 契约与数据层（REST 驱动）**
  - [ ] `web/src/lib/journey/types.ts`：搬运 `types/hermes.ts:665-704` 的类型。
  - [ ] `web/src/hooks/use-journey.ts`：4 个 TanStack Query hooks 走 `/api/learning/*`。
  - [ ] `web/src/routes/journey.tsx`：基础时间线列表页（先用 `recharts` BarChart 顶替，
        empty state 文案与 Python 一致）+ 路由注册 + 导航入口。
- **Phase 1 — 图形渲染（搬 Core starmap）**
  - [ ] 搬运 `constants/color/geometry/time-axis/text/render/simulation` 到 `components/journey/`，
        改为从 `web/src/lib/journey/types.ts` import 类型（去掉 `@/types/hermes` 依赖）。
  - [ ] 搬运 `star-map.tsx`、`timeline.tsx`、`node-context-menu.tsx`（Canvas + d3-force +
        edit/delete dialog），接入 `use-journey.ts` mutations。
  - [ ] 加 `d3-force`、`@types/d3-force` 到 `web/package.json`。
- **Phase 2 — in-process 图构建与直写**
  - [ ] `web/src/lib/journey/frontmatter.ts`、`graph.ts`（learning_graph.py 全量移植，
        含 `file_mtime + chunk_idx` 时间戳、词法重叠打分、density stats）。
  - [ ] `web/src/lib/journey/mutations.ts`（memory 写回 + skill 归档护栏）。
  - [ ] `src/commands/journey.rs`：`read_journey_sources`、`read_journey_usage`、
        `write_memory_file`、`archive_skill`、`write_skill_file`；`main.rs` 注册。
  - [ ] `source.ts` 双实现 + feature flag（`ui_store` 或构建期 flag）切换 InProcess。
- **Phase 3 — LLM 摘要 + 收尾**
  - [ ] `summarizer.ts` + IndexedDB 缓存 + 页面摘要区（模型不可用则隐藏）。
  - [ ] 删除 `RestJourneySource`；类型/接口清理。
  - [ ] parity 测试套件 + E2E 落盘（§10）。

## 9. Risks & open questions

1. **kimi-code 无等价实现（已确认）**：TS 侧没有现成 journey/memory-graph 可抄；
   缓解：Core `apps/desktop/src/app/starmap/*` 就是 TS 原作，Python 侧只是移植品，
   照搬原作比照搬 Python 更贴近目标，风险集中在“搬运目录间依赖”（`@/types/hermes`、
   `@/store/notifications`、`@/i18n` 等需替换为 Desktop 等价物）。
2. **LLM 摘要条目是全新能力**（Python 没有）：离线/无模型时不可用；摘要内容可能与记忆原文有出入；
   缓解：摘要严格只读展示、IndexedDB 缓存、可一键隐藏；后续可让用户选择是否持久化到 MEMORY.md（本轮不做）。
3. **base skill 判定**：Python 用“Core 仓库 `skills/`”判定 `source==='base'`；
   Desktop 需解析打包 skills 目录（`static/skills` 或 managed runtime 内 skills），
   不同构建形态路径可能漂移 → 归档护栏（`curator.prune_builtins`、`.bundled_manifest`）依赖它。
4. **frontmatter 解析 parity**：`parse_frontmatter` 有 malformed-YAML 回退；TS 轻量 shim 需
   覆盖 string 化 `related_skills`（`"[a, b]"` / `"a, b"`）与 `metadata.hermes` 两种形态，否则
   边数与 Python 不一致。
5. **memory node id 稳定性**：删除/编辑记忆后 `memory:<source>:<index>` 会平移，旧 id 变 stale
   （Python 返回“node id is stale — refresh the graph”）；TS 必须同样在 mutation 后强制 refetch，
   且 edit prefill 打开期间若发生并发删除要防错写（Core `node-context-menu.tsx` 有 `editEpoch` 模式可照抄）。
6. **skill edit 校验 parity**：`_edit_skill` 走 `skill_manager_tool`；TS 直写 SKILL.md 时若跳过
   description ≤60 字符等校验，会与 `skill_manage` 产出不一致 → open question：本轮是否只做“原样写回”，
   校验留给后续 skills 管理重构。
7. **profile 作用域**：`_profile_scope` 在 Python 侧切换 HERMES_HOME；Rust 侧需沿用
   `memory.rs` 的 `active_hermes_home` + remote 模式只读策略（journey 的写操作在 remote 下应禁用）。
8. **时间戳 parity**：`file_mtime + chunk_idx` 是人为单调化手段，TS 必须原样实现，否则 bucket 顺序/recency 不同。

## 10. Test strategy

- **Vitest 单元（web workspace）**
  - `graph.test.ts`：给定 fixture hermes_home（含 SKILL.md frontmatter 变体、.usage.json、
    MEMORY.md/USER.md），断言 nodes/edges/stats 与 Python 黄金 JSON 相等（parity）。
  - `time-axis.test.ts` / `color.test.ts` / `geometry.test.ts`：`computeRecency`（timed/undated）、
    `category_color_map` 黄金角配色、`recencyInk`、`radiusForRecency` —— 直接移植 Core 已有测试思路
    （`share-code.test.ts` 同级可参考）。
  - `mutations.test.ts`：memory delete/edit 后文件内容（§-join 不变式）、skill 归档护栏
    （pinned/hub/protected/未启用 prune_builtins 时拒绝）。
  - `summarizer.test.ts`：mock model client，断言摘要缓存 key、降级路径。
- **Parity 基准**：在 Core venv 下对同一 fixture home 跑 `build_learning_graph()` 导出 JSON，
  检入 `web/src/lib/journey/__fixtures__/graph.golden.json`；TS 构建器输出与其 deep-equal
  （`expect(...).toEqual`）。
- **Rust 单元（src/commands/journey.rs）**：`tempfile::TempDir` + 私有函数直测（§-解析、归档 rename、
  原子写）；并行环境用 `serial_test`（读写 .usage.json 属 env 依赖）。
- **Playwright E2E（e2e/）**：真实 Core 后端 + fake model：打开 journey 路由 → 图渲染出节点 →
  右键 memory node edit 保存 → 数据回写 → delete skill 后 `.archive/` 存在 → 刷新页面图更新。
- **CLI parity 说明**：`test_journey_render.py` 是 Python CLI 契约（ANSI/plain），Desktop 不移植
  CLI；但空态文案与 `--json` payload 形状作为 E2E 断言复用。

## 11. Reference links

- Python 源码：`D:/hermes-agent-cn/agent/learning_graph.py`、
  `agent/learning_graph_render.py`、`agent/learning_mutations.py`、`agent/learn_prompt.py`、
  `hermes_cli/journey.py`、`hermes_cli/web_server.py:4226-4290`、
  `tui_gateway/methods_tools.py:1668-1722`、`tools/skill_usage.py:662-718,1071-1116`
- Python 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/memory.md`（§Learning Journey, L213-229）
- Python 测试：`D:/hermes-agent-cn/tests/hermes_cli/test_journey_render.py`
- TS 原作（主参考）：`D:/hermes-agent-cn/apps/desktop/src/app/starmap/{types,constants,geometry,color,time-axis,simulation,text,render}.ts`、
  `{star-map,timeline,index,node-context-menu}.tsx`、`apps/desktop/src/store/starmap.ts`、
  `apps/desktop/src/hermes.ts:1043-1082`、`apps/desktop/src/types/hermes.ts:665-704`
- kimi-code（无等价，仅佐证）：`D:/kimi-code/pnpm-lock.yaml`（d3-force@3.0.0/@types）、
  `apps/kimi-code/dist-web/assets/journeyDiagram-*.js`（mermaid，不采用）
- Desktop 集成点：`D:/Hermes-CN-Desktop/web/src/{routes/memory.tsx,app.tsx,hooks/use-memory.ts,hooks/use-skills.ts,lib/transport.ts,lib/runtime.ts}`、
  `src/commands/memory.rs`、`web/package.json`
