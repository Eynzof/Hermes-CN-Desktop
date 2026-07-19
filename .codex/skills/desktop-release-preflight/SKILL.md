---
name: desktop-release-preflight
description: Use BEFORE preparing or publishing any Hermes Agent CN Desktop release (new installer, version bump, GitHub Release, or pushing a new build to users). This is the release safety gate that prevents in-place overwrite-upgrade regressions for existing users (live users are mainly on v0.3.2 and upgrade by downloading the new installer over the old one). Covers the managed-runtime reconcile traps (silent kernel downgrade via bundled_runtime_tag, schemaVersion re-bootstrap, the load-bearing stable bundle identifier), the China-mirror "artifactUrl-before-signing" rule, the cnb.cool vs GitHub Actions build-location decision, signing / notarization / Authenticode gates, and shipping to a canary channel first. Complements desktop-release-sync-landing (which handles version sync + the landing latest.json) — run this one FIRST.
---

# Desktop Release Preflight（发版前预检）

## Overview

线上用户主力是 **v0.3.2**，外壳尚无自更新（热更新轨道 C 未建），所以用户升级 = **下载新安装包直接覆盖装**。这套机制**默认是安全的**——用户的内核 runtime 树和所有设置都在 app-data、不在安装目录，覆盖装不动它们；启动时 `install_bundled_runtime_if_needed` 自动 reconcile。**但有两个坑会在不经意间伤到老用户，必须每次发版主动防。** 本技能就是发版前的安全闸门，先于 `desktop-release-sync-landing` 执行。

完整设计见 `docs/hot-update-impl-plan.md`（§12 覆盖升级安全性、§2.5 构建/分发后端、§11 灰度通道）。

## 为什么覆盖升级默认安全（一句话原理）

| 内容 | 位置 | 覆盖安装时 |
|---|---|---|
| 外壳二进制 + 内嵌 `web/dist` + 安装器资源 | 安装目录（Win `%LOCALAPPDATA%`、mac `/Applications`） | 被替换（预期） |
| 已装内核 runtime 树 `versions/<v>/` + `current.json` | `<data_dir>/cn.org.hermesagent.desktop/runtime/`（`src/process/runtime.rs:283-287`） | **保留**，跨升级不变 |
| 配置 / profiles / 会话 / `.env` / `HERMES_HOME` | app-data | **保留** |

前提：bundle identifier `cn.org.hermesagent.desktop` 自首个提交起稳定（`tauri.conf.json:5` 与 `runtime.rs:287` 一致，`v0.3.2` 标签同值）。**改 identifier = 全网用户 runtime 树 + 设置失联**。

启动时 reconcile（`runtime.rs:1479-1619`）：老 `current.json` 与"新安装包内置 runtime 版本"比对 —— 相等只刷新随附资源（`runtime.rs:1574`）；不等就验签 + 原子换入 + 写回滚指针。

## 发版前必过 checklist（按顺序逐条勾）

> 任何一条不满足，**停下来**，不要发 stable。

1. ☑️ **identifier 没改**：`grep identifier tauri.conf.json` 仍是 `cn.org.hermesagent.desktop`。永不更改。
2. ☑️ **`bundled_runtime_tag` 锁到 ≥ 线上 stable 最高 runtime，且是明确版本（不是 `latest`）**。这是**防内核静默降级**的关键（见下"坑 1"）。
   - 查线上 stable 最高 runtime：`gh release list -R Eynzof/Hermes-CN-Core | head` 或看 stable manifest。
   - 触发 `release-desktop.yml` 时用 `workflow_dispatch` 输入 `bundled_runtime_tag=<该版本>`（输入定义在 `.github/workflows/release-desktop.yml:31`），或先把默认值 `:33,89,147`（当前 `runtime-v0.16.0-cn.6`）更新到该版本。
3. ☑️ **本次不 bump `MANIFEST_SCHEMA_VERSION`**（保持 `runtime.rs:29` 的 `2`）。schema→3（强升门改造）单独排期（见"坑 2"）。
4. ☑️ **macOS 走完公证/装订**（`release-desktop.yml:153-293`）。未公证会被 Gatekeeper 拦。
5. ☑️ **Windows 现状未签名**（无 Authenticode）→ 覆盖装会触发 SmartScreen。发版说明里明确告知用户点"仍要运行"，或本次补 Authenticode（见 `docs/hot-update-impl-plan.md` §5）。
6. ☑️ **版本号同步**：改根 `package.json` "version" 后 `pnpm run version:sync`，`pnpm version:check` 通过（这步与 `desktop-release-sync-landing` 重叠，以那篇为准）。
7. ☑️ **发版说明提示"安装前先退出正在运行的桌面端"**（外壳 .exe/.app 文件锁；dashboard 子进程在 app-data 不被锁）。
8. ☑️ **先发 canary 给开发团队覆盖装验证**（见下"灰度优先"），确认 reconcile 行为符合预期，再放 stable。
9. ☑️ 发完后转 `desktop-release-sync-landing`：同步 landing 官网版本 + `https://desktop.hermesagent.org.cn/latest.json`。

## 两个必须主动防的坑（深入）

### 坑 1 — 内核被静默降级（最常见、最隐蔽）

reconcile 只判**相等**（`runtime.rs:1574` 仅 `current.runtime_version == manifest.runtime_version`），**没有"当前已是更新版本则跳过"的保护**。若某 0.3.2 用户已通过热更把内核更新到**高于本次内置版本**的 runtime，覆盖新外壳后启动会把内核**降级回内置版本**（可一键回滚，但用户无感、属意外）。

- **触发条件**：`bundled_runtime_tag`（默认锁死在 `runtime-v0.16.0-cn.6`）落后于线上 stable 渠道已发布的 runtime。
- **规避**：checklist #2 —— 发版时把 `bundled_runtime_tag` 设为 ≥ 当前 stable 最高 runtime。
- **根因修复（排期项，非本次）**：给 bundled 安装路径加 semver 守卫"当前 ≥ 内置则不降级"，与 `docs/hot-update-impl-plan.md` §3.4 的防降级配套（注意 §3.4 改的是自动更新路径，bundled 路径需单独加）。

### 坑 2 — bump schemaVersion = 全员重新 bootstrap

`read_current_record`（`runtime.rs:487-507`）在 `record.schema_version != MANIFEST_SCHEMA_VERSION` 时**直接返回 `None`**（`runtime.rs:494-496`，是丢弃不是迁移）。一旦把常量从 `2` 升到 `3`，**所有 0.3.2 用户的 `current.json`(schema 2) 立即失效 → 当作没装过 → 重新 bootstrap 内置 runtime**，丢失其已热更的版本与回滚历史（离线、快，但非无感）。

- **规避**：checklist #3 —— 紧急/常规发版保持 schema 2。
- **真要升 schema 时**：先给 `read_current_record` 加 v2→v3 迁移（把旧字段补齐后改写），再 bump 常量；分两个版本发，先发"能读旧 schema"的客户端。

## 国内镜像 / 自建分发相关的发版动作

若本次发版要让国内客户端从自建国内服务器下载（见 `docs/hot-update-impl-plan.md` §2、§3）：

- **内核 / UI 的 `artifactUrl` 必须在签名前定死为国内 https 地址**——它是 ed25519 签名载荷字段 #9（`runtime.rs:1098`；Core `sign_runtime_manifest.py` 的 `_PAYLOAD_FIELDS`），**签名后改 URL 必然验签失败**。注入点在 Core `release-runtime.yml:383`（构造 `URL=` 的那行，在调用 signer 之前）。**绝不可签名后用 sed 改 JSON。**
- manifest 的 base URL **不在签名内**，客户端可用 `HERMES_RUNTIME_UPDATE_BASE_URL` / `_MANIFEST_URL` 运行时覆盖，或编译期 bake `*_DEFAULT`，或改 `runtime.rs:523-524` 的 fallback（当前仍指 github.com，**未配置 env/bake 时会静默走 GitHub**）。
- 同一份签名 manifest 只能指一个 zip URL；GitHub 仅作冗余双上传，不追求自动 failover（客户端无镜像回退列表）。

## 构建位置决策（cnb.cool vs GitHub Actions）

详见 `docs/hot-update-impl-plan.md` §2.5。要点：**核心热更不需要写应用后端**；[cnb.cool](https://docs.cnb.cool/zh/) 公共构建节点**只有 Linux（amd64/arm64）**，没有公共 macOS/Windows runner（仅企业版接自有物理机）。因 PyInstaller/Tauri 不能跨平台编译、macOS 需公证、Windows 需 Authenticode，**默认混合**：

| 组件 | 构建位置 | 说明 |
|---|---|---|
| UI 包 / 内核 Linux 产物 | ✅ cnb.cool（Linux，自动拉代码编译） | `vite build`/PyInstaller-Linux 与 OS 无关 |
| 内核 Windows/macOS、外壳 .exe/.dmg | GitHub Actions（已有公证链） | 原生构建 + 公证/签名 |

Ed25519 私钥放执行签名的那个平台 secret，**永不上分发服务器**；推荐把"签名+发布"收敛到单一流水线避免私钥多副本。

## 灰度优先（canary）

发 stable 前，先把同一批产物发到 **canary 渠道**（独立路径 `canary-<platform>-<arch>.json`、**同一密钥**签名，stable 用户永不可见），让开发团队设备覆盖装一遍，确认：① reconcile 不误降级、② 启动正常、③（若含 UI 热更）UI 通道正常。机制见 `docs/hot-update-impl-plan.md` §11。

## 相关技能 / 文档

- 版本同步 + landing `latest.json`：`.codex/skills/desktop-release-sync-landing/SKILL.md`（本技能之后执行）。
- 双仓库启动/打包态补验：`.codex/skills/desktop-dual-repo-test/SKILL.md`。
- 完整热更新方案：`docs/hot-update-impl-plan.md`（§2.5 / §11 / §12）。
