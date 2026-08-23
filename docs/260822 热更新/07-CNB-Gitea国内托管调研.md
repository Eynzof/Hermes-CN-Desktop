# 07. CNB/Gitea 国内托管调研（已调研，现行方案未采用）

## 1. 最终结论

| 决策 | 结论 |
|---|---|
| Git 主仓 | 继续 GitHub |
| 长期制品源 | 只用 GitHub Release |
| 下载缓存 | Cloudflare Worker/Workers Caching |
| Windows runner | 先用 GitHub self-hosted `primelab-win` |
| CNB 制品/Release/构建节点 | 不进入本期实现或关键路径 |
| Gitea Release/Package/Actions | 不部署、不进入本期实现或关键路径 |

CNB/Gitea 能解决部分“代码托管和调度入口”问题，但不能消除 Tauri/Rust/npm、GitHub Release、签名时间戳、Apple/Windows 服务的跨境依赖，也不能自动提供本项目的设备 ring、灰度、暂停和兼容矩阵控制。

## 2. CNB 能力

官方 [构建节点文档](https://docs.cnb.cool/zh/build/build-node.html) 显示根组织可接入 Windows/macOS/Linux 自定义 runner，Windows stage 默认 PowerShell，内网机器需能出站访问 CNB；宿主机模式没有 Docker 隔离且不计平台核时。该能力适合国内 CI 备选，但会引入第二套工作流、runner 身份和镜像一致性治理。

官方 [迁移工具](https://docs.cnb.cool/zh/guide/migration-tools.html) 支持从 GitHub 等平台导入/同步代码；可以用于未来只读灾备镜像，但双向写会制造分支和 tag 的事实源冲突。

官方 [制品库列表](https://docs.cnb.cool/zh/artifact/intro.html) 主要是 Docker、Helm、Maven、npm、PyPI、Cargo、Conan 等包管理类型，并不是为 Tauri 多平台 updater/灰度控制专门设计。即使能用其他文件能力，也会成为第二个持久制品源，违背本期决策。

因此本期不创建 `.cnb.yml`、不注册 `primelab-win` 到 CNB、不上传安装包、不设置 CNB token。

## 3. Gitea 能力

Gitea 提供 Release 附件 API 和 [Generic Package Registry](https://docs.gitea.com/usage/packages/generic/)，可以保存普通二进制；同名版本文件不可覆盖的语义对不可变发布有帮助。

[Gitea Actions](https://docs.gitea.com/usage/actions/overview/) 需要独立 runner；[act_runner](https://docs.gitea.com/1.26/usage/actions/act-runner/) 支持 host/Docker/DinD，其中 Windows 原生打包通常要 host 模式，等于让任务直接使用机器权限。

若为热更新单独部署 Gitea，还需承担：VPS/数据库/磁盘或 S3、TLS、备份、升级、Runner、带宽、DDoS、监控和恢复演练。它把“用 Cloudflare 缓存 GitHub”变成长期自建运维，而且客户端下载仍需要自己的灰度控制面。

因此本期不部署 Gitea、不用其 Release/Package、不用 Gitea Actions。

## 4. 为什么不把它们当 GitHub 回退

- 用户已经确定客户端直接回退 GitHub；加入 CNB/Gitea 会形成第三来源。
- 多来源需要额外签名/SHA/保留/删除/可用性一致性治理。
- 控制面授权后回退固定 GitHub tag 已足够保持同一字节身份。
- CNB/Gitea 的公开可达性、带宽和免费政策也需要持续验证，不能天然当成大陆 CDN。

## 5. 未来何时重新评估

只有出现下列独立需求时再开新 RFC：

- 法务/合规要求代码必须在境内或自有网络留存。
- GitHub 长期不可用于工程协作，且只读镜像已经不能满足灾备。
- 公司已有受运维支持的 CNB/Gitea 平台和原生 Windows runner。
- 需要供应链依赖代理，而不是只解决 Desktop updater。

重新评估也应先做只读代码镜像，不得顺手把 Release 或 updater 的唯一事实源迁走。
