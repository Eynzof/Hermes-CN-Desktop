# run.py — Hermes Agent CN Desktop 开发启动脚本（纯前端，无后端）

`run.py` 是 Python 脚本，用于**只启动前端（Vite dev server）**，适合不需要 Tauri 壳的纯浏览器开发/冒烟场景。按 `Ctrl+C` 自动清理 Vite 进程。

## 背景：为什么不再需要后端

自 Python → TypeScript 重写完成后（实现全部落在 `packages/` monorepo，架构总览见 `docs/typescript-runtime.md`），
agent runtime（会话、模型配置、消息流）已经在 TypeScript 侧实现并通过**进程内网关（in-process gateway）**承载：

- `web/src/lib/gateway-inprocess.ts` — 进程内 JSON-RPC 分发（session.create /
  prompt.submit / model.options / provider.probe / config.set …），替代 Python
  Dashboard 的 `/api/ws` WebSocket。
- `web/src/lib/session-store/` — 进程内会话存储（SessionStore + 可持久化 SQL
  adapter），替代后端 `sessions.db`。
- `web/src/lib/dashboard-handlers.ts` — 进程内 REST 路由（`/api/sessions*`、
  `/api/model/options` 等），替代 Python FastAPI。
- `web/src/lib/local-agent.ts` — 本地回合引擎（默认回声模式，可插拔真实 agent）。

因此 `run.py` 不再启动 hermes dashboard、不再写 `connection.json`、不再清理
hermes 进程——只需把 Vite dev server 拉起来即可开发/调试整个 UI。

> 完整 Tauri 开发（含 WebView 原生能力）仍用 `pnpm tauri:dev`，见 `AGENTS.md`；
> 纯浏览器开发用 `python run.py`。

## 前置要求

- **pnpm**：已安装且 `pnpm install` 已在仓库根目录执行过（`pnpm` 是唯一依赖）

## 基本用法

```bash
# 默认启动（前端 9545 + 自动打开浏览器）
python run.py

# 自定义端口
python run.py --port 8080

# 不打开浏览器
python run.py --no-browser

# 跳过前置检查（脚本中使用）
python run.py --skip-prereqs
```

## 完整选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--port` | `9545` | 前端 Vite dev server 端口 |
| `--no-browser` | `false` | 不自动打开浏览器 |
| `--skip-prereqs` | `false` | 跳过 pnpm 可用性检查 |
| `--help` | — | 显示帮助信息 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `E2E_VITE_PORT` / `VITE_PORT` | 覆盖前端端口（脚本优先使用 CLI `--port`，其次该变量） |

## 端口冲突处理

**前端端口（默认 9545）在运行时重新校验**，而非硬编码：

1. 先尝试绑定 `--port`（同时检查 IPv4 `127.0.0.1` 与 IPv6 `::1`）
2. 若被占用 → 杀掉占用进程（平台相关：Windows `netstat` + `taskkill`，macOS
   `lsof` + `kill`，Linux `ss` + `kill`）
3. 若被操作系统屏蔽（排除端口范围）→ 自动回退到空闲端口，并通过
   `E2E_VITE_PORT` 传给 Vite
4. 最终端口会显示在启动日志里（`Frontend: http://localhost:<port>`）

## 启动前端

```bash
pnpm web:dev    # Vite dev server，默认 9545；被系统屏蔽时自动回退
```

脚本注入 `E2E_VITE_PORT`（Vite 实际监听端口，`web/vite.config.ts` 读取；
直接 `pnpm web:dev` 时 vite 也会自行探测）。

## 退出清理

按 `Ctrl+C` 或子进程退出时自动 `terminate()` 并等待 5 秒，仍不退出的
`kill()` 强杀。清理逻辑防重入（`_cleaning_up` 锁），多次按 `Ctrl+C` 安全。

## 常见问题

### "pnpm not found"

安装 pnpm：

```bash
npm install -g pnpm
# 或：
corepack enable && corepack prepare pnpm@latest --activate
```

### 前端启动报 EACCES（`listen EACCES: permission denied ::1:9545`）

端口没被占用、但 Vite 绑定失败并报 `EACCES`，通常是 **Windows 排除端口范围
（excluded port range）** 导致的：Hyper-V / WSL2 / WinNAT 等会动态预留一段 TCP
端口，落在范围内的端口（即使空闲）绑定也会报 `EACCES`。检查：

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

如果 9545 落在某个范围里（如 `9511–9610`），就是它了。注意这些范围**重启后会
变化**，所以无法靠改死一个端口解决——脚本与 `web/vite.config.ts` 都会在启动时
探测 9545 是否可用，不可用则自动回退到空闲端口。

想手动回收被预留的端口：重启电脑，或重启 Hyper-V/WSL 相关服务（如管理员
`net stop winnat && net start winnat`，或关闭再打开 WSL）。

## 对比 `pnpm tauri:dev`

| 方面 | `python run.py` | `pnpm tauri:dev` |
|------|----------------|-----------------|
| 前端 | 浏览器（Vite dev server） | Tauri WebView（Vite dev server） |
| 后端 | 无（进程内 TS agent） | 无（进程内 TS agent，Tauri IPC 承载 OS 能力） |
| 原生能力 | 无（浏览器） | 全部（系统托盘、文件对话框等） |
| 适用 | 纯前端调试 | 完整桌面端开发 |
| 端口 | 9545（被系统屏蔽时自动回退） | 9545（Vite dev） |