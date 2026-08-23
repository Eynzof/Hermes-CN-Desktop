# Windows Installer & Runtime Packaging — Python → TypeScript Rewrite Plan

## 1. Summary

Windows 侧"安装器 + managed runtime 打包"是桌面端（Tauri 壳）把 Hermes-CN-Core
内核送进用户机器的整条链路。本计划的核心设计决策是：**继续使用 Core 产出的
PyInstaller 冻结 Python runtime 二进制 + Ed25519 签名 manifest（`runtime-v<kernel>-cn.<rev>`，
`cn-desktop` extra 预打包全部桌面后端），Rust 运行时管理器（`src/process/runtime.rs`）保持
为安装/验签/更新/回滚的执行者**；TS/JS 侧只重写"安装器与打包工具链"，即：

1. 桌面仓库新增自己的 PowerShell 一行安装器 `scripts/install.ps1`
   （`irm https://<cdn>/install.ps1 | iex`），负责 uv、Python 3.14、Node.js、
   ripgrep、ffmpeg、venv 的托管式安装，home 锚定 `%LOCALAPPDATA%\hermes`；
2. 把 Core 的 Python 构建/签名/规范化脚本移植为 TS/JS（`node:crypto` 完成
   Ed25519 签名与 SHA-256，kimi-code 的 native SEA 管线是已证实的 TS 等价物）；
3. Rust 侧加固：补 bundled runtime 的"禁止静默降级"semver 守卫，保持
   manifest schema v2 与 `current.json` schema v2 不变。

本计划不删除 WebSocket 依赖（那是后续 in-process 化目标），但冻结了
`current.json` / manifest / `HERMES_DESKTOP_MANAGED=1` / `HERMES_HOME/cache`
四条跨组件契约，作为迁移期间的行为边界。

## 2. Current Python implementation

### 2.1 Core 安装器（被替代的对象）

- `D:/hermes-agent-cn/scripts/install.ps1`（约 101KB，纯 ASCII 强制）：
  一行安装器入口，`param` 里含 `-NoVenv/-SkipSetup/-Branch/-Commit/-Tag/-HermesHome/-InstallDir`
  以及 stage 协议（`-Manifest/-Stage/-ProtocolVersion/-NonInteractive/-Json/-ShowResolvedPaths`）。
  关键能力：
  - 8.3 短路径归一化（`ConvertTo-LongPath`，kernel32 → COM → profile-root 三阶回退），
    修复 `%TEMP%/%LOCALAPPDATA%` 短别名导致 provider cmdlet 报"路径不存在"；
  - `Get-WindowsArch` 用 `Win32_Processor.Architecture` 绕过 Prism 模拟，识别真 arm64；
  - `Get-PowerShellHostExe` 用 `Get-Process -Id $PID` 解析宿主 exe，禁止裸 `powershell`
    拉起 astral uv 安装器（pwsh 下会挂）；
  - uv 托管 Python：`$PythonVersion = "3.14"`，fallback `3.12/3.13/3.10`，
    `Resolve-AvailablePythonVersion` 在 venv 阶段跨进程重解析解释器（`uv python find`）；
  - Node 22 托管安装 + `Ensure-NodeExeOnPath`（npm 生命周期脚本需要 node 在 PATH）；
  - Managed tools 目录 `$HERMES_HOME/tools`：`rg.exe`、`rtk.exe`、`coreutils\bin\cat.exe`；
  - ffmpeg（`Test-Ffmpeg`/安装分支，install.ps1:1534+ / 1888+）；
  - PortableGit / Git for Windows（install.ps1:1262+，含 57MB PortableGit 抓取与
    `$ProgressPreference = "SilentlyContinue"` 提速）；
  - stage 协议（install.ps1:4263+）：`$InstallStages` 数组、`Invoke-Stage` 输出单行 JSON、
    `protocol_version=1`，供 Hermes-Setup.exe / CI 逐 stage 驱动；`Stage-Desktop` 为 opt-in。
- `D:/hermes-agent-cn/scripts/install.cmd`：CMD 包装，`powershell -ExecutionPolicy ByPass
  -NoProfile -Command "iex (irm ...)"`。
- `D:/hermes-agent-cn/scripts/install_coreutils.py`：Microsoft Coreutils 安装
  （winget `Microsoft.Coreutils --silent` → GitHub latest release 直下），
  落 `%HERMES_HOME%/tools/coreutils`，写 HKCU PATH + 注册表 PATH 刷新。
- `D:/hermes-agent-cn/scripts/sign_runtime_manifest.py`：Ed25519 签 manifest。
  载荷字段序（schema v2，12 字段）必须与 `src/process/runtime.rs::signature_payload()`
  逐字段一致：`schemaVersion/channel/runtimeVersion/kernelVersion/runtimeFlavor/
  runtimeRevision/platform/arch/artifactUrl/sha256/sourceRepo/sourceCommit`。
  版本形如 `<kernel>-cn.<rev>`；`artifactUrl` 强制 https；私钥只从
  `RUNTIME_SIGN_PRIVATE_KEY_PEM` 环境变量读。
- `D:/hermes-agent-cn/scripts/normalize_macos_pyinstaller_runtime.py`：
  把 PyInstaller 复制的 `Python.framework` 目录重写成标准 symlink 布局，供 codesign。
- `D:/hermes-agent-cn/scripts/release.py`：CalVer tag、changelog、GitHub Release
  （桌面侧已有 `scripts/sync-release-version.mjs`，无需全量移植）。
- `hermes_cli/runtime_provider.py`：注意——该文件是 **LLM provider/凭证解析**，
  与安装器打包无关，仅在本计划 §9 记录为"不在本 feature 范围"，避免误删。

### 2.2 Core 运行时发布（产物来源，保留）

- `.github/workflows/release-runtime.yml`：`pip install -e ".[cn-desktop]"` →
  PyInstaller `--onedir` → macOS normalize + `sign_macos_runtime_payload.sh`（P-060
  只给主程序签 `allow-unsigned-executable-memory`）→ 内置 Node 22 + Ink TUI
  （P-032，`HERMES_NODE`/`HERMES_TUI_DIR`）→ `scripts/sign_runtime_manifest.py` 签
  `stable-<platform>-<arch>.json` → 发 GitHub Release。
- `pyproject.toml` 的 `cn-desktop` 聚合 extra（P-015）：`web/anthropic/mcp/feishu/dingtalk/
  wecom` + `aiohttp/qrcode/cryptography`，配合 `--collect-submodules`/`--copy-metadata` 与
  构建环境 import 冒烟（P-014 MCP SDK、P-035b 插件迁移后适配器、P-057 memory provider）。
- `hermes_constants.configure_managed_runtime_caches()`（P-026，`hermes_bootstrap` 首个 import
  调用）：`HERMES_DESKTOP_MANAGED=1` 时把 `HF_HOME/HUGGINGFACE_HUB_CACHE/TORCH_HOME/
  TIKTOKEN_CACHE_DIR/MPLCONFIGDIR/NLTK_DATA/PLAYWRIGHT_BROWSERS_PATH` setdefault 到
  `<HERMES_HOME>/cache/<tool>`，未设置 `TMPDIR/TEMP/TMP` 时指向 `<HERMES_HOME>/cache/tmp`。

### 2.3 Desktop 现有（复用基线）

- `scripts/stage-bundled-runtime.mjs`：下载 runtime zip + manifest → `static/bundled-runtime/`
  （schema v2 校验、SHA-256 校验、可选 `--expand-artifact`）。
- `scripts/install-local-runtime.mjs`：dev 模式把 `../Hermes-CN-Core` 装进
  `<dev-runtime>/versions/dev-local-<ver>-<commit>[-dirty-<hash>]/venv`（安装 `[cn-desktop]`），
  写 `current.json`（schema v2）。
- `scripts/tauri-dev-managed.mjs`：`tauri:dev` 入口，强制 managed runtime 路径。
- `scripts/package-portable-windows.mjs`：portable zip（`portable.marker` + `data/` 锚定）。
- `src/process/runtime.rs`（4532 行）：`runtime_root()`/`decide_non_override_root()`、
  `read_current_record()`、bundled reconcile（`install_bundled_runtime_if_needed`）、
  `signature_payload()`/`verify_signature_with_key()`、下载/解压（zip-slip + 5000 文件 +
  500MB 上限）/`smoke_check_runtime()`（180s，`HERMES_RUNTIME_SMOKE_TIMEOUT_SECS` 可调）、
  安装/`previous_runtime_version` 回滚。`RuntimeInstallRecord` schema v2、`portable.marker`。
- `src/commands/runtime_manager.rs`：`runtime_info/check/install/rollback` 4 个 Tauri command。
- `installer/nsis/hooks.nsh`：卸载时询问是否删除 `$INSTDIR\data`；`tauri.conf.json` 资源映射
  `static/bundled-runtime/` → `bundled-runtime/`。
- `docs/managed-runtime.md`（首次启动/升级时序、信任链）、`docs/portable-mode.md`。
- `.codex/skills/desktop-release-preflight/SKILL.md`：发版安全闸门（identifier 承重、
  `bundled_runtime_tag` 防静默降级、schemaVersion 不 bump、国内镜像 artifactUrl 先定后签、
  Authenticode 现状未签名、canary 优先）。

### 2.4 相关 fork notes

P-014 / P-015 / P-026 / P-032 / P-053（`scripts/update_thirdparty.py` 统一钉 rg/rtk 版本 +
`--china-mirror` 回退）/ P-057 / P-058（Windows shell 偏好 git-bash → pwsh → powershell 5.1）/
P-060 全部在 `D:/hermes-agent-cn/FORK_NOTES.zh-CN.md` 有"现象/根因/改动/测试"记录。

## 3. Target TypeScript design

### 3.1 决策记录：runtime 二进制保留 Python

PyInstaller 冻结 runtime 是 agent 执行体（Python 解释器 + 全部后端 SDK），TS 侧
**没有等价物**（kimi-code 的 SEA 只是把 Node JS bundle 打进单文件，不是 Python agent）。
因此：
- 产物所有权仍归 Core（`release-runtime.yml` + `cn-desktop` extra + Ed25519 签名）；
- Desktop 只消费：`scripts/stage-bundled-runtime.mjs`（已有）→ NSIS 内置 zip/manifest →
  `runtime.rs` 本地验签安装；
- 本 feature 的 TS 化边界 = 安装器 + 打包工具链 + 构建脚本，不重写 agent 执行体。

### 3.2 模块布局（web/src 之外，属于 repo 根的 scripts/ 与 Rust）

```
scripts/
├── install.ps1                # 新增：桌面版一行安装器（PowerShell 保留，见 §5.1）
├── install.cmd                # 新增：CMD 包装（一行 curl + powershell）
├── install-toolchain.mjs      # 新增：uv/Python3.14/Node22/rg/ffmpeg/venv 托管安装
├── install-coreutils.mjs      # 新增：TS 移植 install_coreutils.py
├── install-portablegit.mjs    # 新增：PortableGit 探测/安装/`HERMES_GIT` 注入
├── sign-runtime-manifest.mjs  # 新增：TS 移植 sign_runtime_manifest.py（node:crypto）
├── verify-runtime-manifest.mjs# 新增：签名+sha256+平台校验（CI 用，与 Rust 验签同构）
├── normalize-macos-runtime.mjs# 新增：TS 移植 normalize_macos_pyinstaller_runtime.py
├── build-windows.mjs          # 新增：TS 移植 scripts/build_scripts/build_windows.py
├── stage-bundled-runtime.mjs  # 已有（保留）
├── install-local-runtime.mjs  # 已有（保留）
├── tauri-dev-managed.mjs      # 已有（保留）
└── package-portable-windows.mjs # 已有（保留）
```

### 3.3 数据流（一行安装器）

```
irm https://<cdn>/install.ps1 | iex
  → 纯 ASCII 脚本，PS5.1 可解析
  → 8.3 长路径归一化（移植 Core 的三阶 resolver）
  → 解析 HERMES_HOME（默认 %LOCALAPPDATA%\hermes；逃生舱 HERMES_HOME）
  → stage 1 bootstrap：用 Get-PowerShellHostExe 拉起 uv 官方安装器
  → stage 2 tools：install-toolchain.mjs / install-coreutils.mjs / install-portablegit.mjs
      → %HERMES_HOME%\tools\{uv,rg.exe,coreutils,node,ffmpeg,git}
  → stage 3 python：uv python install 3.14（fallback 3.12/3.13/3.10）+ uv venv
  → stage 4 venv：pip install "<source-or-release>[cn-desktop]"
  → stage 5 smoke：hermes dashboard --help（py_compile web_server.py 前置，P-59004）
  → stage 6 desktop 握手：写 current.json（schema v2, source="local-source"）
  → 所有子进程 env 带 HERMES_DESKTOP_MANAGED=1 → Core 侧收敛缓存到 %HERMES_HOME%\cache
```

### 3.4 Rust 侧设计增量

- `runtime.rs` 新增 `no-downgrade` 守卫：bundled reconcile 在
  `current.runtime_version == manifest.runtime_version` 相等分支之前，先比较 semver：
  当前版本 ≥ 内置版本则跳过内置安装（解决 desktop-release-preflight 坑 1）。
- 保持 `MANIFEST_SCHEMA_VERSION = 2`；`read_current_record()` 未来加 v2→v3 迁移槽位
  （先发"能读旧 schema"的客户端，再 bump）。
- 新增 `toolchain_status` 只读命令（可选）：报告 `tools/*` 版本，供设置页展示。

## 4. Data models & persistence

- `current.json`（schema v2，`RuntimeInstallRecord`）：现有字段不动
  （`runtimeVersion/kernelVersion/runtimeFlavor/runtimeRevision/platform/arch/path/
  executablePath/source/installedAt/sourceRepo/sourceCommit/localDirtyHash/
  artifactSha256/previousRuntimeVersion`）。新增可选 `toolchain` 对象（uv/python/node/rg/ffmpeg/
  git 版本快照），用于升级决策；旧记录不填，兼容读。
- 工具链锁文件 `%HERMES_HOME%\tools\toolchain.json`：`{schemaVersion:1, tools:{uv:{version,sha256},
  python:{version}, node:{version}, rg:{version,sha256}, ffmpeg:{version,sha256},
  coreutils:{version}, portableGit:{version}}, installedAt}`。这是 Core `update_thirdparty.py`
  钉版本（P-053）的桌面侧等价物，单一事实来源，支持 `--china-mirror` 镜像前缀。
- 安装器状态 `%LOCALAPPDATA%\hermes\install-state.json`：一行安装器幂等/断点续跑
  （每个 stage 记录 `{stage, ok, at}`），与 Core stage 协议的 stdout JSON 双轨并存。
- 缓存收敛表（来自 P-026，桌面侧不重实现，只作为契约文档 + 安装器 env 注入清单）：
  `HF_HOME/HUGGINGFACE_HUB_CACHE/TORCH_HOME/TIKTOKEN_CACHE_DIR/MPLCONFIGDIR/NLTK_DATA/
  PLAYWRIGHT_BROWSERS_PATH → <HERMES_HOME>/cache/<tool>`；`TMPDIR/TEMP/TMP → <HERMES_HOME>/cache/tmp`
  （仅当三者都未设置）。持久化位置不变（`<runtime_root>/hermes-home/cache`），
  portable 模式自动跟随 `data/`。
- 存储形态：全部 JSON 文件，无 SQLite 需求；`current.json` 原子写（tmp+rename）沿用现有实现。

## 5. Third-party library strategy

| Python/工具 | TS 等价物 | 证据 |
|---|---|---|
| PowerShell `irm|iex` 一行安装器 | **保留 PowerShell**（无 TS 等价；`install.ps1` 就是分发载体） | kimi-code 同样只托管 CDN `install.ps1`（`apps/kimi-code/README.md:24`，`src/constant/app.ts:124-128` 返回 `${cdnBase}/install.ps1`），仓库内无 .ps1 源码 |
| `cryptography` Ed25519（sign_runtime_manifest.py） | `node:crypto` 内建 Ed25519（`crypto.sign(null, data, privateKey)`），无需 npm 依赖；base64 用 `Buffer` | kimi-code `scripts/native/04-sign.mjs` 只用 `node:crypto` 的 `createHash` 做 sha256，不引密码学 npm 包 |
| `hashlib` sha256 / `pybase64` | `node:crypto.createHash('sha256')` + `Buffer.toString('base64')` | kimi-code `scripts/native/package.mjs:26-34`、`04-sign.mjs:31-39` |
| `urllib.request` 下载 + token 头（install_coreutils.py） | 内置 `fetch`/`https`；GitHub token 走 `GITHUB_TOKEN/GH_TOKEN` 头；超时/重试照 `stage-bundled-runtime.mjs:103-136`（fetch→curl 回退） | `stage-bundled-runtime.mjs` 已有 |
| `winreg` PATH 写/读（install_coreutils.py） | **无直接 Node 等价**；薄 shim：`reg.exe query/set`（`REG_EXPAND_SZ`）或 spawn `powershell -Command "[Environment]::SetEnvironmentVariable(...)"`；进程内 PATH 用 `process.env.PATH` 前插 | kimi-code 不写注册表（npm postinstall 只落文件），需自研 shim |
| `zipfile` 解压（zip-slip/500MB 上限） | 客户端侧已在 Rust（`zip` crate，runtime.rs:722-771）；构建侧 TS 用 `unzip`（已有 `stage-bundled-runtime.mjs:157`）或 `yazl`（打包） | kimi-code `package.mjs:44-47` 用 `yazl`（npm dep 已存在） |
| `psutil`/`taskkill` venv 进程树清扫（test_install_ps1_venv_process_tree.py） | `child_process.spawn('taskkill',['/PID',pid,'/T','/F'])`；Windows exe 可改名不可覆盖语义参照 kimi | kimi-code `src/cli/update/native-swap.ts:9-16`（rename exe→.bak→staged→exe） |
| `semver` 比较（防降级守卫） | npm `semver`（`gt`/`satisfies`） | kimi-code `native-swap.ts:24` `import { gt } from 'semver'` |
| `plistlib` + macOS codesign（entitlements） | plist 文件原样提交 + `codesign` spawn（`buildCodesignArgs` 模式） | kimi-code `scripts/native/04-sign.mjs:11-29`、`entitlements.plist` |
| `release.py`（GitHub Release 编排） | `scripts/sync-release-version.mjs` + `gh` CLI / GitHub REST fetch（已有） | desktop `scripts/sync-release-version.mjs` |
| PyInstaller 冻结 runtime | **无 TS 等价**——保留 Core 产物，见 §3.1 | kimi-code SEA（`02-sea-blob.mjs`/`03-inject.mjs`）只是 Node 单文件，不能替代 Python agent |
| Python `venv`/`pip` | uv 托管（`uv venv`/`uv pip install`），与 Core install.ps1 同源 | install.ps1 的 `Install-Venv`/`Resolve-AvailablePythonVersion` |
| 版本钉 + 国内镜像（P-053） | `update-thirdparty.mjs`（新增）：从 GitHub latest API 检查 rg/rtk/ffmpeg，同步 `toolchain.json` 与 CI YAML，支持 `HERMES_THIRDPARTY_MIRROR` | Core `scripts/update_thirdparty.py` 的 TS 移植 |

kimi-code 参考结论：其 native 打包管线（`apps/kimi-code/scripts/native/01-bundle.mjs →
02-sea-blob.mjs → 03-inject.mjs → 04-sign.mjs → 05-verify.mjs → package.mjs →
produce-manifest.mjs`）证明了"TS 脚本 + node:crypto/sha256 + yazl + codesign + manifest.json
（`{version, tag, platforms:{target:{filename,checksum}}}`）"的完整打包模式可直接复刻到
桌面仓库的 runtime staging/签名脚本；但其**安装器本体是外部 CDN 上的 install.ps1**，
仓库内只有消费方代码——与本计划"保留 PowerShell 一行安装器、TS 化其余部分"一致。

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Tauri IPC**：复用 `src/commands/runtime_manager.rs` 的 `runtime_info/runtime_check_update/
  runtime_install_update/runtime_rollback`；`runtime_info` 已暴露 `RuntimeInfo`（含
  `runtime_root/current_record_path/versions_dir/downloads_dir`）。新增只读
  `toolchain_status` 命令可在设置页展示工具链版本，不改 `RuntimeInfo` schema。
- **前端**：`web/src/lib/tauri-bridge.ts` 的 onboarding 覆盖层（Block H）与 `runtime-status`
  事件流保持不动；一行安装器是桌面外路径（终端用户），与窗口内安装并行，互不冲突。
- **package.json**：新增 `install:windows`（`powershell -ExecutionPolicy ByPass -File
  scripts/install.ps1`）、`toolchain:install`、`runtime:sign`、`runtime:verify`、
  `runtime:stage-bundled-windows`（已有）等脚本；`tauri:build:bundled-windows` 前插
  `runtime:verify` 步骤（验签内置 manifest 后再打 NSIS）。
- **NSIS / portable**：`installer/nsis/hooks.nsh`、`tauri.conf.json` 资源映射、
  `package-portable-windows.mjs` 不变；`scripts/install.ps1` 生成的 `%LOCALAPPDATA%\hermes`
  与 portable 的 `<unzip>\data\hermes-home` 是两种互斥 home（`decide_non_override_root`
  已处理优先级），文档需写明"portable 用户无需跑一行安装器"。
- **Rust**：`runtime.rs` 增加防降级守卫与 toolchain 快照字段（§3.4）；`main.rs` 启动时
  若检测 `HERMES_HOME\tools` 存在但 desktop 未初始化，可提示"检测到 CLI 安装，是否迁移"，
  但不自动接管（尊重 standalone CLI 的共享 home）。

## 7. Removing the WebSocket dependency (migration path)

本 feature 不直接删除 WS，它是"内核如何上机"的地基。迁移路径按契约冻结推进：

1. **冻结 API 面**（本计划期间不许破坏）：`current.json` schema v2 字段集、
   manifest schema v2 的 12 字段签名载荷、`HERMES_DESKTOP_MANAGED=1` 语义、
   `HERMES_HOME/cache` 收敛变量集合、`runtime_root()` 优先级（env > portable marker >
   Windows 安装目录 > legacy AppData）。
2. **阶段 A（现状）**：桌面端通过 managed runtime 启动 Python dashboard，前端走
   `/api/ws`（`web/src/lib/gateway-client.ts` + `src/process/ws_proxy.rs` 中继兜底）。
3. **阶段 B（本计划落点）**：安装器/打包全链路 TS 化 + Rust 加固；内核仍 Python，
   WS 依赖不变；唯一变化是"上机方式"更快、可脚本化、可回滚。
4. **阶段 C（后续 in-process 计划）**：当 agent loop 迁到 TS（kimi-code `packages/agent-core`
   等价物）后，managed runtime 降级为可选 executor；届时冻结面允许演进（bump schema 前
   必须先发"读旧 schema"客户端）。
5. 删除路径标识：`docs/managed-runtime.md` 的 `/api/ws` 时序图保留到阶段 C；
   本计划只删 Core 侧 Python 构建脚本在桌面管线中的调用点，不删 Core 仓库文件。

## 8. Migration phases & task breakdown

- **Phase 0 — 决策落档（0.5d）**：把 §3.1 决策（保留 PyInstaller runtime + 签名 manifest）
  写进 `docs/managed-runtime.md`；确认 `runtime.rs` 防降级守卫排期。
- **Phase 1 — 桌面版一行安装器（3-5d）**：`scripts/install.ps1` + `install.cmd`
  （纯 ASCII、8.3 长路径、`Get-PowerShellHostExe`、stage 协议、uv/Python 3.14/Node 22/
  rg/ffmpeg/venv、`%LOCALAPPDATA%\hermes` 默认 home）；`install-toolchain.mjs` 实现
  `toolchain.json` 锁文件与镜像前缀。
- **Phase 2 — Coreutils/PortableGit TS 移植（2d）**：`install-coreutils.mjs`
  （winget → GitHub 直下 → `tools\coreutils` → 注册表 PATH shim）、
  `install-portablegit.mjs`（探测系统 git / 57MB PortableGit 下载，`HERMES_GIT` 注入）。
- **Phase 3 — 签名/校验/规范化 TS 移植（2-3d）**：`sign-runtime-manifest.mjs`、
  `verify-runtime-manifest.mjs`（载荷字段序与 `runtime.rs::signature_payload` 对照测试）、
  `normalize-macos-runtime.mjs`、`build-windows.mjs`（替换 `build_windows.py`）。
- **Phase 4 — Rust 加固（1-2d）**：bundled reconcile 防降级 semver 守卫；
  `RuntimeInstallRecord.toolchain` 可选字段；`toolchain_status` 命令。
- **Phase 5 — CI + 测试（2-3d）**：GitHub Actions 增加 Windows job 跑
  `install.ps1` 冒烟 + `runtime:verify`；移植 Core 的 6 个 `test_install_ps1_*` 断言为
  vitest（读源断言）与 Windows-only 集成测试。
- **Phase 6 — 文档（1d）**：更新 `docs/managed-runtime.md`、`docs/portable-mode.md`、
  README；补 `docs/windows-installer.md`。

## 9. Risks & open questions

- **无 TS 等价项（最高风险）**：PyInstaller 冻结 Python runtime 无法 TS 化——
  决策保留，但意味着"一行安装器装 Python 内核"在阶段 C 之前始终存在，WS 依赖无法
  仅靠本 feature 移除。
- **PowerShell 安装器无 TS 等价**：`irm|iex` 必须原生 PS（kimi-code 同构，其
  install.ps1 不在仓库内、无法引用实现）；桌面版 `install.ps1` 是**新写**而非移植，
  需自行保持 6 个回归契约（ASCII-only、uv 宿主解析、Python fallback 跨进程重解析、
  node PATH 注入、venv 进程树清扫、web_server.py 语法探针）。
- **注册表操作无 Node 原生等价**：Coreutils PATH 写入需 `reg.exe`/PowerShell shim，
  域策略锁注册表的环境会降级为仅进程内 PATH。
- **ffmpeg 无 kimi-code 先例**：kimi-code 不打包 ffmpeg；需决策分发源
  （winget vs GitHub release 钉 sha256 + 镜像，P-053 模式），并处理体积/许可。
- **Authenticode 未签名**（desktop-release-preflight #5）：安装器产物.exe 仍会触发
  SmartScreen；一行安装器虽绕开下载器签名，但 uv/Node/ffmpeg 下载本身需 https+sha256。
- **防降级守卫的版本语义**：`runtime-v<kernel>-cn.<rev>` 的 `cn.<rev>` 是发布修订号，
  不能只用 kernelVersion 比较；守卫必须解析完整 runtimeVersion 三元组
  （kernel + flavor + revision），测试要覆盖"同 kernel 高 rev"场景。
- **`hermes_cli/runtime_provider.py` 澄清**：该文件是 provider 凭证解析，不在本 feature；
  若后续计划误把它当"runtime 打包"处理会浪费时间——已在 §2.1 标注。
- **shell 偏好（P-058）落点**：git-bash → pwsh 7 → PS 5.1 是 Core 的**运行时**默认；
  一行安装器自身必须**总是**用解析出的 PowerShell 宿主执行（不做 bash），两者不冲突，
  但文档要写清。

## 10. Test strategy

- **源级断言（vitest，移植 Core 6 个 `test_install_ps1_*`）**：
  - `install.ps1` 纯 ASCII（禁非 ASCII 字节，防 PS5.1 ANSI 解码错位）；
  - 无裸 `powershell` 拉起 astral uv（必须是 `& $psHostExe ...`）；
  - `Resolve-AvailablePythonVersion` 在 `Install-Venv` 里先于 `uv venv` 调用，且复用
    `$PythonFallbackVersions` 单源；
  - `Ensure-NodeExeOnPath` 在 npm 阶段前把 node 目录前插 PATH；
  - `venv` 清扫用 `taskkill /T /F` 按 exe 路径选进程树（Windows-only 集成，复用
    `tests/test_install_ps1_venv_process_tree.py` 的 fake-bin 手法）；
  - `py_compile hermes_cli/web_server.py` 失败即 stage 失败（P-59004）。
- **签名/校验同构测试**：`sign-runtime-manifest.mjs` 对固定载荷签名 → Rust
  `verify_signature_with_key()` 能验；反向 Rust 签名 → TS 验。`tests/runtime_manifest.rs`
  已存在，扩展为跨语言向量测试（固定 private key + 固定 payload 的 golden signature）。
- **防降级测试（Rust）**：`install_bundled_runtime_if_needed` 在当前
  `current.runtime_version` 高于内置时跳过（同 kernel 高 rev / 不同 kernel 各一例）。
- **缓存收敛（移植 `test_managed_runtime_caches.py`）**：不变式——未设
  `HERMES_DESKTOP_MANAGED` 无操作、`setdefault` 不覆盖、temp 已配置时不动；
  该逻辑在 Core 内，桌面侧测试改为"安装器注入 env 清单与 Core `_MANAGED_CACHE_ENV_DIRS`
  一致"。
- **e2e**：`tests/install/install-update-e2e.sh` 是 POSIX 沙箱；Windows 等价物为
  GitHub Actions windows runner 上跑 `install.ps1 -Manifest` 全 stage + `dashboard --help`
  冒烟 + 二次运行幂等；NSIS 安装后用 `runtime_info` 断言 bundled runtime 就位。
- **打包**：`runtime:verify` 在 `tauri:build:bundled-windows` 前执行，校验内置
  manifest 签名 + zip sha256；portable zip 冒烟（marker → `data/` 锚定）沿用现有
  Playwright/Rust 测试。

## 11. Reference links

- Core: `D:/hermes-agent-cn/scripts/install.ps1`、`install.cmd`、`install_coreutils.py`、
  `sign_runtime_manifest.py`、`normalize_macos_pyinstaller_runtime.py`、`release.py`、
  `hermes_constants.py`（`configure_managed_runtime_caches`）、`hermes_bootstrap.py`、
  `docs/RUNTIME_RELEASES.md`、`docs/RUNTIME_VERSIONING.md`、`FORK_NOTES.zh-CN.md`
  （P-014/P-015/P-026/P-032/P-053/P-057/P-058/P-060）。
- Core tests: `tests/test_install_ps1_*.py`（6）、`tests/test_managed_runtime_caches.py`、
  `tests/test_managed_runtime_resolution.py`、`tests/test_runtime_macos_entitlements.py`、
  `tests/test_runtime_release_workflow.py`、`tests/test_packaging_*.py`、
  `tests/install/install-update-e2e.sh`。
- Desktop: `scripts/stage-bundled-runtime.mjs`、`scripts/install-local-runtime.mjs`、
  `scripts/tauri-dev-managed.mjs`、`scripts/package-portable-windows.mjs`、
  `scripts/build_scripts/build_windows.py`、`src/process/runtime.rs`、
  `src/commands/runtime_manager.rs`、`installer/nsis/hooks.nsh`、`tauri.conf.json`、
  `docs/managed-runtime.md`、`docs/portable-mode.md`、
  `.codex/skills/desktop-release-preflight/SKILL.md`。
- kimi-code TS reference: `apps/kimi-code/scripts/native/{01-bundle,02-sea-blob,03-inject,
  04-sign,05-verify,package,produce-manifest,resolve-release}.mjs`、
  `apps/kimi-code/src/cli/update/native-swap.ts`、`apps/kimi-code/src/constant/app.ts`、
  `apps/kimi-code/package.json`（`yazl`、`semver`）。
