# Windows 安装版真实模型端到端验收

目标是覆盖当前社区桌面版的全部功能。页面能打开、接口返回 200 或模型回答里出现标记，都不能单独判定功能通过。

第一阶段通过安装版 WebView2 和 Windows 原生窗口采集界面、实际操作并定位缺陷；第二阶段把这些操作变成可以独立重复运行的脚本。`coverage-catalog.json` 是功能工作流清单，`route-catalog.json` 对照实际路由。未实现脚本、缺少账号、未运行或失败的项目必须继续列出，不能把截图当作通过，也不能把一个冒烟测试当成完整验收。

## 当前基线

2026-09-09 更新专项基线已切到 Desktop 0.9.0 / Core 0.21.0-cn.12，四项 RUNTIME 工作流在此安装包上通过。历史 cn.10 的 89 项全功能结果仍保留，本轮没有全量重跑。更新实现、精确产物和发布阻塞见 [软件更新验收报告](../../docs/v0.9.0-software-update-acceptance.md)。

本轮可执行 `scripts/run.ps1 -Case 'RUNTIME-00[1-4]'` 复跑离线、Core、UI 和整包流程；沿用交互式计划任务、真实模型和本地签名更新服务。测试报告里的 `ux-runtime-4`、`ux-ui-1`、`ux-offline-1`、`ux-shell-4` 为本轮通过记录。软件更新页面是普通入口，原组件操作位于默认收起的高级更新选项。

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
# 默认首次失败即停止，保留完整报告；只续跑相同安装基线尚未通过的必需项。
& scripts/run.ps1 -Remaining
# 排查时若明确需要继续收集后续失败，可指定 -MaxFailures 0。
# 完整发布门槛：清单中存在失败、未运行或缺前置条件时退出非零。
& scripts/run.ps1 -RequireComplete
# 仅页面观察，不计功能通过。
node scripts/inventory.mjs
# 看板功能使用另一个安装版 Chrome 的独立测试档案（CDP 19230）。
& scripts/start-test-browser.ps1
# Hindsight 真服务：固定镜像摘要、独立数据库和向量模型，端口 18888/19999。
& scripts/start-hindsight.ps1
# 后续复跑前统一准备三个固定版本服务，已存在的专用数据卷继续保留。
& scripts/prepare-services.ps1
# 导出每个流程最近一次结果对应的完整证据包。
& scripts/export-evidence.ps1
```

`start.ps1` 通过交互式计划任务启动独立测试进程，不接管日常安装实例。端口被占用时先报告进程，不自动杀进程。测试串行运行、零自动重试；发现失败后先保留证据，再区分产品问题和脚本问题。每次运行应使用 `scripts/run.ps1` 保存独立的报告目录，避免覆盖前次失败。

## 验收边界

- `MODEL/CHAT/MEM/...` 用例是功能验证；`inventory.mjs` 仅是页面观察，不计入通过数量。
- 飞书、微信真实收发需要测试账号及明确授权的接收者；其他账号服务也需要实际凭证。缺少时记录前置条件，不发送到猜测的接收者。
- 主流程使用官方 `deepseek-v4-flash`；本地部署专项使用隔离 Ollama 中的真实 Qwen3.5 0.8B，图片专项使用固定摘要的 Qwen3.5 4B（专用容器内存 12 GiB）。用户的完整测试机操作授权已覆盖该测试设施准备，结束后恢复官方主模型。
- 语音、原生文件对话框、托盘、完整安装更新需要原生 Windows 证据，不能用 DOM 设置或接口替代这些操作后宣称通过。
- 本任务全部在本地和授权 Windows 主机进行，不推送、创建 PR、操作 CI 或发布版本。

## 证据与当前进度

第一阶段已采集 42 个实际页面并通过视觉和原生控件操作定位问题；第二阶段当前 89 个必需工作流已全部由脚本在 cn.10 安装包上验收通过（2026-09-08），另有 4 项用户豁免、8 项随功能隐藏移出范围。结论及证据索引见 [最终验收报告](../../docs/e2e-fixes-acceptance.md)。最新清单位于 `C:\HermesE2E\reports\coverage.md`；它按精确安装版基线汇总每项最近一次结果，属于累积覆盖，不宣称单轮连续执行全部用例。

每轮 `reports/runs/<UTC>/` 包含安装版摘要、Desktop/Core 版本与提交、`framework-manifest.json`（脚本逐文件 SHA256；新运行另存 `framework-source/` 精确源码快照）、Playwright JSON/HTML/JUnit、截图与断言附件。对话附件核对 UI 会话 ID 到 Core Agent Session ID 的明确映射、SQLite 中的真实计费来源和 Token、工具回执及回合完成日志。MCP 另有服务自身调用记录，文件工具另核对磁盘内容。失败时额外保留 Windows 全屏，原生文件对话框也通过系统窗口和控件操作。

`defects.md` 区分产品问题与脚本问题，保留原始发现证据。备份、生命周期、模型、MCP 和冻结依赖等后续修复及验证见 [修复进度](../../docs/e2e-fixes-progress.md)。间歇性的冷启动和档案重连仍保留独立回归，不用自动重试把失败变绿。

运行环境与数据留在隔离目录。`SHELL-003` 读取并点击原生托盘的“退出 Hermes”，验证 Desktop 与内核结束，再冷启动、立即真实发送并恢复旧会话。启动器不注入进程级 DeepSeek Key，以便测试每个档案自身保存的凭证。停止脚本默认尝试关闭主窗口，而应用设计会隐藏到托盘；需要彻底退出时使用实际托盘退出，或显式 `scripts/stop.ps1 -Force` 终止本测试进程树。强制结束不是正常退出验收。重启不清除 runtime、密钥、数据库或报告。

项目和文件用例创建没有 remote 的独立 Git 仓库，测试暂存、还原与本地提交。通知用例核对 Windows 通知数据库中新产生、且注册标识为 `cn.org.hermesagent.desktop` 的记录。HTTP MCP 和网页监控服务均绑定 Windows 回环地址，测试结束关闭服务；不会把其他项目或消息接收者作为测试目标。

只有 coverage-catalog.json 中所有必需项在相同产物基线上通过，完整验收才算完成。用户已豁免 MODEL-006、CRON-003、IM-FEISHU-001、IM-WEIXIN-001；隐藏的 WANDER-001 至 008 由 SHELL-006 验证入口和直达路径隐藏，不再启动对应服务或执行其功能用例。

列表刷新、失败重试、终端尺寸、外链、通知实际策略等子功能有独立用例编号，原用例通过不能代替这些专项。`--list` 只报告收集到的脚本数量，不记录执行通过。以下带旧 run ID 的段落记录历史诊断，不能代替当前 coverage 结果。

Hindsight 固定为 0.4.9 镜像（摘要写在启动脚本中），通过该版本的 OpenAI 兼容适配器直连 DeepSeek 官方 `/v1`，模型仍为 `deepseek-v4-flash`。嵌入使用真实 `BAAI/bge-small-en-v1.5`，重排使用 FlashRank；命名卷只属于本框架。首次启动需要下载镜像和模型。启动脚本不以容器存活冒充健康，执行 HS-001 前应确认 `http://127.0.0.1:18888/health` 的数据库状态。测试使用独立 Hermes 档案和唯一 Hindsight Bank，实际调用 retain/recall，并检查服务端成功模型调用计数增长。Bank 留在隔离数据库中供回溯。

证据包包含真实桌面截图，属于本地测试材料。不要把它当作公开发布附件。导出默认选择清单中最近结果的报告，可用 `-IncludeRun` 额外保留缺陷分析引用的早期运行；不包含密钥目录和配置备份 ZIP。

当前 Windows 包是独立 Acceptance 构建，productName 为 Hermes v090 Acceptance，启用 reqwest/rustls-tls-native-roots 以信任本机短期 TLS 证书，并使用测试签名公钥。EXE 的 SHA256 固定在基线中；它不是正式分发包。签名流程可以在这个包中真实验证，但正式发布包仍需用正式签名和最终字节复验。

签名 Runtime/UI 更新用例会调用 `scripts/prepare-update-service.ps1`（使用 Acceptance 包原有测试签名密钥），并在需要时通过真实托盘退出再以 `scripts/start.ps1 -UpdateFixture` 启动。更新服务只绑定 `127.0.0.1:19445`，Runtime 候选复用已安装 Core 的确切归档字节，UI 候选仅增加可读取的版本标记。清单签名及下载校验仍由产品执行。全部更新测试结束后可正常退出并以默认启动脚本恢复，再运行 `scripts/stop-update-fixture.ps1` 删除该服务及精确指纹的短期证书；文件和失败证据保留。不要设置只含测试 CA 的 `SSL_CERT_FILE`，否则 Core 会拒绝真实 DeepSeek 的公共证书链。

OpenViking 使用固定 v0.4.17.1 镜像和独立数据卷。依次执行 `scripts/start-ollama.ps1`、`scripts/start-openviking.ps1`、`scripts/initialize-openviking.ps1`；后者将 tenant 凭证写入 secrets/openviking-client.json，不能把服务 root key 填到 Desktop 的记忆客户端。嵌入为真实本地 nomic-embed-text:v1.5，提取与对话仍用 DeepSeek flash；服务端口 19333，Ollama 11435。MEMCFG-001 同时验证外置记忆停用后配置保留。

CODE-001 使用已安装的真实 Claude Code CLI，将 DeepSeek Anthropic 兼容接口配置写入唯一的 secrets/claude/<case>/settings.json，所有模型档位均设为 flash。CLI 配置与用户个人账号隔离，验证生成文件的实际执行结果、CLI 流式回执和界面委派卡片。SET-005 为外部 Core 创建独立私有数据目录，测试本地自动令牌和远程模式手动令牌；后者使用回环服务验证协议，不代表跨机器网络或第三方 OAuth 已通过。

SET-006 使用 PyAudioWPatch 0.2.12.8 采集短时间的真实 WASAPI 扬声器输出，并与静音基线、关闭提示音后的输出比较。音频附件与桌面截图一样仅作为本地测试材料。依赖版本写入 requirements 和锁定文件。

RUNTIME-004 在流程内启动专用的 19446 回环代理，仅接受两个更新主机名，不转发其他目标。HTTPS_PROXY 只传给这次测试 Desktop，DeepSeek 通过 NO_PROXY 直连；不改 hosts、系统代理或公共服务。短期 CA 带两个域名的约束，私钥在 secrets 中，结束后删除精确证书指纹。候选使用已存在的真实 Tauri 签名 NSIS 文件，验证错误签名、摘要拒绝、取消、稍后安装、授权撤回、实际自动重启和旧会话续聊。finally 用原 NSIS 恢复 0.9.0 并核对原 EXE 摘要，保留测试数据。候选版本、安装器和 EXE 哈希以 baseline.json 的 shellUpdateCandidate 为准，不属于正式发布。

VOICE-002 使用测试机单独安装的 VB-CABLE Pack45 驱动对（不打入 Desktop 安装器）：Windows SAPI 生成测试句，向虚拟输出播放，并从实际输入端录音校准，再由 Desktop 的 MediaRecorder 录制和 STT 转写。采集与输出采用 48 kHz 双声道，测试默认输入为 CABLE Output；默认播放仍为原扬声器。脚本校验设备格式，找不到指定输入输出对时不会伪造音频。Steam 虚拟输入曾在实录中失真，已排除出验收夹具。WebView2 的原生麦克风授权弹窗通过真实 HWND 和 UIA 控件处理；界面外的校准录音不代表 Desktop 转写已通过。

整包更新 RUNTIME-004 在旧基线 runs/20260907T093139Z 完整通过，包含更新器自动启动新版本、原会话真实续聊和原安装版自动恢复。失败探索记录全部保留，新基线需要重新执行；候选和原安装器的确切摘要由 baseline.json 固定。

失败后恢复测试基线与功能通过是两个不同结果。流程中的软断言仅用于继续收集同一功能的后续步骤，整项仍标为 failed；同一次操作没有自动重试。外部连接的首次失败和显式再次发送分别留证。进程故障注入仅针对已核对 PID 和可执行路径的测试 Core，不结束用户的其他应用。

Wander 已从本轮产品范围隐藏。历史 MemOS 依赖、脚本和证据保留供追溯，详见 `wander-coverage-audit.md` 和 `wander-baseline.json`，当前运行流程不准备或启动这些服务。

Wander 用例只连接本框架新建的独立 MemOS 数据目录，开始前先保存库存快照，再通过实际界面删除上一项遗留的测试事实；每次结束另保存库存，SQLite 版本记录继续保留。这避免对话提取产生不含用例标记的事实后污染下一项冲突合并。六项主流程在 runs/20260907T102700Z 同轮通过，Escape 取消实际失败并保留为 WIN-022。

MCP OAuth 使用框架自有的真实 SDK 服务和一次性身份，无需外部账号。`run.ps1 -Case MCP-004` 自动验证服务本身，再从 Desktop 完成添加、探测、取消后重试、授权、真实模型调用、自然过期后的刷新、退出和删除。模型必须命中注册 MCP 工具，只允许附带 tool_search/tool_describe 发现步骤，不能用终端或文件操作代替。cn.10 的 runs/20260907T180716Z 已完整通过；服务自检不计为 Desktop 通过。原始缺陷边界见 `mcp-oauth-coverage-audit.md`。

模型 OAuth 的账号登录与登出仍为 MODEL-006；无需账号的官方设备码和取消拆为 MODEL-010。`run.ps1 -Case MODEL-010` 使用真实 Nous Portal，验证设备码、剪贴板、原生浏览器、正常取消和发起中关闭。105653Z 的正常取消通过，发起中关闭留下 pending 会话并迟到打开验证页，整项保留为失败（WIN-024）。详见 `model-oauth-coverage-audit.md`。

消息平台的扫码前步骤不需要账号：`run.ps1 -Case 'IM-(FEISHU|WEIXIN)-002'` 使用官方二维码、实际渲染像素和系统剪贴板，验证生成、解码、复制、重新生成和离页停止轮询；不点击扫码确认或保存凭据。飞书在 111109Z 通过，微信在 111550Z 保留 15 秒超时缺陷 WIN-025，其余步骤完成。测试用 `jsqr@1.4.0` 和 `pngjs@7.0.0` 独立解码屏幕像素，精确版本和完整性写入 pnpm 锁文件。

`run.ps1 -Case IM-WEIXIN-003` 实际等待约 8 分钟验证自然过期；111854Z 记录三次自动刷新和最终过期停止，整项通过。不会模拟时钟或接口；已有普通长轮询超时仍记录于独立失败用例。具体边界见 `im-qr-coverage-audit.md`。完整验收仍未完成，累计数量以导出的 coverage.md 为准。

失败后的步骤复核见 `failure-continuation-audit.md`。114227Z 重新执行备份和四项生命周期；114633Z、114905Z 分别独立核对停机与卸载的异常退出。新增失败后的磁盘证据，并把原会话续聊改为从真实历史列表点击；新入口仍受前面的产品退出问题阻挡，不能宣称已验证。备份检查不再把 request_dump 文件误称为会话备份，最终以真实恢复结果判断。

本地推理与图片专项执行 `run.ps1 -Case 'MODEL-009|CHAT-013'`，自动准备固定摘要的 `qwen3.5:0.8b`，在专用 Ollama 11435 创建 `hermes-e2e-qwen35:0.8b-64k`（实际 65536 上下文、8 CPU、4 GB 容器内存）。不会替换模型返回。首轮下载约 1 GB；完整出处和实际加载信息附在报告中。图片是无文字、随机排列的四色色块，文件名是 UUID，答案不进入模型提示；经 Windows 原生文件选择器上传，并检查实际识别、调用工具和计费来源。辅助识图仍由官方 DeepSeek 发起，视觉请求才发往本地模型。复核和失败边界见 `local-vision-coverage-audit.md`。

当前缺陷修复与逐轮安装包、实机通过记录见 [修复进度](../../docs/e2e-fixes-progress.md)。原有日期段落保留历史证据，不代表当前构建全部通过。Wander Memory/账号功能已隐藏，四项外部账号与消息投递由用户豁免，具体范围以 coverage-catalog.json 为准。
