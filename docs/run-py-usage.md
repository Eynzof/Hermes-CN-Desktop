run.py — Hermes Agent CN Desktop 开发启动脚本（真实后端嵌入式 Python runtime，零 HTTP）

run.py 的默认目标是：以嵌入式 Python runtime（Hard FFI，零 HTTP）启动 Tauri 桌面端开发应用，后端是**真实的 Hermes-CN-Core**。

- 不启动 hermes dashboard 子进程（无 9120 / 8644 / 8645 监听）。
- 不写 connection.json（不会以 Local 模式 HTTP attach 到外部后端）；启动前还会主动删除 dev-runtime 下遗留的 connection.json。
- 后端跑在 Rust 进程内，而且是真包：Core 侧的 `hermes_embedded`（已与 Core 合并）把每个 REST 路由直达真实的 `hermes_cli.web_server` FastAPI 应用（进程内 ASGI 调用，无 socket），每个 Gateway JSON-RPC 方法直达真实的 `tui_gateway.server` dispatcher；agent 事件（message.start / delta / complete、审批等）经 Rust 事件桥实时推给 WebView。全程没有到 Python 后端的 HTTP/WS 连接。

  > 模式守则（2026 更新，合并后）：桌面仓库不再内置任何 `hermes_embedded` 参考包。payload 只有两处来源：HERMES_DESKTOP_EMBEDDED_PAYLOAD 覆盖、或 `<Core>/hermes_embedded`（与 Core 合并后的真实包）。找不到 payload 时 run.py 直接报错退出，不会再退回演示包。需要旧的真实 managed runtime 路径（安装该 Core 到 dev-runtime 并由 bootstrap 起 hermes dashboard 子进程，HTTP/WS 端口 9120）时，显式加 --real-backend。

> 旧版 run.py 的「起后端 dashboard（9120）+ 浏览器前端（9545）」HTTP 模式已删除。纯浏览器前端调试请直接用 pnpm web:dev（需要自行起后端时用 Core 的 hermes dashboard）；完整桌面端开发用 python run.py 或 pnpm tauri:dev。

前置要求

- 带有 `hermes_embedded` 包的 Hermes-CN-Core 仓库：../Hermes-CN-Core，或本仓库内的 hermes_backend/ 检出，或用 HERMES_CN_CORE 环境变量 / --source 指定
- 该 Python 环境能 import Core 依赖（fastapi/pydantic 等；在 Core 检出里 `pip install -e .` 即可）
- pnpm：已安装且 pnpm install 已在桌面端仓库根目录执行过

基本用法

[code block: 14 lines]

完整选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| --source | ../Hermes-CN-Core | Hermes-CN-Core 仓库路径，覆盖 HERMES_CN_CORE 环境变量 |
| --backend | — | 已废弃的 --source 别名；无论指向什么都保持嵌入式启动（该 Core 必须带 hermes_embedded 包，否则报错退出） |
| --real-backend | false | 显式 opt-in：走真实 managed runtime 路径——安装所选 Core 到 dev-runtime 并起 hermes dashboard 子进程（HTTP/WS，端口 9120）；不加班默认仍是嵌入式 |
| --embedded | — | 已废弃的 no-op：嵌入式模式现在是默认模式 |
| --skip-prereqs | false | 跳过前置检查（pnpm / Core source 存在性） |
| --help | — | 显示帮助信息 |

> 旧的 --backend-port、--no-browser、--backend-only、--frontend-only 已删除——它们只属于已移除的 HTTP dashboard 模式。

环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| HERMES_CN_CORE | ../Hermes-CN-Core | Hermes-CN-Core 仓库路径 |
| HERMES_AGENT_CN_SOURCE | 由 run.py 自动设为解析出的 Core 路径 | 传给 scripts/install-local-runtime.mjs，确保安装的 dev runtime 与 --source/HERMES_CN_CORE 一致 |
| HERMES_DESKTOP_EMBEDDED_PYTHON | 1（run.py 自动设置） | 开启嵌入式 Python runtime；设为 0 可关闭嵌入、回退子进程 managed runtime |
| HERMES_DESKTOP_EMBEDDED_PAYLOAD | <Core>/hermes_embedded | 嵌入式 Python payload 根目录（run.py 自动探测；桌面仓库已无内置包） |
| VITE_HERMES_SKIP_VERSION_CHECK | 1（run.py 在嵌入式模式下自动设置） | 嵌入式包经 FFI 上报真实 Core 版本，可能与桌面端烘焙的 EXPECTED_BACKEND_VERSION 不一致；仅 dev 跳过严格版本门 |
| HERMES_DESKTOP_RUNTIME_ROOT | 平台默认 | 桌面 dev-runtime 根目录（覆盖 connection.json 删除路径） |
| HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL | — | 设为 1 时跳过 dev runtime 安装，直接 tauri dev |

工作流程

1. 前置检查：Core 源码（pyproject.toml）存在、pnpm 在 PATH（--skip-prereqs 跳过）。
2. 解析 payload（resolve_embedded_payload()），返回 (payload, origin)：
   1. HERMES_DESKTOP_EMBEDDED_PAYLOAD（显式覆盖）：没有 api.py 时直接报错退出；
   2. <Core>/hermes_embedded（与 Core 合并后的真实包）；
   3. 都没有 → 报错退出（桌面仓库不再有参考包回退）。
3. 选择启动模式：
   - --real-backend 显式给出 → 真实 managed runtime 模式：设置 HERMES_DESKTOP_EMBEDDED_PYTHON=0（src/embedded/mod.rs 的 EMBEDDED_DISABLE_ENV；单纯不设还不够——Rust 的 resolve_payload_root 仍会扫到 Core 检出的 hermes_embedded）、清掉 HERMES_DESKTOP_EMBEDDED_PAYLOAD、保留 HERMES_AGENT_CN_SOURCE=<该 Core>，执行 pnpm tauri:dev。
   - 否则走嵌入式模式（零 HTTP，真实后端）：HERMES_DESKTOP_EMBEDDED_PYTHON=1 + payload + HERMES_AGENT_CN_SOURCE + VITE_HERMES_SKIP_VERSION_CHECK=1，执行 pnpm tauri:dev。
4. 删除 dev-runtime 下遗留的 connection.json（防止 bootstrap 走 HTTP attach 旧路径）。
5. 按 Ctrl+C 或进程退出时自动清理：删 connection.json → terminate() 子进程（等 5 秒）→ 仍未退出的 kill()（等 3 秒）。

> 与 pnpm tauri:dev 的关系：run.py 只是它的嵌入式配置包装（补上 payload 解析与 connection.json 清理）。两者都会安装/使用 dev-runtime；不带 HERMES_DESKTOP_EMBEDDED_PYTHON=1 直接 pnpm tauri:dev 仍是子进程 managed runtime 路径（默认 dashboard 端口 9120）。

常见问题

"Hermes-CN-Core not found"

确保 Hermes-CN-Core 仓库在 ../Hermes-CN-Core（相对桌面端仓库），或用 --source 参数指定路径，或设置 HERMES_CN_CORE 环境变量。

"pnpm not found"

安装 pnpm：

[code block: 4 lines]

"Embedded mode requires a hermes_embedded payload"

裸 python run.py（未显式指定后端）在解析不到 hermes_embedded 包时会在启动前报错退出。解决：设置 HERMES_DESKTOP_EMBEDDED_PAYLOAD 指向 Core 检出的 hermes_embedded 目录，或准备 ../Hermes-CN-Core / hermes_backend/ 检出。

"--backend / --source 指向的 Core 没有 hermes_embedded"

直接报错退出（合并后桌面仓库没有演示包可回退）。在 Core 侧补上 hermes_embedded 包（推荐，保持零 HTTP），或加 --real-backend 走 managed runtime 路径（安装该 Core 到 dev-runtime、起 hermes dashboard 子进程，HTTP/WS 端口 9120）。

"dashboard exited before ready（9120 起不来）"
  只有 --real-backend 才可能遇到。多半是 dev-runtime 里缓存的旧 venv 与当前 Core 源码不匹配（例如源码新增了顶层模块而旧 venv 未重装，ModuleNotFoundError 一类崩溃导致 hermes dashboard 提前退出）。修复：删除 %APPDATA%/cn.org.hermesagent.desktop/dev-runtime/versions/ 下对应版本目录后重试（install-local-runtime.mjs 会重建），或确认没设 HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL=1；嵌入式默认模式不依赖 9120，不受影响。

HERMES_DESKTOP_EMBEDDED_PAYLOAD 指向的目录没有 api.py

直接报错退出。修正路径或 unset 该变量。

启动时弹出「版本不匹配」

嵌入式包经 FFI 上报的是真实 Core 版本（hermes_cli.__version__），若与桌面端 web/src/lib/build-info.ts 烘焙的 EXPECTED_BACKEND_VERSION 不一致会触发严格版本门。run.py 在嵌入式 dev 模式自动设置 VITE_HERMES_SKIP_VERSION_CHECK=1 跳过；发版时仍须按仓库规范同步 EXPECTED_BACKEND_VERSION。

端口

run.py 自身不再绑定/探测任何端口（9120、9545 均已移出脚本）。Vite dev server 仍由 pnpm tauri:dev / web/vite.config.ts 管理（默认 9545，被 Windows Hyper-V/WSL2 排除端口范围屏蔽时自动回退）。
