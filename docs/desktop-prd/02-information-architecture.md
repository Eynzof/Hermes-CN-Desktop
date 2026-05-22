# Hermes Desktop · v2 · 信息架构

> **文档状态**：v0.1 草稿（2026-05-16）
>
> **关联文档**：[`01-prd.md`](./01-prd.md)（取舍依据）、[`00-feature-inventory.md`](./00-feature-inventory.md)（原型来源）
>
> **目标**：把 PRD § 7「信息架构（简版）」展开成可落地的路由表 / URL 状态契约 / 键位 / 深链接 / overlay 层级。

> **代码对齐**：本文档以仓库现状（`web/src/app.tsx` + `web/src/components/app-shell/use-active-top-tab.ts`）为基线，标注「已实现」「待对齐」「待新增」。

---

## 1. 路由总表（v2 当前 + 待补）

| 路径 | 顶导分组 | 组件 | 原型来源 | URL 参数 | 状态 |
|------|----------|------|----------|----------|------|
| `/` | 01 工作台 | `PanelRoute` | 01-workbench / 01b 空状态 | — | ✅ 已实现 |
| `/new` | 01 工作台 | `NewTaskRoute` | 02 / 02b 新建任务 | — | ✅ 已实现 |
| `/tasks/:taskId` | 01 工作台 | `DetailRoute` | 03–06 任务详情组 | `taskId` | ✅ 已实现 |
| `/history` | 01 工作台 | `HistoryRoute` | 19 会话历史 | — | ✅ 已实现 |
| `/projects` | 02 项目 | `ProjectsRoute` | 07 项目列表 | — | ✅ 已实现 |
| `/projects/:workspacePath` | 02 项目 | `ProjectDetailRoute` | 08 项目详情 | `workspacePath` URL-encoded | ✅ 已实现 |
| `/skills` | 03 能力 | `SkillsRoute` | 09 Skills 表格 | — | ✅ 已实现 |
| `/skills/:skillId/edit` | 03 能力 | （待） | 09b 编辑器 | `skillId` | ⏳ 待新增 |
| `/mcp` | 03 能力 | `McpRoute` | 10 MCP | — | ✅ 已实现 |
| `/profiles` | ⚠️ 当前归 03 能力 | `ProfilesRoute` | 20b Profiles | — | ⚠️ 归属待对齐（见 § 9-A） |
| `/cron` | 04 自动化 | `CronRoute` | 11 Cron 例程 | — | ✅ 已实现 |
| `/logs` | 05 可观测 | `LogsRoute` | 12 日志 | `?level=&source=&q=` 待定 | ✅ 已实现 |
| `/health` | 05 可观测 | `HealthRoute` | 13 健康 | — | ✅ 已实现 |
| `/models` | 06 模型 | `ModelsRoute` | 14 Models | — | ✅ 已实现 |
| `/settings` | （顶栏齿轮） | `SettingsRoute` | 15 / 15b 凭证 | `?section=` 内部切换 | ✅ 已实现 |
| `/debug` | 07 T（内部） | `DebugRoute` | — | — | ✅ 已实现（dev 用） |
| `/dev/primitives` | — | `DevPrimitivesRoute` | — | — | ✅ dev-only（`import.meta.env.DEV`） |
| `*` | — | `<Navigate to="/" />` | — | — | ✅ 已实现 |

**没有的路由**（按设计应保持没有）：

- `/login` — 鉴权失败时由 `bootstrap` 阶段（`main.tsx`）决定走 onboarding 还是 panel，不开独立路由
- `/search`、`/command` — 命令面板是 overlay（见 § 4），不进 URL
- 任务详情 b 变体折叠态 — D5 决策：单一路由内通过右侧面板可隐藏实现

---

## 2. URL 状态契约

哪些状态进 URL、哪些进本地：

### 进 URL 的（可分享 / 可后退）

| 状态 | 落位 | 例 |
|------|------|------|
| 当前页面 / 顶导分组 | path | `/tasks/123` |
| 任务 ID | path 参数 | `/tasks/:taskId` |
| 工作区路径 | path 参数（URL-encoded） | `/projects/%2FUsers%2Fclaw%2Fcode%2Fproj` |
| 设置 section | query 参数 | `/settings?section=models` |
| 日志过滤 | query 参数 | `/logs?level=error&source=gateway&q=keyword` |
| 历史搜索 | query 参数 | `/history?q=keyword` |

### 进 UI SQLite（持久 + 跨窗口）

- `hermes-theme`：主题（dark/light） + 密度（comfortable/compact）
- Jotai 偏好 atom 通过 UI store 同步（`activeProfileId`、`activeWorkspacePath` 等）

### 进 Jotai atom（仅当前 session）

- 当前 SSE 连接状态
- Composer 草稿（路由跳走不丢，但关 app 丢）
- 任务详情右侧面板的当前 Tab（files/artifacts/terminal/logs）
- 任务详情右侧面板的「收起 / 展开」（D5 折叠态实现）

### 进 React Query cache

- 所有服务端只读数据：任务列表、项目元信息、Skills 清单、健康探针、Models 配置

---

## 3. 顶导与侧栏

### 3.1 顶导（`TOP_TABS` 定义在 `use-active-top-tab.ts`）

| 序 | id | 标签 | href | path 匹配规则 |
|----|----|------|------|-----------|
| 01 | workbench | 工作台 | `/` | `/` / `/new` / `/tasks/*` / `/history` |
| 02 | projects | 项目 | `/projects` | `/projects*` |
| 03 | skills | 能力 | `/skills` | `/skills*` / `/mcp*` / `/profiles*` |
| 04 | automation | 自动化 | `/cron` | `/cron*` |
| 05 | observability | 可观测 | `/health` | `/health*` / `/logs*` |
| 06 | models | 模型 | `/models` | `/models*` |
| 07 | debug | T | `/debug` | `/debug*` |

> 顶栏右侧另有：`ProfileSelector`（profile 切换下拉）、搜索框（当前 click → `/history`，⌘K 视觉提示但未绑键）、设置齿轮（→ `/settings`）。

### 3.2 各分组的侧栏内容

| 分组 | 侧栏内容（v2 期望） |
|------|---------------------|
| 工作台 | 项目快捷 + 进行中会话 + 「+ 新任务」 |
| 项目 | 项目快捷 + 视图切换（grid/list）+ 跨项目活动会话 |
| 能力 | Skills / MCP 子页切换；**Cron 不出现**（D3 已砍）；profiles 是否出现见 § 9-A |
| 自动化 | 例程；触发器 / Webhooks 项 disabled + 「v2 不可用」hint（D4） |
| 可观测 | 日志 / 健康 子页切换；**Models 不出现**（D3 已砍） |
| 模型 | 无侧栏，主区直接是供应商列表 |
| 设置 | 内部 `?section=` 切换：偏好 / 凭证 / 模型 / OAuth / 调试 |

---

## 4. Overlay / Modal 层级

不进 URL、用 Jotai 状态控制的全局浮层，按 z-index 从下到上：

| 层 | 名称 | 触发 | 状态 |
|---|------|------|------|
| L1 | `ProfileSwitchOverlay` | profile 切换中 | ✅ 已实现 |
| L2 | 命令面板（⌘K） | ⌘K 键 | ⏳ 待新增（17-search-modal） |
| L2 | 工作区选择器 modal | composer / 任务详情 | ✅ 已实现 |
| L2 | 设置内的次级 modal（凭证编辑等） | 用户点击 | ⏳ 部分 |
| L3 | 审批卡 inline | 任务详情中工具调用需审批 | ⏳ 待新增（属于任务详情 inline，不算 modal） |
| L4 | 错误 toast | 异常 | ⏳ 待新增 |
| L5 | 关键确认对话框（破坏性操作） | 删除等 | ⏳ 待新增 |

**原则**：

- 任何能从 URL 分享 / 后退还原的视图都用路由
- 临时状态（命令面板、工作区选择器）用 overlay
- 命令面板**不进 URL**：跨页面唤起、Esc 关闭，进 URL 会污染 history

---

## 5. 键位绑定（桌面端）

### 5.1 已实现

| 键位 | 行为 | 来源 |
|------|------|------|
| ⌘ / Ctrl + ↵ | Composer 发送任务 | `composer.tsx:37` |

### 5.2 v2 计划新增

| 键位 | 行为 | 优先级 |
|------|------|------|
| ⌘ / Ctrl + K | 唤起命令面板（overlay L2） | 高 |
| Esc | 关闭命令面板 / 关闭工作区选择器 / 关闭任何 modal | 高 |
| ⌘ / Ctrl + 1..6 | 切到顶导第 N 项（同顶栏顺序） | 中 |
| ⌘ / Ctrl + , | 打开设置 | 中 |
| ⌘ / Ctrl + N | 在工作台时跳 `/new` | 中 |
| ⌘ / Ctrl + L | 在 `/logs` 内聚焦搜索框 | 低 |
| ⌘ / Ctrl + B | 切「右侧面板收起 / 展开」（任务详情） | 中 |
| ⌘ / Ctrl + W | 关闭当前窗口（OS 默认） | OS 默认即可 |

### 5.3 平台差异

- macOS 用 `⌘`，Windows / Linux 用 `Ctrl`
- 实现层用 `e.metaKey || e.ctrlKey`（已有先例：`composer.tsx`）
- 全局快捷键（OS 级，app 在后台也能呼出）**v2 不做**（Tauri 支持 `global-shortcut` plugin，但增加权限暴露面，推后）

---

## 6. 深链接 namespace（`hermes://`，v2 不实现但保留）

虽然 D8 决定 v2 不做 URL scheme，但 IA 阶段应**预留命名**，避免以后改路由。预计的映射规则：

| 深链 | 内部路由 | 用途 |
|------|----------|------|
| `hermes://` | `/` | 启动 app 到工作台 |
| `hermes://task/<taskId>` | `/tasks/:taskId` | Web Dashboard / IM 消息中点链接拉起 app + 跳到任务 |
| `hermes://session/<sessionId>` | `/tasks/:taskId`（session = task 同义） | 同上 |
| `hermes://workspace/<urlencoded-path>` | `/projects/:workspacePath` | 点击跳到项目详情 |
| `hermes://settings` 或 `hermes://settings/<section>` | `/settings?section=<section>` | 系统通知或外部 link 点击跳设置 |
| `hermes://new?q=<urlencoded-prompt>` | `/new` + 预填 Composer | 浏览器扩展或 IM "发到 Hermes" 入口 |
| `hermes://login?gateway=<url>&token=<...>` | onboarding 流程 | 一键导入连接配置 |

> 写代码时应该用一个 `mapDeepLinkToRoute()` 函数承担映射，未来开 v3 直接接通。

---

## 7. 桌面原生导航整合（D8）

桌面端比 Web 多的几个"入口"，都需要映射到上面的路由 / overlay：

### 7.1 系统托盘菜单（v2 新增）

```
Hermes Desktop ▾
  打开主窗口          → 唤起窗口到 /
  当前任务（X 个进行中） → 子菜单列任务，点击 → /tasks/:id
  新建任务            → /new
  ─────────
  打开命令面板        → ⌘K overlay
  打开设置            → /settings
  ─────────
  退出
```

### 7.2 原生菜单栏（v2 新增）

| 菜单 | 项 | 行为 |
|------|----|------|
| File | 新建任务（⌘N） | navigate `/new` |
| File | 切换 Profile（⌘ ⇧ P） | 打开 ProfileSelector |
| File | 退出（⌘Q） | OS 默认 |
| Edit | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 | OS 默认 |
| Edit | 查找（⌘F） | 当前页有搜索框时聚焦它，否则置灰 |
| View | 切「右侧面板收起 / 展开」（⌘B） | 状态切换（任务详情下生效） |
| View | 切深 / 浅色 | 改 UI SQLite 中的 `hermes-theme` |
| Window | 最小化（⌘M）/ 缩放 | OS 默认 |
| Window | 当前打开的任务（动态） | navigate `/tasks/:id` |
| Help | 仓库链接 / 反馈 / 关于 | 外部浏览器打开 |

### 7.3 本地通知点击行为（v2 新增）

| 通知类型 | 点击行为 |
|----------|----------|
| 任务完成 | 唤起 app + 跳到 `/tasks/<id>` 的「产物」Tab |
| 任务失败 | 唤起 app + 跳到 `/tasks/<id>` 的「日志」Tab |
| 需审批 | 唤起 app + 跳到 `/tasks/<id>` + 高亮审批卡 |
| 健康降级 | 唤起 app + 跳到 `/health` |

### 7.4 拖拽附件落点（v2 新增）

- 接收 OS 级 `drop` 事件（Tauri `event::FileDrop`）
- 当前路由 = `/` 或 `/new` 时：注入 Composer 附件列表
- 当前路由 = `/tasks/:id` 且 Composer 在侧栏可见时：注入侧栏 Composer
- 其它路由：忽略 + 可视提示「拖到工作台或新任务页才能附加文件」

---

## 8. 信息架构图（简）

```
┌─────────────────────────────────────────────────────────────────┐
│ TopBar: [H Hermes /v2] [01 工作台 02 项目 03 能力 04 自动化      │
│          05 可观测 06 模型] [搜索⌘K] [👤 Profile] [⚙ 设置]      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ┌──────────┐ ┌──────────────────────────────────────────────┐   │
│ │          │ │                                              │   │
│ │ 侧栏     │ │ 主区（路由 Outlet）                          │   │
│ │ (随顶导  │ │                                              │   │
│ │  切换)   │ │   任务详情时为三栏：                         │   │
│ │          │ │   ┌─────────┬─────────┬──────────┐           │   │
│ │ - 项目快 │ │   │ 会话栏  │ Chat    │ 右侧 Tab │           │   │
│ │   捷     │ │   │         │ Timeline│ (可隐藏) │           │   │
│ │ - 进行中 │ │   │         │         │          │           │   │
│ │   会话   │ │   └─────────┴─────────┴──────────┘           │   │
│ │ - + 新任 │ │                                              │   │
│ │   务     │ │                                              │   │
│ └──────────┘ └──────────────────────────────────────────────┘   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ StatusBar（可选）：Gateway 状态 / Token 状态 / 当前 SSE 连接     │
└─────────────────────────────────────────────────────────────────┘

Overlay 层（z-index 自下而上）：
  L1: ProfileSwitchOverlay
  L2: 命令面板（⌘K）/ 工作区选择器 modal / 设置次级 modal
  L4: 错误 toast
  L5: 关键确认对话框

OS 层（桌面 v2 新增）：
  - 系统托盘菜单
  - 原生菜单栏（macOS 顶部 / Windows 窗口顶部）
  - 本地通知 + 点击回调
  - OS 级 drop 事件 → Composer 附件
```

---

## 9. 待对齐 / 决策

### 9-A. `/profiles` 归属

**现状**：代码把 `/profiles` 划在「能力」分组（`use-active-top-tab.ts:46-47`），点这个路由顶导第 3 项 highlight。

**问题**：profile 是账号 / 身份概念，跟 Skills / MCP（任务执行能力）语义不一致。

**选项**：

1. 把 `/profiles` 从 `skills.matches` 移除，归入 **设置**（`/settings?section=profiles` 内部 Tab）
2. 保留在「能力」分组但在侧栏明确分组，避免误以为 profile 是一种 "能力"
3. 维持现状，仅在 PRD 注释里说明

**倾向**：方案 1。Profile 切换的入口已经在右上角 `ProfileSelector`，profile 管理（列表 + 编辑）下沉到设置内部更合理。

### 9-B. 命令面板的路由策略

**问题**：命令面板（17-search-modal）按 § 4 设计为 overlay 不进 URL。但有时用户可能希望「分享一条命令面板搜索结果链接」。

**倾向**：v2 命令面板**只做 overlay**。如果有"分享搜索"需求，走 `/history?q=...` 路由。

### 9-C. Skills 编辑器（09b）路由

**问题**：09b 是 Skills 表格的"我的"Tab 下的编辑界面。

**选项**：

1. `/skills/:skillId/edit` 独立路由（深链接友好）
2. `/skills` 内的 modal / 抽屉
3. `/skills?edit=:skillId` query 参数

**倾向**：方案 1（路径式）。深链接预留时 `hermes://skill/<id>/edit` 也对得上。

### 9-D. 任务详情右侧面板 Tab 是否进 URL

**问题**：03–06 给了 4 个 Tab（文件 / 产物 / 终端 / 日志），D5 决定不开 4 个独立路由。但 Tab 切换状态可分享是有价值的。

**选项**：

1. Tab 状态进 query：`/tasks/123?panel=terminal`
2. Tab 状态只进 atom，关页就丢
3. Tab 状态进 UI SQLite（按用户偏好记忆“上次看哪个 Tab”）

**倾向**：方案 1（query 参数）+ 默认 `files`。可分享 + 不需要新路由 + 可后退。

### 9-E. 主体页路由是否带「工作台子分组」

工作台目前匹配 `/` / `/new` / `/tasks/*` / `/history` 四条路径，分属"主页 / 编辑 / 详情 / 历史"四种场景，侧栏内容会不会需要差异？

**当前**：侧栏统一显示「项目快捷 + 进行中会话」。

**待办**：检查 `/tasks/:taskId` 时侧栏是否需要替换为「同任务的相关会话」或保留默认。

### 9-F. Logs / Health / Settings 的子页是否要 URL 状态

- Logs：`?level`、`?source`、`?q`、`?since` 都建议进 URL（可分享、可调试）
- Health：每次进入手动刷新即可，不需要 URL 状态
- Settings：内部 section 用 `?section=` 已经在做

---

## 10. v2 IA 落地清单（给到工程层）

按依赖顺序：

- [ ] 实现 ⌘K 命令面板 overlay（L2）+ 全局快捷键绑定
- [ ] 实现 ⌘1..6 顶导切换 + Esc 关 modal 通用键位
- [ ] 决策 9-A（profiles 归属）→ 改 `use-active-top-tab.ts` 与 `app.tsx`
- [ ] 添加 `/skills/:skillId/edit` 路由（决策 9-C）
- [ ] 任务详情右侧 Tab 进 query（决策 9-D），并加 ⌘B 切换面板显隐
- [ ] Logs 路由加 `?level`、`?source`、`?q` 参数解析
- [ ] 实现深链接映射函数 `mapDeepLinkToRoute()`（即使 hermes:// 不注册）
- [ ] 实现系统托盘菜单（Tauri tray API + 路由跳转回调）
- [ ] 实现原生菜单栏（Tauri menu API）
- [ ] 实现本地通知点击 → 路由跳转
- [ ] 实现 OS drop 事件 → Composer 注入

---

## 11. 变更记录

| 日期 | 版本 | 改动 | 作者 |
|------|------|------|------|
| 2026-05-16 | v0.1 | 初稿；基于现有 `app.tsx` + 顶导定义对齐 | Maintainers |
