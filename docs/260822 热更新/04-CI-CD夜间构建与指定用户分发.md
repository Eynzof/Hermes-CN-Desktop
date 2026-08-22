# 04. CI/CD、夜间构建与指定用户分发

## 1. 当前状态和目标状态

### 当前

- 仓库已有 `.github/workflows/release-desktop.yml`，它用于 tag 对应的 GitHub Release，不能拿来做隐蔽内测。
- 2026-08-22 原型由人工在独立 worktree、`primelab-win`、隔离 Mac 签名环境和 Cloudflare staging 之间完成。
- 构建、签名、上传、草稿、发布和暂停都已真实跑通，但尚未形成一条无人值守 CI。

### 目标

建立独立的 `hot-update-staging` 流水线，只有手工触发和定时 nightly 两种入口；它不打公开 tag、不创建公开 Release、不更新 Landing。自动化止步于 `draft`，任何真实设备可见的 promotion 都必须人工批准。

## 2. 推荐流水线

| 阶段 | 执行位置 | 输入 | 必须产出/检查 |
|---|---|---|---|
| 1. Pin | CI 控制节点 | Desktop SHA、Core SHA/Runtime tag | 不可变构建单；禁止 `latest` 进入发布记录 |
| 2. Validate | Linux/macOS 通用节点 | 两仓源码 | lockfile、最小测试、`compatibility:check`、许可证和版本一致性 |
| 3. Stage Runtime | 各目标构建节点 | 已签 Runtime manifest | Core/Runtime 版本、schema、SHA、源提交均命中矩阵 |
| 4. Build | `primelab-win` 等原生节点 | 固定源码和缓存 | NSIS/DMG/AppImage 等原生包、构建日志、基础物料清单 |
| 5. OS sign | 受控平台签名节点 | 最终安装包 | Windows Authenticode/macOS codesign+notarize；nightly 可按策略跳过 Authenticode，但不得进入真实用户 ring |
| 6. Tauri sign | 隔离签名节点 | OS 签名后的最终字节 | `.sig`；签名后安装包不可再改一字节 |
| 7. Upload draft | CI 发布身份 | 包、签名、metadata | R2 不可变 key；完整回读 SHA/size 一致；D1 `draft, 0%` |
| 8. Smoke | 对应目标测试机 | draft 临时授权 | 安装、启动、Core 版本、更新检查、Range、坏令牌等测试 |
| 9. Promote | 人工审批 | smoke 证据 | `published`，先 1 台或确定性小 bucket，再 5/25/100% |
| 10. Observe | Worker/客户端观测 | 发布 ID | 检查、下载、签名、安装、启动成功率；异常自动建议暂停 |

签名顺序非常重要：Authenticode/codesign 会改变文件，必须先完成操作系统签名，再对最终文件生成 Tauri detached signature。

## 3. GitHub、CNB 和 Gitea 如何分工

推荐近期组合：

```text
GitHub（现有主仓/PR）
  ├─ push mirror → CNB（大陆拉取与 CI 调度备用）
  ├─ 常规单测 → GitHub Actions 或 CNB Linux 节点
  └─ staging build request
       ├─ CNB/GitHub self-hosted → primelab-win
       ├─ 隔离签名节点
       └─ Cloudflare R2/D1/Worker → 内测分发
```

- GitHub 继续作为当前开发事实源，避免一次改动同时迁移代码平台和发布系统。
- CNB 作为只读镜像、国内依赖入口与 `primelab-win` 调度面最有价值。
- Gitea 只在需要自建独立控制权、内网镜像或灾备时引入；不要为了热更新单独维护一套 Gitea。
- 无论代码在哪托管，Cloudflare staging 才是内测发布状态和客户端下载的事实源。

## 4. Nightly 设计

### 4.1 触发

- 每晚固定时间检查 Desktop/Core 指定分支是否有新 SHA；两者都没变则跳过。
- 也允许开发者手工指定 Desktop SHA、Core SHA/Runtime tag 和目标平台。
- Nightly 版本建议：`0.8.1-nightly.20260822.1`，每次构建不可覆盖。

### 4.2 Nightly 自动化边界

允许自动：测试、构建、Tauri staging 签名、上传 draft、在专用机器安装冒烟、生成报告。

禁止自动：推送到真实用户 ring、更新公开 stable、创建正式 tag/Release、使用 production 签名身份、修改 Landing。

### 4.3 保留策略

- 失败构建：保留日志 14 天，二进制可在 3 天后删除。
- 成功 nightly：保留最近 7 个或 14 天，取较小者。
- 被 promotion 的版本：保留当前、上一版和一个已知良好版，直到支持周期结束。
- 每次清理先确认 D1 没有 published 记录引用对应 R2 key。

## 5. 只给指定用户分发

### 5.1 设备注册

每台设备生成随机高熵 token；控制面只保存 `sha256(token)`：

```text
device_id = primelab-win
ring      = prototype
status    = active
token     = 只保存在设备凭据存储中
```

生产客户端应把 token 存 Windows Credential Manager/DPAPI 或 macOS Keychain。当前原型从 `HERMES_SHELL_UPDATE_TOKEN` 读取，便于测试，但不应作为大规模最终形态。

### 5.2 Ring

| Ring | 人群 | 发布规则 |
|---|---|---|
| `prototype` | 开发者专用测试机 | Nightly 可自动安装，不能外发 |
| `canary` | 1–5 名明确知情的内部用户 | 人工批准，先确定性小流量 |
| `beta` | 邀请制内测用户 | canary 稳定观察后分批 5/25/100% |
| `stable` | 正式用户 | 只接受完整发版预检后的正式版本 |

设备只能看到与自身 ring 相同的 release。百分比由 `hash(device_id + release_id) % 100` 决定，同一发布内结果稳定，不会每次检查随机跳动。

### 5.3 撤销用户

- 单台机器：将 device `status` 改为 `disabled`，后续检查和下载都返回 401/404。
- 一组用户：暂停该 ring 的 release 或将比例设为 0。
- token 泄露：禁用旧设备记录，生成新 token；不复用旧值。

## 6. Promotion 与回滚操作

建议将控制动作封装成五个受审计命令：

```text
release create-draft
release verify-artifact
release promote --percent 5
release set-percent --percent 25
release pause
```

每个命令都记录：操作者、审批号、release ID、旧状态、新状态、SHA-256 和时间。生产中禁止直接让 CI 拿 D1 管理员权限执行任意 SQL。

灰度节奏建议：

1. prototype 100%，只在专用测试机；
2. canary 1 台，观察至少一个完整工作日；
3. canary 100%；
4. beta 5% → 25% → 100%，每档以成功率和核心功能 smoke 为门槛；
5. stable 必须重新走正式发版闸门，不从 beta 直接“改个 ring”冒充正式版。

## 7. 大陆构建节点的网络准备

自托管 Windows 节点不能假定 GitHub、Rust、npm、Tauri 辅助工具永远可达。上线 CI 前应预热并监控：

- Git 仓库镜像和固定 Core Runtime 产物；
- pnpm store、Cargo registry/git cache、Rust toolchain；
- Tauri/WiX/NSIS 等打包辅助文件；
- 证书时间戳服务和 Cloudflare staging 域名；
- 失败时的离线缓存校验值和恢复手册。

缓存必须以官方哈希或固定版本校验，不能因为大陆网络困难就跳过完整性检查。

## 8. 最小 CI 准入条件

任何候选包进入 `draft` 前至少满足：

```text
pnpm typecheck
pnpm 针对热更新相关的单元测试
cargo check
cargo 针对 compatibility/app_update/runtime downgrade 的测试
Worker 单元测试
目标平台原生构建
安装包 SHA-256 + Tauri signature
Runtime manifest 与 compatibility matrix 检查
```

全量单元/E2E 可以在合并前主流水线继续执行；热更新 staging 构建不应因为追求速度而跳过上述发布安全门。
