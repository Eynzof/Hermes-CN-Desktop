# run.py — Hermes Agent CN Desktop 开发启动脚本

`run.py` 是一个 Python 脚本，用于**同时启动后端（hermes dashboard）和前端（Vite dev server）**，适合不需要 Tauri 壳的纯浏览器开发场景。按 `Ctrl+C` 自动清理两个进程。

## 适用场景

- 只想在**浏览器**里调试前端 UI，不需要 Tauri 原生能力（系统托盘、文件对话框等）
- 需要**独立启动后端**供 Tauri 桌面端 `pnpm tauri:run` 连接（使用 `--backend-only`）
- 后端已由其他方式启动，只想起前端 dev server（使用 `--frontend-only`）

> 完整 Tauri 开发（含 WebView 原生能力）请用 `pnpm tauri:dev`，见 `AGENTS.md`。

## 前置要求

- **Hermes-CN-Core** 仓库在 `../Hermes-CN-Core`（同级目录），或用 `HERMES_CN_CORE` 环境变量指定
- **Hermes-CN-Core 的 venv**：`../Hermes-CN-Core/.venv` 中已安装 `hermes` CLI
  ```bash
  cd ../Hermes-CN-Core
  python -m venv .venv
  .venv/Scripts/pip install -e .    # Windows
  .venv/bin/pip install -e .        # macOS/Linux
  ```
- **pnpm**：已安装且 `pnpm install` 已在桌面端仓库根目录执行过

## 基本用法

```bash
# 默认启动（后端 9120 + 前端 9545 + 自动打开浏览器）
python run.py

# 自定义后端端口
python run.py --backend-port 9119

# 不打开浏览器
python run.py --no-browser

# 只启动后端（供 Tauri 桌面端 pnpm tauri:run 连接）
python run.py --backend-only

# 只启动前端（后端已由其他方式启动时）
python run.py --frontend-only

# 指定后端仓库路径
python run.py --backend C:/dev/Hermes-CN-Core

# 跳过前置检查（脚本中使用）
python run.py --skip-prereqs
```

## 完整选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--backend-port` | `9120` | 后端 Dashboard 端口（桌面端约定 9120，避开全局 Agent 的 9119） |
| `--no-browser` | `false` | 不自动打开浏览器 |
| `--backend-only` | `false` | 只启动后端，不启动前端 |
| `--frontend-only` | `false` | 只启动前端，不启动后端 |
| `--backend` | `../Hermes-CN-Core` | Hermes-CN-Core 仓库路径，覆盖 `HERMES_CN_CORE` 环境变量 |
| `--skip-prereqs` | `false` | 跳过前置检查（hermes CLI / pnpm 可用性检查） |
| `--help` | — | 显示帮助信息 |

`--backend-only` 和 `--frontend-only` 互斥。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HERMES_CN_CORE` | `../Hermes-CN-Core` | Hermes-CN-Core 仓库路径 |
| `HERMES_DASHBOARD_ORIGIN` | `http://127.0.0.1:{port}` | 后端 URL，传递给 Vite proxy |
| `HERMES_DESKTOP_RUNTIME_ROOT` | 平台默认 | 桌面 dev-runtime 根目录（覆盖 `connection.json` 写入路径） |

## 工作流程

### 1. 前置检查

脚本启动时自动检查：
- Hermes-CN-Core 仓库是否存在
- `hermes` CLI 是否在 venv 中且可运行（跑 `hermes --version`）
- `pnpm` 是否在 PATH 中

跳过检查：`--skip-prereqs`

### 2. 清理遗留状态

后端启动前，清理可能阻止新 dashboard 启动的遗留状态：
- 杀掉已有的 `hermes.exe` / `hermes` 进程
- 杀掉运行 `hermes_cli` 的 Python 进程
- 删除 stale port-lock 文件（`.port-locks/` 目录）
- 删除 `gateway.pid`、`processes.json`

### 3. 端口冲突处理

如果 `--backend-port` 指定的端口已被占用：
1. 先尝试杀掉占用该端口的进程（平台相关：Windows 用 `netstat` + `taskkill`，macOS 用 `lsof` + `kill`，Linux 用 `ss` + `kill`）
2. 杀不掉则回退到 OS 分配的随机空闲端口

**前端端口（默认 9545）在运行时重新校验**，而非硬编码：
- 先尝试绑定 9545（同时检查 IPv4 `127.0.0.1` 与 IPv6 `::1`）
- 若被占用 → 杀掉占用进程
- 若被操作系统屏蔽（见下方“EACCES / Windows 排除端口范围”FAQ）→ 自动回退到空闲端口，并通过 `E2E_VITE_PORT` 传给 Vite
- 最终端口会显示在启动日志里（`Frontend: http://localhost:<port>`）

### 4. 启动后端

```bash
hermes dashboard --no-open --port <port> --host 127.0.0.1
```

环境变量注入：
- `PYTHONIOENCODING=utf-8`
- `HERMES_DASHBOARD_TUI=1`
- `HERMES_DASHBOARD_ORIGIN=<dashboard_origin>`

启动后等待 backend health endpoint（`http://127.0.0.1:<port>/`）返回 200，超时 60 秒。

工作目录使用用户启动脚本的原始 cwd（而非 Hermes-CN-Core 仓库目录），确保 `TERMINAL_CWD` 正确。

### 5. 写入 connection.json

启动前端或完整模式时，在桌面 dev-runtime 目录写入 `connection.json`，告诉桌面端使用 **Local 模式**（attach 到已有后端，而不是自己启动 managed runtime）：

```json
{
  "version": 2,
  "mode": "local",
  "local": {
    "url": "http://127.0.0.1:<port>"
  }
}
```

写入路径（平台相关）：
- Windows：`%APPDATA%\cn.org.hermesagent.desktop\dev-runtime\connection.json`
- macOS：`~/Library/Application Support/cn.org.hermesagent.desktop/dev-runtime/connection.json`
- Linux：`~/.local/share/cn.org.hermesagent.desktop/dev-runtime/connection.json`

可通过 `HERMES_DESKTOP_RUNTIME_ROOT` 环境变量覆盖。

### 6. 启动前端

```bash
pnpm web:dev    # Vite dev server，默认 9545 端口；被系统屏蔽时自动回退
```

环境变量注入：
- `PYTHONIOENCODING=utf-8`
- `HERMES_DASHBOARD_ORIGIN=<dashboard_origin>`（Vite proxy 用这个 URL 转发 API 请求到后端）
- `E2E_VITE_PORT=<frontend_port>`（Vite 实际监听端口，`web/vite.config.ts` 读取；直接 `pnpm web:dev` 时 vite 也会自行探测）

### 7. 打开浏览器

除非指定了 `--no-browser`，否则自动打开 `http://localhost:<frontend_port>`（默认 9545，被系统屏蔽时自动回退到空闲端口）。

### 8. 退出清理

按 `Ctrl+C` 或进程退出时自动执行：
1. 删除 `connection.json`
2. 先 `terminate()` 所有子进程（等待 5 秒）
3. 仍未退出的子进程 `kill()` 强制终止（等待 3 秒）

清理逻辑防重入（`_cleaning_up` 锁），多次按 `Ctrl+C` 安全。

## 与 Tauri 桌面端配合

### 场景：只启动后端 + 用 Tauri 桌面端连接

```bash
# 终端 1：run.py 启动后端
python run.py --backend-only

# 终端 2：Tauri 桌面端连接
pnpm tauri:run
```

`run.py` 写入的 `connection.json` 会让 Tauri 桌面端在 `pnpm tauri:run` 启动时自动 attach 到 `run.py` 启动的后端，而不会自己再起一个 managed runtime。退出时 `connection.json` 会自动清理。

### 场景：run.py vs pnpm tauri:dev

| 方面 | `python run.py` | `pnpm tauri:dev` |
|------|----------------|-----------------|
| 前端 | 浏览器（Vite dev server） | Tauri WebView（Vite dev server） |
| 后端 | 本地 hermes CLI dashboard | managed runtime（从 Core 源码安装） |
| 原生能力 | 无（浏览器） | 全部（系统托盘、文件对话框等） |
| 适用 | 纯前端调试 | 完整桌面端开发 |
| 端口 | 9120（后端）+ 9545（前端，被系统屏蔽时自动回退） | 9120（后端 managed runtime） |

## 常见问题

### "Hermes-CN-Core not found"

确保 Hermes-CN-Core 仓库在 `../Hermes-CN-Core`（相对桌面端仓库），或用 `--backend` 参数指定路径，或设置 `HERMES_CN_CORE` 环境变量。

### "hermes CLI not found"

在 Hermes-CN-Core 目录创建 venv 并安装：
```bash
cd <Hermes-CN-Core>
python -m venv .venv
# Windows:
.venv\Scripts\pip install -e .
# macOS/Linux:
.venv/bin/pip install -e .
```

### "pnpm not found"

安装 pnpm：
```bash
npm install -g pnpm
# 或：
corepack enable && corepack prepare pnpm@latest --activate
```

### 端口被占用

脚本会自动尝试杀掉占用端口的进程。如果杀不掉，会回退到空闲端口。也可以手动释放端口后重试。

### 前端启动报 EACCES（`listen EACCES: permission denied ::1:9545`）

端口没被占用、但 Vite 绑定失败并报 `EACCES`，通常是 **Windows 排除端口范围（excluded port range）** 导致的：Hyper-V / WSL2 / WinNAT 等会动态预留一段 TCP 端口，落在范围内的端口（即使空闲）绑定也会报 `EACCES`。检查：

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

如果 9545 落在某个范围里（如 `9511–9610`），就是它了。注意这些范围**重启后会变化**，所以无法靠改死一个端口解决——脚本与 `web/vite.config.ts` 都会在启动时探测 9545 是否可用，不可用则自动回退到空闲端口。

想手动回收被预留的端口：重启电脑，或重启 Hyper-V/WSL 相关服务（如管理员 `net stop winnat && net start winnat`，或关闭再打开 WSL）。

### 后端启动超时

后端 60 秒未响应 health check 会报错退出。可能原因：
- 另一个 hermes 实例已在运行（脚本尝试清理，但可能因权限不足失败）
- hermes CLI 版本不兼容
- venv 环境损坏

检查 hermes 是否能独立启动：
```bash
<Hermes-CN-Core>/.venv/Scripts/hermes dashboard --port 9120
```
