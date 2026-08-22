# 07. CNB、Gitea 国内托管调研

## 1. 结论

推荐顺序：

1. **Cloudflare Worker + D1 + R2** 继续作为更新控制面和分发事实源。
2. **CNB** 作为 GitHub 的国内镜像、国内 CI 调度和 `primelab-win` 自托管构建节点入口。
3. **Gitea** 仅在需要内网部署、完全自主管理或平台灾备时采用，不作为当前首选更新 CDN。

不要在下一版同时完成“主代码平台迁移 + CI 迁移 + 正式热更新上线”。先镜像、再跑双流水线对照，稳定后才决定是否改变主事实源。

## 2. 能力与成本对比

| 维度 | CNB SaaS | 自建 Gitea | Cloudflare |
|---|---|---|---|
| Git 在大陆可达性 | 通常较好，需按实际运营商测试 | 取决于自建机房/云区域 | 不是代码托管 |
| Windows 自托管构建 | 官方 Build Node 支持 Windows/PowerShell；账户能力需确认 | Gitea Actions runner 可 host 模式执行 | 不承担桌面原生构建 |
| CI 运维 | 平台托管，较低 | Gitea、数据库、Runner、升级和备份全自管 | Worker 部署较低 |
| 通用更新分发 | 有制品/对象存储能力，但不是本项目现成的设备灰度 API | Release/Generic Package 可存文件；出口由自建承担 | R2 + Worker 最符合鉴权、灰度、Range |
| 免费/基础成本 | Git 100 GiB、对象存储 100 GiB、构建 160 核时/月免费（当前官方价格页） | 软件开源，主机、DB、磁盘、对象存储、流量和人力不免费 | 小规模可落在 Workers/D1/R2 免费层 |
| ring/设备授权/暂停 | 需要自己实现 | 需要自己实现 | 原型已实现 |
| 供应商锁定 | 中等 | 低，但运维锁定高 | 控制面 API 可迁移，R2/S3 语义较通用 |

## 3. CNB 调研

### 3.1 官方能力

- [价格说明](https://docs.cnb.cool/zh/saas/pricing.html)：当前免费额度包括 100 GiB Git 存储、100 GiB 对象存储和每月 160 核时构建 CPU；超出部分当前标价为 Git/对象存储 1 元/GiB/月、构建 CPU 0.125 元/核时。
- [云原生构建简介](https://docs.cnb.cool/zh/build/intro.html)和[快速开始](https://docs.cnb.cool/zh/build/quick-start.html)：仓库内流水线配置、按事件运行。
- [构建节点](https://docs.cnb.cool/zh/build/build-node.html)：根组织管理员可以接入 Linux、macOS、Windows 自定义节点；Windows stage 脚本使用 PowerShell；节点需要访问 CNB 完成注册、心跳、任务和日志；任务直接在宿主机运行，自定义节点不计平台构建核时。若控制台没有 Build Nodes 菜单，应向 CNB 确认当前租户能力。
- [流水线缓存](https://docs.cnb.cool/zh/build/pipeline-cache.html)：可用于依赖缓存，但 Windows 打包所需的 Tauri/NSIS 离线预热仍需自己管理。
- [制品库](https://docs.cnb.cool/zh/artifact/intro.html)：主要面向各类软件包仓库；不能直接等同于带设备鉴权、灰度和随时暂停的桌面 updater CDN。

### 3.2 最适合本项目的用法

1. GitHub 到 CNB 做单向受控镜像；镜像记录源 SHA，禁止两边同时接受无规则写入。
2. 在 CNB 注册 `primelab-win`，只赋予 `windows-x64-hot-update` 标签和指定仓库权限。
3. CNB 负责拉取大陆更稳定的代码镜像、调度 PowerShell 构建、生成安装包。
4. 安装包不直接“发布给用户”，而是用最小权限 Cloudflare token 上传到 R2 draft key。
5. 隔离签名节点生成 Tauri `.sig`，D1 写 draft；测试通过后由独立 promotion 身份发布。

### 3.3 需要实测的风险

- CNB SaaS 账户是否实际开放 Windows Build Node 管理；官方不同页面对 namespace/企业能力的表述可能随版本变化。
- 构建节点到 CNB、Cloudflare 自定义域名、Rust/npm 依赖源和证书时间戳服务的连续可达性。
- 对象存储免费额度不等于下载带宽、CDN、Range、访问控制和 SLA 全部免费；价格页未明确承诺的项目一律不推定。
- 自托管节点直接执行仓库脚本，等价于给流水线较高主机权限；必须专机、最小仓库授权、无日常用户数据。

## 4. Gitea 调研

### 4.1 官方能力

- [Gitea Actions 快速开始](https://docs.gitea.com/1.26/usage/actions/quickstart)：Actions 需要独立 runner，官方建议 runner 与 Gitea 实例分开。
- [Gitea Runner](https://docs.gitea.com/runner/) / [act runner](https://docs.gitea.com/1.26/usage/actions/act-runner/)：支持 host、Docker 和 DinD 模式；host 模式可直接在原生机器执行，但没有容器隔离。
- [Package Registry](https://docs.gitea.com/usage/packages/overview/)：包含 Generic Package，私有包通过 PAT 控制读写。
- [Release attachment API](https://docs.gitea.com/api/operations/repo-get-release-attachment/)：Release 资产可以通过 API 和凭据读取。
- [配置说明](https://docs.gitea.com/1.24/administration/config-cheat-sheet/)：attachments、packages、actions log/artifact 等可放本地、S3 兼容 MinIO 或 Azure Blob；S3 可用签名 URL 直接服务。

### 4.2 能做什么

- 在大陆云主机或内网部署一个独立 Git 事实源/镜像。
- 用 Gitea Actions 调度原生 Windows runner。
- 通过 Release asset 或 Generic Package 保存构建物。
- 使用 S3 兼容对象存储减少 Gitea 本机磁盘压力。

### 4.3 为什么不作为当前首选

“Gitea 软件免费”不等于系统免费。至少要承担：

- 云主机或物理机；
- PostgreSQL/MySQL、对象存储和备份；
- 域名/TLS、WAF、监控、升级、安全响应；
- 安装包的公网出口流量或国内 CDN；
- Actions runner 的隔离和清理；
- 自己开发 device/ring/rollout/pause/audit 控制面。

如果只为热更新而搭 Gitea，会把一个简单的 serverless 分发问题变成长期运维项目。只有在公司已经有可靠 Gitea 运维能力、需要内网代码主权或必须脱离 SaaS 时才值得。

## 5. 推荐落地路线

### 阶段 A：镜像验证，不迁移主仓

- CNB 建只读镜像，验证提交 SHA 与 GitHub 一致。
- `primelab-win` 注册为专用 Build Node；只运行无签名 nightly。
- 将构建包上传 Cloudflare draft，比较与人工 SSH 构建的 SHA/行为。
- 连续运行两周，统计排队、失败原因、缓存命中和网络耗时。

### 阶段 B：CNB 承担 staging 编排

- PR/合并仍在当前主仓完成。
- CNB 根据镜像 SHA 调度 Windows 构建；签名与 promotion 仍独立。
- GitHub Actions 保留同一套最小验证，避免镜像或平台差异静默改变产物。

### 阶段 C：决定是否需要 Gitea

只有出现以下任一条件再 PoC Gitea：代码必须落在自有网络、CNB/GitHub 均不能满足可用性/合规、公司已有成熟 Gitea 平台，或需要离线灾备恢复。PoC 先做镜像和 runner，不立即承载正式下载。

## 6. 依赖下载比 Git 平台更容易被忽略

即使仓库迁到国内，Windows 构建仍可能访问 npm、Cargo、rustup、GitHub Release、NSIS、Apple/Windows 时间戳和 Core Runtime。完整方案必须建立：

- 版本固定和 lockfile；
- 受控 pnpm/Cargo 缓存；
- Tauri 打包工具离线缓存及官方校验值；
- Core Runtime 国内镜像，且签名载荷中的最终 URL 在签名前确定；
- 缓存失效演练，确保无法联网时是明确失败，而不是使用未验证文件。

CNB/Gitea 解决的是代码与调度入口，不会自动解决整个软件供应链的大陆网络问题。

## 7. 最终选型

| 决策 | 结果 |
|---|---|
| 是否现在迁离 GitHub | 否 |
| 是否接入 CNB | 是，先镜像 + Windows Build Node PoC |
| CNB 是否直接给客户端下包 | 否，先上传 Cloudflare R2 |
| 是否现在部署 Gitea | 否，保留为自建/灾备方案 |
| 更新发布事实源 | Cloudflare staging D1 + R2 |
| 公开 stable | 仍走仓库正式发版预检和 Landing 规则 |
