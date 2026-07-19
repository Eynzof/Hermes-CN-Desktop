# Hermes-CN 桌面端热更新机制 — 完整落地实施方案

> 面向自建国内分发服务器的权威实施方案。所有结论均以当前代码为准，关键处给出 `文件:行号`。
> 涉及两个仓库：`Hermes-CN-Desktop`（桌面外壳 + UI）与 `Hermes-CN-Core`（Python 内核 + 发布签名流水线）。

---

## 1. 总览与现状结论

系统中存在**三条互相独立、绝不可混为一谈**的更新轨道。下面先用一张表给出"现状 vs 新增"的判定，再逐条说明。

| 轨道 | 更新对象 | 当前是否能热更 | 当前机制 | 本方案要做什么 |
|---|---|---|---|---|
| **A 内核 runtime** | Python 后端（PyInstaller onedir，含 CPython 3.11 + FastAPI + anthropic + alibabacloud 等） | ✅ 已具备完整签名下载→校验→安装→回滚 | `check_runtime_update`/`install_runtime_update`/`rollback_runtime`（`runtime.rs:993/1622/1731`），Ed25519 + sha256，原子 `fs::rename` 安装到 `versions/<v>/`，单步回滚 | **收口**：把下载源指向国内服务器；补 `minAppVersion` 强升门、防降级、多公钥轮换、回滚完整性、进度态 |
| **B UI 层（Tauri webview 前端）** | 用户实际看到的 React 应用（`web/dist`） | ❌ **不可热更**：编译进二进制，无远程/可写目录加载器，无 updater 插件 | `tauri.conf.json:10 frontendDist=./web/dist`，内嵌走 `tauri://localhost` 自定义协议 | **新建**：签名 zip 的 UI 热更通道（自定义 URI scheme + 可写 app-data 目录 + 原子切换 + 回退内嵌包），由签名 `appVersionFloor` 闸门路由 |
| **C Tauri 外壳二进制 self-update** | 整个 `.exe`/`.app`/`.dmg`（Rust + IPC + 内嵌 UI） | ❌ **仅检查通知**，不下载不安装不替换 | `desktop_check_update` 拉 `https://desktop.hermesagent.org.cn/latest.json`（`desktop_update.rs:13`），前端比 semver 后弹窗"去官网下载" | **新建**：接入 `tauri-plugin-updater`（minisign + latest.json），作为"涉及 Rust/IPC 改动"时的整包升级路径 |

### 1.1 必须澄清的两个"web 前端"

仓库里有**两个完全不同的 web 前端**，靠两套完全不同的机制交付，必须区分：

1. **Tauri webview 前端 = `web/`（轨道 B）**：用户在桌面窗口里看到的 React 应用。打包后被 Tauri 嵌入二进制，经内置协议在窗口根加载。`src/` 全树 grep `register_*uri_scheme_protocol` / `WebviewWindowBuilder` / `navigate` / `load_url` **零命中**，窗口在 `tauri.conf.json` 静态声明，`main.rs` 的 Builder（`.setup()` 在 `main.rs:120`、`generate_handler!` 在 `main.rs:352`）**从不创建 WebviewWindow、从不导航、从不注册自定义协议**。所以 webview 永远启动内嵌包。后端连接信息（apiBaseUrl/token/gatewayUrl）是运行时通过 `get_runtime_config` IPC 注入到**已加载的**页面，而非靠导航。

2. **Dashboard web_dist = Hermes-CN-Core Python dashboard 自带的 web UI**：FastAPI 应用 HTTP 根的内置 HTML。**Tauri 窗口从不加载它**，只打它的 `/api` 和 `/api/ws`。这个 UI 在浏览器直接开 dashboard 端口才看得到。

**关键不对称**：dashboard web_dist **已经**事实上可热更——它在 spawn 时被复制到**可写**的 runtime 树 `versions/<v>/_internal/hermes_cli/web_dist`（`runtime.rs:700-705`），dashboard 子进程经 `HERMES_WEB_DIST` 环境变量指向它（`dashboard.rs:796-797`）。但它**没有独立的热更通道**——只能随内核 zip 一起更新或由安装器资源复制（`sync_dashboard_web_dist_from_resource`，`runtime.rs:762`）。而**用户真正看到的** Tauri webview（`web/dist`）才是难点，也是轨道 B 的核心目标。

> **结论**：本方案的主战场是 **B（UI 热更，新建）** 与 **A 的收口**，C 作为"Rust/IPC 改动才需要"的整包逃生通道，三者由签名版本门联动。dashboard web_dist 复用轨道 A 即可，不单列。

---

## 2. 自建国内分发服务器的后端设计

用户**已拥有国内服务器**，这覆盖旧版"不要自建"的建议。下面给出可直接落地的目录/URL 布局、TLS、可选动态 API 与回退镜像。

### 2.1 静态资源布局（一台 HTTPS 静态主机即可起步）

推荐域名规划（沿用已有 `desktop.hermesagent.org.cn`，新增子路径，单域名单同步流水线）：

```
https://desktop.hermesagent.org.cn/
├── runtime/                                  # 轨道 A：内核 manifest + zip
│   ├── stable-win32-x64.json                 # 文件名严格匹配 {channel}-{platform}-{arch}.json
│   ├── stable-darwin-arm64.json
│   ├── stable-darwin-x64.json
│   ├── stable-linux-x64.json
│   ├── beta-*.json   canary-*.json           # 第 11 节
│   └── artifacts/
│       └── runtime-v0.16.0-cn.7/
│           └── hermes-agent-cn-runtime-win32-x64.zip   # 即 artifactUrl 指向处（必须 https）
├── ui/                                       # 轨道 B：UI manifest + zip（新建）
│   ├── stable-win32-x64.json                 # {channel}-{platform}-{arch}.json，与 runtime 同构
│   ├── canary-*.json
│   └── artifacts/
│       └── ui-0.3.3/
│           └── ui-win32-x64.zip
├── shell/                                    # 轨道 C：tauri-plugin-updater
│   ├── latest.json                           # tauri updater endpoint（minisign 签名字段）
│   ├── canary.json
│   └── artifacts/v0.3.3/*.{nsis.zip,app.tar.gz,sig}
└── latest.json                              # 现有 desktop_update.rs 通知用（保留兼容）
```

**URL scheme 设计要点（与客户端代码对齐）**：

- 内核 manifest URL 由客户端 `configured_manifest_url()` 拼成 `{base}/{channel}-{platform}-{arch}.json`（`runtime.rs:566-572`）。把 `HERMES_RUNTIME_UPDATE_BASE_URL` 设为 `https://desktop.hermesagent.org.cn/runtime` 即可，文件名必须**完全复现** `{channel}-{platform}-{arch}.json`。`platform ∈ {win32,darwin,linux}`（`current_platform`，`runtime.rs:226`），`arch ∈ {x64,arm64}`（`current_arch`，`runtime.rs:236`）。注意：darwin arm64 的文件名是 `stable-darwin-arm64.json`（不是 `aarch64`）。
- **artifactUrl 是签名载荷字段 #9**（`signature_payload`，`runtime.rs:1098`），客户端不可改写。所以 zip 的 https URL 必须在**签名前**写死为国内地址（见第 3 节）。force-https 在 `runtime.rs:1659` 强制，**纯 http 内网镜像会被硬拒**。

### 2.2 TLS / 缓存 / CDN

- **TLS 必须有效**：artifactUrl/manifest 全部 https，否则 `runtime.rs:1659-1666` 直接报错。用国内 CA（或已有证书）即可，无特殊要求。
- **缓存策略（默认推荐）**：
  - `*.json` manifest：`Cache-Control: no-cache, max-age=0, must-revalidate`（必须能秒级生效，灰度/下架靠它）。
  - `artifacts/**/*.zip`：`Cache-Control: public, max-age=31536000, immutable`（按版本路径，内容寻址，永久可缓存）。
  - UI `index.html`：`no-cache`；UI `assets/*`（Vite 内容哈希文件名）：`immutable`（详见 4.4）。
- **CDN**：国内可挂任意对象存储 + CDN（OSS/COS/七牛）。**唯一硬约束**：CDN 回源/边缘不得篡改 zip 字节——任何篡改都会被 sha256（`runtime.rs:1238`）+ Ed25519 验签拦下（这正是第 7 节"CDN 投毒仍失败"的根因）。manifest 走 no-cache 避免边缘缓存旧 JSON 阻塞灰度。

### 2.3 可选轻量动态 API（何时上）

**默认起步：纯静态。** 静态 manifest 已能完成"发新版即推送"。以下场景才上动态层（推荐 Cloudflare Worker 风格或自建 Nginx+Lua/小型服务，复用已有 landing Worker）：

| 需求 | 上动态层的时机 | 实现 |
|---|---|---|
| **灰度（百分比/cohort）** | 想按设备百分比放量时 | 动态端点对 `{channel}-{platform}-{arch}.json` 按 cohort 返回不同 `runtimeVersion` 的**已签名** manifest（仍是预签名文件，仅做路由选择，私钥**不上服务器**） |
| **强制升级** | 需阻断旧版时 | manifest 里 `minAppVersion` 字段（须先纳入签名载荷，见 3.3）；动态层不需要参与，客户端判定 |
| **紧急下架（kill-switch）** | 发现坏版本要立即停推 | 动态端点把该 channel 指回上一版已签名 manifest（或返回 304/旧版），秒级生效（因 manifest no-cache） |
| **统计（安装量/成功率）** | 想观测放量效果 | 在 `ui_install_update`/`runtime_install_update` 成功/失败后上报一个匿名 POST（设备 cohort + 版本 + 结果），动态层落库 |

> **关键安全约束**：动态层**只做"挑选哪个已签名 manifest"**，绝不在服务器端生成/改写签名。私钥永远只在 CI（GitHub Secret `RUNTIME_SIGN_PRIVATE_KEY_PEM`，`release-runtime.yml:378`）里。服务器被攻破也只能在已有的几个合法签名版本间切换，无法伪造。

### 2.4 GitHub-Release 回退/镜像同步

客户端**没有镜像/回退列表**（grep 确认只有单个 `FALLBACK_MANIFEST_BASE_URL`，`runtime.rs:523-524`），切换是 all-or-nothing。因此回退策略放在**服务器侧 + 发布侧**：

- **镜像同步**：CI 在签名后，把 `out/*.zip` + `out/*.json` 同时推到（1）GitHub Release（保留，作为冗余源/海外）与（2）国内服务器。推送步骤见第 8 节。
- **artifactUrl 的镜像陷阱**：因为 artifactUrl 在签名载荷内，"同一份签名 manifest"只能指向**一个** zip URL。要让国内客户端从国内下，artifactUrl 必须签为国内 URL；GitHub 仅作冗余存储（同一文件双上传，但 manifest 指国内）。若想 GitHub 也能独立验证，需为 GitHub 单独签一份 artifactUrl 指 GitHub 的 manifest（双 manifest，同密钥）。**默认推荐**：国内客户端只用国内 manifest（artifactUrl 指国内），GitHub Release 仅作人工/海外备份，不追求自动 failover。

### 2.5 构建与分发后端：要不要写后端代码？（cnb.cool / 国内 CI 决策）

**结论先行：核心热更新机制不需要写传统的"后端服务"代码。** "服务器下载后端"本质上是两件事的组合：(1) **静态签名文件的托管/分发**（manifest JSON + 产物 zip，HTTPS 静态即可）；(2) **CI 构建+签名+发布流水线**（自动拉代码→编译→签名→推送）。两者都不是"应用后端"。唯一真正需要写代码的是 **Phase 2 可选的动态 manifest 选择器**（灰度 cohort 路由 / kill-switch / 统计），它是一个 ~100–200 行、**无状态、可 serverless、永不持有签名私钥**的小函数（见 2.3）。

#### 2.5.1 用 cnb.cool 之类国内 CI 平台"自动拉代码并编译"——可行，但有一个硬约束

[cnb.cool（云原生构建）](https://docs.cnb.cool/zh/) 是国内的"代码托管 + CI/CD + 制品库"平台，能力与本方案的匹配点：

- ✅ **声明式流水线**：仓库根放 `.cnb.yml`，按分支/标签/事件触发（[语法手册](https://docs.cnb.cool/zh/build/grammar.html)）——天然适配"开发分支发 canary"（§11c）。
- ✅ **从 GitHub 镜像**：支持把 GitHub/Gitee 等仓库连分支带标签镜像过来（[迁移工具](https://docs.cnb.cool/en/guide/migration-tools.html)），双仓库都能镜像。
- ✅ **制品库 + 流水线缓存**：可托管产物并加速重复构建。
- ⚠️ **硬约束：公共构建节点只有 Linux**（`cnb:arch:amd64` / `cnb:arch:arm64:v8`，[构建节点](https://docs.cnb.cool/zh/build/build-node.html)，Docker 容器化）。**没有公共 macOS / Windows runner**——官方只有企业版能接入"腾讯云 CVM / 自有 IDC / 物理终端（含 macOS/Windows）"（[企业版](https://docs.cnb.cool/zh/enterprise.html)）。

这条约束决定了"能不能纯 cnb.cool 自动编译"对三轨**结论不同**，因为 PyInstaller 与 Tauri **不能跨平台交叉编译**（Windows 的 `.exe`、macOS 的 framework 必须在对应 OS 上构建），且 macOS 要 Developer-ID 公证、Windows 要 Authenticode。

#### 2.5.2 推荐架构：混合（hybrid）

| 组件 / 轨道 | 在哪构建 | 原因 | 签名 | 托管/分发 |
|---|---|---|---|---|
| **UI 包（轨道 B）** | ✅ **cnb.cool（Linux 容器）** | `vite build` 与 OS 无关，纯 Linux 即可；UI 又是最高频热更对象 | Ed25519（同一密钥） | 国内服务器 / cnb.cool 制品 + CDN |
| **内核 Linux x64（轨道 A）** | ✅ cnb.cool（Linux） | PyInstaller 原生 Linux 构建 | Ed25519 | 同上 |
| **内核 Windows / macOS（轨道 A）** | GitHub Actions（或 cnb.cool **企业版**自有 Win/Mac 机） | PyInstaller 不能跨平台；macOS 需 Developer-ID 公证（链已就绪） | Ed25519（**同一密钥**，artifactUrl 签名前定死国内，§3.2） | 推到国内 |
| **外壳 .exe/.dmg（轨道 C）** | GitHub Actions | macOS 公证/装订链已在 `release-desktop.yml:153-293`；Windows 待补 Authenticode | minisign + Apple + （待补）Authenticode | 推到国内 `shell/` |

> **一句话决策**：**"自动拉代码编译"最该落在 cnb.cool 的是「UI 通道」和「内核 Linux 产物」**——纯 Linux、与 OS 无关、最高频，收益最大且零额外成本。**Windows/macOS 的原生构建与公证暂留 GitHub Actions**（已有完整签名/公证链），产物镜像到国内主机。**不写应用后端**，只在 Phase 2 写一个极小的无状态灰度选择器。

#### 2.5.3 备选：全量迁到 cnb.cool

若团队购买 **cnb.cool 企业版**并接入**自有 macOS / Windows 物理机**（满足 PyInstaller/Tauri 的原生构建 + 公证/签名），可把三轨全部构建迁到 cnb.cool，GitHub 仅作镜像/海外冗余。代价是要自备并维护 Mac/Win 构建机 + Apple 证书 + Authenticode 证书。**本方案默认走 2.5.2 的 hybrid**，待 Win/Mac 构建机就绪再评估全量迁移。

#### 2.5.4 签名私钥放在哪（关键安全决策）

- **谁签名谁持有私钥**：Ed25519 私钥（轨道 A/B）只存在执行签名那个 CI 平台的 secret 里——若 UI 在 cnb.cool 签，则放 cnb.cool secret；若内核在 GitHub 签，则放 GitHub secret。**私钥永远不上分发服务器**（§7.2）。
- **推荐：解耦"构建 OS"与"签名位置"**。签名只需要「产物的 sha256 + 国内 artifactUrl + 私钥」，与产物在哪个 OS 编出来无关。可把各平台产物汇聚到**一个"签名+发布"步骤**统一签发，从而把私钥集中在**单一**可信 CI（推荐就近放在做发布推送的那条流水线），避免私钥在多平台 secret 间复制。
- **多渠道同一密钥**：canary/beta/stable 用**同一套密钥**（§11d），cnb.cool 与 GitHub 若都签名，则两边持有**同一私钥**——这增加了泄露面，**更推荐**用上一条的"集中签名"消除多副本。

---

## 3. 内核 runtime 热更新收口

轨道 A 已完整可用，只需"指向国内 + 补四个缺口"。

### 3.1 把下载源指向国内服务器（无需重新编译）

manifest base URL **不在签名载荷内**，可运行时覆盖：

```bash
# 运行时（不改二进制）：
HERMES_RUNTIME_UPDATE_BASE_URL=https://desktop.hermesagent.org.cn/runtime
# 或显式整 URL（绕过文件名模式）：
HERMES_RUNTIME_UPDATE_MANIFEST_URL=https://desktop.hermesagent.org.cn/runtime/stable-win32-x64.json
```

永久 fork 则编译期 bake `HERMES_RUNTIME_UPDATE_BASE_URL_DEFAULT`（`runtime.rs:518`），或改 `FALLBACK_MANIFEST_BASE_URL`（`runtime.rs:523-524`，**当前仍指 github.com/Eynzof/Hermes-CN-Core，无 env 无 bake 时会静默走 GitHub，必须改**）。

> 级联优先级（`configured_manifest_url`，`runtime.rs:531-573`）：`_MANIFEST_URL` env > `_BASE_URL` env > `BAKED_*_DEFAULT` > `FALLBACK`。

### 3.2 ⚠️ artifactUrl 必须在 Core 签名前注入国内地址（精确步骤）

这是收口最关键的一处。artifactUrl 在签名载荷里（`signature_payload` 字段 #9，`runtime.rs:1098`；Core 侧 `_PAYLOAD_FIELDS` 含 `artifactUrl`，`sign_runtime_manifest.py:68`），**签名后任何改写都会让验签失败**。当前注入点是写死的 GitHub URL：

`Hermes-CN-Core/.github/workflows/release-runtime.yml:383`：
```yaml
URL="https://github.com/${GITHUB_REPOSITORY}/releases/download/${GITHUB_REF_NAME}/${NAME}.zip"
```

**改为**（新增一个 secret/输入 `RUNTIME_MIRROR_BASE_URL`，在签名前构造国内 URL）：
```yaml
# release-runtime.yml ~ 383（在调用 sign_runtime_manifest.py 之前）
BASE="${{ secrets.RUNTIME_MIRROR_BASE_URL }}"   # = https://desktop.hermesagent.org.cn/runtime/artifacts
URL="${BASE}/${GITHUB_REF_NAME}/${NAME}.zip"     # 须 https；signer 在 sign_runtime_manifest.py:183 硬校验
# 然后照旧： --artifact-url "$URL"  (release-runtime.yml:392)
```

这样签名自动覆盖国内 URL，**桌面端零改动**即可从国内下载并通过验签。**绝不可**在签名后用 sed 改 JSON。

### 3.3 minAppVersion 纳入签名载荷 + 客户端强制升级门

现状：`minAppVersion` 在 Rust（`runtime.rs:117`）和 TS（`channels.ts:240`）都有声明，但**从不被读取/强制**，且**不在签名载荷内**（`signature_payload` 只有 12 字段，`runtime.rs:1087-1104`）——即使读了也可被篡改。这是死字段。

**改造（两仓库协同，必须先扩签名，再扩客户端，否则旧客户端验签不变、新客户端拒旧 manifest）**：

1. **Core 签名扩字段**：把 `minAppVersion` 加入 `_PAYLOAD_FIELDS`（`sign_runtime_manifest.py:59-72`），并让 `release-runtime.yml` 传 `--min-app-version`（`sign_runtime_manifest.py:167` 已支持，工作流当前不传）。**注意载荷顺序与字符串化必须与 Rust 完全一致**（`"\n".join(str(...))`，`sign_runtime_manifest.py:211`）。
2. **Rust 同步扩 `signature_payload`**：在末尾追加 `manifest.min_app_version`（建议固定为 `None→""` 的 `str()`，与 Python `str(None)` 对齐——或两侧统一约定空串），并锁定一个新测试（参照 `runtime.rs:2380-2401` 现有顺序锁测试）。
3. **`schemaVersion` 升到 3**：因为签名载荷字段集变了，**必须同时升 schema**（当前校验 `schemaVersion==2`，见 `validate_manifest_for_current_platform`），否则新旧客户端对同一文件得到不同载荷→全网验签崩。新客户端接受 v3，老客户端继续只认 v2 文件——服务器同时提供 v2（旧载荷、不含 minAppVersion）与 v3 两套文件名（如 `stable-...-v3.json`），或在过渡期老客户端走旧 manifest、新客户端走新文件。**推荐**：直接全量切 v3 并在新客户端发布稳定后停发 v2。
4. **客户端强升判定**：在 `check_runtime_update`（`runtime.rs:992-1078`，当前 `update_available` 仅靠 `runtime_version != current`，`runtime.rs:1043`）后，加：若 `min_app_version > DESKTOP_VERSION`（`web/src/lib/build-info.ts:4`）则标记 `force_required=true`，UI 阻断使用并引导走外壳更新（轨道 C）。

### 3.4 semver 防降级

现状：`update_available` 是纯字符串不等（`runtime.rs:1043-1046`），指向**更旧**的 runtime 也会被当作"有更新"。这对安全回滚/灰度是隐患。

**改造**：在 `check_runtime_update` 引入 semver 比较（runtime 版本形如 `0.16.0-cn.7`，可解析 `<kernel>-cn.<rev>`）：
- 默认规则：`update_available = semver(manifest) > semver(current)`。
- **越级/回退例外**：服务器主动回滚（manifest 指回旧版）属合法操作——加一个签名字段 `rollbackAllowed: bool`（同样纳入载荷）或约定"manifest 版本 < current 时，仅当 channel 切换或显式 allow-crossgrade 才安装"。**推荐默认**：正常通道只升不降；下架/回滚用第 2.3 节 kill-switch（动态层指回旧版**已签名** manifest，客户端按"目标版本 ≠ 当前则安装"放行，但 UI 文案标注为"回滚"）。canary↔stable 跨档见 11(f)。

### 3.5 多公钥轮换

现状：`verify_signature` 只取**单个**配置公钥（`configured_public_key`，`runtime.rs:575-598`；`verify_signature_with_key` 单 SPKI 键，`runtime.rs:1112-1133`），无重叠窗口。轮换=改 env/bake/fallback，会瞬断旧设备。

**改造（推荐，低风险）**：把 `configured_public_key()` 改为返回 `Vec<String>`（解析逗号分隔的 `HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM` 或多个 `_FILE`），`verify_signature` 改为"任一键验过即通过"。轮换流程：先发带"新+旧"双键的客户端版本 → 服务器改用新键签名 → 旧键退役。这给出重叠窗口，避免 brick。**当前若不轮换则保持单键不动**。

### 3.6 回滚完整性再校验

现状：`rollback_runtime`（`runtime.rs:1731-1810`）同步、无重下载，读 `current.previous_runtime_version`，定位 `versions/<prev>/`，`find_executable_in` 要求文件仍在盘上，复用磁盘上的树。单步深度（仅 `previousRuntimeVersion`）。

**改造**：回滚前对 `versions/<prev>/` 做一次轻量完整性校验——复用 `smoke_check_runtime`（`runtime.rs:1172`，`dashboard --help`，60s）确认可执行仍可跑；可选地把安装时的 `artifactSha256`（`RuntimeInstallRecord` 已有该可选字段，`runtime.rs:52-76`）对该树关键文件做抽样校验。失败则拒绝回滚并提示重新安装，而非把用户带进坏树。

### 3.7 进度态：接死代码或删之

现状：`src/update_stage.rs`（`UpdateStage` Idle→Checking→Downloading→Verifying→Extracting→SmokeChecking→Installing→RestartingDashboard→Complete/Failed/RollingBack/RolledBack）是**死代码**——仅 `lib.rs:16` 声明 + 自身测试，无任何生产读者/发射者。

**改造（推荐：接活）**：在 `install_runtime_update`/`ui_install_update` 的各阶段 `app.emit("update-stage", UpdateStage::Downloading{...})`，前端订阅渲染进度面板。这同时服务轨道 A 与 B。**若不接，则删除该模块**避免长期误导。**默认推荐接活**（成本低、用户价值高，且 UI 热更面板正好需要它）。

---

## 4. UI 层热更新（核心新建）

实现选定设计：**CodePush/asar 风格的、独立通道的 Ed25519 签名 web 包**，解包到 `runtime_root()` 下的可写 app-data 目录，经自定义 Tauri URI scheme 提供，原子版本切换，签名 `appVersionFloor` 闸门，自动回退到内嵌 `web/dist`。**约 90% 复用 `runtime.rs` 既有引擎**。

### 4.1 磁盘布局（镜像 `versions/<v>/ + current.json` 模式）

```
runtime_root()/                              # = OS data dir；HERMES_DESKTOP_RUNTIME_ROOT 可覆盖（runtime.rs:275）
└── ui/
    ├── current.json                         # UiInstallRecord（见下）
    ├── versions/<safe(uiVersion)>/          # 解包后的 web/dist（index.html + assets/）；复用 safe_version_segment（runtime.rs:1135）
    │   ├── index.html
    │   ├── assets/...
    │   └── manifest.json                     # 该版本的已签名 UI manifest 存档
    └── downloads/<uiVersion>.zip
```

`UiInstallRecord`（camelCase，镜像 `RuntimeInstallRecord` 的 `runtime.rs:52-76`）：
```jsonc
{
  "schemaVersion": 1,
  "uiVersion": "0.3.3",
  "appVersionFloor": "0.3.2",     // 该 UI 包要求的最低外壳版本（签名字段）
  "channel": "stable",
  "path": ".../ui/versions/0.3.3",
  "sha256": "...",
  "source": "update",             // "update" | "embedded"
  "installedAt": "2026-06-13T...Z",
  "previousUiVersion": "0.3.2"    // 单步回滚（镜像 previousRuntimeVersion，runtime.rs:1206）
}
```

### 4.2 新增 Rust：`src/process/ui_update.rs`（薄克隆，调用 `runtime.rs` 原语）

把以下 `runtime.rs` 函数改为 `pub(crate)` 供复用：
- `verify_signature_with_key`（`runtime.rs:1112`，单键 Ed25519，**复用同一已 bake 的密钥**，引擎本就只支持单键 `runtime.rs:1106`）。
- `extract_zip`（`runtime.rs:1815-1910`）含全部护栏：zip-slip `enclosed_name()+starts_with(dest)`（`runtime.rs:1834-1846`）、`MAX_ZIP_FILES=5000`、`MAX_ZIP_TOTAL_BYTES=500MB`、symlink-target 拒绝。
- 文件 sha256 比对（`runtime.rs:1238`，大小写不敏感）。
- 原子 `fs::rename` 安装 + 跨设备 `copy_dir_all` 回退（`runtime.rs:1308-1318`）。
- 单步 `previousUiVersion` 回滚（镜像 `rollback_runtime`，`runtime.rs:1731-1810`，纯磁盘无网络）。
- env/bake/fallback URL+channel 级联（镜像 `configured_manifest_url`，`runtime.rs:531-598`）。

**新增 `UiUpdateManifest.signature_payload`**，签名字段精确为（顺序锁死，与 Core 签名脚本一致）：
```
schemaVersion, channel, uiVersion, appVersionFloor, platform, arch, artifactUrl, sha256, sourceRepo, sourceCommit
```
其中 `platform/arch` 用真实 `current_platform()/current_arch()`（UI 包可按平台分发，避免一个超大全平台包；若 UI 资产与平台无关也可固定 `platform="all"`，但**推荐按平台**以便和 runtime 文件名模式统一）。

**UI 专属冒烟检查**（替换无意义的 `dashboard --help`，`runtime.rs:1172-1181`）：解包后校验 `index.html` 能按 UTF-8 解析，且至少引用一个磁盘上存在于 `assets/` 下的资源文件。失败则丢弃该版本、保留当前。

### 4.3 自定义协议处理器（`src/main.rs` Builder，`.setup()` 之前）

在 `main.rs:120` 的 `.setup(` 前注册：
```rust
.register_asynchronous_uri_scheme_protocol("hermesui", move |_app, req, responder| { ... })
```
处理器逻辑：
1. 解析请求路径，对每个请求都套用 `extract_zip` 的 `enclosed_name()/starts_with(dest)` 逃逸护栏（`runtime.rs:1834-1846`），拒绝指向 base 外的 symlink——**防"服务时路径穿越"**。
2. **当且仅当** `ui/current.json` 存在 **且** `index.html` 存在 **且** `appVersionFloor <= DESKTOP_VERSION` 时，从 `ui/versions/<v>/` 提供文件。
3. **否则**回退到内嵌 `frontendDist`（`tauri.conf.json:10` 的 `web/dist` 保持内嵌作为**不可砖化兜底**）。
4. **DEV 旁路**：当 `devUrl`（`tauri.conf.json:9`，`http://localhost:9545`）激活时，处理器旁路，保证 Vite HMR 不受影响。

窗口从静态声明改为 `WebviewWindowBuilder` + `WebviewUrl::CustomProtocol("hermesui://localhost/index.html")`（Windows 解析为 `http://hermesui.localhost`，两种形式都要白名单）。

新增命令 `src/commands/ui_update.rs`（镜像 `runtime_manager.rs:79-149`），注册进 `main.rs:352` 的 `generate_handler!`：
- `ui_check_update` / `ui_install_update` / `ui_rollback`。
- `ui_install_update` 成功后：`emit("ui-update-ready")` 并调用 `WebviewWindow.reload()`——**不重启内核/dashboard**（UI 独立于 Python 后端）。
- `ui_rollback`：把 `current.json` 指回 `previousUiVersion`（盘上已有，无重下载），再 reload。

### 4.4 CSP 改动（最小化，**不开放远程源**）

manifest/zip 的拉取在**原生 Rust 侧**用 `RUNTIME_HTTP_CLIENT`（reqwest）完成，**不经 webview**，所以 `connect-src` **无需**加国内源。`tauri.conf.json:24` 当前：
```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:*; img-src 'self' data: blob:
```
**仅加本地自定义 scheme**：
```
default-src 'self' hermesui: http://hermesui.localhost;
script-src 'self' 'unsafe-inline' hermesui: http://hermesui.localhost;
style-src  'self' 'unsafe-inline' hermesui: http://hermesui.localhost;
img-src 'self' data: blob: hermesui: http://hermesui.localhost;
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:*   # 保持不变，离线能力保留
```
若有插件 allowlist 闸门，把 scheme 加进 `capabilities/default.json`。

### 4.5 缓存正确性（务必做，否则用户卡在旧 UI）

- 协议处理器对 `index.html` 返回 `Cache-Control: no-cache`，依赖 Vite 内容哈希资产名做不可变缓存。
- 切换 `current.json` 后**必须** `reload()`（或发 `ui-update-ready` 事件触发 `WebviewWindow.reload()`），否则 WebView2/WKWebView 继续用旧字节直到下次启动。

### 4.6 哪些 UI 改动**能**/**不能**热更

| 改动类型 | 能否 UI 热更 | 路由 |
|---|---|---|
| 纯 React/CSS/JS（文案、样式、布局、前端 bug、前端逻辑） | ✅ **能** | bump `uiVersion`，`appVersionFloor ≤ 当前外壳` → UI 通道秒级下发 |
| 调用**新增/改名/改 payload** 的 `tauri invoke` 命令（`tauri-bridge.ts` 里约 50 个 invoke：`api_request`/`runtime_install_update`/`im_onboarding_*`/`terminal_*`/`ui_store_*`…） | ❌ **不能** | 必须随**整包外壳更新**（轨道 C），并把该 UI 包 `appVersionFloor` 设为高于所有已发外壳，UI 通道会拒服它 |
| 改 `transport.ts` 原生 IPC 契约 / 新 capability / 改 CSP | ❌ **不能** | 同上，走轨道 C |
| 新增/改 Rust 命令、改后端进程行为 | ❌ **不能** | 轨道 C（必要时配轨道 A） |

> **路由闸门 = 签名的 `appVersionFloor`**。这是整个设计的安全核心：一个误发的、需要新 Rust 命令的 UI 包，只要 floor 高于已装外壳，处理器就拒绝提供并退回内嵌包——**永不因坏包白屏**。

### 4.7 从国内服务器交付

UI 通道只需国内主机以有效 TLS 提供两个静态文件：`{channel}-{platform}-{arch}.json`（签名 manifest）+ `ui-<v>.zip`。env 覆盖（镜像内核级联）：`HERMES_UI_UPDATE_BASE_URL` / `_MANIFEST_URL` / `_CHANNEL`，外加 `*_DEFAULT` 编译期 bake。复用同一已 bake 的 Ed25519 信任密钥。

---

## 5. Tauri 外壳 self-update

### 5.1 现状

`desktop_update.rs` 是**仅检查通知**：`desktop_check_update`（`desktop_update.rs:126`）拉**写死的 const** `https://desktop.hermesagent.org.cn/latest.json`（`desktop_update.rs:13`，**无 env 覆盖**），前端比 semver 弹窗，主操作"去官网下载"开外部浏览器。manifest **未签名**（纯 JSON over HTTPS，零完整性校验，asset 的 `url/sha256` 字段被解析但从不读取）。`Cargo.toml:14-15` 仅有 dialog+notification 插件，**无 tauri-plugin-updater**，`tauri.conf.json` 无 updater/pubkey/endpoints 块。`update_stage.rs` 死代码。

### 5.2 通向真正 self-update 的路径

**推荐：接入官方 `tauri-plugin-updater`**（而非手搓），原因：它是受支持的、签名的、跨平台的整包更新基础设施，与现有 macOS 公证/装订流水线天然叠加。

| 选项 | 评价 | 结论 |
|---|---|---|
| **A. tauri-plugin-updater**（minisign + latest.json + 签名产物） | 官方支持，签名+原子安装+relaunch，Windows `installMode: passive`，macOS 叠加现有 notarize/staple | ✅ **推荐** |
| B. 扩展自搓 `desktop_update.rs` 下载器（消费现有 asset url+sha256 + Ed25519 验签 + 平台安装/relaunch + 激活 `update_stage.rs`） | 复用内核验签蓝图，但平台安装/relaunch 是净新工作量，且要补签名（当前 manifest 未签名） | 备选，工作量更大 |

**落地要点**：
- `Cargo.toml` 加 `tauri-plugin-updater = "2"`；`tauri.conf.json` 加 `plugins.updater.{endpoints, pubkey}`、`bundle.createUpdaterArtifacts=true`。
- endpoints 指国内：`https://desktop.hermesagent.org.cn/shell/latest.json`（动态版可按 channel 返回不同 JSON）。
- **minisign 签的是字节而非 URL**——所以**外壳安装包的国内镜像 URL 可服务器端自由设置，无重签陷阱**（与轨道 A/B 的 artifactUrl-在签名内 形成对照，必须在文档中明确这个不对称）。
- **macOS**：现有 `release-desktop.yml` 已做 Developer-ID codesign + notarytool + stapler + spctl（`release-desktop.yml:153-293`）。updater 产物（`.app.tar.gz` + `.sig`）叠加其上即可。
- **Windows Authenticode**：**当前完全缺失**（`release-desktop.yml` 无 signtool 步骤，NSIS 安装包未签名）。**启用静默外壳更新前必须补 Authenticode 签名**，否则用户每次更新触发 SmartScreen，且 NSIS passive 安装在未签名时体验差。
- 保留 `desktop_update.rs` 通知通道作为兼容/降级（或迁移到 updater 的事件）。把 `DESKTOP_UPDATE_MANIFEST_URL` const（`desktop_update.rs:13`）加一个 env 覆盖（`HERMES_DESKTOP_UPDATE_MANIFEST_URL`），便于自建者迁主机/换证书。
- **回滚不对称**：UI 通道有真·盘上单步回滚（`current.json` 重指，免费）；外壳通道 `tauri-plugin-updater` **无回滚**，只能服务器端把 latest.json 重指旧版 + 用户重装。文档须写明。

---

## 6. 版本与渠道模型

### 6.1 版本同步

桌面外壳单一真源 = 根 `package.json` "version"（当前 `0.3.2`，`package.json:3`），由 `scripts/sync-desktop-version.mjs` 扇出到 `web/`、`packages/protocol`、`packages/shared-ui`、`tauri.conf.json:4`、`Cargo.toml:3`、`Cargo.lock`、README/docs。`pnpm version:sync` 执行，`pnpm version:check`（接在 `typecheck`）失配则退出 1。构建期经 `VITE_HERMES_DESKTOP_VERSION` → `DESKTOP_VERSION`（`build-info.ts:4`）注入渲染层。

**新增**：UI 版本（`uiVersion`）独立于外壳 semver，但**默认与外壳同号起步**（如外壳 0.3.2 → UI 0.3.2），便于 floor 判定直观。UI 版本不进 `sync-desktop-version.mjs` 的强校验（它单独由 UI 发布流水线管理）。

### 6.2 三轴版本 + 兼容矩阵

| 轴 | 版本形态 | 标签 | 更新路径 |
|---|---|---|---|
| 外壳 shell | semver `0.3.2` | `v*` | 轨道 C（tauri-plugin-updater） |
| UI | semver `0.3.3` | `ui-v*` | 轨道 B（UI 通道） |
| 内核 runtime | `0.16.0-cn.7` | `runtime-v*-cn.*` | 轨道 A |

**兼容矩阵（强制关系）**：
- **UI → 外壳**：`UI.appVersionFloor ≤ shell.DESKTOP_VERSION`（签名强制，4.6）。UI 调用的 invoke 契约由外壳提供，故 UI 不能超前于外壳的 IPC 表面。
- **内核 → 外壳**：`runtime.minAppVersion ≤ shell.DESKTOP_VERSION`（签名强制，3.3）。
- **UI ↔ 内核**：解耦（UI 经 REST/WS 打内核，无编译期耦合），无需矩阵。
- 当前代码**无任何编译期兼容表**（仅 `release-desktop.yml` 的 `bundled_runtime_tag` 默认 `runtime-v0.16.0-cn.6` 做构建期绑定）。本方案用签名 floor 字段把"文档建议"变成"运行时强制"。

### 6.3 渠道选择

现状：**只有内核有 channel 概念**且只控 manifest 文件名（`DEFAULT_CHANNEL="stable"`，`runtime.rs:28`；级联 `runtime.rs:551-572`）。`beta/canary` 非一等公民（仅测试出现），**无 UI 选择器，无持久化**。

**改造**：见第 11 节——把 channel 升为一等、可在设置页自助切换、持久化到 ui_store，并贯通三轨（A/B/C）。

### 6.4 灰度与强制升级闸门

- **灰度**：服务器动态层按 cohort 返回不同已签名 manifest（2.3）。
- **强制升级**：内核 `minAppVersion`（3.3）+ UI `appVersionFloor`（4.6）+ 外壳 updater 的 `version` 比较。三者均为签名字段。

---

## 7. 安全与签名

### 7.1 三套独立签名系统

| 轨道 | 签名算法 | 签的内容 | 密钥位置 | 客户端信任根 |
|---|---|---|---|---|
| A 内核 | Ed25519（SPKI PEM） | 12（→13）字段 manifest 载荷，**含 artifactUrl + sha256** | CI Secret `RUNTIME_SIGN_PRIVATE_KEY_PEM`（`release-runtime.yml:378`） | bake `HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM_DEFAULT` / fallback `runtime.rs:525-529` |
| B UI | Ed25519（**复用 A 的同一密钥**） | UI manifest 载荷，含 artifactUrl + sha256 + appVersionFloor | 同 A 的 CI Secret | 同 A 的公钥（引擎只支持单键） |
| C 外壳 | minisign（tauri-plugin-updater） | **安装包字节**（非 URL） | 新 CI Secret（minisign 私钥） | `tauri.conf.json plugins.updater.pubkey` |
| macOS payload | Apple Developer-ID + notarization | 二进制/.app | Apple 证书（CI Secret） | macOS Gatekeeper |
| Windows | **Authenticode（待补，第 5 节）** | .exe/NSIS | 代码签名证书（待购） | Windows SmartScreen |

### 7.2 密钥管理与轮换

- **Ed25519 内核/UI 私钥**：只在 CI Secret，永不上分发服务器。轮换走 3.5 的多公钥重叠窗口。
- **minisign 外壳私钥**：独立于 Ed25519，CI Secret。
- **artifactUrl-在签名内的不对称（必须文档化）**：A/B 的 artifactUrl 在签名载荷里（`runtime.rs:1098`），故国内 zip URL 必须**签名前**定死（3.2、4.7）；C 的 minisign 签字节不签 URL，故外壳镜像 URL 服务器端可自由设。

### 7.3 威胁模型：为什么国内服务器在信任链里、CDN 投毒仍失败

把国内服务器/CDN 视为**半可信传输层**（可能被攻破或被 CDN 边缘篡改）：
- **篡改 zip 字节** → sha256（`runtime.rs:1238`）+ Ed25519 验签（`runtime.rs:1112`）双重拦截，安装中止。
- **篡改 manifest（改 artifactUrl 指向恶意 zip / 改 sha256 / 降 floor）** → 验签失败（这些字段全在签名载荷内）。
- **重放旧的合法签名 manifest（降级攻击）** → semver 防降级门（3.4）拦截；canary↔stable 跨档需显式 allow（11f）。
- **伪造签名** → 需私钥，私钥只在 CI，服务器被攻破也拿不到。
- **服务器只能做的"坏事"** = 在**已有的几个合法签名版本间切换**（含指回旧版）——这正是 kill-switch 的合法能力，最坏后果是"停在某个我们自己签过的版本"，不会执行任意代码。
- **force-https**（`runtime.rs:1659`）阻止降级到明文/中间人友好通道。
- **UI 服务时路径穿越** → 协议处理器复用 `enclosed_name()/starts_with(dest)` 护栏（4.3）。

> **结论**：信任根是 bake 进二进制的公钥，不是服务器。CDN/服务器投毒在密码学层面失败。唯一真正的信任假设是"CI 私钥不泄露"。

---

## 8. CI/CD 改动清单

### 8.1 Hermes-CN-Core `release-runtime.yml`（轨道 A）

| # | 改动 | 位置 |
|---|---|---|
| 1 | artifactUrl 注入国内镜像（签名前） | `release-runtime.yml:383` 改为用 `secrets.RUNTIME_MIRROR_BASE_URL` 构造（见 3.2） |
| 2 | 传 `--min-app-version`（强升门字段） | 在 `release-runtime.yml:392` 的 signer 调用加 `--min-app-version "$MIN_APP"`（workflow_dispatch 输入或按 kernel 映射） |
| 3 | 签名脚本扩载荷字段 + schema→3 | `sign_runtime_manifest.py:59-72` 加 `minAppVersion`；`SCHEMA_VERSION=3`（`sign_runtime_manifest.py:53`） |
| 4 | 新增"推送到国内服务器"步骤 | 在 `release-runtime.yml:396`（Sign manifest 之后、upload-artifact 之前）加 `rsync`/`aws s3 cp`/`curl -T` 把 `out/*` 推到 `runtime/` 与 `runtime/artifacts/<tag>/`（新 secret：host/key） |
| 5 | 渠道路径化（canary/beta） | meta 步对 `channel` 输入分流到不同文件名 + 路径（第 11 节） |
| 6 | 保留 GitHub Release 双上传 | `release` job `release-runtime.yml:416` 不动，作冗余 |

### 8.2 Hermes-CN-Desktop `release-desktop.yml`（轨道 C + bundled）

| # | 改动 | 位置 |
|---|---|---|
| 1 | runtime-manifest 拉取源 + stage `--repo` 改指国内/自有仓库 | `release-desktop.yml:88-89,103,146-147`（当前指 `Eynzof/Hermes-CN-Core`） |
| 2 | 接入 tauri-plugin-updater：`createUpdaterArtifacts` + minisign 签名 + 上传 `.sig` | tauri-action 配置 + `tauri.conf.json plugins.updater` |
| 3 | **新增 Windows Authenticode 签名步骤** | matrix windows job（当前缺失） |
| 4 | 新增"推送外壳更新产物 + latest.json 到国内 `shell/`" | release job 末尾 |
| 5 | macOS：updater 产物叠加现有 notarize/staple | `release-desktop.yml:153-293` 之上 |

### 8.3 新增 UI 通道发布流水线（轨道 B，新文件 `release-ui.yml`）

触发：`ui-v*` 标签 或 workflow_dispatch（含 `channel` 输入）。步骤：
1. `pnpm version:sync` + `pnpm --filter web build` → `web/dist`。
2. 按平台 zip（`ui-<plat>-<arch>.zip`）。
3. 用**改造后的** `sign_runtime_manifest.py`（UI 字段集，`--artifact-url` 指国内 `ui/artifacts/ui-<v>/`，**签名前定死**）签出 `{channel}-<plat>-<arch>.json`。
4. 推到国内 `ui/` 与 `ui/artifacts/ui-<v>/`。
5. （可选）双上传 GitHub Release 作冗余。

### 8.4 通用：推送脚本

三条流水线复用一个 `scripts/push-to-cn-server.sh`（`rsync -avz out/ user@host:/srv/dist/<track>/` 或对象存储 SDK），用同一组 secret（host/key/bucket）。

---

## 9. 分阶段路线图

| 阶段 | 内容 | 工作量 | 退出标准 |
|---|---|---|---|
| **Phase 0 — 止痛/镜像** | (1) 国内静态主机起 TLS + `runtime/`+`shell/`+`latest.json` 布局；(2) Core 流水线 artifactUrl 改指国内 + 推送步骤（3.2、8.1#1,4）；(3) 客户端经 env `HERMES_RUNTIME_UPDATE_BASE_URL` 指国内（或改 fallback `runtime.rs:523-524`）；(4) `desktop_update.rs:13` 的 const 加 env 覆盖 | **2–3 人日** | 国内设备内核热更端到端跑通（下载/验签/装/回滚），无需翻墙；外壳通知走国内 |
| **Phase 1 — 收口 + UI 热更 + 外壳自更新** | (A) 内核：minAppVersion 入签名(schema→3)、semver 防降级、多公钥轮换、回滚再校验、进度态接活（第 3 节）；(B) UI 热更全链路：`ui_update.rs` + 协议处理器 + 窗口切换 + 3 命令 + CSP + 前端面板（第 4 节）；(C) tauri-plugin-updater + Windows Authenticode（第 5 节） | **3–4 人周**（其中 UI ≈3–3.5 人日：~1d Rust，~0.5d 前端，~0.5d CSP/scheme/dev 旁路+跨平台验证，~0.5d 国内 UI 签名发布，~0.5–1d 外壳 updater + landing 端点） | UI 纯前端 fix 不重装秒级下发；floor 不兼容包被拒回内嵌；外壳整包静默更新在 Win/macOS 可用且签名/公证通过；三轴版本矩阵强制生效 |
| **Phase 2 — 动态化/灰度/增量** | (1) 动态 manifest 端点（cohort 灰度 + kill-switch + 统计，2.3）；(2) 一等 canary/beta 渠道 + 设置页自助切换（第 11 节）；(3) 增量/delta（评估 zip 块级 diff 或 bsdiff，缓解整包带宽）；(4) 半更新态自愈（崩溃计数回退内嵌） | **2–3 人周** | 可按百分比放量、可秒级下架、canary 设备自助开关、坏版本自动自愈、带宽随更新规模线性下降 |

---

## 10. 风险与坑

| 风险 | 说明 | 缓解 |
|---|---|---|
| **整包带宽 / 无 delta** | 内核 zip 是 PyInstaller onedir（CPython+FastAPI+anthropic+alibabacloud，估 ~150–350MB 压缩，**官方未文档化具体大小**）；每次更新全量下，无块级 diff | Phase 2 上增量；国内 CDN immutable 缓存；UI 包小（仅前端），优先用 UI 通道发可热更的 fix |
| **半更新态** | 下载/解包/切换中崩溃 | 全程 staging + 原子 `fs::rename`（`runtime.rs:1308`）；`current.json` 最后写；崩溃计数自愈回退内嵌/上一版 |
| **死代码 / 死字段** | `update_stage.rs`（无生产读者）、`minAppVersion`（声明但不读不签）、asset.url/sha256（解析不读，`desktop_update.rs`） | 第 3.3/3.7 接活或删除；不要让团队误以为已生效 |
| **macOS 公证对象变化** | UI 热更包**不**经 Apple 公证（它不是 Mach-O，是 web 资产，由协议处理器从本地可写目录提供）；这是合规的——但**外壳/内核**二进制变更仍须公证（`release-desktop.yml:153-293`） | 明确：UI 热更绕过公证是**预期且安全**（无原生代码）；任何原生变更走轨道 C 并走完公证 |
| **signed-artifactUrl 镜像陷阱** | A/B 的 artifactUrl 在签名载荷内（`runtime.rs:1098`），签名后改 URL = 验签失败；mirror 必须签名前定死 | 注入点固定在 `release-runtime.yml:383`/UI signer 调用；CI lint 校验"签名前 URL 已是国内 https" |
| **UI ↔ Rust 版本错位（skew）** | 热更 UI 调用了旧外壳没有的 invoke → 运行时崩 | 签名 `appVersionFloor` 闸门（4.6）；floor > 当前外壳则拒服回退内嵌；需 Rust 改动的 UI 包强制走轨道 C |
| **schema 升级窗口** | minAppVersion 入签名须升 schema(2→3)，新旧客户端对同一文件载荷不同 | 过渡期服务器同时供 v2/v3 文件，或新客户端稳定后停发 v2；先发新客户端再切签名 |
| **单点信任密钥** | 引擎单键（`runtime.rs:1106`），密钥泄露/丢失=全网瘫 | CI Secret 严管 + 3.5 多公钥重叠轮换能力先就位 |
| **无镜像 failover** | 客户端无回退 URL 列表（`runtime.rs:523`） | 国内主机高可用 + CDN；GitHub 仅人工冗余，不追求自动切换 |
| **Windows 未签名** | NSIS/exe 无 Authenticode，启用静默更新会触发 SmartScreen | 第 5 节：启用外壳静默更新**前**必须补 Authenticode |

---

## 11. 【重点】灰度通道（canary / 开发分支）分发 — 一等公民设计

目标：团队能**从开发分支**发布，**仅 canary 已订阅设备（通常是开发团队自己）**收到更新做测试，**stable 用户完全无感**。本节贯通三轨（A 内核 / B UI / C 外壳）统一设计。

### (a) 国内服务器上的渠道模型

channel 已经是 manifest 文件名的一部分（`{base}/{channel}-{platform}-{arch}.json`，`runtime.rs:566-572`；`DEFAULT_CHANNEL="stable"`，`runtime.rs:28`；channel 也是签名字段，`signature_payload` #2，`runtime.rs:1090`，TS 镜像 `channels.ts:228`）。直接以**文件名 + 路径**区分渠道，三套并存：

```
runtime/  stable-win32-x64.json   beta-win32-x64.json   canary-win32-x64.json
runtime/artifacts/{stable,beta,canary}/<version>/hermes-agent-cn-runtime-*.zip
ui/       stable-win32-x64.json   beta-win32-x64.json   canary-win32-x64.json
ui/artifacts/{stable,beta,canary}/ui-<v>/ui-*.zip
shell/    latest.json   beta.json   canary.json        # tauri updater endpoints
shell/artifacts/{stable,beta,canary}/<v>/*
```

canary manifest 与 stable **完全同构、同密钥签名**，只是路径/文件名不同。stable 用户的客户端**永远只请求 `stable-*.json`**，根本不会发现 canary 文件的存在。

### (b) 设备 opt-in（开发团队自助）

现状：**无 UI 渠道选择器、无持久化**，channel 仅 env/编译期（`runtime.rs:551-553` 读 `HERMES_RUNTIME_UPDATE_CHANNEL` env → `BAKED_MANIFEST_CHANNEL` → `"stable"`）。

**新增（两条路并存）**：

1. **设置页开关（首选，团队自助）**：在设置加"更新渠道"选择器（Stable / Beta / Canary），持久化到 `ui_store`（与现有 `ui_store_*` 命令同机制）。新增一个 Rust 命令 `set_update_channel(channel)` 把选择写入一个客户端可读的配置文件（如 `runtime_root()/update-channel.txt` 或 ui_store 后端文件）。
2. **threading 进 `configured_manifest_url()`**：当前 channel 解析在 `runtime.rs:551-553`。改为：**最高优先级读持久化的用户选择**，再回落 env → baked → `"stable"`。即：
   ```
   channel = persisted_user_channel()           // 新增，最高优先
             .or(env HERMES_RUNTIME_UPDATE_CHANNEL)
             .or(BAKED_MANIFEST_CHANNEL)
             .unwrap_or("stable")
   ```
   UI 通道 `configured_ui_manifest_url()` 与外壳 updater endpoint 选择**复用同一个 `persisted_user_channel()`**，保证三轨渠道一致。
3. **env/构建标志（内部构建）**：内部 dev 包可 bake `HERMES_RUNTIME_UPDATE_CHANNEL_DEFAULT=canary`（`runtime.rs:519`），开箱即 canary，无需手动开关。

> **默认值**：未选择 = `stable`，与现状一致，普通用户零影响。

### (c) 从开发分支的 CI（三轨统一）

**触发方式（推荐 workflow_dispatch + canary 标签双支持）**：
- 内核：`runtime-v0.16.0-cn.7-canary.3` 标签 或 `workflow_dispatch(channel=canary)`；meta 步对 canary 标签**不强制** `CHANNEL=stable`（当前 `release-runtime.yml:83-85` 对 `runtime-v` 标签强制 stable，需对 `-canary.*` 后缀放行 canary）。
- UI：`ui-v0.3.3-canary.2` 或 `workflow_dispatch(channel=canary)`。
- 外壳：`v0.3.3-canary.2` 或 `workflow_dispatch(channel=canary)`。
- **push-to-dev-branch 触发**：可选地对 `dev`/`canary` 分支 push 自动跑 canary 构建（便于团队持续吃狗粮）。

每条流水线把签名产物推到对应 **canary 路径**（`runtime/canary-*.json`、`ui/canary-*.json`、`shell/canary.json`），artifactUrl/路径在签名前定死为 canary artifacts 路径。**三轨用同一 `channel` 输入参数，行为一致**。

### (d) 隔离与信任

- **同密钥**：canary 用**与 stable 完全相同的 Ed25519/minisign 密钥**签名——信任链不变，客户端无需额外配置即可验 canary（公钥已 bake）。
- **路径隔离**：canary 文件名/路径独立，stable 客户端只请求 stable 文件名 → **stable 设备永不发现 canary**。
- **更快/自动检查节奏**：canary 设备检查频率调高（如每次启动 + 每小时），stable 保持每日一次（复用 `desktop-update-notifier.tsx` 的 once-per-day 逻辑，按 channel 分流）。
- **防止 canary 流向 stable 设备**：由 (b) 的文件名机制天然保证——客户端拼 URL 时只会拼自己 channel 的文件名。**不存在**"canary 包被推给 stable 设备"的路径，因为是客户端**主动拉自己渠道的文件**，服务器从不主动推送。

### (e) 晋级流程 canary → beta → stable

**核心约束**：artifactUrl 在签名载荷内（`runtime.rs:1098`）。若晋级时 artifact 的 URL/路径变化，**必须重签**。两种方案：

| 方案 | 做法 | 评价 |
|---|---|---|
| **方案 1（推荐）：渠道无关 artifact URL** | artifact 存在**版本路径**而非渠道路径：`runtime/artifacts/<version>/*.zip`（不含 channel）。manifest 的 `channel` 字段不同但 `artifactUrl` 相同。晋级 = **仅重签 manifest**（改 `channel` 字段，artifactUrl 不变），把新 `{channel}-*.json` 拷到目标渠道路径，artifact **零拷贝零重传** | ✅ **推荐**：晋级即"换一份签名 manifest"，artifact 复用，最省带宽，最快 |
| 方案 2：渠道路径 artifact | artifact 也按渠道存，晋级要**重签 + 重传** artifact 到 stable 路径 | ❌ 多一次大文件搬运，不必要 |

> **明确推荐方案 1**：让 artifact URL **渠道无关**（按版本号路径），channel 仅体现在 manifest 文件名 + 签名的 `channel` 字段。晋级流水线（一个 `promote.yml` workflow_dispatch，输入 `version` + `from_channel` + `to_channel`）：取已签的 artifact（不动），用同密钥重签一份 `channel=<to>` 的 manifest，推到目标渠道路径。canary→beta→stable 三步均如此。

### (f) 防降级与跨渠道交互

semver 规则（3.4）须正确处理 pre-release 与跨档：

1. **pre-release 排序**：canary 版本形如 `0.16.0-cn.7-canary.3`，按 semver pre-release 规则 `0.16.0-cn.7-canary.3 < 0.16.0-cn.7`（正式版）。所以 canary 设备升到正式 `0.16.0-cn.7` 是**正常升级**，不触发防降级。
2. **canary 高于 stable 的情形**：canary 设备装了 `0.17.0-canary.1`，此时 stable 最高才 `0.16.0`。该设备若**切回 stable**，stable manifest 给的 `0.16.0 < 当前 0.17.0-canary.1` → 默认防降级门会拦。**规则**：
   - **切换渠道 = 显式 allow-crossgrade**：当检测到"用户主动切了 channel"（持久化 channel 值变化），下一次 check 放行"目标渠道版本即使更低也可安装"，并在 UI 明确提示"切换到 Stable 将降级到 0.16.0，需要重新安装该版本"。即把**跨渠道切换**当作显式重装意图，绕过防降级门**仅此一次**。
   - **同渠道内**：严格防降级（只升不降），除非服务器 kill-switch 主动指回旧版（带 `rollbackAllowed` 签名标志，3.4）。
3. **floor 仍生效**：跨档切换时 `appVersionFloor`/`minAppVersion` 闸门照常校验——降级目标若 floor 不兼容当前外壳，仍拒绝（避免切回一个需要更新外壳的旧 UI 把自己卡死）。

> **默认规则总结**：同渠道只升不降（防降级）；跨渠道切换=一次性 allow-crossgrade（视为显式重装，UI 提示）；pre-release 按 semver 比较；服务器主动回滚需签名标志。

---

## 12. 覆盖安装 / 原地升级安全性（v0.3.2 → 新版，发版前必读）

> 背景：当前线上用户主力是 **v0.3.2**，外壳尚无自更新（轨道 C 未建），用户升级 = **下载新安装包直接覆盖装**。本节给出"会不会出问题"的代码级结论 + 发版 checklist。
>
> 📌 本节的发版 checklist 已固化为项目技能 **`.codex/skills/desktop-release-preflight/SKILL.md`**（每次发版前先过），与 `desktop-release-sync-landing`（版本同步 + 官网 `latest.json`）配套使用。

### 12.1 结论：设计上安全，因为状态与二进制分离

**用户数据/运行时不在安装目录，而在 app-data，覆盖安装不会动它们：**

| 内容 | 位置 | 覆盖安装时 |
|---|---|---|
| 外壳二进制 + 内嵌 `web/dist` + 安装器资源（`static/bundled-runtime`、`dashboard`、skills、plugins） | 安装目录（Win `%LOCALAPPDATA%`、mac `/Applications`） | **被新版替换**（预期） |
| 已装内核 runtime 树 `versions/<v>/` + `current.json` + `downloads/` | `<data_dir>/cn.org.hermesagent.desktop/runtime/`（`runtime.rs:283-287`） | **保留**，跨升级不变 |
| 用户配置 / profiles / 会话 / `.env` / `HERMES_HOME` | app-data | **保留** |

**关键前提已核对通过**：bundle identifier `cn.org.hermesagent.desktop` 自**首个提交**起从未变过，且 **v0.3.2 标签里就是这个值**（`git show v0.3.2:tauri.conf.json`），`runtime_root()` 用它拼 app-data 路径（`runtime.rs:287`）。**identifier 不变 ⇒ 老 runtime 树 + 设置在升级后被新外壳正确识别**。**⚠️ 永远不要改 identifier**——一改全网用户的 runtime 树与设置全部"失联"（被孤立，触发重新 bootstrap）。

### 12.2 升级后首次启动会发生什么（reconcile 逻辑）

新外壳启动 → `install_bundled_runtime_if_needed(resource_dir)`（`runtime.rs:1479-1619`）拿"新安装包内置 runtime manifest"与磁盘 `current.json` 比对：

1. `read_current_record()`（`runtime.rs:487-507`）读老 `current.json`。**若 schemaVersion 不等于当前常量 / 平台不符 / exe 文件已不在 → 返回 `None`** ⇒ 当作"没装过"，走全新 bundled 安装。
2. 否则按版本：
   - **`current.runtime_version == 内置版本`**（`runtime.rs:1574`）：只把新安装包里的 dashboard web_dist / skills / plugins **重新同步**进 runtime 树（`sync_runtime_resources_from_resource`），直接返回。**→ 这就是"内核没变、只随外壳刷新随附资源"的正常升级路径。**
   - **两者不等**（`runtime.rs:1603-1607`）：验签 → 解包内置 runtime → 冒烟 → 原子 `fs::rename` 装入 `versions/<内置版本>/` → `current.json` 指向它，`previousRuntimeVersion` = 老版本（**可一键回滚**）。

整个过程 staging + 原子换入 + 签名校验，**半途崩溃不会损坏现有 runtime**。所以**绝大多数情况覆盖升级是干净、无感的**。

### 12.3 ⚠️ 必须注意的坑（发版前逐条过）

| 风险 | 代码依据 | 后果 | 规避动作 |
|---|---|---|---|
| **内核被静默降级** | reconcile 只判**相等**，无"当前更新则跳过"保护（`runtime.rs:1574` 仅 `==`）。`bundled_runtime_tag` 默认 `runtime-v0.16.0-cn.6`（`release-desktop.yml:33,89,147`） | 若某 0.3.2 用户已自动更新内核到**高于 cn.6** 的版本，覆盖新外壳会把内核**降级回内置版本**（可回滚，但静默） | **发版前把 `bundled_runtime_tag` 设为 ≥ 当前 stable 渠道已发布的最高 runtime**（别用默认 cn.6 漂移）；并考虑给 bundled 安装加"当前更新则不降级"的 semver 守卫（与 §3.4 配套） |
| **bump schemaVersion = 全员重 bootstrap** | `read_current_record` 在 `schema_version != MANIFEST_SCHEMA_VERSION(2)` 时**返回 None**（`runtime.rs:494-496`），不是迁移 | 若新版把 schema 升到 3（如 §3.3 强升门改造），**所有 0.3.2 用户的 current.json(2) 失效 → 重新 bootstrap 内置 runtime**（丢失已自动更新的版本 + 回滚历史；离线、快，但非无感） | **本次紧急发版不要 bump schema**；§3.3 的 schema→3 单独排期，并先给 `read_current_record` 加 v2→v3 迁移（现状是 None 而非迁移） |
| **安装时 App 在运行** | NSIS 覆盖 / mac 拖拽覆盖 | 外壳 .exe/.app 文件锁；dashboard 子进程在 app-data 不被锁 | 安装器提示关闭；发版说明里提示"先退出再安装" |
| **macOS 未公证 / Windows 未签名** | `release-desktop.yml` 仅 macOS 有公证链；**Windows 无 Authenticode** | mac 未公证会被 Gatekeeper 拦；Win 未签名触发 SmartScreen 警告（非数据损坏，是信任/体验） | macOS 走现有公证；Windows 补 Authenticode（§5）；过渡期发版说明标注"SmartScreen 点'仍要运行'" |
| **dev-local 残留** | release 构建会归档 `local-source` 记录后走 bundled（`runtime.rs:1544-1573`） | 仅影响装过 dev 包的机器，普通用户无关 | 无需动作（`migrate-runtime-trees.mjs` 仅 dev 辅助） |

### 12.4 v0.3.2 → 新版 发版 checklist（最小集）

1. ☑️ **不改** bundle identifier（`cn.org.hermesagent.desktop`）。
2. ☑️ **`bundled_runtime_tag` 锁到 ≥ 线上 stable 最高 runtime**（避免静默降级），且为**明确版本**而非 `latest`。
3. ☑️ **本次不 bump `MANIFEST_SCHEMA_VERSION`**（保持 2）；强升门/schema→3 单独排期。
4. ☑️ macOS 产物走完公证/装订（`release-desktop.yml:153-293`）；Windows 暂未签名 → 发版说明标注 SmartScreen。
5. ☑️ 发版说明提示"安装前请退出正在运行的桌面端"。
6. ☑️（可选）灰度先发 canary（§11）给开发团队覆盖装一遍，确认 reconcile 行为符合预期再放 stable。

> **总结**：v0.3.2 用户下载新包覆盖升级**默认安全**——数据/设置/已装内核都在 app-data 跨升级保留，启动时自动 reconcile。**唯一需要主动防的是"内核静默降级"**（锁 `bundled_runtime_tag`）和**"不要在这次顺手 bump schema"**。

---

## 关键代码锚点速查（实施时直接定位）

- 内核 URL/渠道/公钥级联：`Hermes-CN-Desktop/src/process/runtime.rs:518-598`
- 签名载荷（12 字段，artifactUrl=#9）：`runtime.rs:1087-1104`；验签单键：`runtime.rs:1106-1133`
- check/update_available（纯字符串不等，需改 semver）：`runtime.rs:1043-1046`
- install force-https：`runtime.rs:1659-1666`；artifact 下载：`runtime.rs:1678`；超时 15min：`runtime.rs:38`
- extract_zip 护栏（zip-slip/5000/500MB/symlink）：`runtime.rs:1815-1910`；逃逸检查：`runtime.rs:1834-1846`
- sha256 比对：`runtime.rs:1238`；原子安装：`runtime.rs:1308-1318`；写 current.json：`runtime.rs:1341-1342`
- 冒烟 `dashboard --help`（UI 需替换）：`runtime.rs:1172-1181`，超时 60s：`runtime.rs:44`
- 回滚：`runtime.rs:1731-1810`；previousRuntimeVersion：`runtime.rs:1206`
- dashboard web_dist 可写目录（UI 模式模板）：`runtime.rs:700-705,715-723,762`
- runtime_root / safe_version_segment：`runtime.rs:275,1135`
- 命令注册：`src/main.rs:120(.setup) / 352(generate_handler!)`；runtime 命令：`src/commands/runtime_manager.rs:79-149`
- 外壳更新 const（加 env 覆盖）：`src/commands/desktop_update.rs:13`
- CSP / frontendDist / devUrl / version：`tauri.conf.json:24 / 10 / 9 / 4`；插件（无 updater）：`Cargo.toml:14-15`
- 死代码 UpdateStage：`src/update_stage.rs`（仅 `lib.rs:16` 引用）
- 版本同步：`scripts/sync-desktop-version.mjs`；`package.json:3`；`DESKTOP_VERSION`：`web/src/lib/build-info.ts:4`
- TS 协议：`packages/protocol/src/channels.ts:226-248`（RuntimeUpdateManifest，含 channel:228、minAppVersion:240）
- Core 签名脚本：`Hermes-CN-Core/scripts/sign_runtime_manifest.py:53(SCHEMA=2),59-72(_PAYLOAD_FIELDS),183(https 守卫),200(artifactUrl),205-206(minAppVersion),211(载荷拼接)`
- Core artifactUrl 注入点（签名前改）：`Hermes-CN-Core/.github/workflows/release-runtime.yml:383`；signer 调用：`:392`；私钥 secret：`:378`
- Desktop 发布矩阵 / runtime 解析 / macOS 公证：`Hermes-CN-Desktop/.github/workflows/release-desktop.yml:88-89,103,146-147,153-293`