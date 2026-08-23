# 06. `primelab-win` 操作手册

## 1. 目标和隔离规则

`primelab-win` 只做 prototype/Nightly 验证，不作为制品源或控制服务器。所有连接 outbound-only；不开放入站更新端口。

每次验证必须：

- 使用专用 GitHub runner 标签：`self-hosted, Windows, X64, primelab-win`。
- 使用 `%RUNNER_TEMP%\hermes-hot-update-nightly` 等隔离 Runtime root。
- 使用独立 baseline EXE，不覆盖日常/线上安装。
- prototype 完成后把 D1 release 恢复到 `paused, 0%`。
- 不在日志打印 token、PFX 或 Tauri 私钥。

## 2. SSH/readiness（只读）

Mac 端先确认 SSH config 的真实 alias，再验证 shell。当前配置中的 alias 是 `windows`，目标主机名为 `PRIMELAB-WIN`：

```bash
ssh -G windows | sed -n '1,30p'
ssh windows 'powershell -NoProfile -Command "$PSVersionTable.PSVersion; [Environment]::OSVersion.Version"'
```

后续若 SSH config 调整，仍以 `~/.ssh/config` 为准。不要把 DNS 主机名当成 SSH alias 猜测，也不要为了测试修改远端现有应用或服务。

Windows 上检查：

```powershell
git --version
node --version
pnpm --version
rustc --version
cargo --version
Get-Command signtool -ErrorAction SilentlyContinue
Get-Command ssh -ErrorAction SilentlyContinue
```

GitHub runner 安装在 `C:\actions-runner-hermes`，仓库 runner ID 为 22，标签为 `self-hosted, Windows, X64, primelab-win`。它由计划任务 `Hermes GitHub Actions Runner` 在 `admin` 已登录的交互式会话中启动，必须同时满足 `SessionId >= 1`、`LogonType=Interactive`、`RunLevel=Limited`；`Run with highest privileges` 必须关闭。不要改成 Windows service/Session 0，也不要改回 Highest：前者不能可靠创建 WebView2，后者会让 WebView2 忽略环境变量/注册表中的 CDP flags。微软的 [WebView2 browser flags 文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags) 也明确说明 elevated app 会忽略 local device environment flags。机器离线、交互式会话不存在、证书缺失或 baseline 不存在时让 job 失败，不回落到普通机器。

2026-08-23 PR 验收清理后的 baseline 是 `%LOCALAPPDATA%\Hermes Agent CN Desktop\hermes-agent-cn-desktop.exe`，ProductVersion 为 `0.8.1-prototype.592.7.1.1`，进程已停止；隔离 Runtime 保持 Core `0.20.0`、Runtime `0.20.0-cn.9` 和 preservation sentinel。Nightly 仍必须使用 `%RUNNER_TEMP%` 下的隔离 Runtime root，不能把机器当前状态当成可复用的线上安装。

旧 `.hotupdate.1` 来自 R2 原型，只能证明既有 Tauri/NSIS 安装边界。PR #592 已运行 `.github/workflows/hot-update-windows-pair-test.yml`，从同一个 Desktop/Core SHA 构建：

```text
prototype.<pr>.<run>.<attempt>.1          承重基线
prototype.<pr>.<run>.<attempt>.2          正常候选
prototype.<pr>.<run>.<attempt>.3.badsig   坏签名负向候选
```

先手工覆盖安装 `.1`，再让 `.1` 通过控制面升级到 `.2`；`.badsig` 只允许在重置到 `.1` 后验证拒绝下载，完成后立即 revoke。

PR 内测试由 `hot-update-windows-test` label 触发。`hot-update-staging` Environment 必须先配置 required reviewer，并让 deployment branch rule 精确允许 `refs/pull/<PR>/merge`；只允许 `main` 还不足以放行 PR job。当前 staging 按仓库所有者决定保留管理员绕过，但本测试仍走普通 reviewer 批准并保留 deployment 记录，不调用绕过入口；production 不自动继承这项例外。

## 3. 网络预热

大陆 Windows 首次构建可能访问失败：GitHub checkout/Release、rustup/crates.io、npm/pnpm、Tauri NSIS、WebView2、时间戳和 Cloudflare 自定义域名。

预热原则：

- 依赖缓存必须由官方 URL 下载并核对官方 hash，不能保存不明二进制。
- Rust/npm/NSIS 缓存只解决构建可达性，不改变最终 release SHA 的核验流程。
- Authenticode 时间戳必须在签名时真实可达；不能用“先不签”替代 canary/beta/stable 闸门。
- 每次 smoke 记录 DNS/TLS/TTFB/完整下载，不只记录 `curl 200`。

## 4. Nightly runner 输入

Environment variables/secrets：

```text
HERMES_UPDATE_CHANNEL=prototype
HERMES_UPDATE_DEVICE_ID=primelab-win
HERMES_SHELL_UPDATE_ENDPOINT=<staging check template>
HERMES_SHELL_UPDATE_TOKEN=<runner secret>
HERMES_DESKTOP_RUNTIME_ROOT=<runner temp isolated root>
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
```

`HERMES_SHELL_UPDATE_TOKEN` 仅是 runner 原型兼容入口；真实用户通过一次性邀请写系统凭据库。

## 5. 自动 smoke 做什么

`scripts/windows-hot-update-smoke.mjs` 通过 WebView2 CDP 驱动真实应用：

1. 等待 baseline WebView。
2. 调 `appUpdateCheck`，确认授权目标版本。
3. 调 `appUpdateDownload`，确认来源为 Cloudflare 或 GitHub fallback。
4. 调 `appUpdateInstall`，等待旧进程退出、安装和新进程启动。
5. 重新连接 CDP，确认当前 Desktop 版本且不再有更新。
6. 读取 Runtime `current.json`，核对精确 Core version。
7. 请求 `/api/version`，证明 managed Core 9120 正常。

预期 Desktop/Core version 都由工作流参数传入，脚本不硬编码未来版本。

Windows 安装阶段不依赖 NSIS `/R`。客户端从 updater 缓存启动不同文件名的 detached helper；helper 等旧 Desktop 退出，等待 NSIS 返回成功，再显式拉起已安装 EXE。诊断日志位于隔离 Runtime root 的 `desktop-updater-cache/updater-helper.log`，只允许包含阶段、退出码和 PID。通过 SSH 直接启动 GUI 会落入 Session 0，真机已复现 WebView2 `0x80070578`，不能用于完整 UI smoke；helper 可单独覆盖 Session 0 安装边界，完整 Nightly 必须由 Session 1、非提升 runner 驱动。

PR 双包测试还使用：

- `scripts/windows-hot-update-prepare.ps1`：导入公开 staging 证书、验证 Authenticode、覆盖安装基线并创建数据保留 sentinel。
- `scripts/windows-hot-update-launch.ps1`：用隔离 Runtime root、prototype device 和 WebView2 CDP 启动真实安装包。
- `scripts/windows-hot-update-smoke.mjs --mode ...`：支持 install、download-only、错误 token、下载失败和 pause 后安装阻止五类断言。
- staging 镜像的 `STAGING_FAULT_TAG` / `STAGING_FAULT_ASSET` / `STAGING_FAULT_STATUS`：只在 `ENVIRONMENT=staging` 且 tag、资产完全相等时返回 404/429/503；恢复时重新部署无故障变量版本。

故障注入必须在目标机器先核对 `x-hermes-staging-fault`。版本化对象一旦在该边缘 HIT，缓存层可能在 Worker 执行前直接返回旧响应；应使用尚未预热的新 tag/资产，不能仅凭 Wrangler deploy 成功就认为故障已生效。

## 6. 候选验收矩阵

| 用例 | 操作 | 预期 |
|---|---|---|
| Cloudflare 冷/热缓存 | 完整下载两次并取 Range | SHA 一致；第二次期望 HIT/缓存命中证据；Range 206 |
| GitHub 回退 | staging 中使用专门故障注入的镜像版本/路由 | 只有超时、429、5xx回退；重新完整下载；显示 GitHub source |
| 错 token/ring | 换 token 或 channel | 401；不访问下载域名/GitHub |
| pause | 下载前或安装复核前 pause | check 204 或 install 停止 |
| 坏签名 | 独立 staging 候选，签名与包不匹配 | 失败且不回退、不安装 |
| 404 | 固定 tag 中不存在资产 | 不回退，候选暂停 |
| pending | 下载后选择稍后并重启 | 下次能恢复；安装后陈旧缓存清理 |
| Runtime 防降级 | baseline 有更高 revision | Desktop 更新不覆盖成更低 Runtime |

故障注入必须只发生在 staging 独立 Worker/version，不能改 GitHub 现有发布资产或 production DNS。

## 7. 人工安装后证据

- `Get-AuthenticodeSignature <installer>` 为 `Valid`。
- “应用和功能”/卸载注册表版本正确。
- EXE ProductVersion/FileVersion 正确。
- `current.json` 的 runtime/core/revision/source commit 正确。
- 9120 `/api/version` 正确；配置、会话、profiles 未丢失。
- UI 显示实际下载来源和 fallbackUsed。
- 测试结束 release 为 `paused, 0%`，device 可按需 disable。

保留 workflow run URL、SHA、release ID、安装前后版本和网络数据；截图只作为补充，不能代替这些机器证据。
