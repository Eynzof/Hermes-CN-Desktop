# 12. Hermes Studio 对照与复用结论

## 1. 它怎么做桌面更新

Hermes Studio 当前是 Electron/electron-builder 方案：

- [updater.ts](https://github.com/EKKOLearnAI/hermes-studio/blob/main/packages/desktop/src/main/updater.ts) 使用 `electron-updater`，优先 `https://download.ekkolearnai.com/latest`，不可用时把整个更新 feed 切到 GitHub `releases/latest/download`。
- `autoDownload=false`，发现版本后让用户确认下载；下载完成后提供立即重启或稍后。
- Windows 遇到 updater lock/pending 问题时做有限缓存清理，并在安装前终止同一应用的其他实例。
- [electron-builder.yml](https://github.com/EKKOLearnAI/hermes-studio/blob/main/packages/desktop/electron-builder.yml) 使用 generic provider；发布资产包含 Electron 的 `latest*.yml` 和 blockmap。
- [desktop-release.yml](https://github.com/EKKOLearnAI/hermes-studio/blob/main/.github/workflows/desktop-release.yml) 构建多平台资产、合并 macOS manifest 并发布 GitHub Release。
- [runtime-manager.ts](https://github.com/EKKOLearnAI/hermes-studio/blob/main/packages/desktop/src/main/runtime-manager.ts) 对 Runtime 另有 Cloudflare/GitHub 源、manifest/hash 和 active-version 管理。

## 2. 可以复用的设计思想

- 下载前让用户确认；安装前再提供“立即重启/稍后”。
- Desktop 壳更新与 Runtime 版本管理分开。
- Windows pending 缓存恢复必须限定到本应用精确目录。
- 安装前只处理同一应用的其他实例/owned runtime。
- Cloudflare 主路径 + GitHub故障回退。
- Runtime manifest、hash 和 active/previous 指针。

这些思想已经用 Tauri/Rust 的独立实现吸收进本分支，没有复制 Hermes Studio 源码。

## 3. 不能直接复用的实现

| Hermes Studio | 本项目为什么不能照搬 |
|---|---|
| Electron `latest.yml`、blockmap、electron-updater | 本项目是 Tauri v2，清单和 detached signature 契约不同 |
| 整个 feed 回退 GitHub `latest` | 会绕过 D1 的指定设备、暂停和灰度；本项目只在已授权后回退同一资产 |
| Electron pending/Squirrel 目录 | Tauri updater/NSIS 路径和错误类型不同 |
| 其 Release workflow | 本项目还要求 Desktop↔Core matrix、Runtime防降级、D1 audit、四平台 all-or-nothing |

Hermes Studio 没有本项目的 per-device token/ring、stable 确定性灰度和 install 前 D1 复核，因此它是产品交互与容错参考，不是控制面模板。

## 4. 许可证边界

Hermes Studio 的 [LICENSE](https://github.com/EKKOLearnAI/hermes-studio/blob/main/LICENSE) 是 BSL 1.1：当前额外授权限非商业用途，商业使用需另行许可，Change Date 为 2029-05-10，届时转 Apache 2.0。

因此结论是：

- 可以研究公开行为、协议形状和 UX 思路。
- 不复制/改写其 updater、runtime-manager 或 workflow 源码进入本项目。
- 本分支实现应保持 clean-room：基于 Tauri官方 API、本项目既有状态模型和公开行为需求独立编写。
- 若未来确需代码级复用，先完成商业用途和许可证兼容审查并取得书面授权。

## 5. 最终判断

可复用约 30% 的“设计思想”，不能复用其 Electron 资产格式、feed fallback 语义或 BSL 源码。现行 GitHub唯一源 + Cloudflare/D1 控制 + 同资产回退方案比直接照搬更适合本项目。
