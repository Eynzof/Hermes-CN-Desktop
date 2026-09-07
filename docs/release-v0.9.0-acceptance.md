# v0.9.0 本地集成验收

验收日期：2026-09-06 至 2026-09-07。范围为本地源码、Windows x64 冻结内核和原生 Tauri/WebView2 应用；没有执行推送、PR、GitHub Release 发布或远程 CI/CD。

## 版本与源码

| 项目 | 本次固定值 |
| --- | --- |
| Desktop | `0.9.0`，代码提交 `55c672ce4e9872485715e27f2a16e695a1990675` |
| Core | `0.21.0`，最终中文提交 `0419cae3ecf3ee1505c7ecf761677ad9a8b6647f` |
| 上游 release | [v2026.8.31 / v0.21.0](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31)，2026-09-07 再查仍为最新 release |
| 上游 SHA | `29112bef099274229cadff79cdff7bf7b99c4b77` |
| Core 合并提交 | `23fb1a14a425ef9808d686e79ad52089a0724638` |
| Runtime | `0.21.0-cn.3`，schema 2，Windows x64 |
| 产品 identifier | `cn.org.hermesagent.desktop`，未改动 |

工作分支分别为 Core `chore/sync-v021-desktop-v090`、Desktop `feat/desktop-v090-core-v021`，均位于独立 worktree。原有主工作区及并行任务的未提交内容没有纳入本次提交。

Core 上游包含仅大小写不同的两个 `contributors/emails/agent@…Mac-mini.local` 文件；macOS 大小写不敏感文件系统会显示其中一项工作树差异。本次没有修改或暂存该上游名单碰撞。

## 用户功能

功能入口和未新增 UI 的取舍见 [版本说明](release-v0.9.0.md)。本次重点交付定时任务编辑、运行记忆、网页变化监控，以及运行中子 Agent 的追加指令和停止控制。现有 MCP 管理界面继续适配 MCP 2。

合并中保留中文模型目录、离线镜像、自定义模型能力与上下文覆盖、Wander、原有消息接入和 Windows 本机执行能力。低频 cron 高级字段以及上游 Bot Mode、peer、浏览器 Agent 保留在 Core/随附 Dashboard，不增加另一套 Desktop 管理界面。

## 源码验证

按变更范围执行测试，未运行所有平台的全量测试套件。失败用例修复后只重跑对应范围；下列数字对应各日志自身，存在重叠，不相加为总测试数。

| 范围 | 结果与证据 |
| --- | --- |
| Python 模型、网关、cron、工具生命周期 | 相关分组修复后通过；`v090-core-retest.log` 为 114 通过、1 跳过；`v090-core-features-tests.log` 为 75 通过 |
| Windows Shell 发现规则 | 81 通过，`v090-windows-shell-tests.log`；覆盖真实 Git Bash 和 System32/Sysnative/SysWOW64 WSL 启动器排除 |
| todo 与 Windows 兼容 | 修复警告消费问题后 84 通过；平台专属用例在 macOS 跳过，另以 Windows 实机补验 |
| Desktop 类型与版本一致性 | `v090-final-typecheck.log` 通过 |
| 前端与后台子任务状态 | `v090-desktop-unit.log`、`v090-background-subagent-tests.log` 通过 |
| Rust Runtime / UI / 壳更新 | Runtime 91 通过、1 ignored；UI 25 通过；壳更新 10 通过 |
| v0.21 ZIP 解压 | 9 个 focused 测试通过；Windows 上对真实 5333 文件包执行 artifact 解压测试通过 |
| Web 与 TUI 构建 | Core 的上游 npm workspace 和 Desktop Vite 均完成构建 |
| 浏览器 + 真实 Core | 对话、历史继续、cron 编辑/清除监控、MCP stdio echo、子任务跨父回合 steer/stop 通过 |

可重复的浏览器用例保存在 `e2e/specs/v090-core-features.spec.ts`；MCP 2 fixture 为 `e2e/fixtures/mcp_echo.py`。本地详细日志统一存放在 CNDesktop 工作区根目录 `artifacts/v090-*`。

## Windows 原生功能

机器为获授权的 `192.168.50.2`（SSH 别名 `windows`）。GUI 在交互 Session 1 的普通用户计划任务中启动，使用真实 WebView2 和 `hermesui` 页面；通过本地 CDP 隧道操作界面，不以开发服务器页面替代安装版。模型端使用确定性本地 fixture，Agent、工具、WebSocket、SQLite、进程与文件操作均走真实实现。

| 场景 | 实际证明 |
| --- | --- |
| 中文聊天、历史继续、长流式 | 原生对话内容与流式事件通过，`v090-native-features.json` |
| 图片消息 | 粘贴 PNG，70 字节图片到达模型请求，`v090-native-features.json` |
| 后台子任务 | 父会话发起新一轮后仍可追加指令、收到排队反馈；停止后收到真实 `subagent.complete / interrupted` |
| cron UI | 创建、编辑、保留调度、开启/清除 self 记忆和 monitor URL，`v090-native-cron-mcp.json` |
| MCP 2 | 冻结内核连接真实 stdio 服务并列出 echo 工具，原生管理页面通过 |
| 冻结 Python cron 脚本 | `__run-script` 独立子进程执行，中文文件真实落盘 |
| 默认 Git Bash | 原生聊天触发 terminal，写入 `terminal-bash-result.txt`；内容为“终端中文成功” |
| 显式 PowerShell | 配置 `terminal.shell: powershell` 后触发同类工具；`terminal-result.txt` 为正确 UTF-8 中文（含 BOM） |

## 三类更新

所有更新 manifest、资产及事件接收端均由测试机本地 HTTPS fixture 提供；测试进程代理将合法测试域名映射到本地，未访问或写入生产更新服务。使用独立测试签名、公钥和临时 CA，未改仓库生产签名公钥。

| 场景 | 结果 |
| --- | --- |
| Runtime 实际安装 | `cn.1 → cn.2` 签名 ZIP 安装、切换和受管进程重启成功 |
| Runtime 防降级 | 重启随附 cn.1 的桌面壳后仍运行 cn.2 |
| Runtime 回退 | 回退到 cn.1，实际进程版本与 current.json 相符 |
| 最终 Runtime | 再安装 cn.3，当前运行提交为 `0419cae3ecf3…` |
| Runtime 损坏包 | 错误签名和错误 SHA 安装被拒绝，原内核继续运行 |
| UI 独立热更 | UI.1 → UI.2 → UI.1 回退成功；DOM 版本标记随之变化，Core PID 未变化 |
| 壳检查与下载 | 候选兼容矩阵检查、签名和 SHA 验证、缓存准备状态成功，原生弹窗展示“稍后 / 立即重启安装” |
| 壳损坏包 | 错误签名、SHA 拒绝；签名失败不尝试下载回退 |
| 控制面暂停 | 已下载缓存存在时，控制面返回 204 仍阻止安装，Core 未被停止 |
| 安装失败恢复 | 测试专用 NSIS hook 返回 77 后，helper 恢复旧 Desktop，Core cn.3 重新运行 |
| 壳正常升级 | 原生“立即重启安装”按钮触发 0.9.0 → 0.9.1 测试候选；重启后真实壳版本为 `0.9.1-prototype.local.1`，Core cn.3 正常运行 |

失败恢复和成功升级后，配置 SHA-256、中文 sentinel 和 45 条已有历史消息保持；原日常安装登记仍为 `0.8.1-prototype.592.7.1.2` 及原用户目录。本轮验收安装使用独立产品名 `Hermes v090 Acceptance` 和 `C:\HermesV090\Desktop App`，同时验证含空格的当前目录安装参数。证据包括 `shell-data-failure.json`、`shell-data-upgraded.json`、`v090-shell-after-upgrade-check.json`、`v090-shell-after-upgrade-runtime.json`。

## 构建产物与发布边界

最终 Runtime ZIP：`hermes-agent-cn-runtime-win32-x64-0.21.0-cn.3.zip`，177975129 字节，SHA-256 `71c6c59769709d179773c3c468da419df4063af07e237a86eb3f84a078344492`，5333 个文件，解压总计 345015343 字节。

最终 Windows 安装器：`Hermes v090 Acceptance_0.9.0_x64-setup.exe`，158550289 字节，SHA-256 `c99c23bd9289b23bf44147f13741a0eb7412dce253739f861a69161032dabace`。本地可用产物位于 `artifacts/v0.9.0-windows-local/`，包含安装器、测试签名、Core ZIP、验收 manifest 和 SHA 索引。

最终安装包另以空的 `C:\HermesV090\desktop-final-clean` 启动，并移除外部 bundled-runtime/Dashboard/skills/plugins 路径覆盖。真实 `current.json` 的来源为 `bundled`，Runtime 为 cn.3、提交为 `0419cae3ecf3…`；壳版本为 0.9.0，随包 UI 为 `55c6`，没有热更 UI 标记，原生聊天成功。证据为 `v090-final-clean-check.json` 和 `v090-windows-final-installed.png`。

安装后的 EXE 与构建目录 EXE 仅有 Tauri 的 3 字节 bundle 类型标记差异（`UNK → NSS`），记录于 `v090-installed-exe-provenance.json`；安装器及 Core ZIP 下载回本地后重新核对 SHA-256 一致。

Windows 使用 Python 3.14.6、uv 0.12.10、随附 Node.js 22.22.0。验收构建关闭 LTO 并使用独立测试签名；生产发布配置及公钥保留原值。本地 `0.9.1-prototype.local.1` 仅作为验证跨版本安装的候选，不是拟发布版本。

没有执行 macOS/Linux 安装包 E2E、真实外部付费模型调用、生产分发或 Authenticode 发布签名。正式发布需使用已有生产签名与发布流程，本报告不代表已发布到用户端。

## 环境收尾

测试计划任务 `HermesV090Acceptance` 已注销；本轮 Desktop、受管 Core、模型 fixture、HTTPS fixture 均已停止，9120/19120/19123/19229/19443/19444 不再有测试监听。临时 CA 的精确指纹 `97BD9A621269EA13767B7204ED943AEE2DCA54F1` 已从信任根移除并确认不存在；本地 CDP SSH 隧道已关闭。没有更改系统 hosts 或系统代理，也未修改日常旧版的安装登记。详见 `v090-cleanup-windows.json`。

本轮安装包、隔离数据、源码副本及日志保留在 `C:\HermesV090`，便于复核；安装版若再次手动启动，应继续显式使用独立 `HERMES_DESKTOP_RUNTIME_ROOT`。工作区中的验收报告提交不改变上述已验证二进制的代码 SHA。
