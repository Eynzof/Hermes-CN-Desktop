# macOS 原生更新验收

使用实际 Developer ID 签名 App、冻结 Core 和真实 Tauri 签名 `.app.tar.gz`，数据、更新夹具、安装目录均独立。先通知用户再进行视觉操作。现阶段 UI 由原生辅助功能工具操作，下面脚本固化启动、真实产物检查及证据采集，不宣称 macOS UI 流程已无人值守通过。

需要 Python 3.11+、cryptography、独立 App 副本及其候选 `.sig`。先用 `codesign --verify --deep --strict` 验证两份 App。候选 Desktop 版本必须确实高于基线，不能只改清单。安装资源必须包含 `dashboard/web_dist`；不要将新 App 合并复制到旧目录造成多余签名资源。

```sh
python update-fixture.py --prepare --root /absolute/fixture \
  --candidate '/absolute/candidate/App.app.tar.gz' --version 0.9.1-prototype.ux.6
python update-fixture.py --root /absolute/fixture
```

夹具仅绑定 127.0.0.1:19448，仅响应两个更新主机，不转发模型请求，不修改 hosts 或系统代理。短期 CA 有域名约束及两天有效期。通过 macOS 系统认证将 `ca.cer` 加入当前用户测试信任后再验证更新；不得跳过 TLS 验证。macOS 的平台证书验证不以 `SSL_CERT_FILE` 代替系统信任。

```sh
security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" /absolute/fixture/ca.cer
python acceptance.py launch --app '/absolute/installed/App.app' \
  --root /absolute/acceptance-runtime --fixture /absolute/fixture --output /absolute/launch.json
python acceptance.py snapshot --app '/absolute/installed/App.app' \
  --root /absolute/acceptance-runtime --output /absolute/before.json
```

启动脚本清除大小写代理变量，DeepSeek 与回环地址均绕过夹具。真实模型凭据仅放在独立 `hermes-home/.env`。可选 `ca-bundle.pem` 必须同时包含公共 CA，不能仅含测试证书。启动器遇到 API 端口占用即停止，不结束其他实例。

确认流程：从底部进入更新页，核对高级选项默认收起；检查更新、返回工作台核对 Modal、稍后提醒与底部入口；用真实 DeepSeek 保存会话。下载后核对仍是同一进程和版本，用户点击生效后等待更新器自行重启，不手动启动来掩盖重启失败。之后再次 snapshot，核对实际 App 版本/摘要、PID、持久化状态、原配置摘要和真实计费会话，回到原会话继续发送。候选撤回可将 `mode.json` 的 available 或 authorized 设为 false；不改客户端持久化计划来伪造状态。

完成后正常退出测试应用，确认实际进程及 Core 已停止；原 App 副本恢复需使用完整目录替换并重新严格验签。移除 metadata.json 中确切指纹的测试证书与对应用户信任，停止本轮夹具，保留原始结果及失败日志。不要删除日常 runtime 或用户数据。

`getApp`/辅助功能读取可能在应用退出后自动启动它，退出后的核对应使用 PID/端口，不再读取该 App 的界面，以免缺少隔离环境变量而误入默认数据目录。
