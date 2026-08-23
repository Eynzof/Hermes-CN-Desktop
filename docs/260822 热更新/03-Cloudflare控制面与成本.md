# 03. Cloudflare 控制面、缓存、成本与大陆网络

## 1. 组件职责

| 组件 | 职责 | 不承担 |
|---|---|---|
| 控制 Worker | 鉴权、ring、灰度、204、清单和最小事件接收 | 安装包代理、后台 UI、签名 |
| D1 | devices、releases、release_events、client_update_events | 二进制、密钥明文 |
| 下载 Worker | 固定 GitHub Release 路径代理、响应头规范、480 MiB 闸门 | 版本发现、鉴权、开放代理 |
| Workers Caching | 完整对象边缘缓存、Range 切片 | 持久制品存储、可用性承诺 |

代码分别位于 `infra/hot-update-staging/` 和 `infra/release-mirror/`。当前 staging 配置使用两个不同自定义域名，避免控制响应被缓存，也避免把设备 token 送入下载域名。

## 2. D1 模型

`0002_github_origin.sql` 是追加迁移，不重写历史库：

- `releases` 新增 `github_release_tag`、`github_asset_url`、`mirror_url`、Desktop/Core SHA 和 Runtime tag。
- 旧 `artifact_key` 只为兼容旧 schema 保留，管理 CLI 写成 `tag/file`，任何运行时代码都不把它当对象存储 key。
- `release_events` 记录 register-draft、promote、set-percent、pause、revoke 的操作者、workflow URL、前后状态和时间。
- `client_update_events` 只保存 identity hash、最小版本/来源/错误分类，不保存 token、IP 或机器名自由文本。

发布记录必须由 `scripts/hot-update-control.mjs release register-draft` 从真实 GitHub Release 下载 `release-record.json`、updater 和 `.sig` 后生成。命令会重新计算 SHA/大小，人工不能填这些字段。

## 3. 缓存和 Range 的正确做法

版本化路径缓存 30 天并带 `immutable`；`/latest/{asset}` 仅供人工下载别名，最多 5 分钟，自动更新永远不用它。

下载 Worker 开启 Wrangler `cache.enabled`。按 Cloudflare 的 [Workers Caching 配置与 Range 说明](https://developers.cloudflare.com/workers/cache/configuration/)，客户端发 Range 时平台先去掉 Range，让 Worker 返回完整 `200` 并缓存完整对象，再由边缘切成 `206`。Worker 自己不能向 GitHub 请求/返回部分对象，否则 `206` 不会进入 Workers Cache。

Worker 内部使用 `fetch()` 访问 GitHub，因此可参与 Cloudflare Cache/Tiered Cache；不使用 POP-local 的 Cache API。Cloudflare 官方说明了两者差异：[Workers 与 Cache 的交互](https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/)。

响应要求：

- `X-Mirror-Upstream: github`
- `Accept-Ranges: bytes`
- CORS 和 expose headers
- 删除 `Set-Cookie`
- 不转发 Authorization、Cookie、Range 和条件请求到 GitHub
- 固定仓库、合法 SemVer tag、单层安全资产名

## 4. 成本估算

按当前官方额度，小规模内测预期现金成本为 0：

- [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)：100,000 请求/日；缓存 HIT 仍算请求但不执行 Worker CPU。
- [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)：Free/Pro/Business 单缓存对象上限 512 MB；响应体本身无强制上限。
- 本项目给 updater 设置 480 MiB 闸门，为 512 MB 留出余量；当前约 185 MB。
- [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)：Free 每日 500 万 rows read、10 万 rows written，总存储 5 GB。
- Workers Paid 当前最低 5 美元/月；只有日请求、CPU 或 D1 免费额度接近上限时再升级。

GitHub 承担真实源站字节，Cloudflare 账户没有对象存储费用。缓存冷节点和失效后仍会回源 GitHub，因此“现金成本 0”不是“源站流量/网络风险为 0”。

建议告警：Workers 日请求 70%、D1 rows read/write 70%、429/5xx > 2%、fallback > 5%、签名失败 > 0。

## 5. 中国大陆网络现实

普通 Cloudflare 全球网络不是 Cloudflare China Network，也没有大陆 SLA。实际路径有三种：

| 场景 | 客户端行为 | 结果 |
|---|---|---|
| 控制 Worker 不可达 | 不去 GitHub发现版本 | 保持当前版本，稍后重试 |
| 控制成功，Cloudflare 下载超时/429/5xx | 使用清单中固定 tag 的 GitHub URL重下完整包 | 可能成功，也可能同样受限 |
| 控制成功，但 401/403/404、签名/SHA/格式错误 | 不回退 | 立即报错并暂停候选 |
| 两个下载源都不可达 | 保留当前版本和已缓存 pending（若有） | 人工下载/网络切换 |

GitHub 回退是必要安全网，但不是大陆加速方案。每个候选都要在电信、联通、移动和企业/校园网络采集 DNS、TLS、TTFB、完整下载、`CF-Cache-Status`、Range 和 fallback 结果。

若规模扩大后大陆成功率仍不合格，应单独做合规/商务决策（ICP、Cloudflare China Network 或新的大陆 CDN）。这属于未来架构变更，不能在本期悄悄引入另一套制品事实源。

## 6. R2 迁移边界

旧 staging R2 只属于 2026-08-22 历史原型。迁移规则是：停止写入、从新 Worker 解绑，但不在切换当天删除；GitHub→Cloudflare 链路连续通过两次候选并观察 14 天后，再由人删除旧 bucket 和 secrets。production 当前没有获准执行任何此类操作。
