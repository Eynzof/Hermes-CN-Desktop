# Managed Runtime — 端到端流程文档

桌面端 (`hermes-agent-cn-desktop`) 是一个 Tauri 壳子，自己不带 agent
逻辑。所有 RPC / 事件流的另一端是 `Hermes-CN-Core`（[fork] of
NousResearch/hermes-agent）的 dashboard 子进程。

本文档讲：那个 dashboard 子进程是**怎么进到用户机器上**的，桌面端
怎么找到它、用它、更新它，以及"你好"那一刻 WebSocket 帧是如何穿过
整条链路的。读完应该能够：

- 知道每个组件的职责和它们存放在哪个 repo 里
- 知道一次"首次启动"具体在做什么（按时间顺序）
- 知道一次"runtime 升级"具体在做什么
- 知道一次"桌面端升级"具体在做什么
- 知道有人攻击这条链路时，哪一处会挡住他

[fork]: https://github.com/Eynzof/Hermes-CN-Core

## 一、关键问题：桌面端怎么找到 agent

历史上桌面端假定用户机器里**全局装了** `hermes` CLI（pip install
hermes-agent），调用 `subprocess.spawn("hermes", "dashboard")`
来起后端。两个隐患：

1. **版本错配**：用户全局装的是上游 NousResearch 版本，桌面端依赖
   的是 Hermes-CN-Core 的若干 fork patch（如 P-002 `/api/upload`）。
   版本不对时功能静默缺失或报错，用户一脸懵。（历史上还包括 P-009
   的 SSE 路由——桌面端 ≥0.4 已改用上游原生 `/api/ws`，该依赖消失。）
2. **零安装体验差**：用户必须自己 `pip install hermes-agent-cn`，
   还要装对 Python 版本（3.11+）、装对 Hermes-CN-Core 而不是上游。不是面向
   终端用户的产品形态。

解决方向：**桌面端自带 runtime**。Windows 与 macOS 的正式安装包都应
预置目标平台的 `Hermes-CN-Core` runtime payload + manifest，首次启动优先从
包内资源安装；云端下载只作为包内 runtime 缺失、运行时升级或兜底修复路径。
Windows 与 macOS 都直接预置 runtime zip。macOS runtime 本身由
`Hermes-CN-Core` 的 release workflow 产出，在上游打包阶段已经把 PyInstaller
复制出来的 `Python.framework` 规范化成标准 framework symlink 布局，并完成
Developer ID 签名；桌面端只验证这份签名友好的 zip，避免 Tauri resource
复制展开目录时破坏 framework symlink，不再重签、不再临时改名 `.framework`。
整套机制叫 **managed runtime**。

## 二、组件 + 文件分布

```
hermes-agent-cn-desktop/        ← 桌面壳子
├── src/main.rs                  setup() 触发 bootstrap
├── src/process/
│   ├── runtime.rs               下载 / 签名校验 / 安装 / 回滚
│   └── dashboard.rs             启动 dashboard 子进程，优先 managed
├── src/commands/
│   └── runtime_manager.rs       4 个 Tauri command (info/check/install/rollback)
├── web/src/lib/tauri-bridge.ts  前端等 ready 事件 + 显示覆盖层
└── .github/workflows/
    └── release-desktop.yml      tag v* → 跨平台打 .exe/.dmg

Hermes-CN-Core/              ← 实际 agent（fork of NousResearch/hermes-agent）
├── tui_gateway/
│   ├── ws.py                    /api/ws WebSocket transport（官方，桌面端 ≥0.4 使用）
│   └── sse.py                   /api/v2/events SSE transport（P-009，已弃用，留给旧外壳）
├── hermes_cli/
│   └── web_server.py            FastAPI 入口，路由 /api/ws 与 /api/v2/{events,rpc}
├── scripts/
│   └── sign_runtime_manifest.py Ed25519 签 manifest
├── docs/RUNTIME_RELEASES.md     fork 侧发布流程
└── .github/workflows/
    └── release-runtime.yml      tag runtime-v* → PyInstaller + 签 + 发 Release
```

## 三、Runtime 版本号

Runtime 版本采用 schema v2：`runtime-v<kernelVersion>-cn.<runtimeRevision>`。
`kernelVersion` 对应 Hermes-CN-Core 的 `[project].version`，`runtimeRevision` 是同一
内核版本下中文 runtime 打包修订号，例如 `runtime-v0.16.0-cn.4`、
`runtime-v0.16.0-cn.5`。完整规范见 `Hermes-CN-Core/docs/RUNTIME_VERSIONING.md`。

## 四、首次启动时序（桌面端 PROD 模式）

```
用户双击 .msi 装好 → 第一次开桌面端

[tauri::Builder::default().setup() 开始]
  ↓
1. resolve HERMES_HOME，读 sticky profile，准备 host/port
  ↓
2. runtime::get_runtime_info() → current.json 不存在
  ↓
3. runtime::install_bundled_runtime_if_needed(resource_dir) 先检查安装包资源：
   static/bundled-runtime/stable-<platform>-<arch>.json
   static/bundled-runtime/hermes-agent-cn-runtime-<platform>-<arch>.zip
   或 static/bundled-runtime/hermes-agent-cn-runtime-<platform>-<arch>/
   如果存在，走本地验签、SHA-256 校验或已展开目录安装、smoke test，并把
   Dashboard web_dist 与 bundled skills 同步进 runtime/_internal
   如果不存在，才进入云端 managed runtime 下载兜底
  ↓
4. tauri::async_runtime::spawn(async move {...}) 起一个后台任务，
   setup() 立刻 return Ok(()) → 窗口立刻弹出
  ↓
[窗口已经开了，前端开始 bootstrap]
  ↓
5. tauri-bridge.ts::installTauriBridge() 调 get_runtime_config
   → 拿到 api_base_url="" 因为 Rust 还没填
  ↓
6. 检测到 prod 模式 + 空 url → 注入 Block H 覆盖层 DOM
   "正在启动Hermes Agent内核..."，随后根据 runtime-status 展示安装或启动状态
  ↓
7. 监听 Tauri 事件 "runtime-status"
  ↓
[同时 Rust 后台任务在跑]
  ↓
8. emit runtime-status "installing"
   如果包内 runtime 不存在或不可用，runtime::install_runtime_update(None) 开始：
   a. configured_manifest_url() →
      https://github.com/Eynzof/Hermes-CN-Core/releases/latest/download/stable-win32-x64.json
   b. reqwest GET → 拿到 manifest JSON
   c. configured_public_key() → baked-in PEM
   d. verify_signature(manifest) → Ed25519 验证 schemaVersion/channel/
      runtimeVersion/kernelVersion/runtimeFlavor/runtimeRevision/platform/arch/
      artifactUrl/sha256/sourceRepo/sourceCommit 12 字段 canonical payload 的签名
      （src/process/runtime.rs::signature_payload）
   e. reqwest GET artifact_url (https 强校验) → 拿到 ~35MB zip
   f. sha256(zip) == manifest.sha256 (大小写不敏感)
   g. tempfile::tempdir() 解压（zip-slip 防御 + 5000 文件 + 500MB 上限）
   h. find_executable_in(staging) 找 hermes-agent-cn-runtime-<plat>-<arch>.exe
   i. smoke_check_runtime(exe) 跑 `dashboard --help`，返回码 0
   j. fs::rename(staging, target) 装到
      %APPDATA%/cn.hermes.agent.desktop/runtime/versions/0.16.0-cn.4/
   k. write current.json 指向这个版本
   包内 runtime 路径同样会写 current.json，区别只是 source="bundled"
  ↓
9. emit runtime-status "starting-dashboard"
   dashboard::ensure_hermes_dashboard():
   a. dashboard.rs::resolve_hermes_command() →
      runtime::read_current_record() 命中 → 返回 versions/0.16.0-cn.4/exe path
   b. spawn 子进程，传 HERMES_HOME 等 env
   c. wait_for_dashboard 轮询 /api/status 直到 2xx 或 401
  ↓
10. probe dashboard_is_compatible → /api/upload 在 openapi.json 里
    （/api/ws 是上游原生路由，无需探测）
  ↓
11. fetch_session_token 从 dashboard 的 HTML 里 regex 出
    __HERMES_SESSION_TOKEN__
  ↓
12. 把 api_base_url / gateway_url / session_token / dashboard_handle
    全部写进 AppState
  ↓
13. emit runtime-status "ready"
  ↓
[前端那边]
  ↓
14. tauri-bridge 收到 ready 事件 → 关掉覆盖层 → 重新调
    get_runtime_config 拿到完整配置
  ↓
15. window.__HERMES_RUNTIME__ 写好 → installTauriBridge resolve
  ↓
16. main.tsx createRoot.render(<App />) → React mount
  ↓
17. App 内部 gateway-client.ts::connect() →
    socketFactory(ws://127.0.0.1:<port>/api/ws?token=...)
    （gateway-socket-path.ts 选择：webview 原生 WebSocket 直连，
    被拦则自动切 Rust 中继 ws_proxy.rs——线协议完全相同）
  ↓
18. 服务端 hermes_cli/web_server.py @app.websocket("/api/ws") →
    tui_gateway/ws.py::handle_ws:
    - token query 验签
    - accept 后立即 emit gateway.ready 事件帧
  ↓
19. 前端 gateway-client.ts 收到 open + gateway.ready
    → 用户可以发"你好"了
  ↓
20. 用户发"你好"
  ↓
21. gateway-client.ts::request():
    同一条 WS 上发 {"jsonrpc": "2.0", "id": "w1", "method": "prompt.submit", ...}
  ↓
22. tui_gateway/server.py::dispatch:
    - 短 handler → 同 socket 回一帧 JSON-RPC response
    - 长 handler → 线程池跑完后同 socket 回帧（无异步 ack 拆分）
  ↓
23. agent 真的开始处理 → emit message.delta / tool.start / ...
    → 同一条 WS 推帧
    → 前端 gateway-client.ts::handleFrame 派发到 typed listeners
    → React 组件更新
```

## 五、后续启动（managed runtime 已装）

跳过 1-15 大部分：

```
setup() → runtime::read_current_record() 返回 Some(record)
       → 走 ensure_hermes_dashboard 直接用 record.executable_path
       → 拉 token，写 state，emit "ready"
       → 窗口已 visible，bridge 看到 apiBaseUrl 非空，不显示覆盖层
       → React 直接 mount
```

冷启动延迟约 1-3s（cargo 优化构建 + 一次 ensure_dashboard 探测）。

### 本地开发启动

现在 `pnpm tauri:dev` 默认也走 managed runtime 路径，不再静默连接
PATH 里的 `hermes`。脚本会先把相邻 checkout：

```
../Hermes-CN-Core
```

安装进桌面端 runtime 目录里的独立 venv，然后写入 `current.json`：

```
~/Library/Application Support/cn.hermes.agent.desktop/runtime/
  versions/dev-local-<kernelVersion>-<commit>[-dirty-...]/venv/
  current.json
```

这个 venv 是普通 wheel 安装，不是 editable install；dashboard 进程从
`current.json.executablePath` 启动，所以代码和依赖都收束在 runtime
目录里。开发时如果刚改过 `Hermes-CN-Core`，重新运行：

```
pnpm runtime:install-local -- --force
```

再启动：

```
pnpm tauri:dev
```

桌面端已锁定到 managed runtime：默认和 dev 都走 managed runtime，不再支持连接外部
dashboard。

```
pnpm tauri:dev:external
```

`pnpm tauri:dev:external` 现在只是**已废弃的兼容别名**，它走的是和 `pnpm tauri:dev`
完全相同的 managed dev 路径（脚本会显式设置 `HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT=0`）。
代码侧 `external_agent_allowed()` 会忽略 `HERMES_DESKTOP_ALLOW_EXTERNAL_AGENT` 和
`HERMES_DESKTOP_DEV_EXTERNAL_DASHBOARD`、始终返回 `false`，因此这两个环境变量已不再生效，
别名仅为向后兼容保留。

## 五、Runtime 升级

```
fork main 收到 P-009 之后的新代码 → 你 git tag runtime-v0.16.0-cn.5; git push origin runtime-v0.16.0-cn.5
  ↓
fork CI release-runtime.yml 触发：
  matrix: win32-x64 / darwin-arm64 / linux-x64
  per job:
    1. setup-python 3.11
    2. pip install -e . + pyinstaller + cryptography
    3. pyinstaller --onedir --name hermes-agent-cn-runtime-<plat>-<arch> hermes_cli/main.py
    4. <NAME>.exe dashboard --help（smoke test，验证 PyInstaller 包对了）
    5. zip dist/<NAME>
    6. python scripts/sign_runtime_manifest.py 用 RUNTIME_SIGN_PRIVATE_KEY_PEM
       签 manifest JSON （stable-platform-arch.json）
  release job:
    softprops/action-gh-release → 把 3 zip + 3 manifest 发到
    releases/runtime-v0.16.0-cn.5
  ↓
现在 https://github.com/Eynzof/Hermes-CN-Core/releases/latest/download/
指向 runtime-v0.16.0-cn.5 这个 Release
  ↓
任何已装桌面端下次启动时：
  1. 看到 current.json 里是 0.16.0-cn.4
  2. 用户在 UI 里点 "Check for update"，或者首次启动逻辑就会
     check_runtime_update() → 拿到 0.16.0-cn.5 manifest → update_available
  3. 用户确认升级 → runtime_install_update → 走 first-run 那条
     install 路径
  4. current.json 改指 0.16.0-cn.5，previous_runtime_version=0.16.0-cn.4
  5. 出问题可以 runtime_rollback 回 0.16.0-cn.4
```

## 六、桌面端升级

```
你 git tag v0.5.3; git push origin v0.5.3
  ↓
desktop CI release-desktop.yml 触发：
  matrix: windows-latest / macos-14 (arm64)
  per job:
    1. setup-node + pnpm + rust toolchain
    2. pnpm install
    3. 解析 runtime manifest 的 sourceRepo/sourceCommit，checkout 对应 runtime 源码仓库
    4. stage Dashboard web_dist、bundled skills、目标平台 runtime payload + manifest
       Windows 与 macOS 都使用上游签好的 runtime zip；macOS 额外校验包内 framework 与 Mach-O 签名
    5. tauri-apps/tauri-action@v0 → 打 .exe / .dmg
       runtime URL + 公钥仍是 baked-in 兜底，不需要 env wire 进 CI
  ↓
新装包发到 releases/v0.5.3 → 用户下载装新版
  ↓
新版起来后，看到 current.json 已经有 runtime → 不下载 → 直接用。
全新安装则先使用安装包内置 runtime；除非内置资源缺失或用户主动升级，
才进入云端下载流程。
```

## 七、信任链 / 攻击面

谁要伪造一个 Hermes-CN-Core runtime 让所有桌面端装上它？得同时
做到：

1. **替换 GitHub Release 的 zip**：需要 push 权限到
   runtime release 仓库的发布权限（或者干掉 GitHub 自己）。
2. **重签 manifest**：需要 `RUNTIME_SIGN_PRIVATE_KEY_PEM` 私钥。
   这个 key 只存在 GitHub Actions secret 里，写入后不能从 GitHub 读出。
3. **桌面端公钥被替换**：桌面端的公钥是**硬编码进 binary**的
   （`src/process/runtime.rs::FALLBACK_PUBLIC_KEY_PEM`）。要替换
   就得让用户安装一个用不同公钥编出的桌面端，回到 #1。

也就是说，攻击者需要同时攻破 release 仓库发布权限和签名私钥，
才能投毒。普通 CDN 投毒（HTTPS 中间人 / 缓存毒化）不工作，因为
Ed25519 验签会失败、SHA-256 校验会失败、桌面端拒绝安装。

正交防御：

- `artifact_url` 必须 `https://` 开头（`runtime.rs:477-495`），
  防止有人把 manifest 改成 `file://` / `http://` 引用本地或明文。
- zip 解压做 zip-slip 防御 + 5000 文件 + 500MB 上限
  （`runtime.rs:722-771`）。
- 解压后跑 smoke test (`dashboard --help`)，挂了就不切到这个版本。
- AppState 里 `previous_runtime_version` 字段支持一键 rollback。

## 八、密钥轮转

如果私钥泄露 / 怀疑被偷：

1. 本地生成新 Ed25519 keypair（参考 fork 的 `docs/RUNTIME_RELEASES.md`）
2. 私钥 → 用 `gh secret set RUNTIME_SIGN_PRIVATE_KEY_PEM` 替换
3. 公钥 → 改 `src/process/runtime.rs::FALLBACK_PUBLIC_KEY_PEM`
   常量 + 同步到 `Hermes-CN-Core/docs/RUNTIME_RELEASES.md`
4. 桌面端 tag 一个新 v（让所有用户拿到新公钥的 binary）
5. fork 端 tag 一个新 runtime-v（用新私钥重签）

**注意**：步骤 4 必须先做完且所有用户都升级了，再做步骤 5。否则
旧公钥的桌面端会拒绝新签名，直接卡在覆盖层不进。或者保留两套
keypair 同时签的过渡期（这个我们的代码现在不支持，要的话改
`signature_payload` 增加 `key_id` 字段，桌面端按 key_id 选公钥）。

## 九、调试问题

| 现象 | 多半的原因 | 怎么查 |
|---|---|---|
| 桌面端窗口卡在 "正在下载 runtime" 不动 | 包内 runtime 缺失且 manifest URL 404 / 网络不通 | 先检查安装包内 `Contents/Resources/bundled-runtime/` 是否有当前平台 manifest，以及 Windows 的 zip 或 macOS 的展开目录，再看 GET stable-<platform>-<arch>.json |
| 显示 "runtime 安装失败：SHA-256 mismatch" | artifact 被劫持 / CDN 缓存了旧版 | 强制刷新 GitHub Release 缓存，或重发布 |
| 显示 "runtime 安装失败：Signature verification failed" | 公私钥不匹配 / fork 重签了 manifest | 对照桌面端二进制里的公钥 vs `RUNTIME_SIGN_PRIVATE_KEY_PEM` |
| dashboard 起来但聊天报 "与运行时的连接已断开" | /api/ws 握手失败（token 失效 / 进程半死） | 看环境诊断的「网关 WebSocket」项；`?wspath=relay` 试中继路径；必要时状态栏重启内核 |
| 升级后启动闪退 | 新 runtime 跑不起来 | 删 `%APPDATA%\cn.hermes.agent.desktop\runtime\current.json` 让桌面端重新走 first-run |
| 升级想回滚 | runtime 出 bug | UI 调 `runtime_rollback` 或手动改 current.json 指 versions/旧版本/ |

## 十、Issue 链接

* 本文档 — desktop/runtime 边界和 managed runtime 全链路说明
* `Hermes-CN-Core` PR #4 — P-009 server-side patch + 发布管线
* fork 的 `docs/RUNTIME_RELEASES.md` — 签名密钥、发布操作细节
