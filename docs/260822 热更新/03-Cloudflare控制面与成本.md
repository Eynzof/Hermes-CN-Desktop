# 03. Cloudflare 控制面与成本

## 1. 是否需要单独搭一台“热更新服务器”

内测阶段不需要。推荐的最小后端是：

| 组件 | 职责 | 原型实现 |
|---|---|---|
| Cloudflare Worker | HTTPS API、Bearer 鉴权、ring/灰度决策、Tauri JSON、Range 下载代理 | `infra/hot-update-staging/src/index.js` |
| D1 | 设备、令牌哈希、发布版本、状态、比例、精确物料信息 | `migrations/0001_initial.sql` |
| R2 | 不可变安装包 | 私有 bucket，通过 Worker 读取 |
| Wrangler/受控 CI | 建库、迁移、上传、回读校验、发布/暂停 | staging 目前为人工操作，生产需自动化 |

这比一台 VPS 少了系统补丁、反向代理、磁盘扩容和出口带宽账单，也天然适合按请求量付费。后续如果要做管理 UI，它也应该是受 Cloudflare Access 或服务令牌保护的独立管理面，而不是把管理 API 暴露在更新 Worker 的公共路由上。

## 2. 当前 staging 资源

| 资源 | 当前值 | 是否影响正式环境 |
|---|---|---|
| Worker | `hermes-desktop-hot-update-staging` | 否 |
| 自定义域名 | `https://hot-update-staging.hermesagent.org.cn` | 否，独立 staging |
| workers.dev | `https://hermes-desktop-hot-update-staging.eynzof.workers.dev` | 否；大陆测试机实测超时 |
| D1 | `hermes-desktop-hot-update-staging` | 否 |
| R2 | `hermes-desktop-hot-update-staging`，APAC location hint | 否 |
| 当前发布状态 | `paused`，`rollout_percent=0` | 不再向基线设备下发 |

没有修改正式 R2 bucket、官网、Landing、GitHub Release 或公开 `latest.json`。

## 3. API 和数据模型

### 3.1 客户端 API

```text
GET  /health
GET  /v1/check/{target}/{arch}/{current_version}
HEAD /v1/artifacts/{release_id}/{file_name}
GET  /v1/artifacts/{release_id}/{file_name}
```

除 `/health` 外都要求：

```http
Authorization: Bearer <device-token>
```

服务端只保存令牌的 SHA-256，不保存明文。检查请求的决策顺序为：鉴权 → 设备 active → ring 匹配 → 最新 published → rollout bucket 命中 → 候选版本高于当前版本。任何一步不满足都返回 `204` 或不可枚举的 `404`。

### 3.2 D1 事实

`devices` 保存：设备 ID、令牌哈希、ring、状态、创建时间、最近访问时间。

`releases` 保存：发布 ID、单调递增 sequence、channel、Desktop 版本、平台/架构、bundle 类型、R2 key、文件名、Tauri 签名、SHA-256、大小、Core/Runtime 精确版本、Runtime revision、发布说明、时间、状态和灰度比例。

状态机：

```text
draft -> published -> paused
                  \-> revoked
paused -> published  （只允许经过重新审批）
```

生产实现应使用受约束的状态迁移命令，禁止直接执行任意 SQL。

## 4. 免费层成本测算

以下额度来自 2026-08-22 查阅的官方文档，Cloudflare 后续可能调整，正式上线前应重新核对：

- [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)：Free 每天 100,000 次请求，每次最多 10 ms CPU；Paid 最低月费目前为 5 美元。
- [R2 定价](https://developers.cloudflare.com/r2/pricing/)：Standard 免费 10 GB-month 存储、每月 100 万次 Class A、1,000 万次 Class B，互联网出口流量免费。
- [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)：Free 每天 500 万行读取、10 万行写入，总存储 5 GB，且无额外出口费。
- [Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)：部署前还需核对请求体、CPU、子请求和账户级限制。

原型 Windows 候选安装包为 `185,693,447` 字节，即约 185.7 MB（177.1 MiB）：

- 单纯按 10 GB 免费存储计算，理论上约放 53 份同等大小的完整包；还需为其它平台、日志和计量误差留余量。
- 建议每个 `{ring, platform, arch}` 只保留“当前、上一版、一个已知良好版”，nightly 超过 14 天自动删除。
- 100 台内测设备每天检查 4 次约 400 次 Worker 请求；即使每次下载产生多次 Range/重试，仍远低于免费额度。
- R2 出口免费消除了大文件下载最明显的带宽账单，但不代表中国大陆网络质量有保证。

### 一个可复算的月成本公式

```text
存储 GB-month = 各安装包大小 GB × 保留月数
检查请求/月 = 活跃设备数 × 每日检查次数 × 30
下载请求/月 = 升级设备数 × 每包平均 Range/重试请求数
D1 读取 ≈ 检查数 × 2 + 下载请求数 × 1
D1 写入 ≈ 每台活跃设备每小时至多一次 last_seen + 发布管理写入
```

当免费层接近 50% 时就应告警，不等到硬上限才扩容。内部规模下如果需要更稳定的 Worker 能力，优先考虑 5 美元/月 Paid，而不是为了省固定小额费用增加自建服务器运维。

## 5. 中国大陆网络边界

Cloudflare 普通全球网络和 Cloudflare China Network 是两套服务。官方说明 [China Network](https://developers.cloudflare.com/china-network/) 需要 Enterprise 订阅，并要求域名具备 ICP 备案；[可用产品说明](https://developers.cloudflare.com/china-network/reference/available-products/) 也指出 R2 不能在中国大陆创建 bucket，R2 自定义域名不能直接在中国大陆网络内启用，可评估 Global Acceleration 等连接方式。

本次真实观察：

| 入口 | `primelab-win` 结果 | 结论 |
|---|---|---|
| `*.workers.dev` | 超时 | 不作为大陆客户端正式入口 |
| `hot-update-staging.hermesagent.org.cn` | 健康检查、清单、Range 下载均成功 | 自定义域名在这一条线路可用，但不能外推为全国 SLA |

因此分阶段处理：

1. **小规模内测**：Cloudflare 自定义域名 + 多运营商真实探针；控制面和 R2 保持免费层。
2. **扩大 beta**：至少三大运营商、多个地区和企业网络持续采样；如果错误率无法接受，增加大陆对象存储/CDN 作为受控镜像。
3. **正式规模化**：在 ICP + Cloudflare China Network 与国内云 CDN 之间做商务/合规评估。控制面仍可保留 Cloudflare，下载 URL 由发布记录选择区域源。

## 6. 下载和缓存策略

- 安装包 key 一旦写入就不可覆盖；同一版本内容变化必须换版本和 release ID。
- 当前私有下载返回 `Cache-Control: private, no-store`，防止共享缓存绕过设备授权。
- R2 上传后必须从远端完整回读并核对 SHA-256，再允许写入 `published`。
- 支持 `Range` 和 `HEAD`，便于断点续传、预检大小和失败重试。
- 清单永远 `no-store`，发布暂停必须尽快生效。
- 如果未来采用短期签名 URL 提升缓存命中，URL 必须短时效、绑定发布/设备或受 Access 保护，并重新评估泄漏后的下载窗口。

## 7. 什么时候才需要传统后端

只有出现下列需求时才考虑独立服务：复杂组织/账号体系、跨产品许可证、百万级设备遥测、需要事务性的多区域发布编排，或法规要求数据必须落在指定大陆区域。即便如此，大文件仍应放对象存储/CDN，应用服务器只做控制决策，不转存安装包。
