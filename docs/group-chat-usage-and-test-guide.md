# 多 Agent 群聊：用户场景与测试指南

> 适用功能：CN fork P-052（PR 分支仍沿用历史名称 P-048）
>
> 配套仓库：Hermes-CN-Desktop + Hermes-CN-Core
>
> 文档用途：用户使用手册、QA 测试规范、测试执行记录

## 1. 功能是什么

多 Agent 群聊把多个 Hermes Profile 放进同一个房间。每个 Profile 都是一个独立成员，继续使用自己的：

- 模型与 Provider；
- `SOUL.md` 人格；
- Profile 描述；
- 配置、技能和工具权限。

用户负责决定下一轮由谁发言。当前版本不是让 Agent 在后台自动互相对话，而是让用户通过普通消息和 `@` 提及编排多个成员。

### 1.1 快速使用

1. 先准备至少两个职责不同的 Profile，例如 `planner`、`critic` 和 `synthesizer`。
2. 在工作台侧栏点击「新建群聊」。
3. 填写可选的群聊名称，勾选参与成员并创建。
4. 进入房间后：
   - 直接发送，所有成员依次回答；
   - 输入 `@all`，所有成员依次回答；
   - 输入 `@planner`，只有 `planner` 回答；
   - 输入 `@planner @critic`，只有这两个成员按房间成员顺序回答。
5. 需要成员互相评论时，分成多轮：先让一方发言，再在下一条消息中点名另一方审查。

输入 `@` 后，界面会列出 `@all` 和当前房间成员。成员栏显示人数、名字和 Profile 描述。

### 1.2 当前真实语义

| 行为 | 当前语义 |
|---|---|
| 普通消息，不包含 `@` | 发给房间内所有成员 |
| `@all` | 发给房间内所有成员 |
| 一个或多个有效 `@名字` | 只发给被提及的成员 |
| 错误的 `@名字` | 不触发任何成员，并产生 `groupchat.no_targets` |
| 回复顺序 | 串行，按建群时的成员顺序，不按文字中 mention 的先后 |
| 同一轮上下文 | 所有目标成员拿到同一个“本轮开始前”快照，互相看不到同轮的新回答 |
| 下一轮上下文 | 能看到前面已经完成的成员发言，并带发送者名字 |
| 成员身份 | 实时流、完成态和房间 transcript 都携带 `sender_agent_id/name/avatar` |
| 房间状态 | 只保存在当前 Core 进程内存中 |

“串行”只表示执行顺序；同一轮仍然是独立意见。例如一条普通消息依次触发 A、B、C，B 和 C 不会看到 A 在这一轮刚生成的回答。要让 C 汇总 A、B 的观点，应在三人都完成后再单独发送一轮给 C。

### 1.3 建议的 Profile 设计

职责应互补，而不是只换三个名字使用同一套提示词。

| Profile | 建议职责 | Profile 描述示例 |
|---|---|---|
| `planner` | 提出方案 | “负责给出目标、步骤、依赖与执行方案” |
| `critic` | 红队审查 | “负责寻找反例、遗漏、安全与交付风险” |
| `synthesizer` | 主持与决策 | “负责比较各方观点、处理冲突并给出结论” |
| `researcher` | 证据收集 | “只基于可核验来源整理事实与出处” |
| `qa` | 验收设计 | “把需求转成可执行测试和失败判据” |

## 2. 六类复杂用户场景

每个场景都采用多轮用户编排。不要期待 Agent 自动接力。

可直接复用的角色卡、Profile 指令、逐轮提示词和输出契约已经整理到
[多 Agent Orchestrator 场景库](./Orchestrator/README.md)。本节保留面向测试的简版流程，
`docs/Orchestrator/` 负责维护面向用户的编排模板。

### 2.1 多专家独立会诊后由主持人总结

**Profile**

- `domain-a`：领域专家 A；
- `domain-b`：领域专家 B；
- `risk-reviewer`：风险专家；
- `synthesizer`：主持人。

**示例提示词**

```text
我们要决定是否在三个月内把现有服务迁移到新架构。
请分别给出：收益、主要代价、前置条件、最担心的失败方式。
不要参考其他成员在本轮的意见。
```

**操作顺序**

1. 发送 `@domain-a @domain-b @risk-reviewer` 加上面的提示词，让前三名专家独立回答。不能直接发送，否则 `synthesizer` 也会参与第一轮。
2. 等所有气泡完成。
3. 发送：

   ```text
   @synthesizer 请比较上一轮三位成员的意见，列出共识、冲突、缺失证据，
   最后给出“现在执行 / 先做验证 / 暂缓”三选一结论。
   ```

**预期结果**

- 第一轮每位专家形成独立意见；
- 第二轮主持人能明确引用至少两名成员的观点；
- 主持人的回答只有一个气泡。

**不要误解**

- 第一轮后发言的专家不会看到同轮前一位专家刚写的内容；
- 不应让主持人也参与第一轮，再期待它自动更新自己的同轮结论。

### 2.2 方案提出者、红队与决策者的多轮辩论

**Profile**

- `planner`：提出可执行方案；
- `critic`：只负责反例和风险；
- `decision-maker`：按标准作最终选择。

**操作顺序**

1. `@planner` 给出初版方案，必须包含假设和退出条件。
2. `@critic` 结合 planner 的上一轮回答，列出至少三个可证伪风险。
3. `@planner` 逐条回应 critic，只修改确有必要的部分。
4. `@decision-maker` 按成本、风险、可逆性和验证难度评分并决策。

**预期结果**

- 每轮只有被点名成员回答；
- planner 第二次回答能看到 critic 的上一轮内容；
- decision-maker 能区分初版和修订版。

**不要误解**

- `@planner @critic` 同轮发送不会形成辩论，两人只会独立回答同一条用户消息；
- 当前没有 Agent 自动 `@` 另一个 Agent 后触发接力的能力。

### 2.3 不同模型的 A/B 对比

**Profile**

- `model-a`、`model-b`：配置不同模型，使用相同角色说明；
- `judge`：固定第三个模型，负责按统一量表评价。

**操作顺序**

1. 发送 `@model-a @model-b` 加同一任务，让 A、B 独立作答。不能直接发送，否则 `judge` 也会参与第一轮。
2. `@judge` 按统一量表比较两份回答的正确性、完整性、可执行性和幻觉风险。
3. 对调 A、B 的模型配置后在新房间重复，排除名字或顺序偏差。

**预期结果**

- A、B 各自使用自己的 Profile 模型；
- 两个回答保持独立气泡和正确名字；
- judge 的评分引用具体内容，不只给主观偏好。

**不要误解**

- 群聊输入框上的会话模型选择器不应被当成批量覆盖所有成员模型的可靠入口；
- 群聊历史会显示 sender，因此群聊内的 judge 只能做弱盲评；严格匿名需要在独立 judge 会话中使用去标识后的回答；
- 测试结果必须同时记录模型、Provider 和 Profile，不能只记录显示名。

### 2.4 资料研究、事实核查与编辑

**Profile**

- `researcher`：整理事实和出处；
- `fact-checker`：查找证据缺口与互相冲突的来源；
- `editor`：只在事实核查结束后生成成稿。

**操作顺序**

1. `@researcher` 输出“事实 / 来源 / 时间 / 置信度”表格。
2. `@fact-checker` 检查上一轮每条事实，标记已证实、存疑或错误。
3. 必要时再次定向 `@researcher` 补证据。
4. `@editor` 只使用已证实内容形成稿件，并保留不确定性说明。

**预期结果**

- fact-checker 能看到 researcher 的上一轮表格；
- editor 不应把“存疑”事实写成确定结论；
- 每条重要结论能追溯到房间历史。

**不要误解**

- 当前群聊本身不会自动验证来源；
- 使用实时网络搜索时要另外保存来源链接和访问时间。

### 2.5 对隔离代码库进行只读 Review

**Profile**

- `architect`：检查模块边界与依赖；
- `platform-reviewer`：检查操作系统、运行时和兼容性；
- `qa`：设计回归用例。

**准备**

- 使用临时 fixture 仓库，不指向用户真实项目；
- 只允许 `read_file`、搜索和只读 Git 命令；
- 测试前记录所有文件校验和与 `git status --porcelain`。

**操作顺序**

1. `@architect` 阅读 `requirements.md` 和 `design.md`，列出架构风险。
2. `@platform-reviewer` 结合上一轮内容检查平台兼容性。
3. `@qa` 把两人的结论转成验收矩阵。
4. 再次记录校验和和 Git 状态。

**预期结果**

- 三个成员引用的是同一 fixture 内容；
- 最终工作区无已修改文件、无未跟踪文件；
- QA 用例能关联到前两名成员发现的具体风险。

**不要误解**

- “只读 Review”不包括自动修复、格式化、依赖安装或提交代码；
- 如果出现审批请求，应拒绝任何写入或外部动作。

### 2.6 基于脱敏日志的故障复盘

**Profile**

- `ops-analyst`：重建时间线；
- `security-reviewer`：检查安全与数据泄漏风险；
- `incident-lead`：形成结论和行动项。

**操作顺序**

1. `@ops-analyst` 从脱敏日志重建事件顺序，区分事实与推测。
2. `@security-reviewer` 复核日志中是否存在凭证、个人信息或越权信号。
3. `@incident-lead` 综合两方内容，生成根因、促成因素、未决问题和行动项。

**预期结果**

- 时间线中的每一步可对应到日志行；
- 安全成员不重复输出可能的敏感值；
- 负责人明确区分已确认根因和待验证假设。

**不要误解**

- 禁止把真实 API Key、Token、Cookie 或个人信息放入群聊；
- 当前群聊不是审计日志或事故管理系统。

## 3. 已支持能力、当前缺陷与 MVP 限制

### 3.1 已支持

- 从现有 Profile 多选建群；
- 可选群聊名称；
- `@all`、单成员和多成员路由；
- 普通消息默认全员参与；
- 成员独立流式气泡；
- 下一轮的共享历史投影；
- 当前 Core 进程内刷新读取 transcript 和成员信息。

### 3.2 当前确认缺陷

| 编号 | 现象 | 期望 |
|---|---|---|
| BUG-GC-001 | 发送后输入框要等所有串行成员结束才清空 | 点击发送后 500ms 内清空，后台继续执行 |
| BUG-GC-002 | 页面刷新后再次发送出现 `session not found`，草稿保留 | 房间仍存在时可继续发送 |
| BUG-GC-003 | 20 轮压力中 UI 出现重复气泡，并把一个成员的文本并入另一成员气泡；同轮 REST transcript 仍正确 | UI 气泡数量、文本和 sender 与 REST transcript 一一对应 |

这些缺陷不是产品语义，也不能写成“已知限制所以无需修复”。

### 3.3 MVP 限制

- 房间和共享 transcript 不跨 Core 进程重启持久化；
- 没有 Agent 自动接力；
- 不并行调用多个成员；
- 没有群聊专用上下文压缩；
- 没有可靠的群聊级停止/中断保证；
- 没有为长时间运行房间提供 freshness guard。

测试这些边界时使用 `EXPECTED_LIMIT`，不要把它们误报为普通回归；但 UI 若无明确提示、静默丢失或展示错误状态，仍应单独记录缺陷。

## 4. 测试分层

### 4.1 Level 0：双仓与运行时预检

每次执行前记录：

- Desktop 分支、完整 SHA、工作区状态；
- Core 分支、完整 SHA、工作区状态；
- Python、Node、pnpm 和操作系统版本；
- `tui_gateway.server.__file__`，确认没有导入其他 checkout；
- Dashboard、Vite、假模型实际监听端口；
- 隔离 `HERMES_HOME` 的绝对路径。

开发桌面标准端口是 Dashboard `9120` 和 Vite `9545`。自动化测试为了不影响运行中的实例，使用：

- Dashboard：`9121`
- Vite：`9546`
- 假模型：`8098`

### 4.2 Level 1：确定性 E2E

确定性测试使用真实 Desktop Web UI、真实 Core Gateway 和真实会话循环，只把模型替换成本地假模型。

正式用例位于：

```text
e2e/specs/group-chat.spec.ts
```

两个群聊 PR 尚未合并时显式运行：

```bash
E2E_GROUPCHAT=1 \
E2E_DASHBOARD_PORT=9121 \
E2E_VITE_PORT=9546 \
E2E_FAKE_MODEL_PORT=8098 \
HERMES_CORE_DIR="/path/to/Hermes-CN-Core-agent-group-chat" \
HERMES_CORE_PYTHON="/path/to/python3.14/venv/bin/python" \
pnpm --filter @hermes/e2e exec playwright test specs/group-chat.spec.ts
```

不设置 `E2E_GROUPCHAT=1` 时，跨仓群聊 spec 会跳过，避免 Desktop PR 的默认 CI 暂时绑定尚未合并的 Core 分支。Core P-052 合入 `main` 后，应在默认 E2E 工作流启用该变量。

20 轮压力用例还需要显式设置：

```bash
E2E_GROUPCHAT=1 \
E2E_GROUPCHAT_STRESS=1 \
E2E_DASHBOARD_PORT=9121 \
E2E_VITE_PORT=9546 \
E2E_FAKE_MODEL_PORT=8098 \
HERMES_CORE_DIR="/path/to/Hermes-CN-Core-agent-group-chat" \
HERMES_CORE_PYTHON="/path/to/python3.14/venv/bin/python" \
pnpm --filter @hermes/e2e exec playwright test \
  specs/group-chat.spec.ts --grep "二十轮"
```

压力用例把 REST sender 序列和 UI 气泡数量分别统计。若 Core transcript 正确但 UI 合并或重复气泡，必须记为 Desktop `FAIL`，不能以“后端数据没丢”判为通过。

假模型提供四种标记：

| 标记 | 用途 |
|---|---|
| `group-context-e2e` | 返回当前成员名字和它在历史中看见的其他测试成员 |
| `group-long-stream-e2e` | 返回带成员名字的长碎片流 |
| `group-failure-e2e` | 让 `qa-failing` 返回确定性错误，其他成员正常 |
| `stream-order-marker` | 保留现有单聊长流回归 |

测试 Profile 统一使用 `qa-` 前缀，并写入隔离 `HERMES_HOME`：

- `qa-planner`
- `qa-critic`
- `qa-synthesizer`
- `qa-failing`

### 4.3 Level 2：真实模型

真实模型测试复用相同的 Profile 职责和操作顺序，但只断言行为关系，不断言随机措辞：

- 只有正确目标成员回答；
- 每名成员符合自己的角色；
- 主持人能引用至少两名上一轮成员的具体观点；
- 不同 Profile 不泄漏彼此隐藏配置；
- 一个模型失败时其他成员仍继续。

安全要求：

- 使用独立测试配置和临时 Profile；
- 凭证只通过本机安全环境或 CI Secret 注入；
- 日志只记录 Provider、模型 ID 和“凭证是否存在”，绝不打印凭证值；
- 禁止真实发布、发送消息、创建 PR、修改用户仓库或执行其他外部写操作。

仓库提供显式 opt-in 的真实模型冒烟脚本：

```bash
E2E_REAL_GROUPCHAT=1 \
E2E_DASHBOARD_ORIGIN="http://127.0.0.1:9122" \
E2E_DASHBOARD_TOKEN="<isolated-dashboard-token>" \
node e2e/harness/groupchat-real-smoke.mjs
```

调用前必须自行启动隔离 Core Dashboard。建议额外设置 `HERMES_TUI_TOOLSETS=clarify` 和 `HERMES_IGNORE_RULES=1`，使测试模型不能读写文件、执行终端或载入真实工作区规则。脚本只输出 sender 顺序、回复长度、上下文断言和耗时，不输出模型正文或凭证值。

同一脚本还支持恢复边界探测：

- `E2E_GROUPCHAT_CREATE_ONLY=1`：只建房并输出房间 ID；
- `E2E_GROUPCHAT_PROBE_ROOM=<room-id>`：查询指定房间；
- `E2E_EXPECT_ROOM_MISSING=1`：把重启后房间缺失按 `EXPECTED_LIMIT` 验收。

### 4.4 Level 3：恢复、边界与预期失败

覆盖：

- 刷新后继续发送；
- 切换到普通会话再返回；
- WS 在成员长流中断开后恢复；
- 点击停止；
- 错误 mention；
- 侧栏和历史页是否暴露 `gc_<room>:<profile>` 内部子会话；
- Core 重启后房间失效是否有明确提示；
- 3～5 个成员、20 轮混合路由压力。

分类规则：

| 状态 | 含义 |
|---|---|
| `PASS` | 实际结果满足验收 |
| `FAIL` | 已支持路径不满足验收 |
| `EXPECTED_LIMIT` | 命中明确的 MVP 限制，实际表现与文档一致 |
| `BLOCKED` | 环境、凭证或外部依赖阻塞，未得到有效结果 |
| `NOT_RUN` | 本轮未执行 |

## 5. 测试矩阵

| ID | 层级 | 场景 | 主要验收 |
|---|---|---|---|
| GC-01 | L1 | 三成员建群、成员栏、`@` 候选 | 成员数量、顺序、描述、`@all` 正确 |
| GC-02 | L1 | 普通消息与 `@all` | 全员各一个气泡，按房间顺序串行 |
| GC-03 | L0/L1 | 单/多 mention、大小写、中文标点、相似名、错误名、引用块 | 只触发正确成员；错误名无回复 |
| GC-04 | L1 | 同轮独立上下文 | 每名成员报告看不到同轮其他成员 |
| GC-05 | L1/L2 | 下一轮定向总结 | 主持人能看到并引用至少两名上一轮成员 |
| GC-06 | L2 | 规划—批评—修订—总结四轮协作 | 角色和历史连续，目标成员集合正确 |
| GC-07 | L1 | 三成员长碎片流 | 不丢 token、不重复、不串气泡 |
| GC-08 | L1/L2 | 中间成员模型失败 | 后续成员继续；错误归属失败成员 |
| GC-09 | L2 | 不同模型和角色 | 模型、身份、人格保持独立 |
| GC-10 | L2 | Profile 隐私隔离 | 不输出其他 Profile 的配置或凭证 |
| GC-11 | L2 | 临时 fixture 仓库只读 Review | 校验和与 Git 状态前后完全一致 |
| GC-12 | L3 | 会话切换与页面刷新 | transcript、成员身份保留且可继续发送 |
| GC-13 | L3 | WS 中断、重连 | 不丢失/重复消息，成员归属稳定 |
| GC-14 | L3 | 停止群聊回复 | 记录当前行为；可靠中断暂按 MVP 限制分类 |
| GC-15 | L3 | Core 重启与历史/侧栏检查 | 房间明确失效；不得把内部子会话冒充群聊 |
| GC-16 | L3 | 3～5 成员、20 轮压力 | 记录延迟、消息数、身份稳定性和上下文增长 |

## 6. 统一验收标准

### 6.1 路由与顺序

- 触发成员集合与 mention 规则完全一致；
- 多目标回复按房间成员顺序执行；
- 错误 mention 不触发其他成员兜底；
- 每个目标成员最多产生一个本轮回答。

### 6.2 消息与身份

- 每名目标成员有独立气泡；
- `message.start`、`message.delta`、`message.complete` 和 REST transcript 的 sender 一致；
- 完成态 refetch 和刷新后不能合并不同成员；
- 长流开始/结束标记各出现一次，所有中间片段完整且顺序正确。

### 6.3 上下文

- 同轮目标成员不读取其他成员同轮新回答；
- 下一轮能看到已完成的历史；
- 主持人总结至少引用两名不同成员的具体观点；
- 不产生连续同角色消息或身份错置。

### 6.4 交互与恢复

- 点击发送后 500ms 内清空草稿；
- 刷新后房间仍存在时能够继续发送；
- 一个成员失败不阻断后续成员；
- Core 重启造成的房间丢失必须明确提示，不能静默显示为可继续。

### 6.5 只读与安全

- fixture 校验和不变；
- `git status --porcelain` 前后均为空；
- 没有外部消息、发布、提交、PR 或云资源写入；
- 日志、截图和报告不包含凭证值。

## 7. 证据采集

每轮至少保存：

1. 双仓完整 SHA 和 `git status --short`；
2. Core 专项测试、Desktop typecheck/Vitest 和 Playwright 结果；
3. Playwright screenshot、video 或 trace；
4. 房间 REST transcript 的角色和 sender 序列；
5. 浏览器 console error；
6. 草稿清空时延、每个成员开始/完成时间；
7. 失败用例的最小复现和对应缺陷编号。

不得把只看到后台测试通过当成桌面 UI 通过，也不得用全局 Hermes 的 `9119` 代替桌面 managed runtime `9120`。

## 8. 执行记录模板

### 8.1 环境

| 字段 | 值 |
|---|---|
| 执行时间 | |
| 操作系统 / 架构 | |
| Desktop 分支 / SHA | |
| Core 分支 / SHA | |
| Desktop 工作区状态 | |
| Core 工作区状态 | |
| Python / Node / pnpm | |
| HERMES_HOME | |
| Dashboard / Vite / 模型端口 | |
| 模型与 Provider | |

### 8.2 结果

| 用例 ID | 状态 | 耗时 | 实际结果摘要 | 证据位置 | 缺陷编号 |
|---|---|---:|---|---|---|
| GC-01 | `NOT_RUN` | | | | |
| GC-02 | `NOT_RUN` | | | | |
| GC-03 | `NOT_RUN` | | | | |
| GC-04 | `NOT_RUN` | | | | |
| GC-05 | `NOT_RUN` | | | | |
| GC-06 | `NOT_RUN` | | | | |
| GC-07 | `NOT_RUN` | | | | |
| GC-08 | `NOT_RUN` | | | | |
| GC-09 | `NOT_RUN` | | | | |
| GC-10 | `NOT_RUN` | | | | |
| GC-11 | `NOT_RUN` | | | | |
| GC-12 | `NOT_RUN` | | | | |
| GC-13 | `NOT_RUN` | | | | |
| GC-14 | `NOT_RUN` | | | | |
| GC-15 | `NOT_RUN` | | | | |
| GC-16 | `NOT_RUN` | | | | |

### 8.3 缺陷记录

```text
标题：
用例 ID：
环境与双仓 SHA：
前置条件：
复现步骤：
预期结果：
实际结果：
发生频率：
截图 / video / trace：
相关事件或 REST transcript：
可能涉及的文件 / 行：
```

功能修复必须使用独立提交和独立验证，不与测试文档或测试工具提交混在一起。

## 9. 2026-07-23 执行记录

### 9.1 环境

| 字段 | 值 |
|---|---|
| 执行时间 | 2026-07-23 16:43～17:08 CST |
| 操作系统 / 架构 | Darwin 25.5.0 / arm64 |
| Desktop 分支 / SHA | `feat/agent-group-chat` / 执行时基线 `0fc02841c97bc11cef9c800623b9fde605214a9b`，叠加本次文档与测试工作树 |
| Core 分支 / SHA | `cn/P-048-agent-group-chat` / `7614e02ac4ffb5029ad5cb08c4bb3d37b60512b7` |
| Desktop 工作区状态 | 仅本文档、E2E、假模型和 CI Python 版本的预期改动 |
| Core 工作区状态 | 干净；本轮未修改 Core |
| Python / Node / pnpm | Python 3.14.5 / Node v24.18.0 / pnpm 9.15.0 |
| 确定性 HERMES_HOME | `e2e/.runtime/hermes-home`，每次由 harness 重建 |
| 真实模型 HERMES_HOME | `/tmp/hermes-groupchat-real.*`，执行后已删除 |
| Dashboard / Vite / 模型端口 | L1：`9121 / 9546 / 8098`；L2：Dashboard `9122`；L3 重启：Dashboard `9123` |
| 模型与 Provider | L1：`fake-model / custom`；L2：`deepseek-v4-flash / deepseek` |

自动测试没有接管或停止开发实例；执行结束后 `127.0.0.1:9120` 的原 Core 进程仍在监听。

### 9.2 回归结果

| 检查 | 结果 |
|---|---|
| Core 导入路径 | 指向配对 worktree 的 `tui_gateway/server.py` |
| Core 群聊专项 | `31 passed` |
| Core Ruff | 通过 |
| Desktop `pnpm typecheck` | 通过 |
| Desktop `pnpm test:unit` | Protocol `66 passed`；Web `1000 passed` |
| Desktop `cargo check` | 通过 |
| Desktop `cargo test --all-features` | `495 passed` |
| 默认 Playwright | `8 passed, 9 skipped (17.3s)`；群聊 spec 未设置开关时全部跳过 |
| 群聊确定性 Playwright | `8 passed, 1 skipped (1.1m)`；基础、路由、上下文、长流、故障隔离和内部会话可见性通过，三个已知交互边界按分类执行，压力用例需额外开关 |
| 真实模型冒烟 | 通过；三成员全员、单成员、多成员反向 mention 和规划—批评—修订—总结四轮均满足 sender 与上下文断言，耗时 `44.315s` |
| 20 轮压力 | `FAIL`；Core REST 为 20 条 user + 45 条 assistant，sender 序列正确；UI 为 53 个 assistant 气泡，首次偏差出现在第 4 轮 |
| E2E 独立 TypeScript 检查 | 本次 `group-chat.spec.ts` 无新增错误；命令仍被仓库既有 `config.mjs`/`red-square.mjs` 声明缺失和 `chat-loop.spec.ts` 参数错误阻塞 |

压力统计：

```text
rounds=20
assistant_messages(REST)=45
transcript_messages=65
stable_senders=3
rest_sender_sequence_ok=true
ui_assistant_bubbles=53
expected_assistant_bubbles=45
first_ui_mismatch_round=4
latency_ms.p50=954
latency_ms.p95=1935
latency_ms.max=1965
```

### 9.3 用例结果

| 用例 ID | 状态 | 耗时 | 实际结果摘要 | 证据位置 | 缺陷编号 |
|---|---|---:|---|---|---|
| GC-01 | `PASS` | 包含于 L1 套件 | 三成员、成员栏、描述和四个 mention 候选正确 | `e2e/specs/group-chat.spec.ts` | |
| GC-02 | `PASS` | 包含于 L1 套件 | 普通消息和 `@all` 均按房间顺序各回复一次 | 同上 | |
| GC-03 | `PASS` | 包含于 L1 套件 | 单/多 mention、大小写、中文标点、相似错误名和引用块边界正确 | 同上 | |
| GC-04 | `PASS` | 包含于 L1 套件 | 第一轮三成员均报告 `seen=none` | 同上 | |
| GC-05 | `PASS` | L2 总计 `44.315s` | 假模型与真实模型主持人均引用 planner、critic | `e2e/harness/groupchat-real-smoke.mjs` | |
| GC-06 | `PASS` | 包含于 L2 | 真实模型四轮 sender 为 planner → critic → planner → synthesizer，历史标记连续 | 同上 | |
| GC-07 | `PASS` | 包含于 L1 套件 | 三成员长碎片流起止标记各一次，无丢 token | `e2e/specs/group-chat.spec.ts` | |
| GC-08 | `PASS` | 包含于 L1 套件 | `qa-failing` 错误归属正确，planner 和 critic 继续 | 同上 | |
| GC-09 | `NOT_RUN` | | 本机可用测试 Profile 使用同一模型，未伪造 A/B 结果 | | |
| GC-10 | `NOT_RUN` | | L2 已限制为 `clarify` 工具且日志无凭证，但未做带秘密哨兵的主动泄漏测试 | | |
| GC-11 | `NOT_RUN` | | 本轮未给真实模型开放文件工具，未执行 fixture Review | | |
| GC-12 | `FAIL` | 包含于 L1 套件 | 内存房间可回读，但页面刷新后发送出现 `session not found` | `e2e/specs/group-chat.spec.ts` | BUG-GC-002 |
| GC-13 | `NOT_RUN` | | 未执行成员流中途强制断 WS 的恢复测试 | | |
| GC-14 | `EXPECTED_LIMIT` | `12.4s` 单测运行 | 点击停止后三个成员仍全部完成，符合“可靠中断未支持”的 MVP 边界 | `e2e/test-results/` | |
| GC-15 | `EXPECTED_LIMIT` | `4.732s` | Profile 会话列表未暴露内部 `gc_:profile`；Core 重启后 `groupchat.info` 明确返回房间不存在 | `e2e/harness/groupchat-real-smoke.mjs` | |
| GC-16 | `FAIL` | `20.0s` | REST 45 个 assistant 完全正确；UI 53 个气泡并发生跨成员合并 | `e2e/test-results/group-chat-P-052-多-Agent-群聊复杂场景-三成员二十轮混合路由保持身份、消息数量和上下文增长稳定-chromium/` | BUG-GC-003 |

### 9.4 额外交互验收

| 检查 | 状态 | 实际结果 | 缺陷编号 |
|---|---|---|---|
| 发送后 500ms 内清空草稿 | `FAIL` | 长流期间 500ms 时草稿仍存在，全部成员结束后才清空 | BUG-GC-001 |
| 刷新后继续发送 | `FAIL` | `session not found`，草稿保留 | BUG-GC-002 |
| 内部成员子会话不可见 | `PASS` | 分别查询成员 Profile 的公开会话列表，未出现 `gc_<room>:<profile>` | |

本轮只新增测试、测试工具、文档和 CI Python 版本调整；没有混入 BUG-GC-001～003 的产品修复。
