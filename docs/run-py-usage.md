run.py — Hermes Agent CN Desktop 开发启动脚本（嵌入式 Python runtime，零 HTTP）

`run.py` 现在只做一件事：以**嵌入式 Python runtime（Hard FFI，零 HTTP）**启动 Tauri 桌面端开发应用。

- **不**启动 hermes dashboard 子进程（无 9120 / 8644 / 8645 监听）。
- **不**写 `connection.json`（不会以 Local 模式 HTTP attach 到外部后端）；启动前还会主动删除 dev-runtime 下遗留的 `connection.json`。
- 后端跑在 Rust 进程内：REST 走 native IPC → Rust `api_request` → FFI 注册表；Gateway 走内存传输；全程没有到 Python 后端的 HTTP/WS 连接。

> 旧版 `run.py` 的「起后端 dashboard（9120）+ 浏览器前端（9545）」HTTP 模式已删除。纯浏览器前端调试请直接用 `pnpm web:dev`（需要自行起后端时用 Core 的 `hermes dashboard`）；完整桌面端开发用 `python run.py` 或 `pnpm tauri:dev`。

前置要求

- Hermes-CN-Core 仓库在 `../Hermes-CN-Core`（同级目录），或用 `HERMES_CN_CORE` 环境变量 / `--source` 指定
- pnpm：已安装且 `pnpm install` 已在桌面端仓库根目录执行过

基本用法

```bash
# 嵌入式 Python runtime（Hard FFI，零 HTTP）——唯一模式
python run.py

# 指定 Core 仓库路径
python run.py --source C:/dev/Hermes-CN-Core

# 跳过前置检查（pnpm / Core source）
python run.py --skip-prereqs

# 查看帮助
python run.py --help
```

完整选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--source` | `../Hermes-CN-Core` | Hermes-CN-Core 仓库路径，覆盖 `HERMES_CN_CORE` 环境变量 |
| `--backend` | — | 已废弃的 `--source` 别名 |
| `--embedded` | — | 已废弃的 no-op：嵌入式模式现在是默认模式 |
| `--skip-prereqs` | `false` | 跳过前置检查（pnpm / Core source 存在性） |
| `--help` | — | 显示帮助信息 |

> 旧的 `--backend-port`、`--no-browser`、`--backend-only`、`--frontend-only` 已删除——它们只属于已移除的 HTTP dashboard 模式。

环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HERMES_CN_CORE` | `../Hermes-CN-Core` | Hermes-CN-Core 仓库路径 |
| `HERMES_AGENT_CN_SOURCE` | 由 run.py 自动设为解析出的 Core 路径 | 传给 `scripts/install-local-runtime.mjs`，确保安装的 dev runtime 与 `--source`/`HERMES_CN_CORE` 一致 |
| `HERMES_DESKTOP_EMBEDDED_PYTHON` | `1`（run.py 自动设置） | 开启嵌入式 Python runtime；设为 `0` 可关闭嵌入、回退子进程 managed runtime |
| `HERMES_DESKTOP_EMBEDDED_PAYLOAD` | `<Core>/hermes_embedded`，否则 `./hermes_embedded` | 嵌入式 Python payload 根目录（run.py 自动探测） |
| `HERMES_DESKTOP_RUNTIME_ROOT` | 平台默认 | 桌面 dev-runtime 根目录（覆盖 `connection.json` 删除路径） |
| `HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL` | — | 设为 `1` 时跳过 dev runtime 安装，直接 `tauri dev` |

工作流程

1. 前置检查：Core 源码（`pyproject.toml`）存在、pnpm 在 PATH（`--skip-prereqs` 跳过）。
2. 解析 payload（`embedded_payload_root()`）：
   1. `HERMES_DESKTOP_EMBEDDED_PAYLOAD`（显式覆盖，例如用 mklink 链接到 Core 的 `hermes_embedded`）
   2. `<Hermes-CN-Core>/hermes_embedded`（真实 Core 集成包）
   3. `<Desktop>/hermes_embedded`（仓库内置参考包）
3. 删除 dev-runtime 下遗留的 `connection.json`（防止 bootstrap 走 HTTP attach 路径）。
4. 设置 `HERMES_DESKTOP_EMBEDDED_PYTHON=1` 与 `HERMES_DESKTOP_EMBEDDED_PAYLOAD`、`HERMES_AGENT_CN_SOURCE`，执行 `pnpm tauri:dev`（`scripts/tauri-dev-managed.mjs` 已支持这些环境变量，并会先装 dev runtime）。
5. 按 Ctrl+C 或进程退出时自动清理：删 `connection.json` → `terminate()` 子进程（等 5 秒）→ 仍未退出的 `kill()`（等 3 秒）。

> 与 `pnpm tauri:dev` 的关系：`run.py` 只是它的嵌入式配置包装（补上 payload 解析与 `connection.json` 清理）。两者都会安装/使用 dev-runtime；不带 `HERMES_DESKTOP_EMBEDDED_PYTHON=1` 直接 `pnpm tauri:dev` 仍是子进程 managed runtime 路径（默认 dashboard 端口 9120）。

常见问题

"Hermes-CN-Core not found"

确保 Hermes-CN-Core 仓库在 `../Hermes-CN-Core`（相对桌面端仓库），或用 `--source` 参数指定路径，或设置 `HERMES_CN_CORE` 环境变量。

"pnpm not found"

安装 pnpm：

```bash
npm install -g pnpm
# 或
corepack enable && corepack prepare pnpm@latest --activate
```

"Embedded mode requires a hermes_embedded payload"

`--embedded`（现在是默认模式）找不到 `hermes_embedded` payload 时会在启动前报错退出。解决：设置 `HERMES_DESKTOP_EMBEDDED_PAYLOAD` 指向含 `api.py` 的包目录，或准备 Core / Desktop 的 `hermes_embedded`。

端口

`run.py` 自身不再绑定/探测任何端口（9120、9545 均已移出脚本）。Vite dev server 仍由 `pnpm tauri:dev` / `web/vite.config.ts` 管理（默认 9545，被 Windows Hyper-V/WSL2 排除端口范围屏蔽时自动回退）。
