# 05. Tauri 客户端状态机、回退与回滚

## 1. 状态机

```text
idle
  → check-control
  → 204 / unauthorised / incompatible → idle（不发现 GitHub）
  → authorised
  → 用户确认
  → download-cloudflare
      → 可回退网络错误 → download-github（完整重下）
      → 签名/SHA/格式/权限错误 → failed
  → verified-pending
  → 用户“立即重启安装”或“稍后”
  → recheck-control
  → stop-owned-runtime
  → Windows: launch-detached-helper → process-exit → NSIS → relaunch
  → macOS/Linux: launch-tauri-installer
```

对应 Rust commands：`app_update_check`、`app_update_pending`、`app_update_download`、`app_update_install`。

## 2. 检查阶段

- endpoint 必须是 HTTPS `/v1/check/` 模板。
- restricted ring 从系统凭据库读取 token；环境变量只用于 CI/旧原型迁移。
- stable 首次生成随机 installation ID 并持久化。
- Tauri 拿到响应后继续验证 metadata schema、channel、release ID、GitHub allowlist、Desktop↔Core、Runtime revision、大小和 tag/version。
- `manifestSource` 固定报告 `cloudflare-control`。

自动检查：启动后 60 秒一次；此后每 12 小时一次，每次抖动 ±30 分钟。仍保留手动检查。

## 3. 下载阶段与 GitHub 回退分类

下载前清空 `Update.headers`，因此控制请求的 Authorization、device/install ID 都不会进入镜像或 GitHub。

允许回退：

- Reqwest/Network 传输错误、DNS/TLS/连接超时。
- HTTP 429。
- HTTP 5xx。
- 没有可判定 HTTP status 的网络错误。

禁止回退：

- 控制面 204、401、403。
- 下载 401、403、404。
- metadata/兼容矩阵/allowlist 错误。
- Tauri Minisign 错误、SHA/大小错误、安装包格式错误。

回退只替换同一个 `Update` 的下载 URL，为固定 tag 的 `githubFallbackUrl`。两个来源均由 Tauri updater 验证同一 detached signature；下载后再核对 SHA-256 和大小。

当前 Tauri 2.10.1 没有本方案需要的真正断点续传。Cloudflare 下载失败后，GitHub 从 0 开始重下完整包；差分/续传不阻塞本次上线。

## 4. Pending 与 Windows 恢复

验证成功后只写本应用 runtime root 下的：

```text
desktop-updater-cache/pending.json
desktop-updater-cache/pending-update.exe   # Windows
desktop-updater-cache/pending-update.bin   # macOS/Linux
```

下次启动可恢复“立即重启/稍后”。清理只允许这个精确子目录，禁止通配删除 `%LOCALAPPDATA%`、Tauri 全局缓存或其他应用目录。若 pending 版本已等于当前版本，视为安装成功后的陈旧缓存并清理。

## 5. 安装前复核

用户选择安装时，客户端再次访问控制面：

- release 已 pause/revoke、设备被禁用、灰度不再命中或控制面不可达，均不安装。
- pending 文件 SHA/size 必须仍与记录一致。
- 只停止当前 Desktop 拥有的 managed Runtime/WS relay，再启动 detached updater。
- 其他同应用实例由安装期精确路径策略处理，不做进程名大范围终止。

Windows 不直接调用 `tauri-plugin-updater 2.10.1` 的 `Update.install`：该版本会忽略 `ShellExecuteW` 返回值并立即退出，测试机还证明 NSIS `/R` 在 Session 0/断开会话下不能作为可靠重启保证。客户端把当前已签名 EXE 复制成缓存目录内的 `updater-helper-<pid>.exe`；helper 在 Tauri/WebView2/单实例锁启动前分流，等待旧进程退出，执行已通过 Tauri detached signature 与 SHA/size 校验的 `pending-update.exe /P /UPDATE`，核对 NSIS 退出码后再拉起新 EXE。helper 与主程序文件名不同，因此不会被 NSIS 的旧应用进程检查误杀。

helper 日志只写阶段、退出码和重启 PID，不写 token、下载 URL 或用户数据。安装失败时它会尝试重新拉起仍存在的旧 EXE；不能把失败伪装成安装成功。

## 6. 进度与诊断

检查、下载和事件都携带：

- `manifestSource`
- `downloadSource`：`cloudflare-cache` 或 `github-release`
- `fallbackUsed`
- `releaseId/channel/version`

UI 在下载完成后明确显示实际来源；事件接口记录最小来源和错误分类，token 永不进入日志或配置文件。

## 7. 回滚策略

- **未安装**：pause/revoke/0% 立即阻止新设备安装。
- **已安装且能启动**：不自动降级；制作更高版本号的前向修复，从 prototype 重新灰度。
- **Runtime/UI**：继续使用本地 previous pointer，独立于 Desktop 壳版本。
- **壳完全无法启动**：提供上一稳定版人工恢复安装包和操作说明；这是灾难恢复，不是假装自动回滚。

不要把同一 SemVer 的 GitHub 资产覆盖成另一份字节，也不要把 beta D1 记录改名为 stable。签名、SHA 和客户端版本比较都要求版本化资产不可变。
