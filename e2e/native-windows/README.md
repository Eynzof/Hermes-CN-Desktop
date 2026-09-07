# Windows 安装版真实模型端到端验收

目标是覆盖当前社区桌面版的全部功能。页面能打开、接口返回 200 或模型回答里出现标记，都不能单独判定功能通过。

第一阶段通过安装版 WebView2 和 Windows 原生窗口采集界面、实际操作并定位缺陷；第二阶段把这些操作变成可以独立重复运行的脚本。`coverage-catalog.json` 是功能工作流清单，`route-catalog.json` 对照实际路由。未实现脚本、缺少账号、未运行或失败的项目必须继续列出，不能把截图当作通过，也不能把一个冒烟测试当成完整验收。

## 当前基线

具体版本、Desktop/Core 提交及安装版 EXE 摘要见 `baseline.json`。测试独立根目录默认是 `C:\HermesE2E`，使用独立 runtime、HERMES_HOME 和工作区。托管 API 使用 9120，WebView2 CDP 使用 19229。测试在 Windows 上执行，连接已安装的原生应用，不启动 Vite，不替换模型接口。

唯一默认模型是 DeepSeek 官方 `deepseek-v4-flash`。模型配置测试通过 UI 保存真实凭证并探测；对话测试核对 SQLite 中的模型、计费来源、Token、消息和 Core 回合结束日志。工具测试还检查实际文件。MCP 等测试服务是有明确行为的本地真实服务，用于验证第三方协议，不伪造模型或 Hermes 后端。

密钥放在 `C:\HermesE2E\secrets\deepseek.env`，内容为 `DEEPSEEK_API_KEY=...`，不放入仓库、命令行参数或报告。启动脚本设置仅当前测试用户和 SYSTEM 可读的 ACL。测试截图遮盖密码输入，文本附件清除本次密钥，关闭包含输入参数的 trace。

## Windows 执行

需要交互式登录的 Windows 桌面、已安装且匹配基线的 Hermes、Node.js、pnpm 和 Python。当前主机的具体路径在启动脚本默认参数中，可通过参数/环境变量覆盖；不要通过修改基线来掩盖误用了其他安装包。

```powershell
Set-Location C:\HermesE2E\native-windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1
# 每次运行保留独立目录；此命令执行当前已实现的工作流。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run.ps1
# 定位一个功能，只跑相应工作流。可用正则；含 | 时应从 PowerShell 内调用。
& scripts/run.ps1 -Case 'CHAT-002|MCP-001'
# 完整发布门槛：清单中存在失败、未运行或缺前置条件时退出非零。
& scripts/run.ps1 -RequireComplete
# 仅页面观察，不计功能通过。
node scripts/inventory.mjs
# 看板功能使用另一个安装版 Chrome 的独立测试档案（CDP 19230）。
& scripts/start-test-browser.ps1
# Hindsight 真服务：固定镜像摘要、独立数据库和向量模型，端口 18888/19999。
& scripts/start-hindsight.ps1
# 导出每个流程最近一次结果对应的完整证据包。
& scripts/export-evidence.ps1
```

`start.ps1` 通过交互式计划任务启动独立测试进程，不接管日常安装实例。端口被占用时先报告进程，不自动杀进程。测试串行运行、零自动重试；发现失败后先保留证据，再区分产品问题和脚本问题。每次运行应使用 `scripts/run.ps1` 保存独立的报告目录，避免覆盖前次失败。

## 验收边界

- `MODEL/CHAT/MEM/...` 用例是功能验证；`inventory.mjs` 仅是页面观察，不计入通过数量。
- 飞书、微信真实收发需要测试账号及明确授权的接收者；其他账号服务也需要实际凭证。缺少时记录前置条件，不发送到猜测的接收者。
- `deepseek-v4-flash` 不支持图片理解，视觉模型另有明确授权后才能更换；默认保留不支持图片的负向验收。
- 语音、原生文件对话框、托盘、完整安装更新需要原生 Windows 证据，不能用 DOM 设置或接口替代这些操作后宣称通过。
- 本任务全部在本地和授权 Windows 主机进行，不推送、创建 PR、操作 CI 或发布版本。

## 证据与当前进度

2026-09-07 已采集 42 个实际页面，正在将逐项操作转为脚本。最新清单以 `C:\HermesE2E\reports\coverage.md` 为准；它按安装版基线汇总每项工作流最近一次结果，属于累积进度，不能代替同一轮全量结果。

每轮 `reports/runs/<UTC>/` 包含安装版摘要、Desktop/Core 版本与提交、`framework-manifest.json`（脚本逐文件 SHA256）、Playwright JSON/HTML/JUnit、截图与断言附件。对话附件核对 UI 会话 ID 到 Core Agent Session ID 的明确映射、SQLite 中的真实计费来源和 Token、工具回执及回合完成日志。MCP 另有服务自身调用记录，文件工具另核对磁盘内容。失败时额外保留 Windows 全屏，原生文件对话框也通过系统窗口和控件操作。

`defects.md` 区分产品问题与脚本问题。当前已确认备份未包含 state.db 聊天历史、重复恢复同名档案未清除 Core 删除标记、默认 Edge TTS 缺少冻结包依赖，以及 Build 对必需技能的提示不一致。间歇性的冷启动和档案重连问题继续保留回归，不用自动重试把失败变绿。

运行环境与数据留在隔离目录。`SHELL-003` 读取并点击原生托盘的“退出 Hermes”，验证 Desktop 与内核结束，再冷启动、立即真实发送并恢复旧会话。启动器不注入进程级 DeepSeek Key，以便测试每个档案自身保存的凭证。停止脚本默认尝试关闭主窗口，而应用设计会隐藏到托盘；需要彻底退出时使用实际托盘退出，或显式 `scripts/stop.ps1 -Force` 终止本测试进程树。强制结束不是正常退出验收。重启不清除 runtime、密钥、数据库或报告。

项目和文件用例创建没有 remote 的独立 Git 仓库，测试暂存、还原与本地提交。通知用例核对 Windows 通知数据库中新产生、且注册标识为 `cn.org.hermesagent.desktop` 的记录。HTTP MCP 和网页监控服务均绑定 Windows 回环地址，测试结束关闭服务；不会把其他项目或消息接收者作为测试目标。

完整覆盖仍在实施中。现有脚本全绿也不代表全部功能验收完成；未编写、未运行、外部账号待提供和已发现产品缺陷都必须继续列出。

清单现已拆分为 91 个必测工作流。列表刷新、失败重试、终端尺寸、外链、通知实际策略等子功能有独立用例编号，原用例通过不能代替这些待测项。`--list` 只报告收集到的脚本数量，不记录执行通过。

Hindsight 固定为 0.4.9 镜像（摘要写在启动脚本中），通过该版本的 OpenAI 兼容适配器直连 DeepSeek 官方 `/v1`，模型仍为 `deepseek-v4-flash`。嵌入使用真实 `BAAI/bge-small-en-v1.5`，重排使用 FlashRank；命名卷只属于本框架。首次启动需要下载镜像和模型。启动脚本不以容器存活冒充健康，执行 HS-001 前应确认 `http://127.0.0.1:18888/health` 的数据库状态。测试使用独立 Hermes 档案和唯一 Hindsight Bank，实际调用 retain/recall，并检查服务端成功模型调用计数增长。Bank 留在隔离数据库中供回溯。

证据包包含真实桌面截图，属于本地测试材料。不要把它当作公开发布附件。导出仅选择清单中最近结果的报告，不包含密钥目录和配置备份 ZIP。
