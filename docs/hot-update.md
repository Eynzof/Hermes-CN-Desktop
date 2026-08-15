# Hermes-CN 桌面端热更新（统一自更新 + UI 热更 + 开发热更）

> 本文是热更新的**唯一权威文档**（合并自旧 `hot-update-plan.md` / `hot-update-impl-plan.md` 两篇方案，原文件已归档删除），
> 以**当前代码**为准，描述已落地机制 + **使用方法**（含无公网版本时的本地 dummy server 验证步骤）。
> 涉及两个仓库：`Hermes-CN-Desktop`（外壳 + UI + 统一更新客户端）与 `Hermes-CN-Core`（Python 内核 + 签名流水线）。

---

## 1. 总览：四条更新路径（现状）

| 路径 | 更新对象 | 状态 | 入口 |
|---|---|---|---|
| **A 内核 runtime 热更** | Python 后端（PyInstaller onedir） | ✅ 早已具备，本次**收口**（可配置下载源 + 与外壳统一版本） | `check_runtime_update` / `install_runtime_update` / `rollback_runtime`（`src/process/runtime.rs`），Ed25519 12 字段签名 + sha256 + 原子 `fs::rename` + 单步回滚 |
| **B UI 层热更** | 用户看到的 React 应用（`web/dist`），**不重启内核** | ✅ **本次新建完成** | `hermesui:` 自定义协议 + `ui/versions/<v>/` 可写树 + 10 字段 Ed25519 签名 + `appVersionFloor` 闸门 + 单步回滚（`src/process/ui_update.rs`、`src/commands/ui_update.rs`） |
| **C 外壳整包自更新（统一一键更新）** | 桌面端二进制 + 内嵌 UI + 内核，**同一版本**一起换 | ✅ **本次新建完成** | 统一 manifest（`latest.json`，`src/unified_manifest.rs`）+ `app_update_check` / `app_update_install`（`src/commands/app_update.rs`）+ 分离式 `scripts/apply-desktop-update.mjs` |
| **D 开发期后端热更** | 本地源码安装（local-source）的 dev-runtime 内核 | ✅ **本次新建完成（dev-only）** | `hot_update_backend` 命令（`src/commands/hot_update.rs`）+ `scripts/hot-update-backend.mjs`，git pull 后重装 + 重启 dashboard |

下载源可统一由用户可编辑的 `update-config.json` 配置（`src/update_config.rs`），级联：**文件 > `HERMES_UPDATE_*` 环境变量 > 编译期 bake > 硬编码 fallback**。

> **版本模型（统一版）**：外壳与内核**共用同一个版本号**（如 `0.7.0`）。`scripts/sync-release-version.mjs` 一键同步两个仓库；统一 manifest 强制 `version == runtime.kernelVersion == runtime.manifest.kernelVersion`（`sameVersion`），不一致时不提供更新。

---

## 2. 统一自更新（外壳 + 内核一键更新，路径 C）

### 2.1 统一 manifest（`latest.json`）

`releaseManifestUrl` 指向的 `latest.json` 是统一更新唯一入口（默认 `https://desktop.hermesagent.org.cn/latest.json`），schema：

```jsonc
{
  "schemaVersion": 1,
  "version": "0.8.0",                 // 顶层版本 = 外壳 == 内核
  "publishedAt": "2026-01-01T00:00:00Z",
  "minAppVersion": "0.7.0",
  "assets": {
    "win32-x64": {                     // "{platform}-{arch}"，见 unified_manifest.rs
      "desktop": { "kind": "nsis", "fileName": "...setup.exe", "url": "https://…", "sha256": "…", "size": 123 },
      "runtime": {
        "kind": "runtime",
        "fileName": "hermes-runtime-0.8.0-win32-x64.zip",
        "url": "https://…",
        "sha256": "…",
        "size": 456,
        "kernelVersion": "0.8.0",      // 必须 == 顶层 version
        "manifest": { /* 完整的、已签名的轨道 A RuntimeUpdateManifest（原样透传） */ }
      }
    }
  },
  "repository": "…", "semver": "…", "sourceUrl": "…"  // 兼容旧 desktop_update.rs 通知字段
}
```

关键点：
- **runtime 产物内嵌已签名的轨道 A manifest**（12 字段载荷含 `artifactUrl` + `sha256`），客户端原样透传给 `install_runtime_update`，**绝不重编码**，否则验签失败。
- `sameVersion` 硬约束：顶层 `version` ≠ `runtime.kernelVersion` ≠ `runtime.manifest.kernelVersion` → 清单无效，UI 不提供更新。
- 保留 `repository/semver/sourceUrl` 旧字段，`desktop_update.rs` 的“检查通知”通道继续可用。

### 2.2 安装流程（`app_update_install`）

```text
app_update_check   → 拉统一清单 → same-version 校验 → semver 比较 → 结果
app_update_install → 三重守卫（managed 模式 + 无并发 app 更新 + 无并发 dashboard 重启）
   ├─ [1] runtime::install_runtime_update(内嵌轨道 A manifest)  下载+sha256+Ed25519+解压+smoke+记录
   ├─ [2] 重启 managed dashboard → GET /api/version == manifest.version（失败 → rollback_runtime + 中止）
   ├─ [3] 下载桌面端安装包 → sha256 校验 → Windows Authenticode best-effort 校验
   ├─ [4] 写 pending-app-update.json + 分离启动 scripts/apply-desktop-update.mjs（内嵌在二进制）
   └─ app.exit(0) → 更新器等主进程退出 → 静默安装 → 以 HERMES_APP_UPDATED=1 重启
```

- 进度以 `app-update-progress` 事件流式推给前端（阶段 + 0-100 百分比 + 文案）。
- `apply-desktop-update.mjs`：读 marker `{pid, installerPath, targetVersion, kind, exePath, timeoutMs}`，等待主进程退出后：
  - Windows `nsis`：`<installer> /S /currentuser --updated`（免 UAC、静默）
  - macOS `dmg`：`hdiutil attach` → `ditto` 拷入 `/Applications` → `detach`
  - `zip`（portable）：`tar -xf … -C /`
  - 重启时带 `HERMES_APP_UPDATED=1`，新 UI 据此弹“已更新”提示。

---

## 3. UI 层热更（路径 B，`hermesui:` 协议）

### 3.1 原理

`web/dist` 平时内嵌在二进制里；UI 通道则把**签名的 web 包 zip** 解压到可写的 `runtime_root()/ui/versions/<v>/`，主窗口通过自定义 `hermesui:` URI scheme 从该目录加载，签名 `appVersionFloor` 闸门 + 自动回退内嵌包。

磁盘布局（镜像 runtime 的 `versions/<v>/ + current.json`）：

```
runtime_root()/            # HERMES_DESKTOP_RUNTIME_ROOT 可覆盖
└── ui/
    ├── current.json       # UiInstallRecord（camelCase，含 previousUiVersion）
    ├── versions/<v>/      # 解压后的 web/dist（index.html + assets/ + manifest.json 存档）
    └── downloads/<v>.zip
```

UI manifest（`UiUpdateManifest`，签名载荷**恰好这 10 个字段、顺序锁死、`\n` 连接**，与 Core 签名脚本一致）：

```
schemaVersion, channel, uiVersion, appVersionFloor, platform, arch,
artifactUrl, sha256, sourceRepo, sourceCommit
```

- 校验用**与内核同一把**已 bake 的 Ed25519 公钥（`runtime::configured_public_key()`，可被 env / update-config.json 覆盖）。
- `appVersionFloor`：签名闸门——UI 包要求的桌面外壳最低版本。floor > 当前外壳 → 拒绝安装/拒绝服务，**坏包永不白屏**。
- `platform/arch` 必须与当前平台一致；`artifactUrl` 强制 https（测试构建可用 `HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT=1` 放行 http）。
- 冒烟检查：`index.html` 可读且引用至少一个真实存在于 `assets/` 下的文件（Vite 内容哈希产物）→ 失败丢弃该包。
- 激活：staging 解压 → 冒烟 → `fs::rename` 原子换入 → 写 `current.json`（最后写）。
- 回滚：`ui_rollback` 把 `current.json` 指回 `previous_ui_version`（盘上已有，无网络），再 reload 窗口。

### 3.2 服务端（`hermesui:` 处理器，`src/main.rs`）

1. **DEV 旁路**：`HERMES_DESKTOP_DEV_URL` 或 debug 构建 → 窗口走 Vite（`http://localhost:9545`），处理器休眠（HMR 不受影响）。
2. 生产：`ui/current.json` 有效 + `index.html` 在盘 + floor 闸门通过 → 从 `ui/versions/<v>/` 服务；`index.html` 返回 `Cache-Control: no-cache`，内容哈希资产 `immutable`。
3. 否则回退内嵌 `frontendDist`——**窗口永不砖**。
4. 请求路径全程复用 zip-slip 的 `enclosed_name()` 级护栏（`resolve_ui_asset`：拒绝绝对路径 / `..` / 逃逸 / 越界 symlink）。

命令：`ui_check_update` / `ui_install_update` / `ui_rollback`（`src/commands/ui_update.rs`）。安装/回滚成功后 Rust 侧发 `ui-update-ready` 并 `reload()` 主窗口（前端再兜底 `location.reload()`），**不重启内核**。

### 3.3 UI 包 URL 级联

`HERMES_UI_UPDATE_MANIFEST_URL`（完整 URL）> `HERMES_UI_UPDATE_BASE_URL` + `HERMES_UI_UPDATE_CHANNEL` > 编译期 `HERMES_UI_UPDATE_BASE_URL_DEFAULT` / `HERMES_UI_UPDATE_CHANNEL_DEFAULT` > fallback `https://desktop.hermesagent.org.cn/ui/{channel}-{platform}-{arch}.json`。

### 3.4 什么能热更、什么不能

| 改动 | 能否 UI 热更 | 说明 |
|---|---|---|
| 纯 React/CSS/JS | ✅ | bump `uiVersion`，floor ≤ 外壳 → UI 通道秒级下发 |
| 新增/改名/改 payload 的 `tauri invoke` 命令、改 CSP/capability、改 Rust | ❌ | 必须走外壳整包更新（路径 C），并把该 UI 包 `appVersionFloor` 设为高于所有已发外壳，UI 通道拒服 |

---

## 4. 内核 runtime 热更（路径 A）收口

已有链路不变：拉 manifest → Ed25519 验签（12 字段含 artifactUrl+sha256）→ 强制 https → 下载 → sha256 复核 → 防 zip-slip 解压（限 5000 文件 / 500MB）→ smoke（`dashboard --help`）→ 原子换入 → 写 `current.json` → 重启 dashboard。

**本次新增**：下载源可经 `update-config.json` 的 `runtimeManifestUrl` / `runtimeBaseUrl` 覆盖（`configured_manifest_url_from_update_config`，优先级高于 env 之外仍保留旧级联），`runtimePublicKeyPem` 可覆盖信任公钥（`configured_public_key`）。

---

## 5. 下载源配置（`update-config.json`）

文件位于 `runtime_root()/update-config.json`（即 `HERMES_DESKTOP_RUNTIME_ROOT`，portable 模式同址）。模板见 `scripts/update-config.example.json`：

```jsonc
{
  "schemaVersion": 1,
  "channel": "stable",                       // stable | beta | canary
  "releaseManifestUrl": "https://desktop.hermesagent.org.cn/latest.json",
  "runtimeBaseUrl": "https://desktop.hermesagent.org.cn/runtime",
  "runtimeManifestUrl": "",                  // 空则用 runtimeBaseUrl + channel 拼
  "runtimePublicKeyPem": "",                 // 空则用 bake/fallback 公钥
  "timeoutSeconds": 10,                      // 1–300
  "verifySha256": true,
  "verifySignature": true,
  "mirrors": []                              // 设置页展示用（预留）
}
```

- 级联（高 → 低）：文件 → `HERMES_UPDATE_*` env → 编译期 bake → 硬编码 fallback。
- 校验：channel 白名单、URL 必须 https（或空）、timeout 范围；写盘走临时文件 + 原子 rename。
- 文件缺失/损坏 → 回退默认值，`configError` 经 `get_update_config` 上报 UI，**不阻塞启动**。
- 命令：`get_update_config` / `set_update_config`；前端“更新源设置”面板（`web/src/routes/managed-runtime-panel.tsx`）编辑并“测试连接”。

环境变量速查（`HERMES_UPDATE_*` 覆盖文件）：

```
HERMES_UPDATE_CHANNEL / HERMES_UPDATE_RELEASE_MANIFEST_URL / HERMES_UPDATE_RUNTIME_BASE_URL
HERMES_UPDATE_RUNTIME_MANIFEST_URL / HERMES_UPDATE_RUNTIME_PUBLIC_KEY_PEM
HERMES_UPDATE_TIMEOUT_SECONDS / HERMES_UPDATE_VERIFY_SHA256 / HERMES_UPDATE_VERIFY_SIGNATURE
```

---

## 6. 开发期后端热更（路径 D，dev-only）

一键把 `Hermes-CN-Core` 源码仓库的最新提交重装进桌面 dev-runtime 并重启内核（外壳/UI 不动）：

```bash
node scripts/hot-update-backend.mjs [--source D:/hermes-agent-cn] \
    [--skip-git] [--skip-frontend-deps] [--build-frontend] [--dry-run]
```

- 步骤：校验源码树（`pyproject.toml`）→ 工作区干净守卫 + `git pull --ff-only`（**脏树/非快进直接中止**，绝不 stash/reset）→ 可选前端构建 → `scripts/install-local-runtime.mjs --source <src> --force` → 命令层重启 dashboard。
- UI 按钮仅对 `local-source` dev-runtime 显示；Rust 命令双重守卫（managed 模式 + local-source 记录 + 无并发重启）。
- 源码路径优先级：输入参数 > 当前记录的 `sourceRepo`（local-source 时）> `HERMES_AGENT_CN_SOURCE` env > `../Hermes-CN-Core` / `../hermes-agent-cn`。

---

## 7. 发版用法（发布侧）

### 7.1 统一版本号

```bash
# 一键 bump 桌面 + 内核（--core 指定 Core 仓库，缺省只改桌面）
node scripts/sync-release-version.mjs 0.8.0 --core D:/hermes-agent-cn
node scripts/sync-release-version.mjs 0.8.0 --core D:/hermes-agent-cn --dry-run   # 只预览
node scripts/sync-release-version.mjs --check --core D:/hermes-agent-cn           # CI 门，失配 exit 1
```

桌面侧（复用 `sync-desktop-version.mjs`）：`package.json`、`web/`、`packages/`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、README/docs、`release-desktop.yml`、`web/src/lib/build-info.ts`（含 `EXPECTED_BACKEND_VERSION`）。Core 侧：`pyproject.toml [project].version` + `hermes_cli/__init__.py __version__`。

### 7.2 产物与签名

- **内核 zip + 轨道 A manifest**：Core 流水线 `sign_runtime_manifest.py` 签名（12 字段）。**`artifactUrl` 必须在签名前定死为国内 https**——它是签名载荷字段 #9，签名后改 URL = 全网验签失败。镜像/GitHub 双上传只作冗余，不追求自动 failover。
- **UI 包**：`pnpm --filter @hermes/web build:desktop` → 按平台 zip → 10 字段签名 → 推 `ui/{channel}-{platform}-{arch}.json` + `ui/artifacts/ui-<v>/`。
- **统一 `latest.json`**：按 §2.1 schema 生成，`version` = 本次版本，内嵌已签名的轨道 A manifest。
- 私钥只在执行签名的 CI secret 里，**永不上分发服务器**；CDN/服务器被攻破也只能在已签名的合法版本间切换，无法伪造（防降级靠 semver 比较，防篡改靠 Ed25519 + sha256 双校验）。

---

## 8. 使用（用户 / 开发者）

### 8.1 桌面端 UI（设置 → 内核管理面板，`web/src/routes/managed-runtime-panel.tsx`）

| 按钮 | 作用 | 前置 |
|---|---|---|
| **检查更新 / 一键更新** | 统一更新（外壳+内核同版本，自动重启） | managed 模式 + `app_update` 桥可用 |
| **更新源设置** | 编辑 `update-config.json`（含测试连接） | 同上 |
| **检查界面更新 / 安装 / 回退** | UI 层热更（不重启内核） | `ui_*` 桥可用 |
| **热更新后端（dev）** | 本地源码后端热更 | 仅 `local-source` dev-runtime |

另有桌面更新通知组件（`web/src/components/desktop-update-notifier.tsx`）：检测到新版本时，若桥可用显示 **“立即更新”**（走统一流程），否则保留 **“去官网下载”**。

### 8.2 本地验证（无公网新版本 → dummy server）

> 新版本未上传 GitHub / 官网时，用本地 dummy server 走通“拉清单 → 验签 → 下载 → 安装 → 回滚”全流程。
> 需要：Node ≥ 18、Rust 工具链、pnpm。**仓库已内置一条可一键跑完的集成测试**（推荐路径，见 Step 1）；
> 想手搓各步骤时按 Step 2–5 操作。

**Step 1（推荐）— 一条命令跑通真实链路**：

```bash
# 先构建真实 UI 产物（可选但推荐，让测试打包真实 web/dist；桌面版用 --base=./）
pnpm --filter @hermes/web build:desktop

# 跑 dummy-server 集成测试（真实本地 HTTP 服务 + 真实验签 + 真实安装/回滚）
# 默认用内置最小 dist fixture；设置 HOT_UPDATE_TEST_DIST 后改用真实 web/dist
set HERMES_DESKTOP_RUNTIME_ROOT=%TEMP%\hu-test
set HOT_UPDATE_TEST_DIST=web\dist
cargo test --test hot_update_dummy_server
```

`tests/hot_update_dummy_server.rs` 自动完成：生成一次性 Ed25519 测试密钥 → 打包 dist 为 zip →
签名 10 字段 UI manifest → 在 `127.0.0.1` 起真实 HTTP 服务提供 manifest + zip →
调 `check_ui_update` / `install_ui_update`（0.7.0 → 0.7.1）/ `rollback_ui_update`（回到 0.7.0），
断言安装目录、`ui/current.json`、`previousUiVersion` 回滚指针全部符合预期。

**Step 2 — 手搓：生成测试 Ed25519 密钥对**（公钥给客户端信任，私钥用来签 manifest）：

```bash
node -e "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');\
  require('fs').writeFileSync('test-pub.pem',publicKey.export({type:'spki',format:'pem'}));\
  require('fs').writeFileSync('test-priv.pem',privateKey.export({type:'pkcs8',format:'pem'}))"
```

**Step 3 — 构建真实 UI 产物并打包**：

```bash
pnpm --filter @hermes/web build:desktop                 # 产出 web/dist（真实 Vite 产物，桌面版 --base=./）
cd web/dist && zip -r ../../ui-<version>-<platform>-<arch>.zip . && cd ../..
sha256sum ui-*.zip                               # 记下 sha256，写入 UI manifest
```

**Step 4 — 签名 UI manifest（10 字段载荷，顺序见 §3.1）**：用 Step 2 私钥对

```
schemaVersion\nchannel\nuiVersion\nappVersionFloor\nplatform\narch\nartifactUrl\nsha256\nsourceRepo\nsourceCommit
```

签出 base64 签名，拼成 `stable-<platform>-<arch>.json`（`platform ∈ {win32,darwin,linux}`，`arch ∈ {x64,arm64}`）。

**Step 5 — 起本地 dummy server 指向它**（任意静态服务器即可，如 `python -m http.server 8000`，目录结构）：

```
/ui/stable-<platform>-<arch>.json   → UI manifest
/artifacts/ui-<version>.zip         → UI zip
（可选）/latest.json                → 统一 manifest
```

然后把客户端指过去（环境变量覆盖，见 §3.3 / §5）：

```bash
set HERMES_DESKTOP_RUNTIME_ROOT=%TEMP%\hu-test
set HERMES_UI_UPDATE_MANIFEST_URL=http://127.0.0.1:8000/ui/stable-win32-x64.json
set HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM=<测试公钥 PEM>
set HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT=1
```

启动应用 → 设置 → 内核管理面板 → “检查界面更新 / 安装 / 回退”。

**Step 6 — 脚本 dry-run 自检**：

```bash
node scripts/apply-desktop-update.mjs <pending-app-update.json> --dry-run   # 打印将执行的安装/重启命令
node scripts/hot-update-backend.mjs --source D:/hermes-agent-cn --dry-run   # 预览 dev 热更流程
node scripts/sync-release-version.mjs --check --core D:/hermes-agent-cn     # 版本一致性门
```

> ⚠️ 内核（路径 A）的 `artifactUrl` 强制 https（无测试放行口），dummy server 只能验证 UI 通道 + 统一 manifest 解析 + 各脚本；内核链路以 `cargo test` 的 wiremock 单测覆盖。UI 通道的 http 放行（`HERMES_UI_UPDATE_ALLOW_HTTP_ARTIFACT=1`）仅对 **test / debug（dev）构建**生效，release 构建始终强制 https。

---

## 9. 安全模型（浓缩）

- **信任根是 bake 进二进制的公钥**（可被 env / update-config.json 覆盖），不是服务器。
- 篡改 zip 字节 → sha256 + Ed25519 双拦截；篡改 manifest（artifactUrl/sha256/floor）→ 验签失败（这些字段全在签名载荷内）；重放旧合法签名 → semver 防降级（`compare_versions` 数值比较）；伪造签名 → 需私钥，私钥只在 CI。
- UI 服务时路径穿越 → `resolve_ui_asset` 复用 zip-slip 护栏。
- 服务器唯一能做的“坏事” = 在已签名的合法版本间切换（这正是 kill-switch / 回滚能力），最坏停在某个自签版本，无法执行任意代码。
- macOS：UI 热更包无需公证（纯 web 资产、无原生代码，由本地协议处理器提供）；任何原生变更走路径 C 并完成公证/装订。Windows：统一更新对安装包做 Authenticode best-effort 校验（损坏签名拒绝安装；未签名 dev 构建放行）。

---

## 10. 关键文件索引

- 统一更新：`src/commands/app_update.rs`、`src/unified_manifest.rs`、`src/update_config.rs`、`scripts/apply-desktop-update.mjs`、`scripts/update-config.example.json`
- UI 热更：`src/process/ui_update.rs`、`src/commands/ui_update.rs`、`src/main.rs`（`hermesui:` 协议 + 窗口创建）、`tauri.conf.json`（CSP）
- 内核热更（既有）：`src/process/runtime.rs`（`install_runtime_update` / `verify_payload_signature` / `configured_manifest_url` / `configured_public_key`）
- dev 热更：`src/commands/hot_update.rs`、`scripts/hot-update-backend.mjs`、`scripts/install-local-runtime.mjs`
- 版本同步：`scripts/sync-release-version.mjs`、`scripts/sync-desktop-version.mjs`
- 前端：`web/src/hooks/use-app-update.ts`、`use-ui-update.ts`、`use-hot-update-backend.ts`、`web/src/lib/app-update.ts`、`update-config.ts`、`web/src/routes/managed-runtime-panel.tsx`、`web/src/components/desktop-update-notifier.tsx`、`packages/protocol/src/channels.ts`（IPC 类型）
- 验证：`tests/hot_update_dummy_server.rs`（dummy server 集成测试）、`src/process/ui_update.rs` / `src/commands/app_update.rs` / `src/update_config.rs` / `src/unified_manifest.rs` 内嵌单测

相关文档：`docs/managed-runtime.md`（内核 runtime 详解）、`docs/macos-signing-and-notarization.md`、`.codex/skills/desktop-release-preflight/SKILL.md`（发版安全闸门）、`.codex/skills/desktop-release-sync-landing/SKILL.md`（官网版本同步）。
