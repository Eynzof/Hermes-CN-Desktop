# Windows 真实模型测试缺陷台账

基线：Desktop 0.9.0 / 55c672ce，Core 0419cae3 / 0.21.0-cn.3。原始证据保存在独立测试根目录 reports，仓库不保存密钥和运行数据库。

| ID | 类别 | 现象与证据 | 当前状态 |
|---|---|---|---|
| WIN-001 | 待复现产品问题 | 首次发送停留首页并出现 WebSocket connection failed；Core 后来建立 relay 连接。相同安装版后续真实发送成功。证据 real-model-first.log、phase1-first-window.png。 | 保留冷启动验收，尚未修复 |
| WIN-002 | 配置可见性 | 仅通过 DEEPSEEK_API_KEY 进程环境提供凭证时，实际对话成功，但模型页显示需要初始化、健康项显示缺少凭证。通过 UI 保存后模型页恢复。 | 待确定预期和对应回归 |
| WIN-003 | 冻结包依赖 | 启动日志 email-platform 缺少 email.mime，photon-platform 缺少 filecmp；另有 Nemo Relay 初始化缺少 nemo_relay。 | 已捕获，需逐项确认受影响的可见功能 |
| WIN-004 | 可访问性 | 内置记忆删除按钮没有可访问名称，截图显示垃圾桶图标；当前脚本需限定到记忆卡片定位无名按钮。 | 未修复 |
| WIN-005 | 高优先级数据完整性 | 备份 UI 承诺包含会话历史，但真实导出的 ZIP 主动排除了 state.db，且 sessions/ 为空。代码仍假定会话保存在 sessions/，manifest 却固定声明 includesSessions=true。当前真实对话都在 state.db。证据 runs/20260907T035929Z 的 BACKUP-001。 | 导出及恢复后历史损失均已确认；runs/20260907T040301Z 同时证明记忆恢复成功和会话恢复失败；保留失败断言 |
| WIN-006 | 可访问性 | 档案创建的“克隆来源”和“模型”标签没有关联 select，无可访问名称。 | 未修复，脚本按实际表单顺序定位 |
| WIN-007 | MCP 参数编辑 | 参数编辑器按空白分割且保留引号，不支持带空格的 Windows 路径；为无空格路径加常见引号也会启动失败。 | MCP-005 在 runs/20260907T075230Z 实际保存带空格路径并探测，返回 Connection closed；保留失败断言和落盘参数，普通无空格路径 MCP-001 已通过 |
| WIN-008 | 高优先级备份恢复 | 删除 restored-default 后重新导入同名档案，文件目录存在且 config.yaml 与原档案 SHA256 一致，但 /api/config 返回 500，模型信息变为空。v0.21 的 profiles/.deleted/restored-default 删除标记仍在；Rust install_staging_profile 只安装目录，未按 Core 的档案创建流程清除标记。 | 已由安装版 UI 及同一冻结内核独立复现；profile-diagnostic-20260907T044110Z/stderr.log 指向 assert_named_profile_home_live |
| WIN-009 | 档案切换后聊天阻塞 | 切回 default 后模型和健康页正常，但发送提示 backend version check has not completed，无法新建对话；WebView 重载后恢复。 | runs/20260907T042950Z 的 CHAT-006、CHAT-003、SKILL-002 连续复现；新增 PROF-002 专项回归；runs/20260907T044831Z 切回后真实聊天通过，当前归类为间歇问题，不自动重试掩盖失败 |
| WIN-010 | 可选语音依赖缺失 | 默认 Edge TTS 配置可保存，但实际朗读返回未配置可用的语音提供方；冻结内核的 edge_tts Python 依赖不可用。 | VOICE-001 表单通过，VOICE-003 真实合成未通过；不能把系统安装 Edge 浏览器当成 TTS 依赖已具备 |
| WIN-011 | Build 向导能力提示 | v0.21 将 hermes-agent 定义为 ESSENTIAL_SKILLS，不允许禁用；Desktop 向导仍允许取消勾选并承诺未选技能会禁用。生成后该技能仍启用，没有说明保护规则。 | PROF-003 多次复现；区分必需技能保护与普通技能禁用，保留界面断言 |
| WIN-012 | 定时运行历史覆盖 | 连续点击立即运行，13:42:22 的真实模型结果和同一秒内的 no_change 结果只有一份历史。Core cron/jobs.py 的 save_job_output 使用秒级文件名后 atomic_replace 覆盖。 | runs/20260907T054009Z CRON-002 已捕获；连续记忆主流程间隔到下一秒，快速重复的历史完整性另列待回归 |
| WIN-013 | 内核生命周期 | 在安装版内核页点击“停止内核”，停止状态已落盘，但 Desktop 主进程随后退出，预期的离线控制台未显示；CDP 和 API 均消失。 | RUNTIME-001 在 runs/20260907T065558Z、20260907T065935Z 连续复现，后次记录 Desktop PID 31724 退出码 0；重新启动应用可进入离线控制台并手动恢复内核，根因待确认 |
| WIN-014 | 网关重启反馈 | 内核页点击“重启 Gateway”后显示 backend version check has not completed，未向真实 Gateway 发起成功操作。刷新网关地址使版本状态失效后，紧接的 postJSON 仍受版本门禁阻止。 | runs/20260907T070200Z 的 RUNTIME-005 已捕获界面反馈；需复验修正后的 Gateway 成功态断言，不以 Dashboard PID 代替 Gateway 状态 |
| WIN-015 | 内核热更新后会话恢复 | 实际签名更新完成，Core 已运行候选版本 .4，旧会话历史仍可见；发送原会话续聊却提示 session not found，输入留在编辑器，未产生新的模型调用。 | RUNTIME-002 runs/20260907T074015Z 已复现；更新和回滚后的续聊分别保留断言，不能只凭 current.json 或进程就判定更新通过 |
| WIN-016 | 生命周期状态不一致 | 前次停止状态留存时，通过 Runtime 回滚可以启动 Core，却未同步用户期望状态：同一内核页同时显示“本机内核正在运行”和“已停止”，backendReady=false。 | runs/20260907T073404Z 准备阶段超时，实际 PID 65736 / runtime .3；点击“启动内核”恢复一致，未修改产品代码 |
| WIN-017 | 高优先级界面回退 | 一次点击“回退”后，ui/current.json 在约 45ms 内从 e2e.2 → e2e.1 → e2e.2，最终实际页面仍是 e2e.2；网络记录中的 ui_rollback 在重载时 ERR_ABORTED，控制台报告 IPC 降级为 postMessage。 | RUNTIME-003 runs/20260907T075835Z 保留版本变更时间线、实际页面 meta、IPC 请求及真实任务证据；现象支持重载中 IPC 重发导致回退执行两次的判断。更新中 Core PID 不变、真实任务完成和回退后续聊均已验证，整体回退断言仍失败 |
| WIN-018 | MCP 目录缺失 | 安装版 /api/mcp/catalog 返回 entries=[]，v0.21 源码中的 optional-mcps 未进入冻结包，市场没有可安装条目。 | MCP-003 runs/20260907T080900Z；当前归档内部及版本根均无 optional-mcps，普通手动添加 MCP 已通过 |
| WIN-019 | 外部连接首次发送 | 本地外部 Core 的接口和 WebSocket 探测通过，界面显示连接正常，实际首次发送却在原生 WebSocket 握手中返回 403，降级后仍报 WebSocket connection failed。 | SET-005 runs/20260907T083648Z 保留首次失败；显式再次发送成功，远程模式错误令牌检测、正确令牌续聊及切回内置内核后真实发送均已完成，整体仍失败 |
| WIN-020 | 崩溃恢复状态不同步 | 强制结束已核对路径的测试 Core 后，Core 被重新拉起，Rust control.running/backendReady=true；界面 backendReady=false 并显示“已停止”，可点击的启动按钮返回“内核操作正在进行中”。 | SHELL-005 runs/20260907T083913Z；Desktop 进程保持不变、Core PID 更新，手动重载页面可恢复，自动恢复及原会话续聊尚未通过 |
| WIN-021 | 默认本地转写不可用 | WebView2 原生麦克风授权、MediaRecorder 录制和离开页面后释放音轨均成功；通过已校准的虚拟麦克风输入测试句，提交真实录音后，Core 返回未配置可用 STT 提供方。 | VOICE-002 runs/20260907T094008Z；输入校准、实际设备和转写错误均有附件。当前 stt.provider=local，未注入转写文本，后续文字发送因转写失败未完成；需排查冻结包中的本地识别依赖 |
| WIN-022 | Wander 聊天取消 | 页面提示 Escape 可取消等待，但生成时唯一绑定 onKeyDown 的输入框被 disabled。实际按键后没有 cancelled 标记，最终回复仍写入界面。 | WANDER-008 runs/20260907T102700Z 记录了发送后输入框禁用、实际 Escape 按键、真实 DeepSeek 完成及最终界面；两个取消断言失败，未修复 |
| WIN-023 | MCP OAuth 界面缺失 | 添加对话框没有认证方式，受保护的 HTTP MCP 返回 401 后仅显示错误，服务卡片没有授权入口；保存的 auth 为 null。Core 已有独立授权接口，但 Desktop 未接入。 | MCP-004 runs/20260907T104625Z 实际服务自检通过后，从安装版添加并探测；服务只收到 401 请求，没有 OAuth 握手。授权入口断言失败，后续登录、取消、刷新和退出尚未执行。详见 mcp-oauth-coverage-audit.md；未修复 |
| WIN-024 | OAuth 发起中关闭无效 | 启动请求尚未返回时关闭登录弹窗，没有 session ID 可取消；迟到响应仍创建 pending 会话并打开官方验证页。 | MODEL-010 runs/20260907T105653Z 使用 Nous 官方设备码：发起 34 ms 后关闭，1056 ms 后响应完成，查询会话仍 HTTP 200 / pending；正常等待设备码后取消则返回 404。整项保留失败，测试清理迟到会话且凭据摘要未变。详见 model-oauth-coverage-audit.md；未修复 |
| WIN-025 | 微信二维码状态检查超时 | Desktop 的共享 HTTP Client 总超时为 15 秒，而官方未扫码状态检查约 30 秒才正常返回 wait；页面轮询连续超时。Core 对同一二维码接口已使用 35 秒。 | IM-WEIXIN-002 runs/20260907T111109Z 连续三次约 15 秒失败；111550Z 自动诊断官方 HTTP 200 / wait / 30133 ms，安装版状态检查仍失败。后续重新生成和离页停止通过，整项保持失败。详见 im-qr-coverage-audit.md；未修复 |
| TEST-001 | 脚本 | UI 新会话短 ID 与 state.db 中 Agent Session ID 不同，最初不能取到持久化证据。 | 已按 Core 日志的明确映射修正 |
| TEST-002 | 脚本 | 工具参数包含 marker、第一轮 API 已累计 Token，原脚本仍在工具运行时检查文件，导致 ENOENT 误报。 | 已修正，真实文件读写复跑通过 |
| TEST-003 | 脚本 | 归档状态误读 Core 数据库，实际由 Desktop Rust 代理持久化；辅助会话查询 limit 超过 100。 | 已按真实来源修正，HIST-001 全流程通过 |
| TEST-004 | 脚本 | 把嵌入终端误认为 PowerShell；实际为 ComSpec/cmd.exe。MCP 服务初版引用旧 SDK FastMCP 路径。 | 已按实际运行环境修正，PTY-001 和 MCP-001 通过 |
| TEST-005 | 脚本 | 主题页控件可能在滚动区域下方，未滚动就要求在视口内。 | 已加入真实滚动，六种主题和全部缩放复跑通过 |
| TEST-006 | 原生对话框 | 目录选择是 Win32 文件夹输入控件，不接受普通文件保存对话框的 Alt+N/Alt+S；失败后原生弹窗可能遮挡后续页面。 | 已枚举实际控件并操作文件夹 Edit 和选择按钮；用例前检查未关闭的原生弹窗，失败时保存全屏并取消弹窗 |
| TEST-007 | 对比与操作预期 | 迁移说明包含实时采集时间和 Windows 剪贴板换行；批量删除成功后会自动退出选择模式。 | 仅归一化时间/换行；按实际删除后的状态断言，迁移及会话导出批删均通过 |
| TEST-008 | 模型交互与新版契约 | ModelCombobox 填写的是搜索词，必须点击候选或按 Enter 才提交；v0.21 会话思考档位写 session.model_config，不写全局 agent.reasoning_effort。已保存凭证的非当前平台按钮名称带“已保存密钥”。 | 已按实际交互确认模型，并读取数据库 reasoning_config；MODEL-002 全档位真实调用通过 |
| TEST-009 | 路由与引导时序 | 相同路由保留内部 tab/向导步骤；引导完成触发 WebView 重载，桥接对象暂时不存在。 | 各独立用例开始时先卸载上一个页面；引导等待真实 backendReady 和桥接对象；SHELL-002 通过 |
| TEST-010 | Windows 原生控件 | UIA IsOffscreen 不代表窗口已最小化；Win11 的通知/托盘 XAML 窗口可能缺席 UIA 根节点；托盘菜单没有 UIA 子元素，切换焦点后按键不保证选中菜单。 | 最小化改查 IsIconic，系统窗口先枚举 HWND；原生菜单读取文字和实时位置再点击，正常退出和重启通过 |
| TEST-011 | 压缩测试资料 | v0.21 摘要会原样保留用户消息；重复粘贴长用户输入，实际发出了摘要请求，却因 would_grow 被拒绝提交。 | 改用真实文件读取产生的长工具回执；保留用户暗号，CHAT-011 已完成真实压缩和压缩后续聊 |
| TEST-012 | 原生附件与弹窗清理 | 测试辅助器生成双反斜杠路径，原生选择器报告文件名无效；其子提示框不在 UIA 根节点里，第一次清理未能关闭。 | 路径改用 Join-Path，按当前应用 PID 枚举真实 HWND，先关闭已启用的子框再关闭父框；CHAT-007 在 runs/20260907T062502Z 通过 |
| TEST-013 | 固定版本服务适配 | 当前 Hindsight 文档的 deepseek provider 不适用于固定的 0.4.9 镜像；该版本用 OpenAI 兼容接口。空 pg0 Docker 卷初始为 root，不可写。 | 使用官方 DeepSeek /v1 和 flash，初始化专用卷为镜像实际 UID 1000；真实数据库、向量检索和模型指标通过，HS-001 runs/20260907T063407Z |
| TEST-014 | 浏览器加载时序 | 打开外部页面后两次读取窗口清单，Chrome 标题在其间变化，导致已通过等待后再次查找为空。 | 在轮询中保留实际匹配 HWND，再核对地址栏；KANBAN-001 runs/20260907T063005Z 通过 |
| TEST-015 | GUI 启动环境 | 启动器重定向 Desktop 的 stdout/stderr，外部 PowerShell 继承后把提示符写到 desktop.log；Hermes CLI 触发 NoConsoleScreenBufferError，实际终端黑屏。 | 启动器改为普通 GUI Start-Process，不重定向父级句柄；PTY-002 外部终端真实对话、环境与退出在 runs/20260907T065355Z 通过，Core 自身日志继续保留 |
| TEST-016 | 生命周期等待 | 卸载确认框实际为 dialog；完成操作后应用主动重载，提前读取桥接状态可命中 Execution context was destroyed。 | 改为先订阅真实 load 事件、完成后读取状态；Desktop 进程退出另按 WIN-013 保留，不用重试掩盖 |
| TEST-017 | 更新证书隔离 | 新公钥会同时导致旧内嵌 Runtime 验签失败；只含本地 CA 的 SSL_CERT_FILE 被 Core 继承后，真实 DeepSeek 连接报 CERTIFICATE_VERIFY_FAILED。 | 更新服务复用 Acceptance 签名密钥；只导入专用 Windows 根证书，不向模型进程注入 SSL_CERT_FILE |
| TEST-018 | 更新服务生命周期 | SSH 中直接 Start-Process 的后台服务会随 OpenSSH 会话结束被清理，manifest 随后连接失败。 | 本地 HTTPS 服务改用独立计划任务运行，并在启动脚本中验证真实 HTTPS 200 |
| TEST-019 | 更新表单和阶段时序 | 更新表单先挂载再异步读取保存值；外层 label 名称含当前选项/JSON 值。Runtime 签名校验发生在安装阶段，current.json 又早于 Core 启动完成。 | 等待持久 deviceId 后编辑，使用标签前缀；测试实际安装验签边界，并等待明确的完成提示与真实进程 |
| TEST-020 | Windows 会话与窗口句柄 | SSH 登录不能访问交互桌面凭据库（CredDelete 1312）；窗口退出期间枚举到的 HWND 可能在 UIA FromHandle 前销毁，浏览器标题也会在加载时改变。 | 合成邀请凭据由交互辅助器按精确测试 deviceId 删除；仅忽略已确认销毁的 HWND，外部窗口按已观察 HWND 和窗口类定位 |

页面快照中的加载态、未配置外部服务或系统时间差异不自动归类为产品缺陷。必须补充真实操作或明确预期后再定性。

| ID | 类别 | 现象与证据 | 当前状态 |
|---|---|---|---|
| TEST-021 | 外置服务配置 | 固定版 OpenViking 不接受新版 telemetry 配置；本地嵌入缺少 llama-cpp-python，root API key 不能访问 tenant 数据。 | 使用真实 Ollama nomic-embed-text:v1.5 768 维嵌入，创建独立 account/admin user，Desktop 填其 user_key；OV-001 runs/20260907T081945Z 全流程通过 |
| TEST-022 | DeepSeek 表单定位 | 模型凭证文本框实际名为 DEEPSEEK_API_KEY，原脚本使用 API Key，未成功修改任何密钥。 | 按实际标签修正；CHAT-012 runs/20260907T081945Z 真实 401、保留问题和同会话恢复通过 |
| TEST-023 | 编程 Agent 命令与时限 | Windows 嵌入终端是 cmd，但 Core terminal 工具选择 Git Bash；将 cmd 语法传入后命令失败，模型自修正又超过默认回合等待时间。 | 使用实际 Git Bash 命令和独立 Claude 配置；限制失败即报告、清理未完成回合；CODE-001 runs/20260907T083648Z 真正生成及执行代码、CLI Token 和委派卡片均通过 |
| TEST-024 | 通知声音待定位 | SET-006 的 sound-on 输出为 0；同一 Node 子进程录音方式可以录到系统 WAV 正向校准，独立的一次 Desktop 通知也曾录到声音。 | 已增加每轮正向校准和通知 XML；延迟 12 秒仍不能稳定解决，不能直接归因于 Windows 限流，也不能凭通知数据库记录判声音通过 |
| TEST-025 | 服务进程归属 | Windows venv Python 启动基解释器子进程，监听端口 PID 与启动器 PID 不同。 | 更新服务按确切命令行及直接父子关系核对；清理结束本测试进程树并验证端口消失，三个真实记忆服务的统一准备已验证 |
| TEST-026 | 更新缓存清理 | “稍后安装”留下的本测试缓存会在重启后显示全局提醒，遮挡其他用例；runs/20260907T091455Z 的 CHAT-010 / SET-006 因此前置污染失败。 | 在原生启动提醒中点击稍后；失败清理仅删除已核对版本和摘要的本测试缓存。保留被污染的失败记录，再独立复跑对应流程 |
| TEST-027 | 安装更新时序 | 旧 Page 消失、CDP 端口可访问、新 WebView 页面出现和候选清理 pending 缓存不是同一时点；早期清理还命中安装包 EBUSY。 | 等待本次 updater helper 的安装退出码及重启 PID，再等待新页面和候选消费缓存；保留已完成 helper 日志的快照。RUNTIME-004 runs/20260907T093139Z 整体通过，含原安装包自动恢复 |
| TEST-028 | 麦克风原生权限 | 点击录音后 WebView2 弹出原生“http://hermesui.localhost 想要使用麦克风”权限泡泡；网页 DOM 无法定位，getUserMedia 持续等待。 | 通过调试端口所属 WebView PID、实际 HWND、权限来源和 UIA allow-button 核对后点击允许；不使用 CDP grantPermissions 跳过真实授权交互 |
| TEST-029 | 证据包路径 | 旧 PowerShell Compress-Archive 证据包中 542 / 546 个条目含反斜杠，macOS 提取成错误文件名。 | 新导出使用 Python zipfile 写入标准斜杠路径，并校验 ZIP 摘要和目录结构 |
| TEST-030 | 虚拟音频采样率 | Steam 虚拟麦克风输入为 44100 Hz，输出为 48000 Hz；按输出率打开输入会返回 Invalid sample rate。 | 分别使用设备报告的实际采样率。真实输入端校准峰值 0.356，已证明系统合成测试句确实通过虚拟驱动进入麦克风 |
| TEST-031 | 前台条件核对 | SetForegroundWindow 是请求，不保证 Windows 实际切换焦点；未核对焦点会把后台通知误判为前台抑制失败。 | SET-006 读取真实 GetForegroundWindow，必要时点击已定位的 Desktop 标题栏并等待焦点；runs/20260907T094710Z 前台抑制、后台完成和审批提醒通过，声音仍为 0，整项保持失败 |

VOICE-004 在 runs/20260907T083648Z 分别执行手动和自动朗读，两项都命中 WIN-010。CRON-004 在 runs/20260907T082912Z 实际同秒执行，3 次请求只保留 2 条输出，专项确认 WIN-012。

RUNTIME-002 / RUNTIME-003 在 runs/20260907T094008Z 再次复现 WIN-015 / WIN-013 与 WIN-017。新的自动更新环境准备、原生邀请凭据删除、独立用例重启及嵌入界面恢复均已执行；这不能替代功能通过。CHAT-010 在同轮重新通过，排除了上轮缓存提醒遮挡造成的测试污染。

| ID | 类别 | 现象与证据 | 当前状态 |
|---|---|---|---|
| TEST-032 | Wander 前置条件 | 原清单误将本地 MemOS 页面写成云账号、空间和文件上传操作，导致六项过早归入账号阻塞。 | 已对照对应 Desktop 源码纠正，详见 wander-coverage-audit.md。六项均通过真实 MemOS + 官方 DeepSeek flash 验证 |
| TEST-033 | MemOS 启动进程归属 | OpenSSH 子进程随 SSH 生命周期退出；从 Node execFileSync 直接启动持久子进程又会持有同步命令管道。 | 改为独立 HermesNativeE2E-Wander 计划任务，核对三个端口的实际 PID 和父子关系；101142Z 启动失败证据保留 |
| TEST-034 | 源码归档中文路径 | Windows tar.exe 提取中文文件名后，与 Python 读取的 Git 归档名称不一致，固定源码校验失败。 | 使用 Python tarfile 重新完整提取，并在服务启动时逐文件核对归档 SHA256；101538Z 失败证据和旧提取目录保留 |
| TEST-035 | MemOS 元数据输入 | 测试把 source 写成任意字符串，但真实 MemoryOS 类型只接受 conversation / retrieved / web / file / system。 | 将正向用例改为 source=system；WANDER-002 在 102104Z 通过。此前 101705Z 等待库存失败属于脚本输入错误 |
| TEST-036 | MemOS 用例隔离 | 对话提取可能产生不含唯一标记的额外事实，仅删除带标记的结果会在下一项参与真实冲突合并，改变新事实的文本。 | 开始前保存完整库存快照，再通过 UI 清理本框架独立服务的库存；结束后保存库存。102305Z 未进入 Escape 断言的探索失败保留；隔离后六项主流程 102700Z 同轮通过 |
| TEST-037 | OAuth 设施版本适配 | 固定 MCP SDK 2.0.0 使用 httpx2；其撤销表单的 nullable client_secret 字段没有默认值，公开客户端省略该字段仍返回 400。 | 104443Z / 104522Z 失败发生在设施自检阶段，保留记录。改用已锁定的 httpx2，并显式提交空字段；104625Z 七项设施验证通过后才开始 Desktop UI 验收 |
