# P0 修复分支整合到 v0.9.0 的本地记录

日期：2026-09-09。两个仓库的目标分支均为 `fix/v090-e2e-acceptance`，工作区位于 `wt/v090-e2e-fixes/`。Desktop 保持 0.9.0，Core 保持 0.21.x 兼容系列。

## 来源和范围

| 仓库 | 源分支 | 指定修复提交 | 本地移植提交 |
| --- | --- | --- | --- |
| Desktop | `fix/issue-triage-20260909` | `d5c3a707124344dc07533c809cd45a54de2f1602` | `dc37a4d05311fa9740eee663a57bc443a90331f5` |
| Core | `fix/issue-triage-20260909` | `e762343c7bfd982ca84a3e107ae36122ef409183` | `43e68066d2` |

源分支还包含嵌入式 Python 等其他架构改动，因此按指定修复提交逐项移植，并核对前置行为。两个源分支及其工作区保持原样。

本轮整合了档案切换与备份恢复后的会话重置、澄清交互、外部内核版本检查、网关共享锁及归属判断、文件读取边界、旧版 WebKit Markdown 兼容、冻结包工具发现和 Windows PTY 资源、安装器 Python 3.14 要求与 CN 仓库来源、Ubuntu 22.04 构建基线及对应测试。

以下修复在目标分支已有实现，合并时保留：

- P0 网关崩溃需要的 `InProcessCronScheduler` 导入；本轮执行了网关启动、调度线程启动与关闭的回归用例。
- 备份 SQLite WAL 中的聊天历史及完整数据恢复。
- 冻结 cron 脚本通过独立 `__run-script` 子进程执行，以及 v0.21 的取消、超时、进程树清理和更新维护锁。`cron/scheduler.py` 与整合前检查点完全一致，采用源分支更完整的真实子进程测试。

Core #136 继续按原要求跳过。

## 冲突处理与原工作保护

整合前保存补丁、文件归档及 SHA256 清单，并将已有更新体验实现保存为本地检查点：

- Desktop：`75ce220c7f4d4b1a7d9787747beb77a9619ef054`。
- Core：`1d28ab7991c98d7f493c872e41ea6cb6c43188fb`。
- 备份目录：`/Users/enzo/Documents/GithubProjects/hermes/CNDesktop/artifacts/p0-integration-20260909-205643`。

处理了 Desktop 的 `package.json`、版本检查实现及测试冲突，以及 Core 的补丁台账、cron 实现及测试冲突。

- 保留更新控制工具依赖，加入两项 Markdown 依赖补丁；冻结锁文件安装通过。
- 外部 Core 忽略本机安装记录，按兼容系列接收稳定补丁；显式版本要求及已记录的托管安装版本仍严格匹配。
- 档案切换后安装记录重新读取期间，沿用兼容矩阵，避免已热更新的托管 Core 被构建时版本误判；保留异步检查失效控制。
- 高级更新选项、统一更新页、更新执行锁及 Core 任务保护保持原实现。
- Core 新台账条目中的重复编号调整为 P-069～P-071。
- Core 原有大小写冲突文件 `contributors/emails/agent@Agents-Mac-mini.local` 未加入提交，内容 SHA256 与整合前一致。

## 本轮最小范围验证

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，补丁已应用 |
| `pnpm typecheck` | 通过，含版本同步、Desktop/Core 兼容矩阵、4px 网格检查 |
| 前端直接相关测试 | 11 个文件、151 条通过 |
| Rust 编译及直接相关测试 | 50 条通过 |
| Core 直接相关测试 | 9 个文件、92 条通过，1 条 Windows 专用用例在 macOS 跳过 |
| 冲突标记及 `git diff --check` | 通过 |

前端覆盖版本检查、网关连接、档案和备份、会话解析、聊天和澄清、Markdown、软件更新状态和更新页。Rust 覆盖备份 WAL、文件读写边界、网关锁、Dashboard 进程接管、更新执行锁和兼容矩阵。Core 覆盖 cron 真实子进程执行与超时清理、维护锁、P0 网关启动路径、安装器、打包约定、CUA 恢复以及本地 HTTP 阻塞超时。

首次检查发现了整合前已经过时的测试断言：Rust 把 Desktop 0.9 当成未知系列、Core 打包测试仍要求已移除的 Tavily 插件、网关启动测试仍 mock 已被调度 provider 替换的函数。已按当前产品行为更新并定向重跑通过。Core 测试环境补装了缺失的 aiohttp，仅修改当前工作区的 `.venv`。Core 测试适配提交为 `a90b0e31f863ed23ec45e0b95aa1cf13dceed678`。

## 验收边界

本轮完成源码整合和本机针对性验证，未重新构建或启动 macOS／Windows 安装包。原分支台账中的 Windows 原生端到端结果属于原候选版本的历史证据；整合后的正式产物仍需重新构建验收。

Intel/macOS 12、Ubuntu 22.04 成品、Core #141 的原始微信阻塞场景，以及 v0.9.0 正式签名、公证和线上更新链路的既有验收事项继续保留。

全部操作在本地完成，未 push、未触发 CI/CD、未公开发布。
