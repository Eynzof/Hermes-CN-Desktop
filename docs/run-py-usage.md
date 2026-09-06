# run.py — Hermes Agent CN Desktop 开发启动脚本

`run.py` 是 `pnpm tauri:dev` 的开发包装器，用于选择真实 Hermes-CN-Core 的运行方式。

## 默认模式：managed runtime

默认把所选 Core 检出安装到桌面端 `dev-runtime`，由 Tauri 启动真实的
`hermes dashboard` 子进程，并通过本机 HTTP/WS（默认端口 9120）通信。这是当前
发布安装包和常规开发使用的稳定路径。

```bash
python run.py
python run.py --source ../Hermes-CN-Core
python run.py --backend C:/dev/Hermes-CN-Core  # --source 的兼容别名
```

Core 检出必须包含 `pyproject.toml`。解析顺序为：

1. `--source` / `--backend`
2. `HERMES_CN_CORE`
3. 本仓库的 `hermes_backend`（若存在完整检出）
4. 同级 `../Hermes-CN-Core`

## 实验模式：embedded Python

`--embedded` 显式启用进程内 CPython + Hard FFI。此模式不启动 dashboard 监听器，
Rust 与 Python 之间不使用 HTTP/WS。它目前只用于开发和 CI 验证；正式安装包仍走
managed runtime，直到 PyInstaller `_internal` payload 在三个平台完成端到端验证。

```bash
python run.py --source ../Hermes-CN-Core --embedded
HERMES_DESKTOP_EMBEDDED_PAYLOAD=/path/to/hermes_embedded python run.py --embedded
```

payload 必须包含 `api.py`，解析顺序为：

1. `HERMES_DESKTOP_EMBEDDED_PAYLOAD`
2. `--source` / `--backend` 直接指向的 payload
3. 所选 Core 检出的 `hermes_embedded`
4. 本仓库 `hermes_backend/hermes_embedded`
5. 同级 `../Hermes-CN-Core/hermes_embedded`

嵌入模式会设置 `HERMES_DESKTOP_EMBEDDED_PYTHON=1`、
`HERMES_DESKTOP_EMBEDDED_PAYLOAD=<payload>` 和仅限开发使用的
`VITE_HERMES_SKIP_VERSION_CHECK=1`。

## 选项

| 选项 | 默认值 | 说明 |
|---|---:|---|
| `--source` | 自动探测 | Core 检出或（配合 `--embedded`）payload 路径 |
| `--backend` | — | `--source` 的兼容别名 |
| `--embedded` | `false` | 显式启用实验性进程内运行时 |
| `--real-backend` | `false` | 已废弃的兼容参数；managed runtime 已是默认值 |
| `--skip-prereqs` | `false` | 跳过 pnpm、Core/payload 存在性检查 |

`--embedded` 与 `--real-backend` 互斥。

## 环境变量

| 变量 | 说明 |
|---|---|
| `HERMES_CN_CORE` | Core 检出路径 |
| `HERMES_AGENT_CN_SOURCE` | 传给本地 runtime 安装脚本的 Core 路径；run.py 自动设置 |
| `HERMES_DESKTOP_EMBEDDED_PAYLOAD` | 嵌入式 payload 覆盖路径 |
| `HERMES_DESKTOP_RUNTIME_ROOT` | 桌面 dev-runtime 根目录 |
| `HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL=1` | 跳过 dev-runtime 重装 |

两种模式都会在启动前清理 dev-runtime 下遗留的 `connection.json`，并在退出时终止
其启动的 Tauri 子进程。纯浏览器前端调试请直接使用 `pnpm web:dev`；完整桌面开发
也可直接使用 `pnpm tauri:dev`（managed runtime）。
