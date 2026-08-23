# Vision & Image Paste — Python → TypeScript Rewrite Plan

## 1. Summary

把 Python 后端的「视觉 + 图片粘贴」能力整体搬进 Desktop TS 前端，最终去掉
Dashboard `/api/ws` + REST 依赖：

- **剪贴板图片粘贴**：桌面 Composer 里 Ctrl+V / 粘贴按钮（对应 CLI 的
  `/paste`、BracketedPaste / Ctrl+V / Alt+V 绑定）读取剪贴板图片，多图可连续
  附加，显示 `[📎]` badge，提交时作为 OpenAI 风格 `image_url` content part
  发给模型。
- **vision-capable vs text-only 路由**：`decide_image_input_mode`（auto /
  native / text）移植为 TS；视觉模型走原生像素（`image_url` data URL），
  纯文本模型走 `vision_analyze` 文本描述注入。
- **vision_analyze 工具**：双路径 — 主模型视觉可用且 provider 支持图片工具结果
  时走 native fast path（`_multimodal` 信封），否则调用辅助视觉模型描述后回传文本。
- **多图附加**：CLI 已支持多图（每张一个 badge、`_image_counter`），桌面端
  Composer 已有 attachment tray，补上多图 + 剪贴板来源即可。

设计目标：粘贴、归一化（MIME sniff / 转码 / 尺寸与字节预算）、路由决策、
`vision_analyze` 全部在前端进程内完成；Rust 只保留 OS 能力（剪贴板插件、
文件选择、HTTP 代理）。

## 2. Current Python implementation

### 2.1 剪贴板粘贴（CLI）

- `D:/hermes-agent-cn/cli.py`
  - `_try_attach_clipboard_image()`（~L7725）：调
    `hermes_cli.clipboard.save_clipboard_image`，存到
    `~/.hermes/images/clip_<ts>_<n>.png`，追加到 `self._attached_images`，
    `_image_counter` 递增。
  - 粘贴入口：BracketedPaste handler（`handle_paste` ~L16745，仅
    image-only/空粘贴才自动附加）、`c-v` 兜底（~L16811）、`escape v`
    Alt+V（~L16825）、`/paste` 命令（~L10531）、
    `_should_auto_attach_clipboard_image_on_paste`（L3559）。
  - 多图 badge：`_format_image_attachment_badges`（L3526）；Ctrl+C 清空。
  - 路径附加：`_detect_file_drop`（L3454）、`_resolve_attachment_path`
    （L3380）、`_collect_query_images`（L3916）。
  - 消息形状兼容：`_prepend_note_to_message`（L3253）处理 str 与
    `[{"type":"text"},{"type":"image_url"}]` 列表。
- `D:/hermes-agent-cn/hermes_cli/clipboard.py`
  - `save_clipboard_image(dest)` / `has_clipboard_image()`；平台后端：
    macOS（pngpaste → osascript）、Windows/WSL（PowerShell
    `System.Windows.Forms.Clipboard` → `Get-Clipboard -Format Image` →
    FileDropList 图片文件）、Linux（wl-paste / xclip）；文本写入
    `write_clipboard_text`（pbcopy → Set-Clipboard → wl-copy → xclip → xsel）。

### 2.2 路由与消息构建

- `D:/hermes-agent-cn/agent/image_routing.py`
  - `decide_image_input_mode(provider, model, cfg)`：`agent.image_input_mode`
    显式 auto/native/text；auto 时 `_lookup_supports_vision`（用户
    `supports_vision` 覆盖 → models.dev `get_model_capabilities` → Ollama
    `/api/tags` 探测）为 True → `"native"`；否则有显式 `auxiliary.vision` →
    `"text"`。
  - `build_native_content_parts(user_text, image_paths, image_urls)`：产出
    OpenAI 风格 content 列表，本地路径读盘 → magic-byte sniff →
    `_UNIVERSALLY_SUPPORTED_MIMES` 外转码 PNG（Pillow / pillow-heif /
    pillow-avif）→ base64 data URL；远程 URL 透传；文本部分附加
    `[Image attached at: …]` 提示。
  - `extract_image_refs(text)`：正则提取本地路径 / 图片 URL，跳过代码块。
- `D:/hermes-agent-cn/run_agent.py`：`_try_shrink_image_parts_in_messages`
  （L7333）在 provider 首次拒绝后按 `_RESIZE_TARGET_BYTES`（5MB）缩小重试
  （reactive 策略，不预设各 provider 上限表）。

### 2.3 vision_analyze 工具与源解析

- `D:/hermes-agent-cn/tools/vision_tools.py`（2221 行）
  - `vision_analyze_tool(image_url, user_prompt, model, task_id, region)`
    （L1299）：`tools.image_source.resolve_image_source` → 归一化
    （`_normalize_to_supported_image`，SVG→PNG rasterize）→ 可选
    `region` 裁剪（`_crop_image_region`）→ base64 → 辅助 LLM 描述
    （`agent.auxiliary_client.async_call_llm`，OpenRouter/Nous/Codex/Anthropic/
    custom OpenAI 兼容）。
  - Native fast path `_vision_analyze_native`（L1142）+
    `_build_native_vision_tool_result`（L1069）：返回
    `{_multimodal: true, content: [text, image_url], text_summary, meta}`。
  - 尺寸护栏：`_MAX_BASE64_BYTES`=20MB 硬顶、`_EMBED_TARGET_BYTES`=4MB、
    `_EMBED_MAX_DIMENSION`=7900px（防 Anthropic 5MB/8000px 不可变历史毒化）、
    `_VISION_MAX_DOWNLOAD_BYTES`=50MB、CPU burst 线程池
    `_vision_cpu_executor`（encode/resize 限核数并发）。
  - `VISION_ANALYZE_SCHEMA`（L1714）+ 工具注册（L1798）。
- `D:/hermes-agent-cn/tools/image_source.py`
  - `resolve_image_source(src, ctx, permitted=("image",))`：统一
    data:/http(s)/file/local/container 解析；SSRF（`tools.url_safety`）、
    50MB ingest 上限、凭据文件守卫（`agent.file_safety`）、非本地终端后端
    sandbox 内 exec-read 兜底。
- `D:/hermes-agent-cn/gateway/run.py`
  - `_enrich_message_with_vision`（L23043）：text 模式 — 每个图片用
    `vision_analyze_tool` 描述并 prepend 文本（含 `sanitize_context` 防
    memory-context 泄漏），是 gateway（Telegram/Discord）的等效路径。

### 2.4 文档

- `D:/hermes-agent-cn/website/docs/user-guide/features/vision.md`：
  `/paste`、Ctrl+V、平台兼容表、SSH 限制、路由表（视觉模型→像素 /
  文本模型→vision_analyze 描述）、`vision_analyze` 双行为。

## 3. Target TypeScript design

### 3.1 模块布局（web/src 或 packages/*）

```
web/src/lib/
  image-mime.ts            # 移植 kimi-code utils/image/image-mime.ts（魔数 sniff + 尺寸）
  image-normalize.ts       # 非支持格式转 PNG（canvas 路径 / wasm 解码器 / 拒绝+提示）
  image-compress.ts        # 移植 kimi-code image-compress.ts 的像素+字节预算缩小
  image-source.ts          # resolveImageSource（data:/http/file）→ Uint8Array + mime
  vision-routing.ts        # decideImageInputMode + buildNativeContentParts + extractImageRefs
  vision-analyze.ts        # vision_analyze 工具（native fast path + aux 描述）
  image-paste.ts           # 剪贴板/粘贴事件 → File/Uint8Array（扩展现有 clipboard-image.ts）
  image-attachment-store.ts# 多图附加 store（Jotai atom）+ badge/清除逻辑
packages/protocol/src/hermes-api.ts  # 扩展 image part（bytes/data/mimeType 完整字段）
web/src/hooks/use-image-attachments.ts  # Composer 集成 hook
web/src/hooks/use-vision-model.ts        # 当前模型 supportsVision 能力读取
```

### 3.2 核心接口（伪签名，非实现代码）

```ts
// image-mime.ts
type SupportedImageMime = 'image/png'|'image/jpeg'|'image/gif'|'image/webp';
function parseImageMeta(bytes: Uint8Array): { mime: SupportedImageMime; width: number; height: number } | null;

// vision-routing.ts
type ImageInputMode = 'auto'|'native'|'text';
function decideImageInputMode(opts: {
  provider: string; model: string;
  cfg?: HermesConfig;            // in-process config（原 config.yaml）
  catalog?: ProviderCatalog;     // provider-catalog.ts，含 supportsVision
}): 'native'|'text';
function buildNativeContentParts(
  userText: string,
  images: PendingImage[],        // { bytes | path | url, mime, name }
): { content: ContentPart[]; skipped: string[] };
function extractImageRefs(text: string): { localPaths: string[]; urls: string[] };

// vision-analyze.ts
async function visionAnalyze(opts: {
  imageUrl: string; userPrompt: string;
  model?: string; region?: [x,y,w,h];
  activeModel: { provider: string; model: string; supportsVision: boolean };
}): Promise<ToolResult>;  // native _multimodal 信封 或 { success, analysis }
```

### 3.3 数据流（无 Python 后端）

1. 用户粘贴：composer `onPaste` → `imageFileFromClipboardData` /
   `readClipboardImageAsFile`（`@tauri-apps/plugin-clipboard-manager.readImage`）
   → `image-mime.ts` sniff → `image-attachment-store` 追加（多图）。
2. 提交：`vision-routing.decideImageInputMode`（读 `provider-catalog.ts`
   的 `supportsVision`，替代 models.dev）：
   - `native` → `buildNativeContentParts` 产出 `[{type:'text'}, {type:'image_url',url:dataUrl}]`。
   - `text` → 对每张图调 `visionAnalyze`（aux 模型）→ 描述文本 prepend 到用户文本。
3. 发送：走 OpenAI 兼容 chat.completions（Rust `api_request` 代理或
   in-process transport），不再依赖 WS `prompt.submit` 的 `images` 数组语义
   （该数组当前只传路径字符串）。
4. `vision_analyze` 工具调用：in-process `visionAnalyze` — 主模型视觉可用 → 返回
   `_multimodal` 信封让主模型看到像素；否则 aux 描述文本。

## 4. Data models & persistence

- **PendingImage / ComposerAttachment**（内存，不落盘）：`{id, source:'clipboard'|'browser'|'path', bytes?: Uint8Array, file?: File, mime?, name, previewUrl?}`；会话内多图顺序保留，提交后清空。
- **消息 content part**：`packages/protocol` 的 `HermesImageMessagePart`（已存在，
  L329）保持 `type:'image'` + `url/src/path/data/mimeType`；新增可选
  `bytes?: string`（data URL）字段，供 in-process 发送直接消费，同时兼容后端历史。
- **持久化**：历史消息图片不把大 data URL 写库 — 存文件路径 + 缩略图引用，
  渲染沿用 `message-image.tsx` 的 `fetchMediaDataUrl` 懒加载；文件落在 app data
  `images/`（镜像 `~/.hermes/images`），由 Rust 侧写入（可复用 file_dialogs /
  api_proxy 的路径能力）。schema 迁移：`HermesImageMessagePart` 增加
  `bytes`/`data` 字段（`.optional()`，向后兼容）；`PromptSubmitParams.images`
  保留但标记 deprecated。
- 无 SQLite 新增表；仅本地消息缓存（IndexedDB）存 part 结构。

## 5. Third-party library strategy

| Python 依赖 | TS 等价 | kimi-code 证据 |
|---|---|---|
| Pillow（转码/缩放/裁剪） | `jimp` + wasm WebP 解码；浏览器 canvas（零依赖转 PNG） | `packages/agent-core/src/tools/support/image-compress.ts`（Jimp 解码重编码、`webp-decode.ts`）；Desktop 已有 `encodeRgbaToPngFile`（canvas） |
| 魔数 MIME sniff（`_sniff_mime_from_bytes`） | 手写 `image-mime.ts`（magic bytes + 尺寸） | `apps/kimi-code/src/utils/image/image-mime.ts`（PNG/JPEG/GIF/WebP） |
| pybase64 / base64 | `Buffer.toString('base64')` / `atob` | kimi-code 全仓用 Buffer |
| httpx（图片下载 + SSRF 守卫） | fetch + redirect 循环 + IP allowlist（移植 `tools/url_safety.py`） | kimi-code 无直接等价（其读图走本地文件/剪贴板）→ **实现 from scratch** |
| xclip / wl-paste / powershell.exe / osascript | `@tauri-apps/plugin-clipboard-manager`（`readImage()`，Desktop 已用）；Linux/WSL 兜底可仿 kimi-code 的 `runCommandAsync` | `apps/kimi-code/src/utils/clipboard/clipboard-{image,common,native}.ts`；`@mariozechner/clipboard` 原生绑定 |
| models.dev 能力元数据 | `web/src/lib/provider-catalog.ts` 的 `supportsVision`（已存在）+ 配置覆盖 | `packages/agent-core/src/services/modelCatalog/` 目录 |
| prompt_toolkit bracketed paste | DOM `paste` 事件 + clipboard-manager 插件 | kimi-code `tui/controllers/editor-keyboard.ts`（编辑区粘贴） |
| `auxiliary.vision`（OpenRouter/Nous/…） | OpenAI 兼容 chat.completions 调用（复用 `transport.ts` / Rust `api_request`） | kimi-code `services/prompt/promptService.ts` 的 LLM 调用模式 |
| 格式策略（闭集 + 拒绝提示） | 移植 `image-format-policy.ts` 的 `MODEL_ACCEPTED_IMAGE_MIMES` + notice | `packages/agent-core/src/tools/support/image-format-policy.ts`（直接证据） |
| 尺寸预算（4MB embed / 7900px） | 移植 `image-compress.ts` 的 `IMAGE_BYTE_BUDGET` / `MAX_IMAGE_EDGE_PX` | 同上 image-compress.ts |

**无 TS 等价的明确项**：
1. **容器 sandbox exec-read 兜底**（`image_source.py::_resolve_container_fallback`）—
   桌面 standalone 无容器终端后端场景，可声明 out of scope（非目标）。
2. **SVG rasterizer（cairosvg / svglib）** — 浏览器无等价；方案：拒绝 + 转换指引
   （与 kimi-code `buildImageConversionGuidance` 一致）。
3. **HEIC/AVIF 解码**（pillow-heif / pillow-avif）— 浏览器 canvas 不能解；
   方案：Rust 侧 `image` crate 或拒绝 + 指引，标记为 open question。

## 6. Integration with existing Hermes-CN-Desktop frontend

- **复用**：
  - `web/src/lib/clipboard-image.ts`：`readClipboardImageAsFile`、
    `imageFileFromClipboardData`、`encodeRgbaToPngFile`（已是 Tauri
    clipboard-manager 封装，见 package.json `@tauri-apps/plugin-clipboard-manager ^2.3.2`）。
  - `web/src/lib/message-images.ts`：`extractImagePartsFromUnknown` /
    `imagePartFromSource` — 解析历史消息里的图片 part。
  - `web/src/components/chat/goose-composer.tsx`：已有 `attachClipboardImage`
    （L708）、`addBrowserFiles`、`attachments` state、`AttachmentTray`
    （goose-composer-attachments.tsx）→ 扩展为多图 + 粘贴事件 hook。
  - `web/src/components/chat/message-image.tsx`：历史图片渲染（data URL /
    `fetchMediaDataUrl`）。
  - `web/src/hooks/use-gateway.ts`：`sendPrompt` 已支持 `images: string[]` →
    `prompt.submit`；迁移期保持，之后换 content parts。
  - `packages/protocol/src/hermes-api.ts`：`HermesImageMessagePart` /
    `PromptSubmitParams` 直接扩展。
  - `src/commands/file_dialogs.rs`：`pick_files` 供「附加图片文件」按钮；
    `src/commands/api_proxy.rs` 供下载远程图片 / aux LLM 调用。
  - `web/src/lib/provider-catalog.ts` + `goose-composer-model-picker.tsx`：
    `supportsVision` 已用于 UI 标签，直接作为路由能力来源。
- **新增**：`image-paste.ts`（统一剪贴板来源）、`image-attachment-store.ts`
  （Jotai 多图 store）、`vision-routing.ts`、`vision-analyze.ts`、
  `use-vision-model.ts`（订阅当前模型能力）。

## 7. Removing the WebSocket dependency (migration path)

冻结 API 面（迁移期兼容层）：
- `prompt.submit {session_id, text, images: string[]}`（旧）→
  `prompt.submit {session_id, content: ContentPart[]}`（新，含 image_url data URL）。
- `HermesImageMessagePart` 的 `type:'image'` + `url/path/data/mimeType` 形状不变。
- `vision_analyze` 工具 schema（`image_url/user_prompt/model/region`）不变。

阶段：
- **Phase A（保留 WS）**：图片在 web 端完成 sniff/转码/压缩，`images` 传本地
  路径或 data URL；Composer 增加 `/paste` 等价按钮 + 多图 badge；后端仍做
  native/text 路由。此阶段仅前端改动。
- **Phase B（并行双轨）**：`vision-routing.ts` 在前端镜像 `decide_image_input_mode`
  （读 provider-catalog，含 config 覆盖）；vision_analyze 的 native fast path
  前端化（`_multimodal` 信封），text 模式 aux 调用走 `api_request`；WS 只保留
  事件流，提交改走 REST content parts。
- **Phase C（删除 WS 提交）**：删除 `prompt.submit` WS 路径；图片附加 →
  in-process content parts；`vision_analyze` 全前端；Rust 仅剩
  clipboard/file/HTTP 代理能力。

## 8. Migration phases & task breakdown

| Phase | 任务 | 涉及文件 |
|---|---|---|
| A1 | 移植 image-mime sniff + 单图粘贴进 composer（复用 attachClipboardImage） | web/src/lib/image-mime.ts、goose-composer.tsx |
| A2 | 多图 attachment store + badge + 清空；图片文件按钮（pick_files） | image-attachment-store.ts、goose-composer-attachments.tsx、file_dialogs.rs |
| A3 | 粘贴事件归一化（paste event + clipboard-manager 兜底），去重 | image-paste.ts（扩 clipboard-image.ts） |
| B1 | vision-routing：decideImageInputMode + buildNativeContentParts + extractImageRefs；接入 provider-catalog.supportsVision | vision-routing.ts、use-vision-model.ts、provider-catalog.ts |
| B2 | 前端图片归一化/压缩（canvas / jimp），unsupported 拒绝提示 | image-normalize.ts、image-compress.ts、image-format-policy.ts（移植） |
| B3 | vision-analyze in-process：image-source + native fast path + aux 调用 | image-source.ts、vision-analyze.ts、transport.ts |
| B4 | protocol 扩展 content parts + PromptSubmitParams 新形状；sendPrompt 迁移 | packages/protocol/hermes-api.ts、use-gateway.ts |
| C1 | 删除 WS prompt.submit 提交路径，事件流保留；E2E 全绿 | gateway-client.ts、use-gateway.ts、e2e/ |
| C2 | 文档更新（vision.md 桌面版）、清理 deprecated images 数组 | website/ 或 docs/ |

## 9. Risks & open questions

1. **会话毒化（session poisoning）**：不支持格式（HEIC/AVIF/SVG）一旦进不可变
   历史，重发必 400 — 前端必须与 Python 同样在 ingest 点拒绝/转码（kimi-code
   `image-format-policy.ts` 同一原则）。
2. **HEIC/AVIF 浏览器解码**：canvas/jimp 均不支持；需 Rust `image` crate 转码
   命令或拒绝+指引（macOS sips / ImageMagick）。open question：是否引入 wasm
   (heic/avif) 依赖。
3. **Linux/WSL 剪贴板**：`clipboard-manager` 插件在 Linux 的图片支持弱于
   kimi-code 的 wl-paste/xclip/powershell.exe 链；需 Rust command 包装 shell
   兜底（对齐 hermes_cli/clipboard.py 的 PowerShell FileDropList 路径）。
4. **models.dev 能力数据离线化**：provider-catalog 是静态快照，新模型
   supportsVision 可能过期 — 需保留用户 `supports_vision` 配置覆盖（对应
   `_supports_vision_override`）+ Ollama 探测（可选）。
5. **text 模式 enrichment 无 kimi-code 等价**：`_enrich_message_with_vision`
   （每图 aux 描述 + sanitize_context 防泄漏）在 kimi-code 没有直接对应实现，
   需 from scratch 且保留 sanitize 逻辑（parity 见 test_vision_memory_leak.py）。
6. **多图 token/字节预算**：无 Python 的 4MB embed cap 前端等价物需移植
   kimi-code 的 `IMAGE_BYTE_BUDGET`/`MAX_IMAGE_EDGE_PX`，并保留 provider 拒绝后
   缩小重试（`_try_shrink_image_parts_in_messages`）。
7. **SSH/远程会话**：桌面端是本地 Tauri，剪贴板读取天然本地，SSH 限制不复存在
   （docs vision.md 的表格项变为 N/A）——需在 UI 文案确认。

## 10. Test strategy

移植 Python 测试为 vitest 单元 + Playwright E2E 奇偶校验：

| Python 测试 | TS 对应 |
|---|---|
| tests/tools/test_vision_tools.py（sniff/尺寸/size cap/错误分类） | image-mime.test.ts、image-normalize.test.ts |
| tests/tools/test_vision_native_fast_path.py（_multimodal 信封形状） | vision-analyze.test.ts（buildNativeVisionToolResult） |
| tests/tools/test_vision_region.py（region 裁剪） | image-normalize.test.ts（cropImageRegion） |
| tests/agent/test_vision_resolved_args.py、test_vision_routing_31179.py | vision-routing.test.ts（config 覆盖、auto/native/text、OpenAI 别名） |
| tests/run_agent/test_vision_aware_preprocessing.py（native content parts） | buildNativeContentParts.test.ts |
| tests/gateway/test_vision_preprocess.py、test_vision_memory_leak.py | enrichMessageWithVision.test.ts（sanitize_context 防泄漏） |
| tests/test_image_enrich.py（描述注入） | vision-analyze.test.ts（aux 描述 → 文本 prepend） |

- **vitest**：纯函数单元测试（routing 决策表、MIME sniff 向量、压缩预算、
  content parts 构建、native 信封）。
- **Playwright E2E**：复制图片 → 粘贴 → badge 出现 → 提交 → 历史含 image part
  → 视觉模型收到 `image_url`；text-only 模型收到描述文本；多图顺序与去重；
  不支持格式提示不毒化会话。
- **奇偶校验**：用 Python 测试里的固定字节/URL 作为 fixture，断言 TS 输出与
  Python 行为一致。

## 11. Reference links

- Python Core：
  - `D:/hermes-agent-cn/tools/vision_tools.py`
  - `D:/hermes-agent-cn/tools/image_source.py`
  - `D:/hermes-agent-cn/agent/image_routing.py`
  - `D:/hermes-agent-cn/cli.py`（L3253-3943、L7725、L16745-16840）
  - `D:/hermes-agent-cn/hermes_cli/clipboard.py`
  - `D:/hermes-agent-cn/gateway/run.py`（`_enrich_message_with_vision` L23043）
  - `D:/hermes-agent-cn/run_agent.py`（`_try_shrink_image_parts_in_messages` L7333）
  - `D:/hermes-agent-cn/website/docs/user-guide/features/vision.md`
  - Tests：tests/tools/test_vision_tools.py、test_vision_native_fast_path.py、
    test_vision_region.py、tests/agent/test_vision_resolved_args.py、
    test_vision_routing_31179.py、tests/run_agent/test_vision_aware_preprocessing.py、
    tests/gateway/test_vision_preprocess.py、test_vision_memory_leak.py、
    tests/test_image_enrich.py
- kimi-code TS：
  - `D:/kimi-code/apps/kimi-code/src/utils/image/image-mime.ts`
  - `D:/kimi-code/apps/kimi-code/src/utils/clipboard/clipboard-image.ts`
  - `D:/kimi-code/apps/kimi-code/src/utils/clipboard/clipboard-common.ts`
  - `D:/kimi-code/apps/kimi-code/src/utils/clipboard/clipboard-native.ts`
  - `D:/kimi-code/apps/kimi-code/src/tui/components/media/image-thumbnail.ts`
  - `D:/kimi-code/packages/agent-core/src/services/message/message.ts`
  - `D:/kimi-code/packages/agent-core/src/tools/support/image-compress.ts`
  - `D:/kimi-code/packages/agent-core/src/tools/support/image-format-policy.ts`
- Desktop：
  - `D:/Hermes-CN-Desktop/web/src/lib/clipboard-image.ts`
  - `D:/Hermes-CN-Desktop/web/src/lib/message-images.ts`
  - `D:/Hermes-CN-Desktop/web/src/hooks/use-gateway.ts`（sendPrompt L458）
  - `D:/Hermes-CN-Desktop/web/src/hooks/use-mic-recorder.ts`（hook 模式参考）
  - `D:/Hermes-CN-Desktop/web/src/components/chat/goose-composer.tsx`、
    goose-composer-attachments.tsx、message-image.tsx、message-adapter.ts
  - `D:/Hermes-CN-Desktop/web/src/lib/provider-catalog.ts`（supportsVision）
  - `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts`
    （HermesImageMessagePart L329、PromptSubmitParams L1307）
  - `D:/Hermes-CN-Desktop/src/commands/file_dialogs.rs`、api_proxy.rs
