# macOS 应用签名与公证流程

本文档沉淀 Hermes Agent CN Desktop 的 macOS 直分发签名方案。这里的“直分发”指用户从 GitHub Releases、官网或其他自管渠道下载 `.dmg`，不经过 Mac App Store 上架流程。因此，本项目使用 `Developer ID Application` 证书签名应用，再把最终 `.dmg` 提交给 Apple Notary service 公证并 staple 到安装包上。

本文按 2026-05-21 的项目实现和 Apple 官方文档整理。Apple Developer 后台和 Tauri/GitHub Actions 的细节可能会变化，遇到异常时应优先看本文末尾的官方链接和当前仓库的 `.github/workflows/release-desktop.yml`。

## 一、应该选哪种证书

如果目标是“签名后自己分发 macOS 包，不上架 App Store”，应选择 `Developer ID Application`。它用于签名 Mac app，配合公证后可以被 Gatekeeper 识别为来自已验证开发者的应用。

不要选 `Mac App Distribution`。这个证书用于提交 Mac App Store Connect，不适合 GitHub Releases 或官网直分发。也不要把 `Developer ID Installer` 当成默认选项；它用于签名 `.pkg` 安装包。本项目当前产物是 Tauri 生成的 `.dmg`，核心是用 `Developer ID Application` 签 `.app`，再对最终 `.dmg` 做公证和 staple。

创建 Developer ID 证书时，如果页面让选择 Sub-CA，默认选 `G2 Sub-CA (Xcode 11.4.1 or later)`。只有为了兼容非常旧的 Xcode 或旧构建链时，才考虑 `Previous Sub-CA`；新证书不应为了短期省事选择旧 Sub-CA。

生成 CSR 时，证书助理里的“用户电子邮件地址”和“常用名称”按开发者账号填写即可；如果选择“保存到磁盘”，`CA 电子邮件地址` 可以留空。关键点是 CSR 必须在最终要持有私钥的 Mac 上生成，这样下载回来的 `.cer` 才能和本机钥匙串里的私钥配成一张可导出的签名身份。

## 二、App Store Connect 是否必须配置

不上架 App Store 不需要创建 App Store Connect 里的 App 记录，也不需要走 App Review、TestFlight 或版本元数据流程。

但自动公证需要 Apple 认证凭据。当前项目使用 App Store Connect API Key 调 `xcrun notarytool`，所以需要在 App Store Connect 的“用户和访问 / 集成 / 团队密钥”里生成一个 `.p8` 私钥。这个 API Key 只是给 Notary service 做身份认证，不代表要把应用提交到 App Store。

实践上，本项目生成 Team API Key 时选择“开发者”职能即可完成公证。如果后续 Apple 权限策略变化导致 notarytool 返回权限错误，再让 Account Holder/Admin 重新生成或调整权限。

## 三、本地证书安装与导出

下载 `developerID_application.cer` 后双击安装到“钥匙串访问”。安装完成后，在“我的证书”里应能看到类似下面格式的身份，并且证书左侧能展开出私钥：

```text
Developer ID Application: <Developer Name> (<TEAM_ID>)
```

可以用下面命令确认 codesign 能看到这张身份：

```bash
security find-identity -v -p codesigning
```

给 GitHub Actions 使用时，需要把这张签名身份导出成 `.p12`，再 base64 后放入 GitHub Secret。建议从“钥匙串访问”的“我的证书”里右键导出，格式选择 `.p12`，设置一个强密码。导出后可以这样生成 secret 内容：

```bash
base64 -i DeveloperIDApplication.p12 -o DeveloperIDApplication.p12.b64
pbcopy < DeveloperIDApplication.p12.b64
```

`.p12`、`.p8`、`.b64` 都不能提交到仓库。它们只应保存在本机安全目录或 GitHub Secrets 里。如果 `.cer` 安装后没有私钥，通常说明 CSR 不是在当前钥匙串生成的，需要回到“证书助理”重新生成 CSR 并重新签发证书。

## 四、GitHub Secrets 约定

当前 release workflow 读取这些 secrets。名字不要随意改，除非同步修改 `.github/workflows/release-desktop.yml`。

```text
APPLE_CERTIFICATE           base64 后的 Developer ID Application .p12
APPLE_CERTIFICATE_PASSWORD  导出 .p12 时设置的密码
APPLE_SIGNING_IDENTITY      Developer ID Application: <Developer Name> (<TEAM_ID>)
APPLE_API_KEY               App Store Connect API Key 的 Key ID
APPLE_API_ISSUER            App Store Connect API Key 的 Issuer ID
APPLE_API_PRIVATE_KEY       AuthKey_<KEY_ID>.p8 的完整文本内容
```

还有一个可选 secret：`RELEASE_TOKEN`。默认情况下，workflow 已声明 `permissions: contents: write`，并且应使用 `github.token` 创建或更新 GitHub Release。只有仓库级 Actions 权限导致 `Resource not accessible by integration` 之类错误时，才考虑配置 `RELEASE_TOKEN` 作为兜底。这个 token 应只给 release 所需的最小权限，用完后及时撤销或删除。

## 五、CI 发版流程

发版入口是 `.github/workflows/release-desktop.yml`。它在推送 `v*` tag 时运行，也支持手动 `workflow_dispatch` 指定 tag。macOS job 运行在 `macos-14`，目标架构是 `aarch64-apple-darwin`。

流程大致是：先安装 Node、pnpm、Rust 和 Tauri 依赖，再拉取 `hermes-agent-cn` 对应 runtime manifest 的 Dashboard 前端、内置技能以及 macOS arm64 runtime manifest，并把 runtime zip 原样放进 `Contents/Resources/bundled-runtime/`。这里不能把 runtime 目录展开后交给 Tauri resource 复制，因为 Tauri 会把 `Python.framework` 里的 symlink 复制成普通文件，直接破坏 framework 签名。macOS runtime 必须在 `hermes-agent-cn` 上游 release 阶段就完成处理：先把 PyInstaller 复制出来的 `Python.framework` 规范化成标准 framework symlink 布局，再对 framework、主程序和所有 Mach-O payload 做 Developer ID 签名，并用保留 symlink 的 zip 方式发布。桌面端 release workflow 只解压校验包内 runtime zip 的签名，不再重签、不再把 `.framework` 临时改名，最后只对生成的 `.dmg` 做公证、staple 和验证。

Tauri 构建结束后，workflow 会对最终 `.dmg` 做一次显式公证、staple 和验证：

```bash
xcrun notarytool submit "$dmg" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl -a -vvv -t open --context context:primary-signature "$dmg"
gh release upload "$RELEASE_TAG" "$dmg" --clobber
```

最后一步会覆盖 tauri-action 先上传的 DMG，确保用户在 GitHub Releases 下载到的是已经 notarized 且 stapled 的最终包。

## 六、本地手动构建和验证

本地手动打 macOS 包时，需要先确认 Xcode Command Line Tools 可用：

```bash
xcode-select --install
xcrun notarytool --version
```

然后在当前 shell 中提供签名和公证所需环境变量。示例里的值用占位符表示，不要把真实私钥写入命令历史或提交到仓库：

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: <Developer Name> (<TEAM_ID>)'
export APPLE_API_KEY='<KEY_ID>'
export APPLE_API_ISSUER='<ISSUER_UUID>'
export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8"
```

构建 Apple Silicon DMG：

```bash
pnpm install --frozen-lockfile
pnpm exec tauri build --target aarch64-apple-darwin --bundles dmg
```

构建产物通常在：

```text
target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
```

如果需要手动公证和 staple，可以对最终 DMG 执行：

```bash
DMG="target/aarch64-apple-darwin/release/bundle/dmg/Hermes Agent CN Desktop_0.2.2_aarch64.dmg"

xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
```

验证成功时，`stapler validate` 应显示 `The validate action worked!`，`spctl` 应显示 `accepted` 和 `source=Notarized Developer ID`。如果本机 Gatekeeper 被关闭，`spctl` 可能额外输出 `override=security disabled`，这只说明本机安全策略状态，不代表包没有公证；判断重点仍然是 `accepted`、`source=Notarized Developer ID` 和 `origin=Developer ID Application: ...`。

如需检查 `.app` 内部签名，可以挂载 DMG 后执行：

```bash
APP="/Volumes/Hermes Agent CN Desktop/Hermes Agent CN Desktop.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP"
spctl -a -vvv -t execute "$APP"
```

## 七、常见问题

如果误选了 `Mac App Distribution`，直分发时应重新创建 `Developer ID Application` 证书。Mac App Store 证书和 Developer ID 证书的使用场景不同，不能互相替代。

如果误选了 `Developer ID Installer`，只有在项目产出 `.pkg` 安装器时才有用。本项目当前发布 `.dmg`，默认不需要这张证书。

如果 GitHub Actions 里提示找不到签名身份，通常是 `APPLE_CERTIFICATE` 不是带私钥的 `.p12`，或者 `APPLE_CERTIFICATE_PASSWORD` 不匹配。仅上传 `.cer` 不够，因为 `.cer` 只有公钥证书，没有私钥。

如果 notarytool 返回签名无效或 entitlement 问题，应先确认构建产物不是 debug 配置，并检查是否带了 `com.apple.security.get-task-allow=true`。公证要求使用 Developer ID 类型证书、启用 Hardened Runtime、签名带时间戳，并且所有可执行文件都要有有效签名。

如果 release 创建时报 `Resource not accessible by integration`，先检查仓库 Actions 的 workflow token 权限是否允许 `contents: write`，以及 workflow 顶部是否有 `permissions: contents: write`。只有这些都不能解决时，再配置可选的 `RELEASE_TOKEN`。

如果 `.p8` 丢失，App Store Connect 不支持再次下载同一把私钥，只能废弃旧 key 并重新生成。重新生成后要同步更新 `APPLE_API_KEY`、`APPLE_API_ISSUER` 和 `APPLE_API_PRIVATE_KEY`。

## 八、安全边界

证书私钥、`.p12` 密码和 `.p8` 内容都属于发布凭据，任何时候都不应写进源码、文档、issue、PR 评论或日志。文档里只允许写 secret 名称和占位符。CI 日志中如果需要排查，也只打印文件是否存在、证书 identity 是否匹配、notarytool 的 submission id 和状态，不打印 secret 内容。

证书或 API key 泄漏后，应立即在 Apple Developer / App Store Connect 后台撤销，并重新生成 GitHub Secrets。撤销 Developer ID 证书会影响后续安装和运行信任链，处理前要评估已经发布版本的影响。

## 九、官方参考

- [Apple Developer：Developer ID](https://developer.apple.com/support/developer-id/)
- [Apple Developer：Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple Developer：Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple Developer：Customizing the notarization workflow](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/customizing_the_notarization_workflow)
