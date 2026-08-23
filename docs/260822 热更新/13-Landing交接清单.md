# 13. Landing 后续交接清单

## 1. 当前边界

本独立分支不修改 `Eynzof/hermes-agent-cn-desktop-landing`。prototype/canary/beta/nightly 禁止更新官网版本、公开 `latest.json` 或把预发布显示成稳定版。

当前仓库的 `infra/release-mirror/` 是下载 Worker 的事实实现；在获得 stable 发布授权后，再由人把所需 Worker/说明同步到 Landing 仓库并走其独立审核。

## 2. Stable 授权后的交接

- [ ] stable GitHub Release 四平台资产、签名、checksums、release-record 都已发布并回读通过。
- [ ] production control/mirror Worker 与 staging 分离，域名和 D1 为 production。
- [ ] production release 先注册 draft/0%，完成 production canary。
- [ ] Landing 版本号、下载链接和 `latest.json` 只指向正式 stable。
- [ ] Landing 文档说明 GitHub是唯一制品源、Cloudflare是缓存；删除任何 R2/CNB/Gitea Release 当前实现描述。
- [ ] 官网下载页可提供 Cloudflare主链接和固定 tag GitHub人工备用链接，但应用自动发现仍只走 control Worker。
- [ ] 对官网、`latest.json`、Cloudflare镜像、GitHub资产做 SHA/版本一致性核对。

## 3. 失败处理

如果 stable Release 资产或 production Worker 未就绪，Landing 同步就是阻塞，不能先改官网“等资产稍后补”。若发现异常，先 pause D1；Landing 已公开版本需要单独决定是否撤下下载入口，但不覆盖同 tag 资产。

## 4. 迁移旧说明

Landing 中若仍有 release mirror/R2 文档，只在正式交接时修改：

- R2 改为“历史原型，已退役/待删除”。
- mirror 路由改为 `/{tag}/{asset}` → 固定 GitHub Release。
- `latest` 只保留人工下载短缓存语义，不用于 updater。
- 明确 Cloudflare 缓存是 best-effort，冷节点会访问 GitHub。

本文件是交接清单，不是修改 Landing 或发 stable 的授权。
