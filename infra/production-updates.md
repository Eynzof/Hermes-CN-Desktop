# 正式更新服务部署与操作

本配置为 v0.9.0 正式更新服务，复用已经验证的控制面及镜像实现，资源与 staging 分开。部署服务本身不会发布版本；D1 中的发布状态与投放比例单独控制。

## 资源与路径

Cloudflare Account：`0e4182f5f8810b68459bae1ef6ef9faa`。

| 资源 | 正式配置 |
| --- | --- |
| 控制 Worker | `hermes-desktop-hot-update-production` |
| 配置文件 | `infra/hot-update-staging/wrangler.production.jsonc` |
| 检查地址 | `https://hot-update.hermesagent.org.cn/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}` |
| D1 | `hermes-desktop-hot-update-production` / `2709a341-5bbc-45f8-8917-dfcdfc3f59b8` |
| 下载 Worker | `hermes-desktop-release-mirror-production` |
| 配置文件 | `infra/release-mirror/wrangler.production.jsonc` |
| 镜像根地址 | `https://hot-update-download.hermesagent.org.cn` |

生产配置关闭 workers.dev 和预览 URL，不配置 staging 故障注入变量。不要覆盖现有 `hermes-desktop-release-mirror`：它负责官网历史 `dl-desktop.hermesagent.org.cn` / R2 下载入口。

镜像只读取两个固定 GitHub 仓库：

- `/v0.9.0/<asset>` → `Eynzof/Hermes-CN-Desktop` 对应 tag 资产。
- `/runtime-v0.21.0-cn.14/<asset>` → `Eynzof/Hermes-CN-Core` 对应 tag 资产。
- `/latest/<asset>` 仍只表示 Desktop latest 人工下载别名；自动更新使用不可变版本路径。

Core 正式归档示例：`https://hot-update-download.hermesagent.org.cn/runtime-v0.21.0-cn.14/hermes-agent-cn-runtime-darwin-arm64.zip`。清单使用同 tag 下的 `stable-darwin-arm64.json` 等真实资产。Core 必须在签名前确定 `artifactUrl`，镜像原样返回清单，禁止分发时改写已签名字段。

Landing 的 `/runtime/stable-<platform>-<arch>.json` 需指向已验收的固定 Runtime tag；此配置不自动改变 Landing 路由、官网版本或旧 `latest.json`。

## 部署

在仓库根目录执行，所需权限是 Workers / routes 编辑和 D1 编辑；私钥不进入 Worker。CLI 使用本机 Wrangler 登录或专用 Cloudflare API token；短期 OAuth 令牌不复制到 GitHub Secrets。

```sh
pnpm exec wrangler whoami
node --test infra/hot-update-staging/test/*.test.js infra/release-mirror/test/*.test.js
pnpm exec wrangler d1 migrations apply hermes-desktop-hot-update-production --remote --config infra/hot-update-staging/wrangler.production.jsonc
pnpm exec wrangler deploy --config infra/release-mirror/wrangler.production.jsonc
pnpm exec wrangler deploy --config infra/hot-update-staging/wrangler.production.jsonc
```

D1 已创建，重复部署不需要再次 create。不同账号重建时，先创建独立正式库，再填入真实 UUID，不能借用 staging 库。Custom Domain 由 Wrangler 绑定并申请证书。[Cloudflare 自定义域名说明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## 投放与撤回

- 正式客户端默认 stable，以自动生成的 `X-Installation-Id` 分桶，不要求邀请或 Bearer token。
- `prototype`、`canary`、`beta` 保留原有设备 token 和 ring 校验；nightly 继续映射 `prototype`，不新增匿名 nightly 入口。
- 生产库初始无设备和发布记录。需要定向内测时在生产库单独登记设备；不复制 staging 设备令牌。
- 用 `scripts/hot-update-control.mjs release register-draft` 从真实 Release 资产核对后登记，传入正式 `--database`、`--mirror-origin`、`--remote`、`--production`，并设置 `HERMES_ALLOW_PRODUCTION_HOT_UPDATE=1`。
- 核对登记状态为 draft / 0%，最终产物验收后再执行 promote / set-percent。出错时 pause / revoke，仅阻止后续安装；不会自动降级已经升级的用户。
- GitHub Release 的公开性、latest 标记与 D1 投放是不同状态。官网旧 `latest.json` 不支持按设备灰度，最后单独推广。

管理操作的精确参数见 `scripts/hot-update-control.mjs` 和 `docs/260822 热更新/04-CI-CD夜间构建与指定用户分发.md`。GitHub 自动管理如启用，使用正式 Environment 的长期 API token；无此 token 时可由已登录本地 CLI 执行管理，不把临时 OAuth 当持久发布凭据。

## 2026-09-20 首次部署记录

- 控制 Worker 版本：`d12e6329-5872-4d58-a08c-c9130ef98f76`。
- 镜像 Worker 版本：`3964353e-de35-4ab5-8404-2270e7785acd`。
- 迁移 `0001_initial.sql`、`0002_github_origin.sql` 成功。远端 SELECT 结果：`releases=0`、`devices=0`。
- 定向 Node 测试：21 / 21 通过（包含 Core 固定仓库路由、stable 免邀请、限制渠道鉴权与 staging 故障注入隔离）。
- 使用桌面端 UA `hermes-agent-cn-desktop-update-check` 实测：两个正式 `/health` 均为 200、JSON `environment=production`；stable 有 installation ID 无 token 时 204；canary 无 token 时 401；原 staging `/health` 仍为 200。
- 本机现有 HTTPS 代理路径访问新 control 域出现 TLS EOF，直连相同地址正常；没有改动代理或 zone 防护规则。裸 Python UA 触发现有站点 1010，验证必须使用实际客户端请求头。
- 此时尚未验证 v0.9.0 资产下载、哈希与 Range，因为发行资产尚未公开；应在公开源可用后核对，不以 `/health` 代替下载验收。
- 本次未改任何现有 release 投放、staging 服务、官网和 latest 清单。
