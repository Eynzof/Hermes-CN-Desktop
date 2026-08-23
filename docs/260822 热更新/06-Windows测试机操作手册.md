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

GitHub runner 安装在 `C:\actions-runner-hermes`，仓库 runner ID 为 22，标签为 `self-hosted, Windows, X64, primelab-win`。它由计划任务 `Hermes GitHub Actions Runner` 在管理员已登录的交互式会话中启动，`Runner.Listener.exe` 应位于 Session 1；不要改成 Windows service/Session 0，因为 Nightly 需要启动 Tauri WebView2 并通过 CDP 驱动真实 UI。机器离线、交互式会话不存在、证书缺失或 baseline 不存在时让 job 失败，不回落到普通机器。

当前 baseline 是 `%LOCALAPPDATA%\Hermes Agent CN Desktop\hermes-agent-cn-desktop.exe`，已安装 Desktop `0.8.1-hotupdate.1`、Core `0.20.0`、Runtime `0.20.0-cn.9`。Nightly 仍必须使用 `%RUNNER_TEMP%` 下的隔离 Runtime root，不能把这份现状当作可覆盖的线上安装。

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
