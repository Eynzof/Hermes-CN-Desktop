# Hermes 中文社区桌面版 Issue 分级与核实

快照日期：2026-09-09。GitHub 当前开放 Issue：Desktop 119 条，Core 34 条，共 153 条。全部编号保留；重复反馈合并根因，不能把 Issue 条数当成独立缺陷数。

代码基线：Desktop `f7f36bf5f9547ae673859a7f96d68b21d966f3a7`，Core `d0575cb0148b78bbb903781299345f5c0e97ad64`。公开 stable 为 Desktop `v0.7.0`、Core `runtime-v0.20.0-cn.9`，不能将 main 或本地 0.9 测试包视为已交付用户。

P0：广泛阻断核心服务，作为发布阻断项立即处理。P1：平台/关键流程不可用、配置或历史损坏、非预期路由与权限边界。P2：局部功能缺陷、可绕开的体验问题与常规需求。P3：外观、便利性、待规划平台与低紧迫度扩展。优先级与核实/发布状态分别记录，未复现不等于不存在。

## 数量

| 等级 | Bug | 需求 |
|---|---:|---:|
| P0 | 6 | 0 |
| P1 | 43 | 0 |
| P2 | 50 | 46 |
| P3 | 1 | 7 |

## 本轮处理与验收边界

本轮在 `fix/issue-triage-20260909` 的独立双仓工作区处理。已完成源码修复及下列针对性验证；尚未发布正式版本，也未关闭 GitHub Issue。

- P0 网关启动：使用 SHA256 校验过的官方 cn.9 Windows 包复现 cron NameError；修复所在 main 的本次冻结候选运行超过 25 秒，随后由测试主动结束。
- 新增修复：冻结 cron 脚本进程隔离、完整 SQLite 备份、档案切换旧会话续聊、重连版本门禁、澄清交互、内置工具磁盘发现资源、Windows PTY 辅助程序、外部内核补丁兼容、网关统一 token 锁目录、文件读取边界、旧 WebKit 正则及 Linux 构建基线、源码安装器。
- Windows 原生链路：Tauri 打包源 `http://hermesui.localhost` → 冻结 Core → 两个本地 OpenAI 协议测试端点。同名模型实际路由、停止后续聊、档案往返、原生 ZIP 保存/导入、恢复历史续聊及澄清选择回传均通过。模型响应使用确定性本地夹具；Tauri IPC、Core、SQLite、MCP stdio 和子进程均真实执行。
- 冻结包补充验收：89 个内置工具发现、6 个插件 doctor、真实 MCP initialize/list/call/shutdown、cron 超时后 PID 退出、Windows Node ConPTY、Dashboard HTML/JS MIME、源码管理器识别冻结网关进程。
- 最小源码回归：Rust 备份 8、文件读取 20、网关相关 23 和后续清理 9；TS 版本/记忆 30、Markdown 31、已有修复 57、档案/备份 19、连接与澄清 53。部分用例交叉覆盖，不相加为独立测试总数。Python 按文件独立进程测试，Windows 原生终端执行及进程树中止另有真实 OS 测试。类型检查和生产前端构建通过。
- Intel/macOS 12：尚无相应目标机；已修已知正则兼容问题并验证构建，签名权限已在 main。需成品实机验收，不能据 Windows 成功判定已解决。
- Ubuntu 22.04：构建矩阵已固定最老支持基线并沿用成品 smoke，尚未运行该平台发行构建。依据 [PyInstaller 的 GLIBC 构建说明](https://pyinstaller.org/en/stable/usage.html#making-gnu-linux-apps-forward-compatible)。
- Core #141：真实挂起 HTTP 连接的超时/事件循环测试通过，但报告中的 macOS + Clash + iLink 现场未复现，保留 P1 待现场栈。
- Core #136：用户明确要求本轮跳过，无转储资料，保留原影响评级。

贡献来源：安装器修复参考并移植 [Core PR #168](https://github.com/Eynzof/Hermes-CN-Core/pull/168)；文件边界修复移植 [Desktop PR #383](https://github.com/Eynzof/Hermes-CN-Desktop/pull/383)；备份快照及 cron worker 的局部设计参考本地 0.9 验收工作。未整体合入其他分支。

完整现场记录保存在协作工作区 `CNDesktop/artifacts/issue-triage-20260909/`；Windows 机上为 `C:\HermesIssueTriage20260909`。关键日志名列于每条 Issue 证据栏。更改代码与正式交付是独立状态。

## 逐条台账

| Issue | 类型 | 等级 | 问题 | 根因组 | 当前状态及证据 |
|---|---|---|---|---|---|
| [Core #179](https://github.com/Eynzof/Hermes-CN-Core/issues/179) | Bug | P0 | [Bug] runtime-v0.20.0-cn.9 无法启动：插件缺失 + gateway 崩溃（NameError: InProcessCronScheduler） | 网关启动崩溃 | 已复现；main 已修，未发布；正式 cn.9 Windows 实机复现 cron NameError；本次冻结候选持续运行超过 25 秒后由测试结束，源码启动回归通过。windows-cn9-probe.log / windows-prepare.log |
| [Core #173](https://github.com/Eynzof/Hermes-CN-Core/issues/173) | Bug | P0 | gateway 启动即崩溃: NameError: name 'InProcessCronScheduler' is not defined (0.20.0-cn.8/cn.9) | 网关启动崩溃 | 已复现；main 已修，未发布；正式 cn.9 Windows 实机复现 cron NameError；本次冻结候选持续运行超过 25 秒后由测试结束，源码启动回归通过。windows-cn9-probe.log / windows-prepare.log |
| [Core #169](https://github.com/Eynzof/Hermes-CN-Core/issues/169) | Bug | P0 | Gateway crashes at startup: NameError: name 'InProcessCronScheduler' is not defined (gateway/run.py start_gateway) | 网关启动崩溃 | 已复现；main 已修，未发布；正式 cn.9 Windows 实机复现 cron NameError；本次冻结候选持续运行超过 25 秒后由测试结束，源码启动回归通过。windows-cn9-probe.log / windows-prepare.log |
| [Core #165](https://github.com/Eynzof/Hermes-CN-Core/issues/165) | Bug | P0 | 0.20.0 runtime gateway crashes on startup: NameError InProcessCronScheduler (cn.5~cn.9 all affected) | 网关启动崩溃 | 已复现；main 已修，未发布；正式 cn.9 Windows 实机复现 cron NameError；本次冻结候选持续运行超过 25 秒后由测试结束，源码启动回归通过。windows-cn9-probe.log / windows-prepare.log |
| [Core #154](https://github.com/Eynzof/Hermes-CN-Core/issues/154) | Bug | P0 | ### [Bug] 0.20.0-cn.5 的 gateway run 启动必崩：NameError: InProcessCronScheduler（所有消息平台 + A2A 不可用） | 网关启动崩溃 | 已复现；main 已修，未发布；正式 cn.9 Windows 实机复现 cron NameError；本次冻结候选持续运行超过 25 秒后由测试结束，源码启动回归通过。windows-cn9-probe.log / windows-prepare.log |
| [Desktop #597](https://github.com/Eynzof/Hermes-CN-Desktop/issues/597) | Bug | P0 | [Windows] v0.20.0-cn.9 启动崩溃 · InProcessCronScheduler 未定义 | 网关启动崩溃 | 已复现；main 已修，未发布；正式 cn.9 Windows 实机复现 cron NameError；本次冻结候选持续运行超过 25 秒后由测试结束，源码启动回归通过。windows-cn9-probe.log / windows-prepare.log |
| [Core #174](https://github.com/Eynzof/Hermes-CN-Core/issues/174) | Bug | P1 | [Bug] Runtime 打包缺失 pybase64/orjson，7 个 provider 插件加载失败 | 冻结包插件缺失 | 发布包缺口确认；本次补齐内置工具发现；main 已补插件磁盘源码，本次继续补齐 tools 的 AST 扫描所需源码。冻结包识别 89 个内置工具；6 个插件 doctor 通过。pybase64/orjson 在 cn.9 已存在，不误报缺包。 |
| [Core #167](https://github.com/Eynzof/Hermes-CN-Core/issues/167) | Bug | P1 | Installer runtime/repository mismatches: setup selects Python 3.11 (metadata requires >=3.14), fork installers clone NousResearch/hermes-agent | 源码安装器错误 | 本次已修；行为测试通过；移植社区 Core PR #168；Python 3.14，所有 SSH/HTTPS/ZIP 指向 CN 仓库，Desktop 本地安装器同步最低版本。 |
| [Core #161](https://github.com/Eynzof/Hermes-CN-Core/issues/161) | Bug | P1 | cron no_agent script fails on PyInstaller-packaged runtime: script path passed to hermes CLI as subcommand (invalid choice, exit 2) | 冻结脚本执行 | 本次已修；Windows 冻结包已验证；__run-script 独立进程执行，支持 cwd 和兄弟导入；超时终止进程树，不改父进程 argv/输出。frozen-probe.log |
| [Core #153](https://github.com/Eynzof/Hermes-CN-Core/issues/153) | Bug | P1 | [Bug] 便携版更新内核后重启自动回退到 bundled 旧版本(0.19.0-cn.7),更新不生效 | 更新降级与文件占用 | main 已修；已有候选验收记录，待正式发布；main 保留较新兼容 runtime 并修复 Windows 替换占用；参见 artifacts/unsigned-core-validation-20260906 的升级/回滚记录。本次不把旧验收包当成本次成品。 |
| [Core #141](https://github.com/Eynzof/Hermes-CN-Core/issues/141) | Bug | P1 | [Bug] Weixin iLink adapter: sending a reply deadlocks the entire gateway (0.19.0-cn.7) | 微信回复阻塞网关 | 未在当前代码复现；保留 P1；真实本地 HTTP 挂起连接已验证超时和其他事件循环任务继续运行；不能代替报告中的 macOS + Clash + iLink 现场。需要该现场的线程栈/日志。 |
| [Core #139](https://github.com/Eynzof/Hermes-CN-Core/issues/139) | Bug | P1 | [suggestion] CN runtime 与源码版 gateway 的 token 锁目录分裂，建议统一 | 网关锁及进程识别 | 本次统一目录；针对性回归通过；Desktop/CLI 共用 HERMES_GATEWAY_LOCK_DIR，默认尊重 XDG_STATE_HOME 或用户 .local/state/hermes/gateway-locks；旧进程保留 marker 原路径，清理仅处理本运行时死锁。Rust 目录、归属和清理回归。 |
| [Core #138](https://github.com/Eynzof/Hermes-CN-Core/issues/138) | Bug | P1 | [bug] hermes-agent-cn-runtime-win32-x64.exe 不被 gateway 识别导致锁失效+管理命令失效 | 网关锁及进程识别 | main 已修；本次 Windows 实进程验证通过；源码 gateway.status 正确识别本次冻结 exe gateway run 的真实 PID；windows-gateway-recognition.log。 |
| [Core #136](https://github.com/Eynzof/Hermes-CN-Core/issues/136) | Bug | P1 | [Bug] GUI 0.7.0 频繁堆损坏崩溃 (0xc0000374 in ntdll.dll) | Windows 原生堆崩溃 | 按用户要求跳过本轮；2026-09-09 用户确认没有转储或复现数据，明确允许跳过；保留 P1 影响评级，不声称已修。 |
| [Core #131](https://github.com/Eynzof/Hermes-CN-Core/issues/131) | Bug | P1 | [Bug] 0.19.0-cn.7 所有 stdio MCP server 无法连接：mcp_stdio_watchdog.py 未打包且 sys.executable 非 Python | MCP stdio 不可用 | main 已有修复；Windows 冻结包已验证；冻结环境跳过把 exe 当 python 的 watchdog；本次新冻结内核运行真实 MCPServerTask，完成 initialize/list/tools/call 和 shutdown。 |
| [Core #116](https://github.com/Eynzof/Hermes-CN-Core/issues/116) | Bug | P1 | bug: Windows runtime 0.19.0-cn.1 omits dashboard web_dist assets | Windows 网页会话启动 | main 已修；本次托管 Dashboard 实机启动通过；Desktop 分发并显式传入其 web/dist；本次冻结内核持续运行，原生聊天及 Dashboard HTML/JS HTTP 200。独立 Core 包不带 Desktop Web UI 的情况不能与托管启动混同。 |
| [Core #111](https://github.com/Eynzof/Hermes-CN-Core/issues/111) | Bug | P1 | Desktop CN 所有内置 Web 搜索插件无法加载 | 冻结包插件缺失 | 发布包缺口确认；本次补齐内置工具发现；main 已补插件磁盘源码，本次继续补齐 tools 的 AST 扫描所需源码。冻结包识别 89 个内置工具；6 个插件 doctor 通过。pybase64/orjson 在 cn.9 已存在，不误报缺包。 |
| [Core #107](https://github.com/Eynzof/Hermes-CN-Core/issues/107) | Bug | P1 | [Bug]: 备份恢复-导出配置失败（文件被锁定） | 备份完整性 | 本次已修；Windows 原生备份及历史续聊通过；SQLite VACUUM INTO 快照保留 WAL；原生保存/打开对话框完成 ZIP 导出和新档案恢复，8 条消息完整性检查通过，恢复后旧会话继续聊天成功。native-backup-fixed-path.log / native-clarify-restore-final.log |
| [Core #93](https://github.com/Eynzof/Hermes-CN-Core/issues/93) | Bug | P1 | [Bug]: 桌面端切换档案后内核始终运行 default，提示「默认档案与当前运行的不一致」，重启内核无法修复 | 档案与会话隔离 | 本次复现并修复；Windows 原生往返验证通过；清除重启前 gateway ID 和运行桶，保留持久会话映射；切换等待版本校验，修复连接失败 Promise 缓存。默认→第二档案→默认，内核 PID 变化，旧会话原 URL 续聊成功。native-profiles-acceptance.log |
| [Core #81](https://github.com/Eynzof/Hermes-CN-Core/issues/81) | Bug | P1 | [Bug]: Web Dashboard MIME type 错误 | Windows 网页会话启动 | MIME 缺陷已修并实测；认证反馈另说明；Windows Dashboard 的 JS 实际返回 application/javascript，HTML/JS 均 200；无凭据 /api/auth/me 返回 401，不放宽认证边界，已认证桌面链路正常。 |
| [Desktop #599](https://github.com/Eynzof/Hermes-CN-Desktop/issues/599) | Bug | P1 | computer_use tool permanently breaks mid-conversation due to unrevived cua-driver session | 电脑操作会话过期 | main 已有修复；本次补回归验证；逻辑 session ended 时以原 identity start_session 并只重试一次；复活失败、二次拒绝和无关错误均验证不会循环。 |
| [Desktop #596](https://github.com/Eynzof/Hermes-CN-Desktop/issues/596) | Bug | P1 | opencode-free 免费模型接入问题：UI 选择器不显示 / gateway Unknown provider / keyless 401（0.20.0-cn.9） | 冻结包插件缺失 | 发布包缺口确认；本次补齐内置工具发现；main 已补插件磁盘源码，本次继续补齐 tools 的 AST 扫描所需源码。冻结包识别 89 个内置工具；6 个插件 doctor 通过。pybase64/orjson 在 cn.9 已存在，不误报缺包。 |
| [Desktop #595](https://github.com/Eynzof/Hermes-CN-Desktop/issues/595) | Bug | P1 | 反馈：New，说明"连接官方 v0.20.5 后端闪退 | 外部内核版本门禁 | 本次已修；针对性测试通过；外部 local/remote 接受同 major/minor 的稳定补丁；托管和显式 expected 仍精确核对。Desktop version-check 测试。 |
| [Desktop #580](https://github.com/Eynzof/Hermes-CN-Desktop/issues/580) | Bug | P1 | 切换档案后，session not found | 档案与会话隔离 | 本次复现并修复；Windows 原生往返验证通过；清除重启前 gateway ID 和运行桶，保留持久会话映射；切换等待版本校验，修复连接失败 Promise 缓存。默认→第二档案→默认，内核 PID 变化，旧会话原 URL 续聊成功。native-profiles-acceptance.log |
| [Desktop #574](https://github.com/Eynzof/Hermes-CN-Desktop/issues/574) | Bug | P1 | [Bug] 调用 adb 等派生守护进程的命令时，UI 中断/停止卡死，只能等 10 分钟超时或重启应用 | 停止与澄清阻塞 | main 已修；Windows 真实进程树中止通过；真实 LocalEnvironment 执行 shell→Python父进程→子进程，中止后父子 PID 均退出，1 项测试 4.3 秒；另验证原生 UI 停止和同会话继续。未连接真实 adb 设备。 |
| [Desktop #564](https://github.com/Eynzof/Hermes-CN-Desktop/issues/564) | Bug | P1 | Portable v0.7.0 (macOS x64): 内置 runtime 安装因 smoke check 超时而永久失败 | Intel 内核启动 | main 已补签名权限；待 Intel 成品验收；release-runtime 调用 sign_macos_runtime_payload.sh，entitlements 包含 allow-unsigned-executable-memory。缺 Intel 目标机，本次 Windows 验收不覆盖此项。 |
| [Desktop #563](https://github.com/Eynzof/Hermes-CN-Desktop/issues/563) | Bug | P1 | [Bug] Windows 原生下网页端 /chat 新建会话弹 node.exe 0xc0000142，两台全新安装机器复现 | Windows 网页会话启动 | 本次已修；冻结包及网页 PTY 验证通过；复现冻结内核 ConPTY 子进程立即退出，源码版相同命令正常；补齐 pywinpty OpenConsole.exe / winpty-agent.exe 后 Node PTY smoke 通过，真实 Dashboard /api/pty 会话创建并持续输出，发送 web-chat-native 后收到模型回复（windows-dashboard-chat-verified.log）。未复现原报告 0xc0000142 原码，复现并修复的是同链路 0xc000013a。 |
| [Desktop #557](https://github.com/Eynzof/Hermes-CN-Desktop/issues/557) | Bug | P1 | Ubuntu 22.04 启动报「内置 runtime 安装失败: Smoke check exited with code Some(255)」——内置 runtime 依赖 GLIBC_2.38，与官网宣称的 22.04+ 支持不符 | Linux 启动兼容 | 本次已修构建配置；待 Ubuntu 22.04 成品验收；发布矩阵固定 ubuntu-22.04 并沿用成品 smoke；本机不把 Windows 成功等同于 Linux 验收。依据 PyInstaller 官方 GLIBC 构建约束。 |
| [Desktop #551](https://github.com/Eynzof/Hermes-CN-Desktop/issues/551) | Bug | P1 | [Bug] 记忆页修改 MEMORY.md 容量上限后自定义 provider (providers.custom) 配置丢失 | 配置保存丢失 | main 已修；真实配置路由测试通过；PUT /api/config 局部 memory 更新保留 providers，显式 providers 删除仍生效。#398 用户已回报 0.6.3 不再丢配置，残余模型显示问题另核。 |
| [Desktop #533](https://github.com/Eynzof/Hermes-CN-Desktop/issues/533) | Bug | P1 | Hermes-CN-Desktop 0.7.0在Intel的mac下不能正常打开 | Intel 内核启动 | main 已补签名权限；待 Intel 成品验收；release-runtime 调用 sign_macos_runtime_payload.sh，entitlements 包含 allow-unsigned-executable-memory。缺 Intel 目标机，本次 Windows 验收不覆盖此项。 |
| [Desktop #529](https://github.com/Eynzof/Hermes-CN-Desktop/issues/529) | Bug | P1 | v0.7bug反馈桌面UI模型切换bug：模型切换错误，右下角计费统计bug：今日tokens永恒为0 | 模型路由错误 | main 已修；本次双端点验证通过；两个本地供应商使用同一 fake-model，切到 triage-b 后由 19491 端点收到真实请求；未使用付费密钥。native-model-stop.log |
| [Desktop #525](https://github.com/Eynzof/Hermes-CN-Desktop/issues/525) | Bug | P1 | [Bug] macOS 12.x 白屏 + 无法打开：内嵌前端 mermaid chunk 使用了 WebKit 不支持的 lookbehind 正则，且 .app 未公证 | 旧版 macOS 白屏 | 本次已修已知正则；待 macOS 12 实机验收；mdast autolink 与 remend 移除不兼容 lookbehind；Safari 15 构建目标、31 项 Markdown 测试和生产构建通过。CSP 已含 ipc://localhost、http://ipc.localhost 与字体 data:；公证仍属发行事项。 |
| [Desktop #522](https://github.com/Eynzof/Hermes-CN-Desktop/issues/522) | Bug | P1 | [Bug] v0.7.0 启动时会将较新的 Runtime 回退为内置版本，并可能因旧进程占用导致启动失败 | 更新降级与文件占用 | main 已修；已有候选验收记录，待正式发布；main 保留较新兼容 runtime 并修复 Windows 替换占用；参见 artifacts/unsigned-core-validation-20260906 的升级/回滚记录。本次不把旧验收包当成本次成品。 |
| [Desktop #520](https://github.com/Eynzof/Hermes-CN-Desktop/issues/520) | Bug | P1 | Windows CN Desktop：cron 调度器将 script 路径错误传给 hermes CLI 子命令，导致所有含 script 字段的定时任务失败 | 冻结脚本执行 | 本次已修；Windows 冻结包已验证；__run-script 独立进程执行，支持 cwd 和兄弟导入；超时终止进程树，不改父进程 argv/输出。frozen-probe.log |
| [Desktop #517](https://github.com/Eynzof/Hermes-CN-Desktop/issues/517) | Bug | P1 | 更新0.7版本后的报错 | Intel 内核启动 | main 已补签名权限；待 Intel 成品验收；release-runtime 调用 sign_macos_runtime_payload.sh，entitlements 包含 allow-unsigned-executable-memory。缺 Intel 目标机，本次 Windows 验收不覆盖此项。 |
| [Desktop #514](https://github.com/Eynzof/Hermes-CN-Desktop/issues/514) | Bug | P1 | v0.7.0 报错：内置 runtime 安装失败: Smoke check failed: Smoke check timed out after 60s | Intel 内核启动 | main 已补签名权限；待 Intel 成品验收；release-runtime 调用 sign_macos_runtime_payload.sh，entitlements 包含 allow-unsigned-executable-memory。缺 Intel 目标机，本次 Windows 验收不覆盖此项。 |
| [Desktop #485](https://github.com/Eynzof/Hermes-CN-Desktop/issues/485) | Bug | P1 | 无法切换新建profile | 档案与会话隔离 | 本次复现并修复；Windows 原生往返验证通过；清除重启前 gateway ID 和运行桶，保留持久会话映射；切换等待版本校验，修复连接失败 Promise 缓存。默认→第二档案→默认，内核 PID 变化，旧会话原 URL 续聊成功。native-profiles-acceptance.log |
| [Desktop #464](https://github.com/Eynzof/Hermes-CN-Desktop/issues/464) | Bug | P1 | Terminal 工具裸命令执行失败 (exit code 4294967295)，需显式调用 powershell.exe 绕过 | Windows 终端执行 | main 已修；Windows 裸命令执行通过；真实 Windows LocalEnvironment 执行 echo，并验证前台派生进程树取消。windows-terminal-tests.log |
| [Desktop #429](https://github.com/Eynzof/Hermes-CN-Desktop/issues/429) | Bug | P1 | 在LLM使用clarify工具时，桌面端UI无法弹出选择框进行交互，导致agent无法收到回复而静止等待到超时 | 停止与澄清阻塞 | 本次确认缺口并修复；Windows 原生交互通过；增加 clarify.request/expire 接收、单选/多选/自由输入、回答回传、超时/中止清理；补齐冻结包工具发现资源。真实模型协议返回 clarify 调用，选择测试档案后内核收到回答并完成回合。 |
| [Desktop #427](https://github.com/Eynzof/Hermes-CN-Desktop/issues/427) | Bug | P1 | 导出当前档案备份 | 备份完整性 | 本次已修；Windows 原生备份及历史续聊通过；SQLite VACUUM INTO 快照保留 WAL；原生保存/打开对话框完成 ZIP 导出和新档案恢复，8 条消息完整性检查通过，恢复后旧会话继续聊天成功。native-backup-fixed-path.log / native-clarify-restore-final.log |
| [Desktop #422](https://github.com/Eynzof/Hermes-CN-Desktop/issues/422) | Bug | P1 | Mac Intel 版本因 CSP 策略缺少 http://ipc.localhost 导致白屏 | 旧版 macOS 白屏 | 本次已修已知正则；待 macOS 12 实机验收；mdast autolink 与 remend 移除不兼容 lookbehind；Safari 15 构建目标、31 项 Markdown 测试和生产构建通过。CSP 已含 ipc://localhost、http://ipc.localhost 与字体 data:；公证仍属发行事项。 |
| [Desktop #417](https://github.com/Eynzof/Hermes-CN-Desktop/issues/417) | Bug | P1 | 大模型卡住无法关闭 | 停止与澄清阻塞 | main 已修；本次 Windows 原生交互通过；模型端点保持请求 30 秒期间点击停止，停止按钮 252ms 内消失，原 URL 同会话继续发送成功；终端父子进程中止另有实机回归。native-model-stop.log |
| [Desktop #398](https://github.com/Eynzof/Hermes-CN-Desktop/issues/398) | Bug | P1 | 自定义模型-重启后config.yaml会被强制bak | 配置保存丢失 | main 已修；真实配置路由测试通过；PUT /api/config 局部 memory 更新保留 providers，显式 providers 删除仍生效。#398 用户已回报 0.6.3 不再丢配置，残余模型显示问题另核。 |
| [Desktop #372](https://github.com/Eynzof/Hermes-CN-Desktop/issues/372) | Bug | P1 | 新对话的工作区设置在首次发送消息后丢失，但后续新对话却继承了该工作区 | 工作区串用 | main 已有修复；后端绑定和前端状态测试通过；tests/test_session_workspace_binding.py 与 web/src/lib/workspaces.test.ts；还需结合原生会话检查实际 cwd。 |
| [Desktop #369](https://github.com/Eynzof/Hermes-CN-Desktop/issues/369) | Bug | P1 | Intel Mac + macOS 12.1 上 Hermes Agent CN Desktop v0.5.8 启动后白屏，但本地 dashboard 正常 | 旧版 macOS 白屏 | 本次已修已知正则；待 macOS 12 实机验收；mdast autolink 与 remend 移除不兼容 lookbehind；Safari 15 构建目标、31 项 Markdown 测试和生产构建通过。CSP 已含 ipc://localhost、http://ipc.localhost 与字体 data:；公证仍属发行事项。 |
| [Desktop #365](https://github.com/Eynzof/Hermes-CN-Desktop/issues/365) | Bug | P1 | 新会话自动继承上一个会话的工作区（Workspace），用户未授权也未收到通知。 | 工作区串用 | main 已有修复；后端绑定和前端状态测试通过；tests/test_session_workspace_binding.py 与 web/src/lib/workspaces.test.ts；还需结合原生会话检查实际 cwd。 |
| [Desktop #359](https://github.com/Eynzof/Hermes-CN-Desktop/issues/359) | Bug | P1 | 在Hermes 桌面端 V0.5.7切换Profile不起任何作用 | 档案与会话隔离 | 本次复现并修复；Windows 原生往返验证通过；清除重启前 gateway ID 和运行桶，保留持久会话映射；切换等待版本校验，修复连接失败 Promise 缓存。默认→第二档案→默认，内核 PID 变化，旧会话原 URL 续聊成功。native-profiles-acceptance.log |
| [Desktop #288](https://github.com/Eynzof/Hermes-CN-Desktop/issues/288) | Bug | P1 | read_workspace_file can read absolute paths when workspace root cannot be canonicalized | 工作区读取边界 | 本次已修；20 项文件边界测试通过；移植 Desktop PR #383，正常 root 仍严格限制，空/失效 root 仅允许 home 子树，不再接受任意绝对路径。 |
| [Desktop #193](https://github.com/Eynzof/Hermes-CN-Desktop/issues/193) | Bug | P1 | 桌面端思考过程中无法像 CLI 一样交互或打断 | 停止与澄清阻塞 | main 已修；本次 Windows 原生交互通过；模型端点保持请求 30 秒期间点击停止，停止按钮 252ms 内消失，原 URL 同会话继续发送成功；终端父子进程中止另有实机回归。native-model-stop.log |
| [Core #176](https://github.com/Eynzof/Hermes-CN-Core/issues/176) | 需求 | P2 | [Feature]: 火山引擎api适配缺失agent plan | 功能与体验 | 初步分类； |
| [Core #162](https://github.com/Eynzof/Hermes-CN-Core/issues/162) | Bug | P2 | [Bug]: 工作台 → 配置 → 再回到工作台，当前任务丢失/新建会话 | 功能与体验 | 初步分类； |
| [Core #155](https://github.com/Eynzof/Hermes-CN-Core/issues/155) | Bug | P2 | [Bug] 会话打开/发消息时 agent 被重复完整初始化 4-5 次，首条消息延迟 1-2 分钟 | 功能与体验 | 初步分类； |
| [Core #152](https://github.com/Eynzof/Hermes-CN-Core/issues/152) | Bug | P2 | [Bug]: 接入外部官方内核后，对话历史与数据分析页面无响应（401 token 缺失） | 功能与体验 | 初步分类； |
| [Core #137](https://github.com/Eynzof/Hermes-CN-Core/issues/137) | Bug | P2 | [bug] weixin session expired 后 sleep(600) 导致消息延迟10分钟 | 功能与体验 | 初步分类； |
| [Core #130](https://github.com/Eynzof/Hermes-CN-Core/issues/130) | Bug | P2 | [Bug] Weixin 图片发送失败：getUploadUrl 未传 context_token 导致 ret:-2 | 功能与体验 | 初步分类； |
| [Core #125](https://github.com/Eynzof/Hermes-CN-Core/issues/125) | Bug | P2 | [Bug]: 自定义 provider 模型的 context_length 配置不生效，回退到 131072 | 功能与体验 | 初步分类； |
| [Core #110](https://github.com/Eynzof/Hermes-CN-Core/issues/110) | Bug | P2 | Desktop CN 模型列表与后端实际可用状态不同步 | 功能与体验 | 初步分类； |
| [Core #108](https://github.com/Eynzof/Hermes-CN-Core/issues/108) | 需求 | P2 | [Feature]: 内核检查更新失败-推荐内核更新检查添加镜像源支持 | 功能与体验 | 初步分类； |
| [Core #106](https://github.com/Eynzof/Hermes-CN-Core/issues/106) | Bug | P2 | 桌面版 computer_use 工具配置显示enabled但实际未打包/不可调用 | 功能与体验 | 初步分类； |
| [Core #105](https://github.com/Eynzof/Hermes-CN-Core/issues/105) | Bug | P2 | [Bug]: 客户端对话流中异常显示系统元数据、无关的系统日志/元数据文本 | 功能与体验 | 初步分类； |
| [Core #95](https://github.com/Eynzof/Hermes-CN-Core/issues/95) | Bug | P2 | 发送快捷键每次新建对话重置为 Enter | 功能与体验 | 初步分类； |
| [Core #87](https://github.com/Eynzof/Hermes-CN-Core/issues/87) | Bug | P2 | Hermes CN Desktop 0.5.8 + Runtime 0.17.0-cn.5 在 Windows 10 上点击"重启Gateway"弹窗 Win Error 5。 | 功能与体验 | 初步分类； |
| [Desktop #590](https://github.com/Eynzof/Hermes-CN-Desktop/issues/590) | 需求 | P2 | 没有官方版的bots模式 | 功能与体验 | 初步分类； |
| [Desktop #589](https://github.com/Eynzof/Hermes-CN-Desktop/issues/589) | Bug | P2 | 历史图片不能正常查看 | 功能与体验 | 初步分类； |
| [Desktop #588](https://github.com/Eynzof/Hermes-CN-Desktop/issues/588) | 需求 | P2 | [需求] 对话历史支持批量归档 / 批量取消归档 | 功能与体验 | 初步分类； |
| [Desktop #587](https://github.com/Eynzof/Hermes-CN-Desktop/issues/587) | Bug | P2 | [Bug] 已关闭的工作区面板会在对话过程中自行重新出现 | 功能与体验 | 初步分类； |
| [Desktop #585](https://github.com/Eynzof/Hermes-CN-Desktop/issues/585) | Bug | P2 | 切换模型对话框只显示每个 provider 前 5 个模型，无法看到全部 | 功能与体验 | 初步分类； |
| [Desktop #584](https://github.com/Eynzof/Hermes-CN-Desktop/issues/584) | Bug | P2 | 升级后 desktop-bin\hermes.cmd 未更新，CLI 仍指向旧 runtime | 功能与体验 | 初步分类； |
| [Desktop #583](https://github.com/Eynzof/Hermes-CN-Desktop/issues/583) | Bug | P2 | 更新检查漏检 stable 更新：0.20.0-cn.8 已发布但客户端报 behind:0 | 功能与体验 | 初步分类； |
| [Desktop #582](https://github.com/Eynzof/Hermes-CN-Desktop/issues/582) | Bug | P2 | [SSL: CERTIFICATE VERIFY FAILED] certificate verify failed: unable to get local issuercertificate (ssl.c:1082) | 功能与体验 | 初步分类； |
| [Desktop #581](https://github.com/Eynzof/Hermes-CN-Desktop/issues/581) | Bug | P2 | 切换对话后返回，输入框草稿丢失（未发送内容不保留） | 功能与体验 | 初步分类； |
| [Desktop #573](https://github.com/Eynzof/Hermes-CN-Desktop/issues/573) | 需求 | P2 | 需求: 自定义服务商增加「OpenAI Responses API」(codex_responses) 接口格式选项 | 功能与体验 | 初步分类； |
| [Desktop #572](https://github.com/Eynzof/Hermes-CN-Desktop/issues/572) | Bug | P2 | 切换模型找不到OpenCode Go的模型List | 功能与体验 | 初步分类； |
| [Desktop #571](https://github.com/Eynzof/Hermes-CN-Desktop/issues/571) | Bug | P2 | [Bug] 聊天消息中汉字转数字过渡处，前两个数字字形粘连重叠 | 功能与体验 | 初步分类； |
| [Desktop #569](https://github.com/Eynzof/Hermes-CN-Desktop/issues/569) | Bug | P2 | 社区桌面版nous portal渠道OAuth登录授权之后找不到如何选择nous portal的限免模型 | 功能与体验 | 初步分类； |
| [Desktop #565](https://github.com/Eynzof/Hermes-CN-Desktop/issues/565) | Bug | P2 | 远程模式下记忆面板与 MCP 面板不可用 | 功能与体验 | 初步分类； |
| [Desktop #562](https://github.com/Eynzof/Hermes-CN-Desktop/issues/562) | 需求 | P2 | 在图形界面允许自定义TTS STT提供商配置 | 功能与体验 | 初步分类； |
| [Desktop #561](https://github.com/Eynzof/Hermes-CN-Desktop/issues/561) | 需求 | P2 | 希望增加字体更换功能或者优化小字的视觉问题 | 功能与体验 | 初步分类； |
| [Desktop #560](https://github.com/Eynzof/Hermes-CN-Desktop/issues/560) | 需求 | P2 | 申请添加任务链功能 | 功能与体验 | 初步分类； |
| [Desktop #559](https://github.com/Eynzof/Hermes-CN-Desktop/issues/559) | 需求 | P2 | 我注意到本GUI缺少插件界面的GUI配置，能否加上 | 功能与体验 | 初步分类； |
| [Desktop #556](https://github.com/Eynzof/Hermes-CN-Desktop/issues/556) | 需求 | P2 | [suggestion] 会话右侧历史消息导航圆点在长上下文中无法看到最新发言，建议改为文字列表或支持定位跳转 | 功能与体验 | 初步分类； |
| [Desktop #555](https://github.com/Eynzof/Hermes-CN-Desktop/issues/555) | Bug | P2 | [Bug] 左侧栏缺少「定时任务」入口：AutomationSidebar 组件已实现但未挂载到 app-sidebar | 功能与体验 | 初步分类； |
| [Desktop #554](https://github.com/Eynzof/Hermes-CN-Desktop/issues/554) | Bug | P2 | BUG REPORT: Hermes Desktop CN Tool Call Arguments Nesting Bug | 功能与体验 | 初步分类； |
| [Desktop #553](https://github.com/Eynzof/Hermes-CN-Desktop/issues/553) | 需求 | P2 | 增加任务执行中插入指令（mid-turn steer）的支持 | 功能与体验 | 初步分类； |
| [Desktop #539](https://github.com/Eynzof/Hermes-CN-Desktop/issues/539) | 需求 | P2 | 增加对任务归类的功能，类似Qoderwork（桌面版） | 功能与体验 | 初步分类； |
| [Desktop #535](https://github.com/Eynzof/Hermes-CN-Desktop/issues/535) | 需求 | P2 | Home界面预览里能右键文件选择本地程序打开或打开文件目录 | 功能与体验 | 初步分类； |
| [Desktop #532](https://github.com/Eynzof/Hermes-CN-Desktop/issues/532) | Bug | P2 | app响应的速度比命令行下的调用慢 | 功能与体验 | 初步分类； |
| [Desktop #530](https://github.com/Eynzof/Hermes-CN-Desktop/issues/530) | 需求 | P2 | 有没有全局的字体大小配置功能 | 功能与体验 | 初步分类； |
| [Desktop #528](https://github.com/Eynzof/Hermes-CN-Desktop/issues/528) | Bug | P2 | TTS语音发送到微信无声失败（MEDIA_FILE限流，需MEDIA_VOICE回退） | 功能与体验 | 初步分类； |
| [Desktop #524](https://github.com/Eynzof/Hermes-CN-Desktop/issues/524) | 需求 | P2 | [Feature] 增加由桌面端托管的 Local Source 模式 | 功能与体验 | 初步分类； |
| [Desktop #516](https://github.com/Eynzof/Hermes-CN-Desktop/issues/516) | 需求 | P2 | 功能建议：后台CLI任务可视化进程面板 | 功能与体验 | 初步分类； |
| [Desktop #515](https://github.com/Eynzof/Hermes-CN-Desktop/issues/515) | Bug | P2 | Bug：桌面端修改模型名称后页面显示与实际模型不一致 | 功能与体验 | 初步分类； |
| [Desktop #512](https://github.com/Eynzof/Hermes-CN-Desktop/issues/512) | Bug | P2 | 新建会话继承上一个会话的模型，而非使用 config.yaml 默认模型 | 功能与体验 | 初步分类； |
| [Desktop #510](https://github.com/Eynzof/Hermes-CN-Desktop/issues/510) | 需求 | P2 | 增加新对话草稿功能 | 功能与体验 | 初步分类； |
| [Desktop #497](https://github.com/Eynzof/Hermes-CN-Desktop/issues/497) | 需求 | P2 | 功能建议：对话中删除指定消息、引用消息、自动滚动到底部 | 功能与体验 | 初步分类； |
| [Desktop #479](https://github.com/Eynzof/Hermes-CN-Desktop/issues/479) | Bug | P2 | MCP不支持本地py mcp服务 | 功能与体验 | 初步分类； |
| [Desktop #475](https://github.com/Eynzof/Hermes-CN-Desktop/issues/475) | 需求 | P2 | 请增加会话导入导出功能！ | 功能与体验 | 初步分类； |
| [Desktop #473](https://github.com/Eynzof/Hermes-CN-Desktop/issues/473) | Bug | P2 | TUI模式下 computer_use 工具无法加载 — check_fn 从未被调用 | 功能与体验 | 初步分类； |
| [Desktop #471](https://github.com/Eynzof/Hermes-CN-Desktop/issues/471) | Bug | P2 | [Bug] 飞书插件已连接但接入页诊断显示 disabled / 按钮灰色不可用 | 功能与体验 | 初步分类； |
| [Desktop #469](https://github.com/Eynzof/Hermes-CN-Desktop/issues/469) | Bug | P2 | 工具调用经常性失效，上面好好的，下面执行不了了，GPT-5.6-terra模型 | 功能与体验 | 初步分类； |
| [Desktop #467](https://github.com/Eynzof/Hermes-CN-Desktop/issues/467) | 需求 | P2 | 聊天提供类似git的分支系统方便对话的分支访问 | 功能与体验 | 初步分类； |
| [Desktop #465](https://github.com/Eynzof/Hermes-CN-Desktop/issues/465) | 需求 | P2 | 工作空间里无法基于worktree新建对话 | 功能与体验 | 初步分类； |
| [Desktop #462](https://github.com/Eynzof/Hermes-CN-Desktop/issues/462) | 需求 | P2 | [Feature] SiliconFlow 预设模型列表增加 DeepSeek-V4-Flash | 功能与体验 | 初步分类； |
| [Desktop #461](https://github.com/Eynzof/Hermes-CN-Desktop/issues/461) | Bug | P2 | 当发送太多文件时会导致窗口被挤压找不到编辑对话按钮 | 功能与体验 | 初步分类； |
| [Desktop #459](https://github.com/Eynzof/Hermes-CN-Desktop/issues/459) | 需求 | P2 | MoA 混合 请求界面增加开关功能，这个不小心设置以后太烧钱了，而且配置存在不完善 | 功能与体验 | 初步分类； |
| [Desktop #458](https://github.com/Eynzof/Hermes-CN-Desktop/issues/458) | 需求 | P2 | 功能请求：支持开机自启动并最小化到系统托盘 | 功能与体验 | 初步分类； |
| [Desktop #447](https://github.com/Eynzof/Hermes-CN-Desktop/issues/447) | 需求 | P2 | 希望增加文件预览功能 | 功能与体验 | 初步分类； |
| [Desktop #446](https://github.com/Eynzof/Hermes-CN-Desktop/issues/446) | 需求 | P2 | 右键菜单增强 | 功能与体验 | 初步分类； |
| [Desktop #442](https://github.com/Eynzof/Hermes-CN-Desktop/issues/442) | Bug | P2 | 自定义配置，默认模型添加给用户带来了很大的麻烦 | 功能与体验 | 初步分类； |
| [Desktop #440](https://github.com/Eynzof/Hermes-CN-Desktop/issues/440) | Bug | P2 | 重新打开又出现新手使用引导 | 功能与体验 | 初步分类； |
| [Desktop #439](https://github.com/Eynzof/Hermes-CN-Desktop/issues/439) | 需求 | P2 | 增加会话摘要功能 | 功能与体验 | 初步分类； |
| [Desktop #438](https://github.com/Eynzof/Hermes-CN-Desktop/issues/438) | Bug | P2 | 配置页面滚动严重卡顿 — Commit + 指针事件 + 分层阻塞主线程 | 功能与体验 | 初步分类； |
| [Desktop #437](https://github.com/Eynzof/Hermes-CN-Desktop/issues/437) | Bug | P2 | 切换对话窗口清空未发送的聊天框输入内容 | 功能与体验 | 初步分类； |
| [Desktop #436](https://github.com/Eynzof/Hermes-CN-Desktop/issues/436) | Bug | P2 | TUI 流式渲染状态累积异常 — 单条消息重复显示多遍（重启后恢复） | 功能与体验 | 初步分类； |
| [Desktop #426](https://github.com/Eynzof/Hermes-CN-Desktop/issues/426) | Bug | P2 | [Bug] 桌面端 TUI assistant 反复发送空消息（80-90% 为空），导致界面不断重复刷新 | 功能与体验 | 初步分类； |
| [Desktop #425](https://github.com/Eynzof/Hermes-CN-Desktop/issues/425) | 需求 | P2 | 需要一个在输入的时候，能引入项目路径，或者ai接受的路径。 | 功能与体验 | 初步分类； |
| [Desktop #423](https://github.com/Eynzof/Hermes-CN-Desktop/issues/423) | Bug | P2 | 为什么只能加一个skill技能的声明？ | 功能与体验 | 初步分类； |
| [Desktop #420](https://github.com/Eynzof/Hermes-CN-Desktop/issues/420) | Bug | P2 | 任务执行中，为什么不能在增加下一个任务呢？ | 功能与体验 | 初步分类； |
| [Desktop #419](https://github.com/Eynzof/Hermes-CN-Desktop/issues/419) | Bug | P2 | 自定义模型配置页面无端消失 | 功能与体验 | 初步分类； |
| [Desktop #418](https://github.com/Eynzof/Hermes-CN-Desktop/issues/418) | 需求 | P2 | 模型配置功能的增强 | 功能与体验 | 初步分类； |
| [Desktop #416](https://github.com/Eynzof/Hermes-CN-Desktop/issues/416) | 需求 | P2 | feat: 在 runtime 中集成 memory provider 插件系统以支持 TencentDB Agent Memory 等外部记忆服务 | 功能与体验 | 初步分类； |
| [Desktop #414](https://github.com/Eynzof/Hermes-CN-Desktop/issues/414) | Bug | P2 | Bug：聊天窗口每次提问后仍不会自动滚动到底部 | 功能与体验 | 初步分类； |
| [Desktop #413](https://github.com/Eynzof/Hermes-CN-Desktop/issues/413) | 需求 | P2 | 跟进Computer use | 功能与体验 | 初步分类； |
| [Desktop #412](https://github.com/Eynzof/Hermes-CN-Desktop/issues/412) | 需求 | P2 | feat: 飞书与微信连接支持 Windows 服务常驻及自定义端口 | 功能与体验 | 初步分类； |
| [Desktop #401](https://github.com/Eynzof/Hermes-CN-Desktop/issues/401) | 需求 | P2 | Feature: Agent Swarm — 同构子任务并行编排 | 功能与体验 | 初步分类； |
| [Desktop #393](https://github.com/Eynzof/Hermes-CN-Desktop/issues/393) | Bug | P2 | 高级-常规-发送快捷键功能bug | 功能与体验 | 初步分类； |
| [Desktop #392](https://github.com/Eynzof/Hermes-CN-Desktop/issues/392) | Bug | P2 | 对话框数据输入的数据溢出 | 功能与体验 | 初步分类； |
| [Desktop #389](https://github.com/Eynzof/Hermes-CN-Desktop/issues/389) | 需求 | P2 | skill配置管理 | 功能与体验 | 初步分类； |
| [Desktop #375](https://github.com/Eynzof/Hermes-CN-Desktop/issues/375) | 需求 | P2 | [需求] 右侧画布实时预览面板 — 支持交互式内容渲染（类 WorkBuddy） | 功能与体验 | 初步分类； |
| [Desktop #361](https://github.com/Eynzof/Hermes-CN-Desktop/issues/361) | Bug | P2 | hermes-cn-destop与hermes-cli连接有问题 | 功能与体验 | 初步分类； |
| [Desktop #355](https://github.com/Eynzof/Hermes-CN-Desktop/issues/355) | Bug | P2 | 用户反馈汇总:模型配置/消息接入/记忆提供方/窗口进程/本机内核/MCP 多项问题 | 功能与体验 | 初步分类； |
| [Desktop #332](https://github.com/Eynzof/Hermes-CN-Desktop/issues/332) | 需求 | P2 | 需求：统一多模型 / 多 Provider 管理（Key + 余额 + 状态 + 自动切换 + 配置回滚） | 功能与体验 | 初步分类； |
| [Desktop #329](https://github.com/Eynzof/Hermes-CN-Desktop/issues/329) | 需求 | P2 | 需求：应用内「数据目录」设置 + 一键迁移（老用户 / 数据与安装目录解耦） | 功能与体验 | 初步分类； |
| [Desktop #325](https://github.com/Eynzof/Hermes-CN-Desktop/issues/325) | 需求 | P2 | 需求：聊天行内富内容渲染（embed / Mermaid / SVG / 告警块）+ 每服务「同意加载」隐私门 | 功能与体验 | 初步分类； |
| [Desktop #321](https://github.com/Eynzof/Hermes-CN-Desktop/issues/321) | Bug | P2 | 经常出现：模型服务调用未成功。常见原因：API Key 失效或不在模型权限范围、网络/服务不可达。请到 设置 → 模型 检查后重试。 | 功能与体验 | 初步分类； |
| [Desktop #294](https://github.com/Eynzof/Hermes-CN-Desktop/issues/294) | Bug | P2 | [Bug] 桌面端 UI 状态显示与 SQLite 持久化不一致：微信"未连接"显示 + Ctrl+Enter 快捷键回退 | 功能与体验 | 初步分类； |
| [Desktop #245](https://github.com/Eynzof/Hermes-CN-Desktop/issues/245) | 需求 | P2 | 总览（tracking）：上游 Electron 桌面端 vs Tauri 桌面端功能差距 | 功能与体验 | 初步分类； |
| [Desktop #239](https://github.com/Eynzof/Hermes-CN-Desktop/issues/239) | 需求 | P2 | 需求：统一「消息平台」管理页（Telegram/Discord/Slack/Email + CN IM 状态与测试） | 功能与体验 | 初步分类； |
| [Desktop #232](https://github.com/Eynzof/Hermes-CN-Desktop/issues/232) | 需求 | P2 | 需求：多 Profile 支持单一 global-remote dashboard（并发会话 socket + 跨档统一视图） | 功能与体验 | 初步分类； |
| [Desktop #220](https://github.com/Eynzof/Hermes-CN-Desktop/issues/220) | 需求 | P2 | 启动屏与新手引导优化：文案区分首启/常启，补充环境检测与已有 Hermes 配置发现 | 功能与体验 | 初步分类； |
| [Desktop #188](https://github.com/Eynzof/Hermes-CN-Desktop/issues/188) | Bug | P2 | 删除模型时未同步删除对应配置文件 | 功能与体验 | 初步分类； |
| [Desktop #115](https://github.com/Eynzof/Hermes-CN-Desktop/issues/115) | 需求 | P2 | 需求：原生支持可选范围的备份与恢复 | 功能与体验 | 初步分类； |
| [Desktop #99](https://github.com/Eynzof/Hermes-CN-Desktop/issues/99) | 需求 | P2 | 需求：为用户消息补充编辑与分支操作 | 功能与体验 | 初步分类； |
| [Desktop #96](https://github.com/Eynzof/Hermes-CN-Desktop/issues/96) | 需求 | P2 | 需求：支持回复过程中的交互式选项卡 | 功能与体验 | 初步分类； |
| [Desktop #11](https://github.com/Eynzof/Hermes-CN-Desktop/issues/11) | 需求 | P2 | 提个建议，hermes桌面版能不能把工作区设置为多选，有些工具放在不同文件夹，不好操作@李嘉乐 | 功能与体验 | 初步分类； |
| [Core #147](https://github.com/Eynzof/Hermes-CN-Core/issues/147) | 需求 | P3 | [suggestion] runtime release 无 release notes，用户无法判断修复内容 | 功能与体验 | 初步分类； |
| [Core #96](https://github.com/Eynzof/Hermes-CN-Core/issues/96) | 需求 | P3 | [Feature]: RTK for shell/terminal command | 功能与体验 | 初步分类； |
| [Desktop #591](https://github.com/Eynzof/Hermes-CN-Desktop/issues/591) | 需求 | P3 | 主题无透明效果 | 功能与体验 | 初步分类； |
| [Desktop #518](https://github.com/Eynzof/Hermes-CN-Desktop/issues/518) | 需求 | P3 | Linux arm 架构 | 功能与体验 | 初步分类； |
| [Desktop #468](https://github.com/Eynzof/Hermes-CN-Desktop/issues/468) | Bug | P3 | 桌面端Tauri框架本身的右键菜单和F12问题修复 | 功能与体验 | 初步分类； |
| [Desktop #457](https://github.com/Eynzof/Hermes-CN-Desktop/issues/457) | 需求 | P3 | 功能请求：增加桌面悬浮任务中心（Task Hub），统一管理多个 Agent 任务 | 功能与体验 | 初步分类； |
| [Desktop #388](https://github.com/Eynzof/Hermes-CN-Desktop/issues/388) | 需求 | P3 | 模板功能 | 功能与体验 | 初步分类； |
| [Desktop #371](https://github.com/Eynzof/Hermes-CN-Desktop/issues/371) | 需求 | P3 | 添加一个是否显示压缩详情的开关 | 功能与体验 | 初步分类； |
