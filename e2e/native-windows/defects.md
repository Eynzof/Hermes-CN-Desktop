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
| WIN-007 | MCP 参数编辑 | 参数编辑器按空白分割且保留引号，不支持带空格的 Windows 路径；为无空格路径加常见引号也会启动失败。 | 当前工作流使用专用无空格目录；带空格路径保留待测项 |
| WIN-008 | 高优先级备份恢复 | 删除 restored-default 后重新导入同名档案，文件目录存在且 config.yaml 与原档案 SHA256 一致，但 /api/config 返回 500，模型信息变为空。v0.21 的 profiles/.deleted/restored-default 删除标记仍在；Rust install_staging_profile 只安装目录，未按 Core 的档案创建流程清除标记。 | 已由安装版 UI 及同一冻结内核独立复现；profile-diagnostic-20260907T044110Z/stderr.log 指向 assert_named_profile_home_live |
| WIN-009 | 档案切换后聊天阻塞 | 切回 default 后模型和健康页正常，但发送提示 backend version check has not completed，无法新建对话；WebView 重载后恢复。 | runs/20260907T042950Z 的 CHAT-006、CHAT-003、SKILL-002 连续复现；新增 PROF-002 专项回归；runs/20260907T044831Z 切回后真实聊天通过，当前归类为间歇问题，不自动重试掩盖失败 |
| WIN-010 | 可选语音依赖缺失 | 默认 Edge TTS 配置可保存，但实际朗读返回未配置可用的语音提供方；冻结内核的 edge_tts Python 依赖不可用。 | VOICE-001 表单通过，VOICE-003 真实合成未通过；不能把系统安装 Edge 浏览器当成 TTS 依赖已具备 |
| WIN-011 | Build 向导能力提示 | v0.21 将 hermes-agent 定义为 ESSENTIAL_SKILLS，不允许禁用；Desktop 向导仍允许取消勾选并承诺未选技能会禁用。生成后该技能仍启用，没有说明保护规则。 | PROF-003 多次复现；区分必需技能保护与普通技能禁用，保留界面断言 |
| WIN-012 | 定时运行历史覆盖 | 连续点击立即运行，13:42:22 的真实模型结果和同一秒内的 no_change 结果只有一份历史。Core cron/jobs.py 的 save_job_output 使用秒级文件名后 atomic_replace 覆盖。 | runs/20260907T054009Z CRON-002 已捕获；连续记忆主流程间隔到下一秒，快速重复的历史完整性另列待回归 |
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

页面快照中的加载态、未配置外部服务或系统时间差异不自动归类为产品缺陷。必须补充真实操作或明确预期后再定性。
