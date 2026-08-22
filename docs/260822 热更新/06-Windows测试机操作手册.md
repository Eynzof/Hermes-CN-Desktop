# 06. Windows 测试机操作手册

## 1. 机器与用途

- SSH 配置别名：`windows`
- Windows 设备名/ring 记录：`primelab-win` / `prototype`
- 用途：Windows 原生编译、NSIS 打包、基线安装、真实 UI 更新、重启和注册表/文件版本验收。
- 禁止用途：持久保存 Tauri 私钥、直接发布 stable、修改线上清单。

通过 SSH 启动 GUI 通常落不到当前交互桌面。需要视觉验收时，使用仅供测试的计划任务在已登录用户 session 中启动应用；测试后删除临时截图/UI Automation 任务。任何视觉测试开始前先告知用户。

## 2. 每次测试前检查

```powershell
node --version
pnpm --version
rustc --version
cargo --version
git rev-parse HEAD
git status --short
```

同时确认：

- Desktop/Core 都是明确 SHA，不使用漂移的 `latest`；
- `compatibility/desktop-core.json` 接受本次组合；
- 端口 9120 没有被非本次测试进程占用；
- 磁盘能容纳源码、Cargo target、两份安装包和 Runtime；
- 当前用户环境变量里只有 staging endpoint，绝没有 production token/私钥。

## 3. 大陆网络下的 NSIS 预热

首次 Windows 打包时，Tauri 会从 GitHub 获取 NSIS。原型中这一步超时，但 Rust/前端编译本身成功。官方 Tauri bundler 源码给出了下载地址、缓存目录和固定 SHA-1：[NSIS bundler 实现](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs)。

原型使用版本与校验：

| 文件 | 官方固定 SHA-1 | 目标 |
|---|---|---|
| `nsis-3.11.zip` | `ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d` | 解压到 `%LOCALAPPDATA%\tauri\NSIS` |
| `nsis_tauri_utils.dll` | `75197fee3c6a814fe035788d1c34ead39349b860` | `%LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode\additional\` |

建议由可稳定访问官方源的机器下载，核对官方哈希后传入构建机。不得从未知网盘拿同名文件，也不得为绕过网络问题关闭哈希校验。

## 4. 构建与签名职责分离

### Windows 构建机

1. 安装依赖并运行最小发布检查。
2. stage 指定 Core Runtime、Dashboard、skills 和 plugins。
3. 构建 NSIS 安装包。
4. 正式使用前先完成 Authenticode 签名和时间戳。
5. 计算最终安装包 SHA-256 和 size，传给隔离 Tauri 签名节点。

当前 `createUpdaterArtifacts=true` 会让 `tauri build` 尝试立即读取 Tauri 私钥。生产 CI 应提供一个**临时、未提交**的构建 override，让 Windows 只生成安装包；不要把 staging 私钥复制到 Windows 来迁就自动签名。原型已经确认 `TAURI_SIGNING_PRIVATE_KEY_PATH` 适用于 `tauri signer sign`，但自动 build 读取的是 `TAURI_SIGNING_PRIVATE_KEY`，空密码在 PowerShell 环境中还会消失并触发交互等待。

### 隔离 Tauri 签名节点

对 OS 签名后的最终安装包执行：

```bash
pnpm exec tauri signer sign \
  "/path/to/Hermes Agent CN Desktop_x64-setup.exe" \
  --private-key "/secure/path/updater.key" \
  --password ''
```

生成 `.sig` 后再次计算安装包和签名文件 SHA-256。签名后不得重新做 Authenticode、改资源、重压缩或覆盖同名文件。

## 5. 配置测试设备

在 Windows 用户级环境写 staging 配置；`<DEVICE_TOKEN>` 从安全渠道获取，不写进仓库、日志或截图：

```powershell
[Environment]::SetEnvironmentVariable(
  'HERMES_SHELL_UPDATE_ENDPOINT',
  'https://hot-update-staging.hermesagent.org.cn/v1/check/{{target}}/{{arch}}/{{current_version}}',
  'User'
)
[Environment]::SetEnvironmentVariable(
  'HERMES_SHELL_UPDATE_TOKEN',
  '<DEVICE_TOKEN>',
  'User'
)
```

重新启动应用进程后环境才生效。生产形态改用 Credential Manager/DPAPI，不长期保留环境变量明文。

## 6. 基线安装与端到端验收

### 基线

1. 静默/被动安装 `N` 版。
2. 查询卸载注册表中的 `DisplayVersion`。
3. 查询主 exe 的 `ProductVersion` 和 `FileVersion`。
4. 启动后确认 Desktop、Core、Runtime、revision 都是构建单声明的值。

注册表检查示例：

```powershell
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* |
  Where-Object DisplayName -eq 'Hermes Agent CN Desktop' |
  Select-Object DisplayName, DisplayVersion, InstallLocation
```

### 候选更新

1. D1 中候选保持 `draft, 0%`，先做 API/Range 冒烟。
2. 发布到 `prototype, 100%`。
3. 应用“设置 → 高级 → 内核”显示当前 Desktop/Core/Runtime。
4. 点击“检查更新”，确认候选版本、Core/Runtime 元数据和“兼容”状态。
5. 点击“一键更新”并确认；观察真实下载字节进度。
6. 确认旧进程退出、NSIS 接管、应用自动重启。
7. 再查 UI、注册表和 exe 版本都变为 `N+1`。
8. 确认 Runtime 没被意外降级；`current.json` 的版本、revision、commit、SHA 不变或符合构建单。
9. 再次检查更新应得到“已是最新”。

## 7. 止血演练

每个候选至少做一次：

1. 将 release 设为 `paused`、比例 0；
2. 让仍在基线版的设备检查，预期 `204`；
3. 用原 artifact URL 发起带 token 的 HEAD/Range，预期 `404`；
4. 已升级设备仍保持 `N+1`，不会降级；
5. 记录前向修复版本预案。

演练结束默认保持暂停，除非下一次测试有明确批准。

## 8. Windows 验收清单

- [ ] 安装包 SHA 与 R2 完整回读一致
- [ ] `.sig` 可被当前客户端内置公钥验证
- [ ] 无 token 为 401，错误 ring/paused artifact 不可下载
- [ ] Range 返回 206、正确 `Content-Range` 和长度
- [ ] 更新 UI 显示精确 Desktop/Core/Runtime 版本
- [ ] 下载进度不是模拟值
- [ ] 更新后注册表、ProductVersion、FileVersion 三者一致
- [ ] 端口 9120 的 Core 正常启动
- [ ] 用户配置、会话和 Runtime 没被清空/降级
- [ ] 暂停后基线设备拿不到候选
- [ ] 临时任务、临时私钥和截图自动化已清理

## 9. 原型后机器现状

截至 2026-08-22，`primelab-win` 安装的是 `0.8.1-hotupdate.1`，Core 为 `0.20.0`，Runtime 为 `0.20.0-cn.9` revision 9；staging release 已暂停。Windows 上没有遗留 Tauri 私钥。后续复测前先重新读取实际状态，不把本文记录当成永远不变的事实。
