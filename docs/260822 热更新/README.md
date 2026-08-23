# Hermes-CN Desktop 热更新方案（2026-08-22）

本目录是下一版热更新工作的总入口。它同时记录：当前代码事实、2026-08-22 原型实测结果、内测基础设施方案，以及进入正式发布前仍需补齐的事项。

## 先说结论

- **原型已经跑通**：Windows 上从 `0.8.1-hotupdate.0` 检查到 `0.8.1-hotupdate.1`，经设备鉴权、版本兼容检查、断点下载、Tauri 更新签名校验和 NSIS 安装后自动重启，最终版本与内置 Runtime 都符合预期。
- **没有动线上版本**：没有发布 Git tag/GitHub Release，没有修改 Landing，也没有让公开 `latest.json` 指向内测版本。当前 Cloudflare 内测发布已暂停，未升级设备检查不到候选包。
- **不需要传统常驻热更新服务器**：内测阶段使用 Cloudflare Worker + D1 + R2 即可。Worker 做鉴权与灰度决策，D1 存设备和发布状态，R2 存安装包。
- **Desktop 与 Core 独立版本**：唯一兼容事实源是 [`../../compatibility/desktop-core.json`](../../compatibility/desktop-core.json)。例如 Desktop `0.8.x` 对应 Core/Runtime `0.20.x`，不再要求版本号相同。
- **Cloudflare 免费层可承担小规模内测**：但普通 Cloudflare 全球网络并不等于中国大陆本地网络。原型机上自定义域名可访问、`workers.dev` 超时，这只能算一次实测，不是全国 SLA。
- **CNB 很适合国内代码镜像和 Windows 自托管构建节点**；Gitea 适合需要完全自主管理时作为代码/CI 备份。两者都不应替代这次的鉴权、灰度和回滚控制面。

## “热更新”在本项目里的准确含义

| 轨道 | 更新对象 | 是否需重启 | 当前状态 | 主要安全边界 |
|---|---|---:|---|---|
| Desktop 壳更新 | Tauri/Rust、内嵌 Web、随安装包携带的 Runtime | 是 | **本次原型已实测** | Tauri updater 签名 + Desktop↔Core 兼容矩阵 |
| Managed Runtime 更新 | Hermes-CN-Core PyInstaller Runtime | 重启 Core | 代码已存在 | Runtime manifest 签名 + SHA-256 + revision/降级保护 |
| UI 包更新 | React `web/dist` | WebView reload | 代码已存在，未纳入本次线上方案 | UI manifest 签名 + `appVersionFloor` + 本地回退 |
| 开发热重载 | Vite HMR / 本地 Core 重装 | 视改动而定 | 仅开发用途 | 不属于用户发布渠道 |

本文档所说的“桌面热更新”默认指第一行：**用户无需手工下载安装包，但仍然是受签名保护的完整安装包升级**。

## 文档导航

1. [通俗说明与当前卡点](./01-通俗说明与当前卡点.md)：现在需要什么、已经具备什么、真正卡在哪里。
2. [目标架构与版本兼容矩阵](./02-目标架构与版本兼容矩阵.md)：三条更新轨道、组件关系、版本判定规则。
3. [Cloudflare 控制面与成本](./03-Cloudflare控制面与成本.md)：Worker/D1/R2、免费层估算、大陆网络边界。
4. [CI/CD、夜间构建与指定用户分发](./04-CI-CD夜间构建与指定用户分发.md)：从提交到内测、灰度、暂停的完整流水线。
5. [Tauri 客户端状态机与回滚](./05-Tauri客户端状态机与回滚.md)：检查、下载、验签、安装、止血和前向修复。
6. [Windows 测试机操作手册](./06-Windows测试机操作手册.md)：`primelab-win` 构建与验收流程、国内网络缓存处理。
7. [CNB、Gitea 国内托管调研](./07-CNB-Gitea国内托管调研.md)：能力、成本、限制和推荐组合。
8. [安全、密钥与权限](./08-安全密钥与权限.md)：签名、设备令牌、证书、最小权限和轮换。
9. [上线分阶段计划与验收](./09-上线分阶段计划与验收.md)：从当前原型到下一版正式可用的门槛。
10. [原型实测记录](./10-原型实测记录.md)：版本、SHA-256、网络结果和当前远端状态。
11. [微软商店上架与热更新](./11-微软商店上架与热更新.md)：EXE/MSI 与 MSIX 路径、认证闸门、Store 构建风味和成本。

## 状态标记

- **已实现**：代码已经在本工作树中。
- **已实测**：在 2026-08-22 的 Windows 原型链路中拿到了真实结果。
- **已部署（staging）**：只存在于独立 Cloudflare staging，不属于线上正式环境。
- **规划**：设计已经确定，但尚未自动化或尚未经过目标平台验收。
- **正式发布阻塞**：未完成前不得进入公开 stable。

## 权威边界

- 代码和配置事实以本工作树为准。
- Desktop↔Core 映射以 `compatibility/desktop-core.json` 为准，文档中的表格只是解释。
- 内测发布状态以 staging D1 为准；原型结束时发布状态为 `paused`、灰度比例为 `0`。
- 公开 stable 发布仍必须执行仓库的 `desktop-release-preflight` 流程。RC/beta/canary 不得修改 Landing 或公开 `latest.json`。
