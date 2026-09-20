# Ubuntu 22.04 正式 Linux 成品最小冒烟

这份临时验收只在 `test/v090-ubuntu2204-release-smoke` 分支运行，不合并到冻结发行分支或默认分支。复用默认分支已注册的 `web-e2e.yml` 工作流名，但在此临时分支用真实成品冒烟替换原开发 Web E2E；没有 fake model、产品重建、模型密钥、发布写权限或 PR。

执行前由发布负责人通知视觉验收，并填写四个确定输入：最终 Desktop 完整 SHA、成功的 release-desktop CI run ID、已验收原始 `checksums.txt` 的 SHA256、`v0.9.0` tag。不在脚本中绑定已作废的 Desktop SHA；独立 checkout 输入中的最终源码，仅读取公钥与版本。Runtime 目标固定 cn18 / `b9f82a21fd9268bd499051e23b614ecb06d5b888`。

脚本下载 CI 创建的同一 draft/public release 中的 `checksums.txt`、`release-record.json` 及两个 Linux updater 资产；只有候选指纹、record 源码 SHA、release 目标提交和成功 CI 来源全部匹配才能继续。按 record 的 `linux-deb/x86_64` 和 `linux/x86_64` 选择 `.deb` 与 AppImage，分别核对 SHA 和 `.sig`，用最终源码中的生产公钥执行 minisign 验签。

在真正 `ubuntu-22.04` runner 上用 apt 安装原 `.deb`，比对安装后的 EXE 与已验签 deb payload 相同。AppImage 原字节验签后解包，用原 AppRun 启动。两个真实 Desktop 在 Xvfb + dbus 会话内依次使用不同的新 HOME/runtime；实际 `/proc/<pid>/exe` 必须对应包内二进制，实际 Core PID 必须位于本轮 `runtime/versions/0.21.0-cn.18`，且 Core 可执行文件 hash 与 ZIP 原件一致。再比对 current.json、source、包内 ZIP、真实 `/api/health`、`/api/version`、空闲状态与 HOME。

保留实际原生窗口截图、进程路径/摘要、版本来源、Core/API 证据和失败日志。Deb 版本来自实际 dpkg 安装记录，AppImage 版本来自已签名资产与固定候选记录；报告不会把这些冒充 UI DOM 版本读取，截图需负责人视觉复核。清理仅针对本脚本创建的进程组和明确属于本轮 runtime 的 Core PID，不涉及 Windows runner。

本地准备检查：Python `compile()`、`actionlint .github/workflows/web-e2e.yml`。没有运行 Linux GUI。

临时分支提交/推送与视觉通知均由负责人安排后才执行：

```sh
gh workflow run web-e2e.yml --repo Eynzof/Hermes-CN-Desktop \
  --ref test/v090-ubuntu2204-release-smoke \
  -f desktop_sha=FINAL_DESKTOP_40_CHAR_SHA \
  -f candidate_run_id=VERIFIED_RELEASE_RUN_ID \
  -f candidate_sha256=VERIFIED_CHECKSUMS_SHA256 \
  -f release_tag=v0.9.0 \
  -f visual_notice_confirmed=true
```

下载并审阅 `ubuntu2204-final-desktop-smoke` artifact。只有两个格式的 `ok=true`、清理成功且原生截图复核通过，才记 Ubuntu 成品冒烟通过。此任务不验证真实模型对话，不替代 Windows/Mac 的升级链验收。
