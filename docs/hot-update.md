# Hermes-CN Desktop 热更新

完整方案、成本、国内网络、CNB/Gitea 调研、CI/CD、Windows 手册和原型证据统一维护在：

> **[`docs/260822 热更新/README.md`](./260822%20热更新/README.md)**

本文只保留代码入口和最重要的约束，避免与详细方案形成两个事实源。

## 当前结论

- Windows Tauri 壳更新原型已经在独立 staging 端到端跑通。
- 内测控制面使用 Cloudflare Worker + D1 + R2，不需要传统常驻更新服务器。
- Desktop、Core、Runtime 使用独立版本线；兼容关系以 [`../compatibility/desktop-core.json`](../compatibility/desktop-core.json) 为唯一事实源。
- Desktop `0.8.x` 当前兼容 Core/Runtime `0.20.x`，不要求三者 SemVer 相同。
- 内测候选只对登记设备/ring 可见，可按百分比灰度并立即暂停。
- 当前 staging 候选已暂停；没有修改公开 stable、Landing、GitHub Release 或线上更新清单。

## 三条更新轨道

| 轨道 | 更新对象 | 代码入口 | 版本/签名边界 |
|---|---|---|---|
| Desktop 壳 | Tauri 完整安装包 | `src/commands/app_update.rs` | Tauri updater signature + Desktop↔Core 矩阵 |
| Managed Runtime | Hermes-CN-Core Runtime | `src/process/runtime.rs`、`src/commands/runtime_manager.rs` | Runtime manifest signature + SHA-256 + revision + 矩阵 |
| UI | `web/dist` | `src/process/ui_update.rs`、`src/commands/ui_update.rs` | UI manifest signature + `appVersionFloor` + 本地回退 |

“一键更新 Desktop”不会在安装器启动前先改当前 Core；目标安装包声明的 Core/Runtime 元数据必须命中兼容矩阵。已安装且更高、兼容的 managed Runtime 不会被内嵌旧 Runtime 静默覆盖。

## Desktop 壳更新配置

内测端点必须是 HTTPS，默认为空，避免开发/原型构建误连公开更新源：

```text
HERMES_SHELL_UPDATE_ENDPOINT=https://hot-update-staging.hermesagent.org.cn/v1/check/{{target}}/{{arch}}/{{current_version}}
HERMES_SHELL_UPDATE_TOKEN=<per-device token>
```

也可以把端点写入 schema 2 的 `update-config.json.shellUpdaterEndpoint`；设备 token 不写入配置文件，只从环境变量读取，生产形态应迁移到系统凭据存储。

Worker 响应在标准 Tauri 字段外必须包含：

```jsonc
{
  "metadata": {
    "releaseId": "...",
    "channel": "prototype",
    "bundledCoreVersion": "0.20.0",
    "bundledRuntimeVersion": "0.20.0-cn.9",
    "runtimeRevision": 9
  }
}
```

## 本地/CI 兼容检查

```bash
pnpm compatibility:check
node scripts/check-desktop-core-compatibility.mjs --core ../Hermes-CN-Core
node scripts/check-desktop-core-compatibility.mjs --runtime-manifest /path/to/runtime-manifest.json
```

`pnpm typecheck` 已包含基础兼容矩阵检查。

## Cloudflare staging 代码

```text
infra/hot-update-staging/
├── migrations/0001_initial.sql
├── src/index.js
├── test/index.test.js
└── wrangler.jsonc
```

公开路由只有健康检查和已鉴权的客户端读取路径。生产管理面、审计、密钥隔离和 CI promotion 尚需按[上线计划](./260822%20热更新/09-上线分阶段计划与验收.md)补齐。

## 发布和回滚原则

1. 构建并签名最终字节；上传 R2 后完整回读 SHA。
2. 先写 `draft, 0%`，目标平台冒烟通过后才人工 promotion。
3. `prototype → canary → beta → stable` 分 ring；每档按 0/5/25/100% 扩大。
4. 事故时立即 `paused + 0%`，阻断新清单和下载。
5. 已升级 Desktop 不自动降级；用更高版本号前向修复。Runtime/UI 的本地回退独立处理。
6. RC/beta/alpha/canary 禁止更新 Landing 或公开 `latest.json`。
7. 正式 stable 必须先执行仓库 `desktop-release-preflight`，资产齐备后再同步 Landing。

## 进一步阅读

- [通俗说明与当前卡点](./260822%20热更新/01-通俗说明与当前卡点.md)
- [目标架构与兼容矩阵](./260822%20热更新/02-目标架构与版本兼容矩阵.md)
- [Cloudflare 成本与大陆网络](./260822%20热更新/03-Cloudflare控制面与成本.md)
- [CI/CD 与指定用户分发](./260822%20热更新/04-CI-CD夜间构建与指定用户分发.md)
- [CNB/Gitea 调研](./260822%20热更新/07-CNB-Gitea国内托管调研.md)
- [原型实测记录](./260822%20热更新/10-原型实测记录.md)
