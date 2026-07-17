# Portable（免安装）模式

桌面端在安装版（NSIS / DMG）之外额外提供免安装 zip：解压即用，全部数据收敛在解压目录，
不写注册表、不留 AppData / `~/Library`（macOS 的 WKWebView 存储除外，见「已知限制」）。
安装版流程完全不受影响——portable 只是同一构建产物的另一种打包与数据锚定方式。

## 工作原理

### marker 文件

zip 内预置 `portable.marker`（Windows 在 exe 同级；macOS 在 `.app` 同级——marker 不能放进
`.app`，会破坏代码签名）。应用启动时探测一次（`src/process/runtime.rs` 的
`PORTABLE_ANCHOR`）：marker 存在 → 整棵数据树锚定到 `<解压目录>/data`。
只判存在性，不读内容；增删 marker 需重启应用后生效。

### 数据根优先级

`runtime_root()` 的决策顺序（`src/process/runtime.rs::decide_non_override_root`）：

1. `HERMES_DESKTOP_RUNTIME_ROOT` 环境变量（逃生舱，始终最高）
2. **portable marker**（全平台、含 debug 构建；且**无视** legacy AppData 旧数据——
   portable 副本绝不触碰安装版的数据）
3. Windows release 全新安装的 `<安装目录>\data` 锚定（原有行为）
4. legacy AppData（`dirs::data_dir()/cn.org.hermesagent.desktop/<runtime|dev-runtime>`）

marker 存在但 `data/` 不可写（如只读介质）时记录 warning 并回退到常规策略。

### `data/` 里有什么

`versions/`（CN-Core 冻结 runtime，自带 Python）、`downloads/`、`gateway-runtime/`、
`hermes-home/`（会话、`config.yaml`、`.env` 凭据、memory、cron、日志、skills、plugins、
`cache/`——含 `HERMES_DESKTOP_MANAGED=1` 重定向进来的 HF/torch/playwright/临时目录等
第三方缓存）、`current.json`、`connection.json`、`desktop-owner.json`；Windows 还包括
`webview2/`（WebView2 用户数据，`main.rs` 通过 `WEBVIEW2_USER_DATA_FOLDER` 重定向）。

内核（CN-Core）的检查更新 / 安装 / 回滚本来就在 `runtime_root` 内原地进行，portable 下
照常工作。桌面外壳自更新维持「仅提示」：portable 用户下载新 zip 覆盖解压（`data/` 保留
即无损升级）；更新弹窗与设置页会根据 `RuntimeConfig.portable` 显示对应引导。

## 打包

```bash
# 先完成对应平台的 bundled 构建（与安装版共用产物），再：
pnpm portable:package-windows        # target/portable/*.zip（在 Windows 上运行）
pnpm portable:package-macos-arm64    # ditto 保签名打 zip
pnpm portable:package-macos-intel
```

- Windows：`scripts/package-portable-windows.mjs` 直接从 `target/<triple>/release/`
  收集 exe + Tauri resources（Windows 上 `resource_dir()` 即 exe 目录，cargo target 目录
  的布局与 NSIS 安装目录一致），附上 marker / README / `data/` 占位后压 zip。
- macOS：`scripts/package-portable-macos.mjs` 用 `ditto` 拷贝 `.app`（保 symlink 与签名），
  同级放 marker / README 后 `ditto -c -k` 压 zip。
- CI：`release-desktop.yml` 在安装包上传后追加 portable zip（macOS 先对公证过的 `.app`
  执行 `stapler staple`，让 portable 副本离线可验）。

## 已知限制

- **macOS WKWebView 存储**：cookie / localStorage / 网页缓存由系统管理，仍写
  `~/Library/WebKit` 等（应用主数据不受影响、全部在 `data/`）。WKWebView 无重定向机制。
- **macOS App Translocation**：从下载目录直接双击 quarantined `.app` 时，系统会把它搬到
  随机临时路径运行，marker 不可见 → 静默退化为普通模式。应用检测到 Translocation 路径时
  会弹提示；用户把解压文件夹移动一次或 `xattr -dr com.apple.quarantine <目录>` 即可解除。
- **多开**：每个解压目录数据独立。同时启动多个实例（或与安装版同开）时，后启动的实例走
  既有端口回退逻辑（9120 起最多 +20）；`desktop-owner.json` 与 HERMES_HOME 匹配校验保证
  互不接管。
- **误删 marker**：Windows 上全新目录仍会落到 `<exe 目录>\data`（与原 fresh-install 锚定
  同构，近乎无感）；macOS 上会退化到 `~/Library`——README 已提示勿删。

## 发版牵连（后续工作，不随本仓库 CI 自动完成）

官网清单 `https://desktop.hermesagent.org.cn/latest.json`（landing 仓库
`Eynzof/hermes-agent-cn-desktop-landing`）需为 portable zip 追加资产条目后，桌面端更新
提示才能引导 portable 用户到对应下载；Rust 端 `DesktopUpdateAsset.assets` 是
`BTreeMap<String, _>`，新增 key 无需桌面端改动。
