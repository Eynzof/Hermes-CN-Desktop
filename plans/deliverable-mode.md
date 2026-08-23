# Deliverable Mode — Python → TypeScript Rewrite Plan

## 1. Summary

Deliverable mode 是 gateway 的“文件即附件”能力：agent 在回复里写出生成文件的
绝对路径（`/tmp/q3.png`、`~/report.pdf`、`C:\out\data.xlsx` 或显式 `MEDIA:<path>`
标签），gateway 自动扫描、校验路径安全性、按扩展名分类，并通过平台原生 API 上传为
图片 / 视频 / 音频 / 文件附件，同时把路径从可见文本里抹掉。当前实现分散在
`gateway/platforms/base.py`（扫描+分类+校验）、`gateway/stream_consumer.py`
（流式文本显示前剥离指令）、`gateway/run.py`（流结束后附件派发）、`gateway/delivery.py`
（cron/kanban 投递）。本计划把它移植为 **in-process TypeScript 模块**
（`web/src/features/deliverables/`）+ **Rust fs 读取/上传命令**，最终删除
Dashboard `/api/ws` 对托管 Python 运行时的依赖。核心设计：
(1) 三个提取器（markdown 图片 URL / 显式 `MEDIA:` 标签 / 裸绝对路径自动检测）
逐一移植为带相同保护语义的 TS 正则与 mask 逻辑；(2) 上传管线复用现有 Rust
`api_proxy.rs::upload_file` 模式（base64 → multipart `POST /api/upload`），
并新增“先读本地文件字节再上传”的原生命令；(3) 消息协议新增
`HermesFileMessagePart`，渲染端复用 `message-image.tsx` 的本地文件读取模式
（`/api/media?path=`）。

## 2. Current Python implementation

Source of truth under `D:/hermes-agent-cn`（行号为读取时核对）：

- **扩展名目录（单一事实源）** — `gateway/platforms/base.py`
  - `MEDIA_DELIVERY_EXTS`（行 1882）：图片 `.png .jpg .jpeg .gif .webp .bmp .tiff .svg`、
    视频 `.mp4 .mov .avi .mkv .webm .3gp`、音频 `.mp3 .m2a .wav .ogg .opus .m4a .flac`、
    文档 `.pdf .docx .doc .odt .rtf .txt .md .epub`、数据 `.xlsx .xls .ods .csv .tsv
    .json .xml .yaml .yml`、地理 `.kmz .kml .geojson .gpx`、演示 `.pptx .ppt .odp .key`、
    压缩包 `.zip .tar .gz .tgz .bz2 .xz .7z .rar .apk .ipa`、Web `.html .htm`；
    故意排除 `.py .log` 等源码扩展名。
  - 由它构建的两个正则（保证不会漂移）：
    `MEDIA_TAG_CLEANUP_RE`（行 1942，锚定 `MEDIA:<path>`，仅已知扩展名才剥离）、
    `MEDIA_EXTENSIONLESS_TAG_RE`（行 1978，无扩展名/未知扩展名路径，经
    `validate_media_delivery_path` 校验后才投递，#36060）。
  - **提取器**：`extract_images`（行 4425，markdown/HTML 图片 URL）、
    `extract_media`（行 4870，`MEDIA:` 标签 + `[[audio_as_voice]]`/`[[as_document]]`
    指令）、`extract_local_files`（行 5006，裸绝对路径自动检测：
    `(?<![/:\w.])(?:~/|/|[A-Za-z]:[/\\])(?:[\w.\-]+[/\\])*[\w.\-]+\.(?:ext)\b`
    + `os.path.isfile()` + 排除 fenced/inline code 区间，路径去重后从文本中删除）。
  - **保护掩码**：`_mask_protected_spans`（行 4779，fenced code / inline code /
    blockquote 替换为空格）、`_mask_json_string_media`（行 4830，JSON 字符串值里的
    `MEDIA:` 不投递，#34375）。掩码只用于定位，剥离时保留原文（#16434）。
  - **安全校验**：`validate_media_delivery_path`（行 1684，默认非严格模式只拦
    凭据/系统路径 denylist；`HERMES_MEDIA_DELIVERY_STRICT=1` 严格模式要求 allowlist
    + 600s recency 窗口）、`_media_delivery_denied_paths`（行 1362，`/etc /proc /sys
    /root ...` + `~/.ssh .aws .gnupg .kube .docker .config ...` + `~/.hermes` 下
    `.env/auth.json/config.yaml/...` 等凭据文件）、`_translate_docker_container_media_path`
    （行 1616，容器路径 → 宿主路径最长前缀翻译）。
  - `filter_media_delivery_paths`（行 4752）/ `filter_local_delivery_paths`（行 4765）
    对提取结果逐条校验并归一化。
  - 派发分类：`should_send_media_as_audio`（行 170，Telegram 只把 MP3/M4A 当音频附件、
    Opus/OGG 仅 `is_voice` 时走 voice）；发送 API 基类方法 `send_image_file` /
    `send_multiple_images` / `send_video` / `send_voice` / `send_document` /
    `send_animation`。
  - 非流式主链路 `_process_message_background`（行 6295–6363）：`extract_media`
    → `filter_media_delivery_paths` → `extract_images` → `extract_local_files`
    （非 ephemeral 才跑，行 6330）→ `filter_local_delivery_paths` →
    session 历史去重（`_history_media_paths`，行 6344–6361，#73771 只作用于裸路径）。

- **流式 consumer** — `gateway/stream_consumer.py`
  - `_clean_for_display`（行 1253）：显示/编辑前剥离 `MEDIA:` 与指令标签
    （`strip_media_directives_for_display`，未知扩展名路径若校验不过则保留可见）。
  - `_send_or_edit`（行 2088）开头即 `text = self._clean_for_display(text)`（行 2100–2103），
    注释明确“媒体在流结束后由 `gateway/run.py::_deliver_media_from_response` 投递”。

- **流后附件派发** — `gateway/run.py`
  - `_deliver_media_from_response`（行 20819）：**EXPLICIT-ONLY**（#20834）——
    只重新扫描 `MEDIA:` 标签，**不跑** `extract_local_files`（裸路径已在流式文本里
    展示过，不再补投）。`[[as_document]]` 时图片改走 `send_document`（保留原字节）。
    分类：`_IMAGE_EXTS` 批量 `send_multiple_images`；音频按
    `should_send_media_as_audio` 走 `send_voice`；视频走 `send_video`；其余
    `send_document`（行 20880–20931）。
  - 会话级自动追加标签去重在 `_collect_auto_append_media_tags`（#73771），与显式
    `MEDIA:` 分开处理。

- **投递路由（cron/kanban）** — `gateway/delivery.py`
  - `DeliveryRouter.deliver()`（行 318）按目标（origin/local/platform:chat）派发；
    `_deliver_local` 保存到文件。Kanban 的 `kanban_complete(artifacts=[...])` 由
    `gateway/kanban_watchers.py` 在完成通知时把每个 artifact 作为附件上传
    （文档 `features/deliverable-mode.md` 第 79–99 行）。

- **文档**：`D:/hermes-agent-cn/website/docs/user-guide/features/deliverable-mode.md`
  （134 行）描述了机制、支持扩展名表、agent 行为引导、kanban artifacts、MCP 对照。

- **测试（parity 来源）**：features_report.md 声称 `tests/gateway/test_deliverable*.py`，
  **该 glob 实际不存在**；真实覆盖分散在：
  `tests/gateway/test_73771_media_resend_dedup.py`（显式 MEDIA 不按历史去重、裸路径
  去重且记录日志）、`test_media_spaced_paths_and_history_dedupe.py`（带空格路径 +
  历史去重）、`test_media_tag_formatting_variants.py`（标签格式变体）、
  `test_platform_base.py`（提取/校验单测）、`test_api_server_media_data_urls.py`
  （API server 的 MEDIA→data-URL 解析）。

## 3. Target TypeScript design

目标：全部在 webview 进程内运行（TS 宿主 agent runtime），Rust 仅提供 OS 能力
（读文件字节、上传 HTTP、路径元数据）。新模块布局：

```
web/src/features/deliverables/
  ext-catalog.ts        DELIVERABLE_EXTS + 分类表（与 base.py:1882 完全一致）
  extract.ts            extractImages / extractMedia / extractLocalFiles（TS 移植）
  mask.ts               maskProtectedSpans / maskJsonStringMedia（定位用，原样保留文本）
  validate.ts           validateDeliveryPath / allowedRoots / deniedPaths / recency
  classify.ts           ext → {category, sendMode}（image-batch/voice/video/document）
  uploader.ts           DeliverableUploader（串行/并发上传 + 事件发射）
  events.ts             DeliverableEvent 类型 + attachment.started/complete/failed
  history.ts            session 级已投递路径去重（对应 _history_media_paths，#73771）
  index.ts              对外门面：scanAndDeliver(response, messageCtx)
src/ (Rust)
  commands/deliverable.rs  read_file_bytes / upload_file_deliverable（新增）
```

- **`extract.ts` 关键语义（移植时不得丢失）**：
  - `extractMedia`：先对全文跑 `maskProtectedSpans` + `maskJsonStringMedia`（仅定位），
    用 `MEDIA_TAG_CLEANUP_RE` 等价 RegExp 收集 `(path, isVoice)`，扩展名不匹配的
    路径走 `MEDIA_EXTENSIONLESS_TAG_RE` + `validateDeliveryPath`（带空格路径最多向前
    延伸 8 个 token，#24032）；删除标签时按合并后的 span 反向删除（`_merge_spans`）。
  - `extractLocalFiles`：路径正则等价移植 + `fileExists()`（Rust IPC 异步）+
    code-span 排除 + 按展开后路径去重（首见优先，#29131）。
  - `extractImages`：markdown/HTML 图片 URL（用于与后端一致地从 cleaned 文本再剥离）。
  - 指令 `[[audio_as_voice]]` 只对音频扩展名生效；`[[as_document]]` 消息级作用于
    所有图片路径（`run.py:20846-20896` 语义）。
- **消费时机（与 Python 对齐）**：
  - 非流式：最终响应文本在“发送给用户”之前先过
    `scanAndDeliver`（提取+分类+上传），可见文本用清理后的版本。
  - 流式：`DeliverableUploader` 在最终消息 finalize 后执行，且**只处理显式
    `MEDIA:` 标签**（保留 #20834 EXPLICIT-ONLY 语义），避免把用户已看到的裸路径
    二次上传。
  - Kanban/任务完成通知：`notify.completed` 事件的 `artifacts` 数组直接进入同一
    uploader（绕过文本扫描）。
- **上传管线**：
  - `Rust read_file_bytes(path) -> { bytes_b64, size, mtime }`（带
    15 MiB 默认上限，参照 `api_proxy.rs` 的 `ensure_upload_decoded_size`）。
  - `upload_file_deliverable(file)`：复用 `api_proxy.rs::upload_file_impl` 的
    multipart `POST {apiBase}/api/upload`（base64 → `reqwest::multipart::Part`），
    带 `session_id/name/type`。TS 侧 `uploader.ts` 负责大小检查、重试（2 次指数退避）、
    事件发射。
  - 渲染端不再依赖“上传后回读”，附件一经上传即把 `HermesFileMessagePart` 追加进
    消息 parts（`url` 指向 `/api/media?path=<localPath>` 或上传返回的远端标识）。

## 4. Data models & persistence

- **协议扩展**（`packages/protocol/src/hermes-api.ts`，当前 `HermesMessagePart`
  是 7 个成员的 discriminated union，行 384–393）新增：
  ```ts
  HermesFileMessagePart = z.object({
    type: z.literal("file"),
    name: z.string(),            // fileNameFromPath
    path: z.string().optional(), // 仅本地附件保留，渲染时经 /api/media 读取
    mimeType: z.string().optional(),
    size: z.number().optional(),
    category: z.enum(["image","video","audio","document","data","archive","web"]).optional(),
    status: z.enum(["uploading","complete","failed"]).optional(),
    url: z.string().optional(),  // 上传成功后的可访问地址 / data-url
    error: z.string().optional(),
  });
  ```
  并在 `HermesMessagePart` union 中追加；`HermesUIMessage.parts` 无需变更。
- **持久化**：附件作为消息 content JSON 的一部分随 `session-log` 序列化
  （`packages/protocol/src/session-log.ts` 已存在），不新增 SQLite 表；
  但**新增 session 级去重集合** `deliveredAttachmentPaths: Set<string>`（内存 +
  session-log 快照字段 `delivered_attachment_paths?: string[]`），对应 Python
  `_history_media_paths`（#73771）：只作用于裸路径自动检测，显式 `MEDIA:` 永远放行。
- **迁移**：不引入 schema migration —— `HermesFileMessagePart` 是追加式 union
  成员，旧消息无此 part，Zod 解析天然兼容。

## 5. Third-party library strategy

| Python 依赖/能力 | TS 等价 | kimi-code 证据 |
|---|---|---|
| `re`（MEDIA_TAG_CLEANUP_RE 等） | JS `RegExp`（逐字移植；注意 JS 无 `re.IGNORECASE` 等价用 `i` flag；`\b`、`(?:)`、lookbehind 均支持） | `web/src/lib/message-images.ts` 已用等价正则做图片扫描（`MARKDOWN_IMAGE_RE` 行 6、`BARE_IMAGE_RE` 行 7）；kimi-code `agent-core-v2/src/agent/tools/read-media-file/readMediaFileTool.ts` 使用 RegExp 处理媒体引用 |
| `os.path.isfile` / `Path.stat`（存在性、mtime、size） | **无纯 TS 等价**（webview 无法直接 fs）；实现 Rust `read_file_bytes`/`file_meta` Tauri 命令 | kimi-code `packages/kap-server/src/lib/promptMedia.ts` 证明 TS 侧通过 `IFileService`/`ISessionMediaStore` 抽象文件访问（`store.get(file_id)`），Desktop 已有 `fetchMediaDataUrl(path)` → `/api/media?path=`（`transport.ts:168`） |
| `httpx` multipart 上传 | Rust `reqwest::multipart`（现有 `api_proxy.rs::upload_file_impl` 行 1069–1121） | kimi-code 上传走 daemon HTTP（`buildDaemonFileUrl`，`promptMedia.ts` 行 77）；Desktop 已有完整 base64→multipart 通道可复用 |
| MIME/类型判定（扩展名表） | TS 常量映射 `ext-catalog.ts`（零依赖） | kimi-code `agent-core-v2` 有 `normalizeImageMime`/`resolveEffectiveImageMime`（`promptMedia.ts` 导入），但本项目仅需扩展名映射 |
| 图片本地渲染 | 现有 `web/src/components/chat/message-image.tsx` + `fetchMediaDataUrl` | kimi-code `apps/kimi-code/src/utils/image*` 有图片压缩/转换工具（README 提及），Desktop 无需引入 |

**“No TS equivalent found” 明确列出**：① 扫描式 deliverable 本身（MEDIA: 标签语法 +
裸路径自动检测 + mask 语义）在 kimi-code 中**没有对应实现**——kimi-code 只有
**入站**附件物化（用户上传 → session attachments dir，见 `kap-server/test/skills.test.ts`
行 919–1002 “materializes an uploaded SVG image as a path-referenced attachment”），
没有“agent 回复里的绝对路径 → 自动上传”的出站功能；② `validate_media_delivery_path`
的严格模式 allowlist/recency/Docker 容器路径翻译无现成 TS 库，需按本计划从零实现
（桌面单用户场景可先只保留 denylist 分支）。其余均为现有 Rust/TS 能力组合。

## 6. Integration with existing Hermes-CN-Desktop frontend

- **复用**：
  - `web/src/lib/message-images.ts`：`isLikelyLocalFilePath`（行 78）、
    `normalizeLocalFilePath`（行 90）、`safeImageSrc`（行 124）、
    `extractMarkdownImageParts`/`extractBareImageParts`（行 194/212）作为
    `extract.ts` 的图片部分参考实现（当前仅图片扩展名，本特性需扩展到全部
    `MEDIA_DELIVERY_EXTS`）。
  - `web/src/lib/composer-prompt.ts`：`isImagePath`（行 34）、`fileNameFromPath`
    （行 41）。
  - `web/src/components/chat/message-adapter.ts`：后端消息 → `ChatMessage` parts 的
    适配点，新增 file part 分支。
  - `web/src/components/chat/chat-types.ts`：新增 `ChatFileItem`（仿 `ChatImageItem`）。
  - `web/src/components/chat/message-timeline.tsx`：附件卡片渲染插槽。
  - `web/src/lib/transport.ts`：`fetchMediaDataUrl`（行 168）与 `POST /api/upload`
    （行 383）——迁移期复用，最终由 Rust 命令直连。
  - `src/commands/api_proxy.rs`：`upload_file`（行 1126）/ `upload_file_impl`
    （行 1069）/ `UploadFileInput`（行 1139）——新增 `deliverable.rs` 复用其
    multipart 逻辑并加 fs 读取。
  - `packages/protocol/src/hermes-api.ts`：扩展 `HermesMessagePart`。
- **替换**：无现有前端 deliverable 逻辑可删；`message-images.ts` 的裸图片正则将被
  `extract.ts` 统一目录替代（保留导出兼容层避免破坏现有调用点）。

## 7. Removing the WebSocket dependency (migration path)

今天：Python gateway 在流结束后经 `_deliver_media_from_response` 上传附件，
Desktop 只通过 WS 收到最终消息文本（附件已在后端完成，前端仅渲染）。
迁移分三阶段：

1. **Phase A（keep backend）**：Desktop 通过 REST 拿到最终响应文本，在**前端**
   跑 `scanAndDeliver` 预演：只做提取+分类校验，生成
   `HermesFileMessagePart` 追加到消息，但上传仍由后端完成（避免双传）。同时把
   WS 事件面冻结为：`message.completed`（含 `raw_text`）、`attachment.started/
   complete/failed`（新增，供 UI 进度显示）。
2. **Phase B（in-process behind same interface）**：`DeliverableUploader` 变为
   权威实现：Rust 读文件 + `/api/upload` 上传；后端仍可通过配置关闭自己那份上传
   （`deliverables.disable_backend_upload: true`），前端结果与 Phase A 校验一致。
3. **Phase C（delete WS/REST）**：agent runtime 完全 in-process 后，删除
   `gateway-client.ts` 的附件相关事件订阅与 `/api/upload` 回退路径，仅保留
   Rust `read_file_bytes` + `upload_file_deliverable`。冻结接口：
   `DeliverableUploader.scanAndDeliver(text, ctx)`、`DeliverableEvent` 结构、
   `HermesFileMessagePart` 字段，保证 Phase B/C 之间 UI 零改动。

## 8. Migration phases & task breakdown

- **P1 — 协议 + 提取器（纯 TS，无 IO）**
  - `ext-catalog.ts`：移植 `MEDIA_DELIVERY_EXTS` 全表与分类。
  - `extract.ts`/`mask.ts`：移植三个提取器 + 两个 mask；单元测试对照 Python
    正则样例（`test_media_tag_formatting_variants.py` 的格式变体）。
- **P2 — Rust 能力**
  - `src/commands/deliverable.rs`：`file_meta(path)`、`read_file_bytes(path)`、
    `upload_file_deliverable(file)`（复用 `api_proxy.rs` multipart）；大小上限
    15 MiB、denylist 校验可下沉 Rust 或留在 TS。
- **P3 — uploader + 事件**
  - `validate.ts`（先 denylist + 存在性，严格模式/allowlist 后置）、`history.ts`
    （session 去重）、`uploader.ts`（串行队列、重试、事件）；`events.ts` 接入
    `gateway-client.ts` 与 store。
- **P4 — 渲染**
  - `HermesFileMessagePart` 入 protocol；`chat-types.ts`/`message-adapter.ts`/
    `message-timeline.tsx` 附件卡片（图片走 `message-image.tsx` 内联，其余文件卡片 +
    下载）。
- **P5 — 收尾与删后端**
  - 非流式/流式/kanban 三路径统一；parity 测试跑通；Phase C 删除 WS 附件路径。

## 9. Risks & open questions

- **测试证据缺口（已核实）**：`features_report.md` 声称
  `tests/gateway/test_deliverable*.py` 存在，但该 glob **无匹配**。parity 测试必须
  以真实文件为准：`test_73771_media_resend_dedup.py`、`test_media_spaced_paths_and_
  history_dedupe.py`、`test_media_tag_formatting_variants.py`、`test_platform_base.py`。
- **No TS equivalent（最大风险）**：kimi-code 无出站 deliverable 扫描，核心正则与
  mask 语义需从零移植；regex 细节（spaced paths #24032、glued tags #68773、JSON
  掩码 #34375、emoji 长度无关但 `\b` 边界、Windows 反斜杠转义）极易出现行为偏差，
  需以 Python 单测为 golden 逐条对拍。
- **流式 EXPLICIT-ONLY 语义（#20834）**：若 TS 端误把裸路径补投，会出现“模型提了
  一句 /tmp/x.png 但文件不存在/不想发”的噪音附件；必须在 finalize 后路径只认
  `MEDIA:`。
- **Windows 路径**：Python 已支持 `C:\...`（#34632），TS 字符串/正则中的反斜杠
  处理、`/D:/foo` POSIX 风格（`message-images.ts` 行 84）需统一规范化。
- **凭据外泄面**：denylist（`~/.ssh .aws .config`、`~/.hermes/.env auth.json`）
  必须保留；桌面单用户默认非严格模式可接受，但公开 gateway 形态需支持严格模式。
- **大文件与进度**：15 MiB 上限（对齐 `api_proxy.rs`）、base64 膨胀 4/3、流式进度
  事件与上传并发顺序需要 UI 反馈设计（`attachment.started/complete/failed`）。
- **`MEDIA:` 兼容性**：既有 skills（`image_generate`、`tts_tool`、
  `send_message_tool`）会继续输出 `MEDIA:` 标签与 `[[audio_as_voice]]`，TS 端必须
  与 Python 的剥离/投递行为一致，否则老技能在桌面端出现“标签泄漏”或“重复上传”。

## 10. Test strategy

- **vitest 单元（`web/src/features/deliverables/*.test.ts`）**：
  - `extract.test.ts`：把 Python 测试用例翻译为 golden（标签格式变体、spaced
    paths、code-block 内不提取、JSON 字符串值掩码、glued `MEDIA:/a.pngMEDIA:/b.png`、
    大小写扩展名、Windows 盘符路径、去重首见优先）。
  - `validate.test.ts`：denylist 前缀/凭据文件/recency 窗口/不存在文件；严格模式
    allowlist。
  - `classify.test.ts`：扩展名 → 分类/`sendMode` 全表，含 Telegram 音频特例
    （MP3/M4A 音频 vs Opus/OGG voice vs 其余 document）。
- **集成（Rust + TS，mock Tauri IPC）**：`uploader.test.ts` 用注入的
  `readFileBytes`/`uploadFile` 双 mock 验证串行队列、失败重试、事件顺序；Rust 侧
  `#[cfg(test)]` 复用 `api_proxy.rs` 的 `wiremock` 模式验证 multipart 字段。
- **Playwright E2E**：发送含 `MEDIA:/tmp/chart.png` 的合成回复 → 附件卡片出现、
  图片内联渲染（`/api/media`）、文本中路径被移除；大文件失败态显示。
- **Parity 脚本（可选）**：同一组输入文本同时喂 Python `extract_*` 与 TS 提取器，
  对比 `(paths, cleaned)` 输出，作为 CI 回归门禁。

## 11. Reference links

- Python 实现：`D:/hermes-agent-cn/gateway/platforms/base.py`（MEDIA_DELIVERY_EXTS
  :1882、MEDIA_TAG_CLEANUP_RE :1942、extract_media :4870、extract_local_files :5006、
  validate_media_delivery_path :1684）、`gateway/stream_consumer.py`
  （_clean_for_display :1253、_send_or_edit :2088）、`gateway/run.py`
  （_deliver_media_from_response :20819）、`gateway/delivery.py`（DeliveryRouter :294）。
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/deliverable-mode.md`
- 测试：`D:/hermes-agent-cn/tests/gateway/test_73771_media_resend_dedup.py`、
  `test_media_spaced_paths_and_history_dedupe.py`、`test_media_tag_formatting_variants.py`
- TS 参考：`D:/kimi-code/packages/kap-server/src/lib/promptMedia.ts`（入站附件
  物化）、`packages/kap-server/test/skills.test.ts`（attachment 物化用例）、
  `apps/kimi-code/src/feedback/archive.ts`（上传文件形状）。
- Desktop 集成点：`D:/Hermes-CN-Desktop/web/src/lib/message-images.ts`、
  `web/src/components/chat/message-image.tsx`、`web/src/components/chat/message-adapter.ts`、
  `web/src/lib/transport.ts`（:168/:383）、`src/commands/api_proxy.rs`（upload_file :1126）、
  `packages/protocol/src/hermes-api.ts`（HermesMessagePart :384）。
