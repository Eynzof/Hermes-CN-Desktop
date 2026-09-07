# v0.9.0 Windows 修复验收

2026-09-08（北京时间）完成：**89 个必需工作流全部通过，4 个用户豁免，8 个随功能隐藏移出范围**。覆盖检查 `--require-complete` 返回 0，`complete=true`。第二阶段全部由脚本执行，无人工接管测试步骤。

## 精确产品基线

| 项目 | 验收输入 |
|---|---|
| Desktop | 0.9.0，5328dee023e32b468d227fcd18834c0365a65875 |
| Core | 0.21.0，92d532982c23627ccd7defe88519c462cbbb3656 |
| Runtime | 0.21.0-cn.10，schema 2，Windows x64 |
| 官方上游 | v2026.8.31 / v0.21.0，29112bef099274229cadff79cdff7bf7b99c4b77 |
| 默认模型 | DeepSeek 官方 deepseek-v4-flash，https://api.deepseek.com/v1 |
| Windows 安装 EXE SHA256 | fd3ebae91731b933a6707070192b2a3913620153c663fd1f2ca9296c65a069ac |
| NSIS 安装器 SHA256 | 16751b4814dfd90994df3bd443d24569cdb97a2bd8497acf3f507293ff552663 |
| Core ZIP SHA256 | 5daa85d5b3974f2a0ab0202d3bf3d5e173375301124e6fc7c29c895f565a5cbc |

产品源码提交固定在 [baseline.json](../e2e/native-windows/baseline.json)。后续测试与文档提交不会改变上述安装包源码身份。官方上游提交已经是当前 Core 的祖先；本次所有操作仅在本地和获授权的 Windows 机器进行。

## 修复与功能范围

- 新版关键界面包括定时任务编辑、运行记忆、网页变化监控，运行中子 Agent 追加指令与停止，以及完整 MCP 服务授权管理；低频高级选项仍由 Core 工具/API 提供。完整取舍见 [版本说明](release-v0.9.0.md)。
- 隐藏 Wander Memory、Wanderminds 账号相关导航、命令与直达入口。模型供应商授权和远程 Core 通用认证继续保留。
- 修复备份中的 SQLite WAL 一致性和恢复已删除档案；内核重启、崩溃恢复、旧会话重连；默认模型同步与 MoA 预热竞争；技能复制入口；原生图片路由和视觉工具缓存。
- 修复 MCP 目录阻塞终端输入、空默认工具、带空格路径、取消竞争和授权后对话工具未加载；补齐冻结语音、邮件等依赖。
- 修复 Runtime 更新解压容量、UI 更新/回退时序与版本校验；保留签名、SHA256、兼容矩阵及防降级校验。

逐轮缺陷、源码回归及失败原始记录见 [修复过程](e2e-fixes-progress.md)。

## 验收方法与边界

安装版 WebView2、Windows UIA、原生文件对话框、剪贴板、托盘和实际 NSIS 更新器均由脚本操作；通过 SQLite、Core 日志、真实文件、外部服务调用和音频采集核对结果。没有用回答中的标记替代工具执行证据，也没有自动重试将失败改为通过。

- 主流程连接 DeepSeek 官方服务。MODEL-009 使用固定 Qwen3.5 0.8B 进行本地无 Key / 64K 推理；CHAT-013 使用固定 Qwen3.5 4B 进行随机图片识别，并由官方主模型调用本地辅助视觉。0.8B 在完整 Agent 上下文中误用 read_file 的失败保留；服务日志已证实原生图片实际解码，不能据此重新归为丢图。
- MCP OAuth 使用本地真实身份与 SDK 服务，验证取消重试、注册工具调用、120 秒自然过期、刷新轮换和退出清理。微信二维码按官方实际时限等待约 8 分钟，验证自然过期、自动刷新和最终停止轮询。
- VOICE-002 经过 SAPI 音源、VB-CABLE 实际录音、Desktop MediaRecorder、Whisper 和官方模型；SET-006 采集真实 WASAPI 提示音，并验证声音关闭、前台抑制、后台完成与审批提醒。
- Runtime、UI 和整包更新连接本机 HTTPS 测试服务。候选 Runtime cn.11 复用确切 cn.10 内核归档，整包候选 0.9.1-prototype.local.5 复用修复后源码；验证的是实际下载、签名拒绝、安装、回退、进程重启和会话恢复链路，不代表另一版本内核的功能验收。
- 用户豁免 MODEL-006（账号 OAuth 登录持久化/登出）、CRON-003（外部定时投递）、IM-FEISHU-001、IM-WEIXIN-001（真实登录及收发）；WANDER-001 至 008 随功能隐藏移出范围，由 SHELL-006 验证隐藏。

当前安装器是独立 Acceptance 构建，使用测试签名公钥和本机短期 TLS 信任；不是正式签名分发包。本任务没有执行 push、PR、CI、公开 Release 或 Landing 更新。正式发布需要另行生成正式签名产物并验证其最终字节。

## 复跑与证据

框架：Windows 的 C:/HermesE2E/native-windows；源码说明见 [Windows E2E README](../e2e/native-windows/README.md)。在交互式 Windows 用户会话内执行：

```powershell
& C:\HermesE2E\native-windows\scripts\prepare-services.ps1
& C:\HermesE2E\native-windows\scripts\start.ps1
& C:\HermesE2E\native-windows\scripts\run.ps1 -RequireComplete
# 定位失败后只运行相应流程；也可用 -Remaining 续跑同一基线缺项。
& C:\HermesE2E\native-windows\scripts\run.ps1 -Case 'CHAT-013\b'
& C:\HermesE2E\native-windows\scripts\export-evidence.ps1
```

每轮包含安装摘要、脚本逐文件 SHA256 和精确源码快照、JSON/HTML/JUnit、截图及断言附件。覆盖率按同一产品基线每项最近一次完整结果累计，不是声称单轮连续执行所有用例。中断、失败和未运行不计通过。

安装包已取回本机 CNDesktop/artifacts/v0.9.0-windows-cn10-local/，包含安装器、签名、Core ZIP、manifest、baseline、artifact-index、SHA256SUMS 和 coverage；两台机器独立计算摘要一致。

最终证据包：Windows `C:/HermesE2E/reports/exports/20260907T192218Z.zip`，本机 `CNDesktop/artifacts/windows-e2e/evidence-cn10-final.zip`；SHA256 `1661184b63e4604a08c1b5000e88375816f3333439217d664c1550d11a2277e5`，186,800,799 字节。共 11 个运行目录、1,848 个文件，另在同名目录完整解压。包含最近结果所需运行，以及整包候选版本断言和视觉语言断言的两份失败补充记录。

最后的 CHAT-013 在 `20260907T191909Z` 运行中通过（135.6 秒）。原生识图要求零工具调用；辅助识图要求主模型为官方 DeepSeek、唯一业务工具为 vision_analyze；中英文颜色名称等价规范化后仍逐个比较随机像素位置。MCP-002 的最新严格工具名与服务进程树清理复测为 `20260907T190535Z`（36.5 秒）。

## 测试机收尾

已恢复 Desktop 0.9.0、Runtime cn.10、内置 UI、官方 DeepSeek、1M 上下文、自动图片模式和自动辅助视觉槽位，并核对实际 EXE、Runtime 归档摘要及源码提交。应用经真实托盘正常退出；专用 Chrome、UIA、Runtime/UI/整包更新、Wander 服务及三个测试容器均已停止，相关监听端口为空，两个临时 CA 已按确切指纹移除。原应用数据、测试证据、服务数据卷和模型保留供复跑。

上轮中断遗留的唯一测试 cron 已从 Desktop UI 删除，任务列表为空。VB-CABLE 已安装且实录验收通过；完成提示窗口没有正常退出，确认确切安装器路径后只结束其已完成进程，没有重启 Windows。音频默认输入保留为 CABLE Output，默认播放保留 Steam Streaming Speakers，驱动作为测试前置设施保留。

清理记录：Windows `C:/HermesV090Fixes/artifacts/r5-final-cleanup.json`，本机 `CNDesktop/artifacts/windows-e2e/r5-final-cleanup.json`；恢复前核验见相邻 `r5-final-state.json`，cron 清理见 `r5-cron-cleanup.json`。这些是最终验收后的环境记录，不修改原始运行报告。
