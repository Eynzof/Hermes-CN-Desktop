# 热更新落地方案(Tauri 外壳 + Python 内核)

> 状态:提案(2026-06-06) · 范围:`hermes-agent-cn-desktop`(外壳)+ `Hermes-CN-Core`(内核 runtime)
> 相关文档:[`managed-runtime.md`](./managed-runtime.md)、[`macos-signing-and-notarization.md`](./macos-signing-and-notarization.md)

本方案回答三个核心问题:**(1) 用户侧热更新如何实现、(2) 是否需要后端、(3) 是否需要下载服务器**。
全部判断基于对真实代码 / CI 的核对,凡是已有机制一律标注「已具备」,缺口给出最小代价补法。

## TL;DR

1. **热更新分两条路、状态完全不同。** 内核(Python runtime)的热更新**已经端到端做完**——从发现、下载、双重校验、原子换入、回滚到设置页 UI 全部就绪,只差几处「保险栓」;而 **Tauri 外壳二进制本身完全没有自更新**,需要新建。别把两者混为一谈。
2. **最小可用不需要动态后端。** 两条路本质都是「拉一个静态签名 JSON + 下一个静态产物 + 客户端验签」。一个对象存储 + CDN 就够,安全性由 ed25519 / minisign 端到端验签保证。动态后端(灰度 / 强制升级 / 统计)是用户上量后的 Phase 2,且可用 serverless,不必常驻服务器。
3. **不需要自建下载服务器,但必须补一层大陆镜像。** 今天所有下载都打在 `github.com` Releases 上,大陆体验差。补对象存储 + CDN 即可。**唯一的硬坑**:runtime 产物的 `artifactUrl` 在 ed25519 签名内,真要把产物迁到镜像,必须「签名前改 URL 重签」,只改客户端不会迁移产物。

---

## 一、现状能力矩阵(基于代码,不臆测)

| 能力 | Tauri 外壳(desktop 0.2.1) | Python 内核 runtime(kernel 0.16.0) |
|---|---|---|
| 发现更新 | ❌ 无任何逻辑 | ✅ `check_runtime_update()` 拉扁平 manifest `${base}/${channel}-${platform}-${arch}.json` |
| 下载 | ❌ 用户手动去 GitHub / 官网下 `.exe`/`.dmg` | ✅ 验签后 GET 整包 zip(强制 https,15min 超时) |
| 完整性校验 | ❌ 无 in-app 校验 | ✅ **下载前** ed25519 验 manifest 签名 + **下载后** sha256 逐字节比对 |
| 原子替换 | ❌ 靠 NSIS / dmg 覆盖安装 | ✅ 临时目录解压(防 zip-slip)→ smoke test(`dashboard --help`)→ `fs::rename` 换入 `versions/<v>/` → 改 `current.json` 指针 |
| 回滚 | ❌ 装坏只能重下旧包 | ✅ `rollback_runtime()` 改指针回 `previousRuntimeVersion` |
| **接入 UI** | ❌ 无 | ✅ **设置页已有「检查 / 安装 / 回滚」三按钮**(`web/src/routes/settings.tsx`、`web/src/hooks/use-runtime-update.ts`、命令注册 `src/main.rs`) |
| 签名体系 | ❌ 无 updater pubkey;Windows 连 Authenticode 都没签;macOS 有完整公证链 | ✅ ed25519,公钥硬编码 `FALLBACK_PUBLIC_KEY_PEM`,私钥在内核仓库 secret `RUNTIME_SIGN_PRIVATE_KEY_PEM` |
| 版本闸门 | ❌ | ⚠️ `minAppVersion` 字段**预留但从不读取**(死字段),且**未纳入签名**(可被中间人篡改) |
| 防降级 | ❌ | ⚠️ 更新判定是字符串 `!=`,无 semver、无降级保护 |
| 密钥轮换 | ❌ | ⚠️ 只有单一活动公钥,无多公钥并存机制 |
| CI 产物 | ⚠️ 产 `.exe`/`.dmg`,**不产 updater 的 `latest.json`+`.sig`** | ✅ 产 zip + 签名 manifest,发 GitHub Releases |

**一句话总结**:内核侧是「**引擎 + 仪表盘都装好了,缺两根保险栓**」;外壳侧是「**整套自更新系统不存在**」。

---

## 二、热更新的两条路径

### 2.1 内核 runtime 热更新 —— 已具备 ~85%,做「收口」

真实链路(逐环节已落地,**不要重造**),按代码实际执行顺序:

```
check(拉 manifest JSON)
  → ed25519 验 manifest 签名          ← 下载前就验,签名覆盖含 artifactUrl + sha256 的 12 字段
  → 强制 artifactUrl 为 https
  → 下载整包 zip
  → sha256(下载内容) == manifest.sha256  ← 第二道校验
  → 临时目录解压(防 zip-slip,限 5000 文件 / 500MB)
  → smoke test(跑 dashboard --help,60s)
  → fs::rename(staging → versions/<v>/)   ← 原子换入
  → 写 current.json 指针
  → restart_dashboard()(只重启子进程,不碰 Tauri 进程)
```

这是教科书级的 OTA 设计:两道独立校验(签名 + 摘要)、smoke test 把关、指针级原子切换、可来回回滚。需要补的只有四件小事:

1. **启用 `minAppVersion` 强制闸门(P1 必做)。** 现在是死字段。要在 check / install 前读 `minAppVersion` 与外壳版本 `0.2.1` 做 semver 比较,不满足就拒绝并提示「请先升级桌面应用」。**安全前提**:必须**先把 `minAppVersion` 纳入签名载荷**(目前不在 12 字段里),否则中间人可把它篡改成 `null` 绕过闸门。
2. **更新判定改 semver + 防降级(P1)。** 现在是纯字符串 `!=`,理论上能被诱导「更新」到一个签名合法的旧版本。改 semver 比较、拒绝低于当前版本。
3. **回滚加一次完整性复检(P2)。** 当前回滚只改指针、信任已落盘旧版本,被篡改不会发现。回滚前复用 `versions/<prev>/manifest.json` 的 sha256 / 签名复校一次。
4. **进度可视化(P2)。** `src/update_stage.rs` 定义了 Downloading → Verifying → … → RestartingDashboard 完整状态机,但**是 dead code**(UI 实际走更简单的 `use-runtime-update.ts`)。要么接通做进度条,要么删掉,避免后人误以为「已实现」。

> ⚠️ **半更新态**:`install` 成功但 `restart_dashboard` 失败时返回 `ok=false`,但 **runtime 已经换好了**。UI 必须据此提示「请重启应用」,而不是误报「更新失败」让用户重试。

### 2.2 Tauri 外壳更新 —— 从零做,两步走

外壳今天**确实没有自更新**:`Cargo.toml` 只有 `tauri-plugin-dialog`(无 `tauri-plugin-updater`),`tauri.conf.json` 无 `plugins.updater` 段,CI(`.github/workflows/release-desktop.yml`)不产 `latest.json`+`.sig`。

**Phase 0(1–2 人日,零依赖):软更新提示。** 复用现成模式:客户端 fetch 一个静态 `desktop-latest.json`(放官网 Cloudflare Pages),比对 `0.2.1`,有新版就用**已在依赖里的** `tauri-plugin-dialog` 弹窗引导去官网 / 镜像重装。先把「用户根本不知道有新版」这个最痛的问题解决,不需要 updater 插件、不需要签名体系。

**Phase 1(真自更新):接 `tauri-plugin-updater`。**

- `Cargo.toml` 加 `tauri-plugin-updater = "2"`;`src/main.rs` 注册插件;`tauri.conf.json` 加 `plugins.updater`(`endpoints` 指向 `latest.json` + `pubkey`);`capabilities` 加 `updater:default`。
- CI 注入 `TAURI_SIGNING_PRIVATE_KEY`,让 `tauri-action` 自动产 `.sig` 和 `latest.json` 上传。
- **NSIS `installMode=currentUser` 是有利前提**:装在 `%LOCALAPPDATA%`、无 UAC,非特权进程可原地覆盖,天然适合静默自更新。
- **macOS 要重排 CI**:updater 的更新产物通常是 `.app.tar.gz` 而非 dmg,公证对象会变,要和现有 notarytool + stapler 链(见 [`macos-signing-and-notarization.md`](./macos-signing-and-notarization.md))对齐,别直接套 dmg 流程。

> 两套签名体系**独立、不要合并**:外壳用 Tauri updater 的 minisign(`TAURI_SIGNING_PRIVATE_KEY`),内核用 ed25519(`RUNTIME_SIGN_PRIVATE_KEY_PEM`)。两套私钥、两套公钥,互不复用——这是正确的隔离。

---

## 三、需要后端吗?—— 最小可用不需要

| 形态 | 何时够用 | 实现 |
|---|---|---|
| **(a) 纯静态签名清单托管** ✅ | Phase 0/1,DAU 上千之前 | 内核 `stable-<plat>-<arch>.json` + 外壳 `latest.json` + 产物,全扔对象存储 / CDN / Releases。**零服务端逻辑**,安全靠客户端验签——托管被攻破也注入不了恶意更新(除非私钥泄露)。 |
| **(b) 动态后端** ⏳ | 出现以下任一真实需求才做 | 灰度 / 分群发布、强制升级 / 紧急下架某坏版本、更新成功率统计、服务端发起回滚下发。**可用 Cloudflare Workers + KV(serverless),不必常驻服务器**;客户端 endpoint 不变,后端从静态文件换成函数,迁移成本极低。 |

**判断标准**:在需要「可控发布节奏 / 某版本必须紧急止血」之前,静态完全够。**不要为了它现在就建后端。**

---

## 四、需要下载服务器吗?—— 不需要自建,需要补大陆镜像

**现状**:runtime 更新 + zip、安装包下载,全部硬编码兜底到 `github.com/Eynzof/Hermes-CN-Core/releases/...`。官网本体已在 Cloudflare Pages(`desktop.hermesagent.org.cn`,免备案、大陆可达),**但点下载仍跳 github.com**;页脚 `res1.hermesagent.org.cn`「国内镜像」目前只是占位链接,无产物。github.com 在大陆超时 / 限速 / 偶发 DNS 污染,首次下数百 MB 的 runtime 体验很差。

**托管选型(都是无状态静态文件,别自建服务器)**:

| 方案 | 优点 | 注意 |
|---|---|---|
| **Cloudflare R2 + Pages**(推荐起步) | 与官网同生态、无出口流量费、免备案、立刻能跑 | 大陆访问速度比 github 好但非最优 |
| **国内 OSS/COS + CDN**(阿里 / 腾讯) | 大陆速度最佳 | **需备案** + 流量费 |
| **GitHub Releases**(保留兜底) | 零成本、已有 | 大陆慢 / 不稳 |

**推荐组合**:海外 / 兜底留 GitHub Releases(不动);大陆主源用 R2(免备案先跑)或国内 OSS+CDN(接受备案则最快);把官网下载按钮 + `res1.hermesagent.org.cn` 真正接上镜像直链。

> ⚠️ **关键坑**:
> - **安装包(.exe/.dmg)镜像最易做**——无签名约束,CI 产物同步一份到对象存储、官网按钮指镜像直链即可。
> - **runtime zip 镜像有签名约束**:`artifactUrl` 是 ed25519 签名覆盖的 12 字段之一。**注意:只改客户端 `HERMES_RUNTIME_UPDATE_BASE_URL` 并不会让产物走镜像**——base 只改「去哪拉 manifest」,manifest 里被签名的 `artifactUrl` 仍指向 github,产物照样从 github 下。真要把**产物**迁到镜像,只有一条正路:**在签名前就把 `--artifact-url` 改成镜像地址重新签**(你持私钥,改内核 CI `release-runtime.yml` 里用 `${GITHUB_REPOSITORY}` 拼 URL 的逻辑)。
> - 当前代码**不支持双签名 / `key_id` 多 key 选择**(见内核 `docs/managed-runtime.md`),别走这条。

---

## 五、签名与安全(两套独立体系)

| | 内核 runtime(已具备) | 外壳 Tauri(需新建) |
|---|---|---|
| 算法 | ed25519(`verify_strict`) | minisign(updater 内置) |
| 私钥 | `RUNTIME_SIGN_PRIVATE_KEY_PEM`(内核 secret) | `TAURI_SIGNING_PRIVATE_KEY`(待加) |
| 公钥 | 硬编码 `FALLBACK_PUBLIC_KEY_PEM`,可 env / 编译期覆盖 | 写入 `tauri.conf.json` |
| 签名覆盖 | 12 字段(含 `artifactUrl`+`sha256`),**不含** `minAppVersion`/`createdAt` | 整个更新产物 |

**需补的安全缺口**:

1. **密钥轮换**:目前单一活动公钥,轮换只能重编译 / 换 env,新旧 key 无法并存过渡。建议 `verify_signature` 改成**多公钥列表逐个尝试**,实现平滑轮换。
2. **`minAppVersion` 入签名**:见 §2.1,启用闸门前必须先让它受签名保护。
3. **Windows Authenticode 签名缺口**:`.exe` 未签 → SmartScreen 警告 + 杀软误报。与热更新独立,但影响安装信任,建议 Phase 1 补 OV/EV 证书。
4. 私钥冷备份、泄露即轮换。TLS 因有端到端验签,pinning 非必需(纵深防御可选)。

---

## 六、版本与兼容

- 两套版本号**完全解耦**:外壳 `0.3.1`(SemVer / `v*` 标签),内核 `0.16.0`(`runtime-v0.16.0-cn.6` 标签);`scripts/sync-desktop-version.mjs` 只同步桌面侧,不碰内核。
- 它们**不是**靠 `bundled_runtime_tag` 在运行时软耦合——`bundled_runtime_tag` 只是 `release-desktop.yml` 的**构建期** `workflow_dispatch` 输入(默认锁定到当前发布 runtime),决定打包时内嵌哪个 runtime;运行期自动更新走的是另一套(默认 channel = `stable`)。
- **建议**:① 发布时把 `bundled_runtime_tag` 锁成**明确版本**而非 `latest`,保证可复现;② 维护一张「desktop 版本 ↔ 兼容 runtime 区间」表纳入发布 checklist;③ 用 §2.1 的 `minAppVersion` 闸门兜住「新 runtime 依赖新外壳能力」的不兼容。

---

## 七、落地路线图

**Phase 0 — 止痛(约 2–4 人日)**
外壳软更新提示 + 安装包大陆镜像(无签名约束,最易)+ README / 官网讲清「外壳需手动重装」。先核对一处:官网 REPO slug 与 CI 上传目标是否一致,否则下载直链 404。

**Phase 1 — 收口 + 外壳真自更新(约 1.5–3 人周)**
内核:`minAppVersion` 闸门(入签名)+ semver 防降级 + 进度可视化 / 或删死代码。外壳:接 `tauri-plugin-updater` 全套 + CI 产 `latest.json`/`.sig` + 对齐 macOS 公证。补 Windows Authenticode。runtime 产物镜像:改内核 CI 在签名前改 `artifactUrl`。

**Phase 2 — 动态化(按需,约 1–2 人周)**
Cloudflare Workers 做灰度 / 强制升级 / 紧急下架 / 统计;多公钥轮换;回滚复检;评估 runtime 增量更新(见下)。

---

## 八、风险与坑(逐条对照动作)

1. **整包更新带宽**:runtime 是 PyInstaller `--onedir` 整目录 zip(数百 MB,含嵌入式 CPython),**无 delta**,改几行 Python 也全量下载。若热更频繁,Phase 2 评估 `zstd --patch-from`/bsdiff 增量,或把「稳定的 stdlib / 三方库」与「频繁变动的 `hermes_cli` 应用层」拆成两个可独立替换的归档。
2. **半更新态**:见 §2.1,UI 要正确提示「重启应用」。
3. **死代码 / 死字段陷阱**:`src/update_stage.rs`、`minAppVersion`、TS 侧 `packages/protocol/src/channels.ts` 的 `minAppVersion` 镜像——都「看着像实现了」,要么接通要么删,避免后人误判能力边界。
4. **macOS 公证对象变化**、**Windows 未签名**、**`bundled_runtime_tag=latest` 漂移**、**官网 `.vercel` 残留 vs 实际 Cloudflare 部署**:逐一见上文,均有对应动作。

---

## 附:关键文件索引(仓库相对路径)

- 内核更新链路:`src/process/runtime.rs`(兜底源 `FALLBACK_MANIFEST_BASE_URL`、公钥 `FALLBACK_PUBLIC_KEY_PEM`、验签 `verify_signature` / `verify_signature_with_key`、强制 https、签名载荷 `signature_payload`、sha256 比对、原子 `fs::rename`、回滚 `rollback_runtime`、`min_app_version` 死字段)
- 命令 + UI:`src/commands/runtime_manager.rs`、`src/main.rs`、`web/src/routes/settings.tsx`、`web/src/hooks/use-runtime-update.ts`
- 死状态机:`src/update_stage.rs`(+ `src/lib.rs` 的 `pub mod`)
- 外壳配置:`tauri.conf.json`(无 updater 段、NSIS `installMode=currentUser`)、`Cargo.toml`
- CI:`.github/workflows/release-desktop.yml`、内核 `release-runtime.yml`、内核 `scripts/sign_runtime_manifest.py`
- 内核 runtime 详解:[`managed-runtime.md`](./managed-runtime.md)
- 官网:`hermes-agent-cn-desktop-landing` 的 `src/site.config.ts`(REPO slug、下载 URL、`res1` 镜像占位)
