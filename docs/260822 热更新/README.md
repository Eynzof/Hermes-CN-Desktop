# Hermes CN Desktop 热更新实施文档

> 最终决策：GitHub Release 是唯一长期制品源；Cloudflare 只做设备/灰度控制和边缘缓存；缓存下载失败时，客户端回退同一个 GitHub Release 的版本化资产。现行方案不使用 R2、CNB/Gitea Release、CNB 构建节点或自建 VPS。

## 当前状态（2026-08-23）

| 状态 | 内容 |
|---|---|
| 已在独立分支实现 | Tauri 检查/下载/安装三阶段、Cloudflare→GitHub 受限回退、系统凭据、pending 恢复、兼容矩阵、控制 Worker、D1 追加迁移、无存储下载 Worker、管理 CLI、正式/Nightly/审批工作流 |
| 已做代码/staging 验证 | Rust/Web 针对性测试、两个 Worker 与管理 CLI 单测、工作流静态检查；两个 staging Worker 和 D1 迁移已部署，真实 GitHub 资产的 Range 已验证 MISS→HIT |
| 已准备测试基础设施 | `primelab-win` 交互式 self-hosted runner 在线；staging Tauri/专机 token/自签名 PFX/Runtime 固定输入已进入受保护 Environment，没有触发工作流 |
| 历史原型已验证 | 2026-08-22 曾用隔离 R2 staging 在 `primelab-win` 跑通 `.0 → .1`；这只是历史证据，已被本方案取代 |
| 尚未完成 | 新 GitHub→Cloudflare 方案的公开 prerelease 真实安装；Cloudflare CI token；公开可信 Windows Authenticode；macOS 双架构签名/公证；多运营商抽样 |
| 明确未操作 | 线上 Release、公开 stable、Landing、官网 `latest.json`、production Worker/D1、现有用户安装 |

“代码已实现”不等于“已上线”。没有单独发布授权前，本目录中的任何命令都不得创建公开 Release、修改 Landing 或推进 production。

## 最终数据路径

```text
GitHub Release（唯一持久化制品源）
        │
        ├── Cloudflare 下载 Worker / Workers Caching（主下载）
        │
客户端 ←┤
        └── 同一 tag 的 GitHub 资产直链（仅网络类失败后回退）

客户端 → Cloudflare 控制 Worker → D1（设备、ring、灰度、暂停、撤销、版本决策）
```

版本发现始终经过 Cloudflare/D1。控制面不可达时客户端保持当前版本，不能用 GitHub `latest` 绕过灰度。

## 文档索引

1. [通俗说明与当前卡点](./01-通俗说明与当前卡点.md)
2. [目标架构与版本兼容矩阵](./02-目标架构与版本兼容矩阵.md)
3. [Cloudflare 控制面、缓存、成本与大陆网络](./03-Cloudflare控制面与成本.md)
4. [CI/CD、Nightly 与指定用户分发](./04-CI-CD夜间构建与指定用户分发.md)
5. [Tauri 客户端状态机、回退与回滚](./05-Tauri客户端状态机与回滚.md)
6. [primelab-win 操作手册](./06-Windows测试机操作手册.md)
7. [CNB/Gitea 国内托管调研（未采用）](./07-CNB-Gitea国内托管调研.md)
8. [安全、密钥与权限](./08-安全密钥与权限.md)
9. [灰度、上线闸门与验收](./09-上线分阶段计划与验收.md)
10. [原型与本分支实测记录](./10-原型实测记录.md)
11. [微软商店边界](./11-微软商店上架与热更新.md)
12. [Hermes Studio 对照与复用结论](./12-Hermes-Studio对照与复用结论.md)
13. [Landing 后续交接清单](./13-Landing交接清单.md)

## 代码事实源

- Desktop↔Core：`compatibility/desktop-core.json`
- 客户端：`src/commands/app_update.rs`、`src/update_config.rs`
- 控制面：`infra/hot-update-staging/`
- 下载镜像：`infra/release-mirror/`
- 管理面：`scripts/hot-update-control.mjs`
- 正式构建：`.github/workflows/release-desktop.yml`
- Nightly：`.github/workflows/hot-update-nightly.yml`
- 人工控制：`.github/workflows/hot-update-control.yml`

本文档解释设计和操作边界；如果文档与上述机器可读配置冲突，以代码和兼容矩阵为准，并修正文档。
