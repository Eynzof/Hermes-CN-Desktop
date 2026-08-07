# 老服务器桌面更新清单

此目录用于让仍然读取旧服务器地址的桌面客户端发现火山 TOS 上的新版。

## 需要上传的文件

将 `update/downloads/` 目录中的内容覆盖到老服务器：

```text
/www/wwwroot/downloads/
```

对应关系：

| 本地文件 | 老服务器目标文件 |
| --- | --- |
| `downloads/fengchihermes/latest.json` | `/www/wwwroot/downloads/fengchihermes/latest.json` |
| `downloads/frogclawhermes/latest.json` | `/www/wwwroot/downloads/frogclawhermes/latest.json` |
| `downloads/huanxinghermes/latest.json` | `/www/wwwroot/downloads/huanxinghermes/latest.json` |
| `downloads/huanxingcomhermes/latest.json` | `/www/wwwroot/downloads/huanxingcomhermes/latest.json` |

`huanxingcomhermes` 在老服务器上当前不存在，需要同时创建目录。

这些 JSON 已指向火山 TOS 的安装包，不需要把 EXE 再上传到老服务器。

## 当前发布内容

| 品牌 | 版本 | Windows 安装包 | SHA-256 |
| --- | --- | --- | --- |
| `fengchihermes` | `0.6.8` | `Hermes-Fengchi-0.6.8_x64-setup.exe` | `14aac6af45957a2f3be0c583d0b7d92448c555110007f75e2356d651a1ed9e0d` |
| `frogclawhermes` | `0.6.8` | `Hermes-FrogClaw-0.6.8_x64-setup.exe` | `4cab1ff53bfbb2483956f98a0f1570cc6e24d1ae73c24f37c8b137079881724d` |
| `huanxinghermes` | `0.6.8` | `HuanxingHermes.Desktop_0.6.8_x64-setup.exe` | `1d2a04f290a64f3b4508482bbdf18a98d847995b51902db234e3d7241e917955` |
| `huanxingcomhermes` | `0.6.8` | `HuanxingHermes.Desktop_0.6.8_x64-setup.exe` | `1d2a04f290a64f3b4508482bbdf18a98d847995b51902db234e3d7241e917955` |

当前 TOS stable 清单只发布了 Windows 资产，因此这些兼容清单也只包含 Windows。不要在没有对应 DMG 和 SHA-256 的情况下手工添加 macOS 条目。

## 上传前检查

覆盖这些文件会让仍在读取旧 URL 的客户端立即发现 `0.6.8`，属于 stable 发布动作。上传前至少用一台已安装旧版的 Windows 测试机完成覆盖安装验证。

- 老客户端首次升级时只能自动下载、校验并打开安装器，不会自动退出旧进程；需要按安装器提示关闭旧应用。安装到 `0.6.8` 后，后续更新才会使用新的自动退出安装流程。
- 旧品牌安装包曾使用 `app.<brand>.desktop` identifier，当前安装包统一使用 `cn.org.hermesagent.desktop`。请确认覆盖后原 profile、模型配置、会话和 managed runtime 可继续读取，并检查 Windows“应用和功能”中没有重复条目。
- 当前 Windows 安装包没有 Authenticode 签名，测试和发布说明需要提示用户处理 SmartScreen 的“仍要运行”。
- 不要改动 JSON 中的 `sha256`、`size` 或 `versionedUrl`；它们已经与 TOS 上的实际安装包核对一致。

## 上传示例

先把整个 `update/downloads` 上传到服务器临时目录，然后在服务器上执行：

```bash
set -e

sudo mkdir -p \
  /www/wwwroot/downloads/fengchihermes \
  /www/wwwroot/downloads/frogclawhermes \
  /www/wwwroot/downloads/huanxinghermes \
  /www/wwwroot/downloads/huanxingcomhermes

sudo install -m 0644 /tmp/hermes-update/downloads/fengchihermes/latest.json \
  /www/wwwroot/downloads/fengchihermes/latest.json
sudo install -m 0644 /tmp/hermes-update/downloads/frogclawhermes/latest.json \
  /www/wwwroot/downloads/frogclawhermes/latest.json
sudo install -m 0644 /tmp/hermes-update/downloads/huanxinghermes/latest.json \
  /www/wwwroot/downloads/huanxinghermes/latest.json
sudo install -m 0644 /tmp/hermes-update/downloads/huanxingcomhermes/latest.json \
  /www/wwwroot/downloads/huanxingcomhermes/latest.json
```

上传的是静态文件，不需要重启 Nginx。

## 上线验证

```bash
for brand in fengchihermes frogclawhermes huanxinghermes huanxingcomhermes; do
  curl -fsSL "https://huanxing.ai/downloads/$brand/latest.json"
done
```

四个响应都应包含：

```json
"version": "v0.6.8",
"semver": "0.6.8"
```

再使用老版本客户端检查更新，确认它显示 `0.6.8`，并从 `huanxing.tos-cn-beijing.volces.com` 下载对应品牌安装包。
