# 04. CI/CD、Nightly 与指定用户分发

## 1. 三条流水线

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/release-desktop.yml` | tag 或人工 dispatch | 四平台固定输入构建、签名、公证、GitHub Release、镜像核验、staging draft/0% 注册 |
| `.github/workflows/hot-update-nightly.yml` | 每日或人工 | Desktop/Core SHA 变化时构建 Windows nightly，prototype 100% 给 `primelab-win`，冒烟后暂停/0% |
| `.github/workflows/hot-update-control.yml` | 人工 dispatch + Environment 审批 | device create/disable、promote、set-percent、pause、revoke、status |

普通 PR/build job 没有 production D1 写权限。promotion 与构建分开，避免“编译成功”自动变成“用户可见”。

## 2. 正式候选流水线

1. 校验 tag 等于 `package.json` 版本，tag commit 等于 checkout SHA。
2. 固定 Runtime tag，从 manifest 取得 Core repo/SHA/version/revision；禁止 `latest`。
3. 校验 identifier、兼容矩阵、Runtime schema、版本同步和最小测试。
4. Windows、macOS arm64、macOS x64、Linux x64 分平台构建。
5. Windows 按 channel 强制 Authenticode；macOS codesign、notarize、staple 后重新生成 updater 包。
6. 对最终字节生成 Tauri detached signature。
7. 平台 job 只上传 Actions artifact；四平台全通过才汇总 `release-record.json` 和 `checksums.txt`。
8. 创建 GitHub draft Release，重新下载全部资产校验 SHA。
9. 发布时 prerelease 显式 `latest=false`；stable 只有在全部正式闸门通过后才设为 latest，并按独立流程同步 Landing。预发布永远不改 Landing。
10. GitHub 与 Cloudflare 各完整下载 updater，并验证 SHA、响应头和 Range 206。
11. 仅在 staging D1 注册 `draft, 0%`；后续必须走受保护控制工作流。

任一平台失败，Release 不发布、D1 不写。发布流水线没有 R2 同步、清理或 R2 secret。

## 3. `release-record.json`

它是 GitHub Release 与 D1 之间的机器可读交接单，包含：

- Desktop version/SHA、Core SHA、Runtime tag/version/revision。
- 每个平台 target/arch/bundle type。
- updater 文件和 `.sig` 文件名。
- 生成时间和 schema。

它不直接信任构建 job 填写的 SHA/size。D1 注册 CLI 会重新下载 GitHub 的真实字节并计算，防止 Actions artifact 与最终 Release 不一致。

## 4. 指定用户如何收到测试版

1. 管理工作流执行 `device-create`，生成随机 token，只把 SHA-256 写入 D1。
2. 工作流产生保存 1 天的一次性邀请 JSON。
3. 测试用户在高级设置导入；token 进入系统凭据库，配置文件只留下 endpoint/channel/device ID。
4. 客户端访问 `/v1/check/prototype/...` 或对应 ring。
5. D1 中 device 必须 active、ring 一致；release 必须 published 且设备落入灰度 bucket。

公开 GitHub prerelease 的安装包本身不保密。控制的是应用自动发现/下发资格，不是阻止知道 URL 的人手工下载。

## 5. Nightly

版本格式：`0.8.1-prototype.nightly.YYYYMMDD.N`。这里故意保留 `prototype` 作为第一个 prerelease identifier：专机当前承重基线是 `0.8.1-prototype.<数字>...`，按 SemVer 规则，第二段非数字 `nightly` 高于数字段，因此首个 Nightly 和后续日期/序号都能单调升级；最终无 prerelease 后缀的 `0.8.1` stable 仍高于全部内测版本。若专机以后安装了 `0.8.1` stable，必须先把 `NIGHTLY_BASE_VERSION` 提升到 `0.8.2`，禁止靠允许降级绕过。

- 先比较最近 nightly 的 `release-record.json`；Desktop/Core SHA 都没变则跳过。
- 只构建 Windows prototype，使用 staging Authenticode/Tauri 身份。
- 创建公开 prerelease，显式不设 latest，不写 Landing。
- 完整核验 GitHub/Cloudflare 后，D1 注册 draft 并临时 promote prototype 100%。
- `primelab-win` outbound-only runner 启动隔离 baseline，真实执行检查、签名下载、安装退出、重启、版本、Runtime `current.json` 和 Core 9120。
- runner 必须在已登录用户的 Session 1+ 中以非提升权限运行；Windows service/Session 0 无法可靠创建 WebView2，`RunLevel=Highest` 又会让 WebView2 忽略本地 CDP flags。工作流和启动脚本都对此 fail-fast。
- 无论 smoke 成败，最后 job 都把 release pause/0%。
- 只删除超过保留策略且未被 D1 引用的旧 nightly；默认最近 7 个成功或 14 天。

PR #592 的同 SHA Windows 三包工作流已由 `hot-update-staging` required reviewer 正常批准并全绿，证明 staging Tauri/Authenticode 身份、公开 prerelease、Cloudflare 镜像核验和 Actions artifact 聚合可用。完整 `hot-update-nightly.yml` 尚未在默认分支触发；Cloudflare token 也尚未通过 `hot-update-control.yml` 的 Actions D1 管理入口验权，因此不能把 PR 三包测试等同于定时 Nightly 已跑通。

## 6. 管理 CLI

```text
device create
device disable
release register-draft
release promote --percent 5
release set-percent --percent 25
release pause
release revoke
release status
```

实现：`scripts/hot-update-control.mjs`。production 操作除 GitHub Environment 审批外，还要求 `HERMES_ALLOW_PRODUCTION_HOT_UPDATE=1`。这是一道额外防误操作闸门，不是权限系统的替代品。

## 7. 外部配置清单

- GitHub Environments：`hot-update-staging`、未来的 `hot-update-production`。
- Staging secrets：Cloudflare token/account、Tauri staging private key、Windows staging PFX/password、`PRIMELAB_WIN_UPDATE_TOKEN`。
- Staging vars：D1 名、控制 endpoint、镜像 origin、baseline EXE、timestamp URL、Nightly Runtime tag。
- Production secrets 必须是另一套身份；Tauri 与 OS 代码签名不得与 D1 promotion 共用一个万能身份。

截至 2026-08-23，`hot-update-staging` 已配置上述 secret/variable，包括 `CLOUDFLARE_API_TOKEN`。PR 三包 workflow 已在该 Environment 中获得审批并创建 `[STAGING ONLY]` public prerelease，但没有调用 D1 管理 token；只有默认分支上的管理工作流读写成功才能证明该 token 权限。`hot-update-production` 尚未创建或部署，定时 Nightly 尚未触发。
