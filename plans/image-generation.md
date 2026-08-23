# Image Generation — Python → TypeScript Rewrite Plan

## 1. Summary

`image_generate` 是 Hermes 的图像生成工具：一个 tool 同时覆盖 **text-to-image**（纯 prompt）与
**image-to-image / editing**（传入 `image_url` / `reference_image_urls` 时自动路由到后端 edit
端点）。主后端为 **FAL.ai**（文档口径 11 个模型：FLUX 2 Klein/Pro、Z-Image Turbo、Nano Banana
Pro、GPT-Image 1.5/2、Ideogram V3、Recraft V4 Pro、Qwen、Krea V2 Medium/Large；`FAL_MODELS`
catalog 实际还含 Seedream、Ideogram V4、Qwen-Image-3、MAI Image、Nano Banana 2 等 ~21 条），
另有插件后端：**OpenAI `gpt-image-2`**（三档 quality）、**OpenAI Codex auth**（Responses
`image_generation` 工具 + SSE）、**xAI**（Grok Imagine，REST JSON）、**DeepInfra**（OpenAI
兼容 `images/generations`，动态 catalog），以及 Python 侧还存在的 **Krea**（原生 API）与
**OpenRouter-compatible** 后端（本次初始移植不包含，见 §9）。

本计划把 Python 侧的「FAL 模型 catalog + payload 构造 + provider 注册表 + 插件 dispatch +
本地缓存落盘」整体移植为 Desktop 内进程 TypeScript 模块（`packages/image-gen/`），并复用现有
前端消息图片管线（`message-images.ts` → `HermesImagePart` → `MessageImage`）。所有对外 HTTP
统一走 Rust `external_request`（SSRF 防护），逐步替换掉 WS/REST 上的 Python 后端调用，最终
目标是在移除 WebSocket 链接后图像生成仍可工作。

**关键设计决策**
- FAL 无 TS SDK：`packages/image-gen/fal-queue-client.ts` 从零实现 FAL REST queue 客户端
  （POST `queue.fal.run/<model>` → 轮询 `status_url`），这是本功能唯一需要“from scratch”的传输层。
- provider 抽象沿用 Python ABC 语义：`ImageGenProvider` interface（`generate` /
  `capabilities` / `list_models` / `is_available`），`ImageGenRegistry` 按 `image_gen.provider`
  配置选择活动后端。
- 输出契约冻结为 Python `success_response` / `error_response` 的 JSON 形状，前端现有
  `extractImagePartsFromUnknown` 无需改动即可渲染。

## 2. Current Python implementation

### 2.1 主工具 — `D:/hermes-agent-cn/tools/image_generation_tool.py`（1993 行）

- `FAL_MODELS`（L97–661）：每条 catalog 声明 `display/speed/strengths/price`、
  `size_style`（`image_size_preset` / `aspect_ratio` / `gpt_literal`）、`sizes`（landscape/
  square/portrait 三种 agent 输入 → 模型原生 size）、`defaults`、`supports` 白名单、
  `upscale` 标志、`edit_endpoint` + `edit_supports` + `max_reference_images`。
  关键细节：`fal-ai/gpt-image-2` 因 655,360 min-pixel 限制映射到 4:3 preset；`gpt-image-1.5`
  用字面尺寸 `1536x1024` 等；`bytedance/seedream/v5/pro` 用 `{width,height}` dict。
- `_build_fal_payload()`（L806）与 `_build_fal_edit_payload()`（L855）：合并 defaults →
  翻译 aspect_ratio → 应用 overrides → 按 `supports` / `edit_supports` 过滤；`prompt` /
  `image_urls` 是必留键（mandatory-key 保护，见测试 `TestMandatoryKeysSurviveWhitelist`）。
- `_submit_fal_request()`（L725）：直连 `fal_client.submit()` 或经 Nous 托管
  `_ManagedFalSyncClient`（`tools/fal_common.py`）；`handler.get()` 阻塞轮询结果。
- `_upscale_image()`（L915）：Clarity Upscaler（`fal-ai/clarity-upscaler`，2×，
  creativity 0.35 / resemblance 0.6 / guidance 4 / steps 18），失败回退原图。
- `image_generate_tool()`（L1079）：统一入口；`use_edit = bool(source_images) and
  bool(edit_endpoint)`；edit 会 clamp `max_reference_images` 并跳过默认 upscale。
- 调度层：`_dispatch_to_plugin_provider()`（L1522，`image_gen.provider` 显式设置时路由到
  注册表插件）、`_maybe_route_managed_krea()`（L1684，原生 `krea-2-*` id + 托管网关）、
  `_confine_source_images()`（L1769，远程 terminal 后端把本地路径经 `tools.image_source`
  解析成 data: URL 再交给 provider）、`_postprocess_image_generate_result()`（L1047，
  ssh/docker 等后端追加 `host_image` / `agent_visible_image` 并强制文件同步）。
- 动态 schema：`_active_image_capabilities()` + `_build_dynamic_image_schema()`（L1883）
  按活动后端/model 把「是否支持 edit、最多几张参考图」写进 tool description。
- 注册：`registry.register(name="image_generate", toolset="image_gen", ...)`（L1983）。

### 2.2 Provider 抽象与注册表

- `D:/hermes-agent-cn/agent/image_gen_provider.py`（399 行）：`ImageGenProvider` ABC
  （`generate(prompt, aspect_ratio, *, image_url, reference_image_urls, **kwargs)` 必须忽略
  未知 kwargs）；`resolve_aspect_ratio` / `normalize_reference_images` /
  `success_response` / `error_response`；`save_b64_image` / `save_url_image` 落盘到
  `$HERMES_HOME/cache/images/`。
- `D:/hermes-agent-cn/agent/image_gen_registry.py`（184 行）：`register_provider` /
  `get_provider` / `get_active_provider`；显式配置优先（即使 `is_available()==False` 也返回，
  让错误信息精确）；未配置时按「唯一可用 provider → 优先 fal」回退。

### 2.3 插件后端 — `D:/hermes-agent-cn/plugins/image_gen/<name>/__init__.py`

| Provider | 模型/端点 | 输出处理 |
|---|---|---|
| `fal` | 委托 `tools.image_generation_tool`（`_it` 间接调用，单一代码路径） | 同主工具 |
| `openai` | `images.generate` / `images.edit`（gpt-image-2，low/medium/high 三档） | b64 → `save_b64_image`；URL → `save_url_image`（防过期） |
| `openai-codex` | `chatgpt.com/backend-api/codex/responses` SSE，`image_generation` 工具 + `input_image` parts；**不发送 tool_choice** | SSE 里取 `image_generation_call.result` b64 → 缓存 PNG |
| `xai` | `api.x.ai/v1/images/generations` / `images/edits`（JSON，编辑用 `grok-imagine-image-quality`） | `file_output.public_url` / b64 / URL（`xai-tmp-*` 会过期 → 本地化） |
| `deepinfra` | `api.deepinfra.com/v1/openai/images/generations`（OpenAI 兼容），动态 catalog `image-gen` tag | b64 / URL → 缓存 |
| `krea` | `api.krea.ai` 异步 job（`generate/image/krea/krea-2/...` + `/jobs/{id}` 轮询 + Enhance） | URL / b64 |
| `openrouter` | OpenRouter/Portal chat-completions 兼容端点（质量链回退） | data URL |

### 2.4 文档与测试

- 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/image-generation.md`
  （模型表、setup、image-to-image 后端矩阵、aspect-ratio 翻译表、upscale 策略、交付表）。
- 测试：`tests/tools/test_image_generation.py`（catalog/尺寸族/GPT-2 4:3/白名单）、
  `test_image_generation_artifacts.py`（`agent_visible_image` + 并发 sync）、
  `test_image_generation_image_to_image.py`（edit payload/路由/dispatch/动态 schema）、
  `test_image_generation_plugin_dispatch.py`（provider 路由、未选中 paid 插件不触发）、
  `tests/agent/test_image_gen_registry.py`、`tests/plugins/image_gen/`（fal/openai/
  openai-codex/xai/deepinfra/krea/openrouter provider 单测 + `check_parity_vs_main.py`）。

## 3. Target TypeScript design

### 3.1 模块布局（新增 `packages/image-gen/` + `web/src/lib/tools/` 胶水）

```
packages/image-gen/
  src/types.ts            # ImageGenProvider interface、统一结果类型、FAL catalog 类型
  src/registry.ts         # registerProvider/getProvider/getActiveProvider（镜像 Python）
  src/cache.ts            # saveB64Image / saveUrlImage（桌面本地缓存目录）
  src/fal-queue-client.ts # 从零实现：POST queue.fal.run/<model> → 轮询 status_url
  src/payload.ts          # buildFalPayload / buildFalEditPayload + 尺寸族翻译 + supports 过滤
  src/catalog.ts          # FAL_MODELS 常量（直接移植 Python dict，含 11 个文档模型 + 其余条目）
  src/upscaler.ts         # Clarity Upscaler 链（可复用 fal-queue-client）
  src/providers/
    fal.ts                # 委托 fal pipeline（镜像 plugins/image_gen/fal）
    openai.ts             # images.generate / images.edit
    openai-codex.ts       # Codex Responses SSE（input_image parts、MIME 门禁）
    xai.ts                # images/generations + edits（JSON）
    deepinfra.ts          # OpenAI 兼容 images/generations（动态 catalog fetch）
  __tests__/              # vitest
web/src/lib/tools/image_generate.ts  # tool handler：dispatch 顺序 = Python _handle_image_generate
```

### 3.2 核心接口（伪代码/签名，非实现）

```ts
interface ImageGenProvider {
  readonly name: string;                 // "fal" | "openai" | "openai-codex" | "xai" | "deepinfra"
  displayName: string;
  isAvailable(): boolean;                // 密钥/凭据存在且依赖可用
  listModels(): ModelRow[];              // {id, display, speed?, strengths?, price?}
  defaultModel(): string | undefined;
  capabilities(): { modalities: ("text"|"image")[]; maxReferenceImages: number };
  generate(opts: {
    prompt: string;
    aspectRatio: "landscape" | "square" | "portrait";
    imageUrl?: string;
    referenceImageUrls?: string[];
    upscale?: boolean;
    [k: string]: unknown;                // 必须忽略未知键（对应 Python **kwargs）
  }): Promise<ImageGenResult>;           // 见 §4
}

interface ImageGenRegistry {
  register(provider: ImageGenProvider): void;   // 重注册覆盖
  getProvider(name: string): ImageGenProvider | undefined;
  getActiveProvider(): ImageGenProvider | undefined; // 显式配置优先 → 唯一可用 → fal 回退
}
```

`web/src/lib/tools/image_generate.ts` 的 dispatch 顺序（镜像 Python `_handle_image_generate`）：
1. 校验 `prompt` 非空；clamp `aspect_ratio`。
2. 若有 `image_url` / `reference_image_urls` 且活动 provider 声明 `capabilities().modalities`
   含 `"image"` → 调 `generate({imageUrl, referenceImageUrls, ...})`；否则给出
   `modality_unsupported` 错误（Python 的 `_dispatch_to_plugin_provider` TypeError 分支语义）。
3. 未显式配置 provider 时走内置 `fal` provider（默认 `image_gen.provider` 语义）。
4. 结果 `ImageGenResult` 直接交给现有 `imagePartFromSource(result.image)` 生成消息图片 part。

### 3.3 运行形态

- 不依赖 Python：所有 provider 的 HTTP 通过 `web/src/lib/transport.ts` 的
  `fetchExternalJSON` / `fetchExternalText`（内部走 Tauri IPC → `src/commands/api_proxy.rs`
  `external_request`），或新增的 long-timeout external 命令（见 §9 风险 R2）。
- 本地缓存：`cache.ts` 把 b64/URL 图片写入 Desktop 应用数据目录（由 Rust 暴露的
  app-data 路径 + `writeFile` 能力或 `readImageBytesFromPath` 同族命令），返回绝对路径；
  `MessageImage` 已支持 `fetchMediaDataUrl(localPath)` 渲染本地路径。
- 设置 UI：新增 provider/model 选择器（可挂在 `web/src/routes/models.tsx` / `advanced.tsx`
  附近），配置读写复用 `web/src/hooks/use-config.ts`。

## 4. Data models & persistence

### 4.1 工具结果契约（冻结，与 Python 完全一致）

```jsonc
// success（success_response）
{ "success": true, "image": "<url|abs path>", "model": "...", "prompt": "...",
  "aspect_ratio": "landscape|square|portrait", "modality": "text|image",
  "provider": "fal|openai|openai-codex|xai|deepinfra", "upscaled": false, "size": "..." }
// error（error_response）
{ "success": false, "image": null, "error": "...", "error_type": "api_error|auth_required|...",
  "model": "...", "prompt": "...", "aspect_ratio": "...", "provider": "..." }
```

前端 `web/src/components/chat/message-adapter.ts`（L491 附近）已用
`extractImagePartsFromUnknown(part.output)` 从 tool 输出提取图片，因此该契约无需改协议。

### 4.2 消息与协议

- 复用 `packages/protocol/src/hermes-api.ts` 现有类型：`HermesImageSource`（L199）、
  `HermesImageMessagePart`（L329，type="image"）、`HermesToolMessagePart`（L352）。
  无需 schema 迁移；可选新增 `provider/model` 元数据字段（`passthrough()` 已容忍）。
- `HermesImagePart` 与 `ChatImageItem`（`web/src/components/chat/chat-types.ts`）不变。

### 4.3 配置持久化

- 与 Python 的 `config.yaml` `image_gen` 段对齐，存到 Desktop 配置存储（复用
  `use-config.ts` 的读取/更新通道；Rust/前端现有 config 持久化，无新表）：

```yaml
image_gen:
  provider: fal            # fal | openai | openai-codex | xai | deepinfra
  model: fal-ai/flux-2/klein/9b
  openai:   { model: gpt-image-2-medium }
  openai-codex: { model: gpt-image-2-medium }
  xai:      { model: grok-imagine-image, resolution: "1k" }
  deepinfra: { model: "" } # 空 = 动态 catalog 首个
```

- 图像缓存：桌面本地磁盘（无 SQLite 依赖）。文件命名沿用
  `<prefix>_<YYYYMMDD_HHMMSS>_<8hex>.<ext>` 以对齐 `save_b64_image` 习惯，便于后续迁移期
  双跑对照。不做远端 terminal 的 `agent_visible_image` 同步（见 §9 R4）。

## 5. Third-party library strategy

> 已核验 `D:/kimi-code`：**没有任何 FAL / 图像生成实现** —— TS 源码与 `package.json`
> 中搜不到 `fal`、`gpt-image`、`image_generation`；`node_modules` 也无 fal 包。因此 FAL
> 传输层必须从零实现；OpenAI 类后端可复用社区 SDK，但桌面 webview 有 CORS 限制，实际仍建议
> 走 Rust `external_request`。

| Python 依赖 | TS 方案 | kimi-code 证据 |
|---|---|---|
| `fal-client`（queue submit + handle.get() 轮询） | **from scratch**：`fal-queue-client.ts`，`POST https://queue.fal.run/<model>`（带 `x-idempotency-key`）→ 解析 `request_id/status_url/response_url` → 轮询 status（GET）直到 `COMPLETED`；封装 `submit(endpoint, args): { get(): Promise<FalResult> }`。 | 无证据（未安装 fal 包） |
| `openai`（`images.generate`/`images.edit`） | `openai` npm SDK v6（`openai.OpenAI({baseURL, apiKey})` 的 `images` 子客户端）；webview 内若 CORS 受阻则降级为手写 REST 走 `external_request`。 | `packages/kosong/package.json` / `packages/agent-core-v2/package.json` 均依赖 `"openai": "^6.34.0"`；`packages/kosong/src/provider/bases/openai/openai-common.ts`、`openai-responses.ts`、`openai-legacy.ts` 使用该 SDK（无 `images.*` 用法，属 chat/responses） |
| `httpx` + SSE（openai-codex 的 `chatgpt.com/backend-api/codex`） | 原生 `fetch` 流式读取 + 手写 SSE 解析（镜像 `_iter_sse_json`）；经 Rust proxy 转发。OAuth token 复用 Desktop 现有 Codex 凭据存储。 | `packages/oauth` 提供 OAuth/PKCE 能力（token 获取/刷新证据）；无 Codex image 实现 |
| `requests`（xai / krea / save_url_image） | `fetch` / `fetchExternalJSON` / `fetchExternalText`（`web/src/lib/transport.ts` 已有封装）。 | kimi-code 用 `openai` SDK + 自研 fetch 层（`kosong` provider bases） |
| `pybase64` / `orjson` | `btoa`/`atob`、`Buffer.from`、`JSON.stringify/parse`。 | 不依赖库 |
| `agent.image_routing._sniff_mime_from_bytes`（codex MIME 门禁） | 直接移植 `apps/kimi-code/src/utils/image/image-mime.ts`（magic-byte 嗅探 PNG/JPEG/GIF/WebP + 尺寸）——**kimi-code 唯一可复用的 image 模块**。 | `apps/kimi-code/src/utils/image/image-mime.ts` |
| `agent.file_safety.raise_if_read_blocked`（本地源图读保护） | Desktop 走 Tauri `readImageBytesFromPath` / `fetchMediaDataUrl`（已有凭据/路径守卫语义），无需新实现。 | — |
| Nous 托管 gateway（`_ManagedFalSyncClient`，`queue_run_origin`） | **初始范围外**：`fal-queue-client.ts` 保留可选 `queueOrigin` 参数（= Python `_normalize_fal_queue_url_format`），Desktop 是否接入 Portal 网关待定（§9 R5）。 | — |
| xAI OAuth / XAI_API_KEY 凭据 | Desktop 已有 `use-oauth-providers.ts` / `packages/oauth` 同族能力；`XAI_API_KEY` 走环境/配置。 | `packages/oauth` |

## 6. Integration with existing Hermes-CN-Desktop frontend

### 6.1 直接复用（无需改动）

- `web/src/lib/message-images.ts`：`imagePartFromSource` / `imagePartFromPossibleImage` /
  `extractImagePartsFromUnknown`（tool 输出 JSON 的 `image` 字段 → `HermesImagePart`）。
- `web/src/components/chat/message-image.tsx`：渲染 URL / data URL / 本地路径（经
  `fetchMediaDataUrl` 读本地缓存）；`message-timeline` 已接 `ChatImageItem`。
- `web/src/components/chat/message-adapter.ts`：tool part 输出 → image parts 的既有管线
  （L491 `extractImagePartsFromUnknown(part.output).map(imagePartToEntry)`）。
- `web/src/lib/transport.ts`：`fetchExternalJSON` / `fetchExternalText` /
  `downloadExternalImageFile` / `readImageBytesFromPath` / `fetchMediaDataUrl`。
- `src/commands/api_proxy.rs`：`external_request`（https-only、禁私有/回环 IP、不跟随
  redirect、15s 超时）、`download_external_image`（20MiB 上限、5 次 redirect 校验）——所有
  provider 出网的安全边界。**注意**：15s 超时对长任务不够，需扩展（§9 R2）。
- `packages/protocol`：`HermesImageSource` / `HermesImageMessagePart` / `HermesToolMessagePart`
  已覆盖结果形状。
- 配置读写：`web/src/hooks/use-config.ts`（现有 config get/update），模型选择 UI 参考
  `web/src/routes/models.tsx` / `advanced.tsx` 的既有交互。

### 6.2 新增/改动

- `packages/image-gen/`（§3.1）+ `web/src/lib/tools/image_generate.ts` tool handler。
- 设置页新增「Image Generation」provider/model 选择（可选：提供
  `capabilities()` 驱动的编辑能力提示，镜像 Python 动态 schema）。
- Rust 侧：若采用直接 provider 长调用，需在 `api_proxy.rs` 增加 long-timeout external 命令
  （或给 `external_request` 加 timeout 参数 + 独立 `EXTERNAL_IMAGE_HTTP_CLIENT`，参考
  `DASHBOARD_AUDIO_PROXY_TIMEOUT=180s` 先例）。

## 7. Removing the WebSocket dependency (migration path)

**冻结的 API 契约**（迁移期双跑对照）：tool 名 `image_generate`、入参 `{prompt,
aspect_ratio, image_url, reference_image_urls, upscale}`、出参 JSON（§4.1）、
`HermesImagePart` 形状。冻结后前端渲染不感知后端在哪。

1. **Phase 0（现状）**：Python 运行时执行 `image_generate`；Desktop 经 WS 收到
   `tool` part 的 `output`（JSON），`message-adapter` 提取 image parts 渲染。改动为零。
2. **Phase 1（in-process 影子实现）**：`packages/image-gen/` + tool handler 实现完整
   provider 集；先在 `image_generate.ts` 内部加开关 `useInProcessImageGen`，默认关闭；
   开启后结果仍以相同 `ImageGenResult` JSON 注入消息流（渲染管线不变）。
3. **Phase 2（切换默认）**：Desktop 会话的 `image_generate` 调用改走 in-process 实现
   （Rust 侧 proxy 只做 HTTP 出口）；WS/REST 路径保留为回退（配置 `image_gen.provider`
   由 Python config 迁移到 Desktop config 的兼容读取）。
4. **Phase 3（删除 WS/REST 路径）**：验证无回归后删除 Python 调用分支；`image_generate`
   完全在 TS 内运行，不再需要 `/api/ws` 的 tool 事件。此后 `image_generate` 与
   Python 后端的唯一联系是共享的 FAL/OpenAI/xAI REST API。

## 8. Migration phases & task breakdown

| Phase | 任务 | 产出/验收 |
|---|---|---|
| A | `packages/image-gen/` 脚手架：types、registry、cache、`fal-queue-client.ts`（含幂等头、轮询、超时、HTTP 状态提取）；Rust 增加 long-timeout external 命令 | vitest：queue client 对 mock status/response_url；registry 注册/选择 |
| B | `catalog.ts` + `payload.ts`：移植 `FAL_MODELS` 全部条目与 `_build_fal_payload` / `_build_fal_edit_payload`（尺寸族、supports/edit_supports 白名单、mandatory 键、edit clamp）；`providers/fal.ts` | 单测镜像 `test_image_generation.py` + `test_image_generation_image_to_image.py` 的 payload 用例 |
| C | `providers/openai.ts`（三档 quality、b64→缓存、edit multipart 或 JSON）、`providers/xai.ts`（generations/edits、`xai-tmp-*` 本地化、storage_options 占位）、`providers/deepinfra.ts`（动态 catalog）、`providers/openai-codex.ts`（SSE 解析、input_image MIME 门禁、不发送 tool_choice） | 单测镜像 `tests/plugins/image_gen/` 各 provider 测试；mock fetch |
| D | `cache.ts` 落盘 + `image_generate.ts` dispatch（clamp、modality_unsupported、provider 未注册错误、upscale 默认/覆盖）+ 动态 schema 文案 | 端到端：tool 调用 → `extractImagePartsFromUnknown` 提取 → `MessageImage` 渲染 |
| E | 设置 UI（provider/model 选择、`capabilities()` 提示）、config 迁移兼容 | 手动验证切换 provider/model 后 schema 文案与调用路径 |
| F | 双跑对照 + WS 移除（§7 Phase 1→3） | 无 WS 依赖下生成成功 |

## 9. Risks & open questions

- **R1（无 TS 等价物，主风险）**：FAL 无 npm 客户端、kimi-code 无任何图像生成实现。
  `fal-queue-client.ts` 从零实现，依赖 FAL 公开 REST 契约（submit → status → result）；
  需在 Phase A 以 FAL OpenAPI/实测固化请求/响应形状，防止上游变更漂移。
- **R2（超时）**：`src/commands/api_proxy.rs` 的 `EXTERNAL_TIMEOUT = 15s` 对 OpenAI
  `gpt-image-2-high`（~2min）、xAI、Krea 等长任务不足。必须新增 long-timeout 命令或
  timeout 参数（参考 `DASHBOARD_AUDIO_PROXY_TIMEOUT=180s` 与 `download_external_image`
  的 20MiB 守卫）。
- **R3（webview CORS）**：即使使用 `openai` npm SDK，webview 内直连外部 API 仍受 CORS
  限制；统一走 Rust `external_request` 可规避，但会失去 SDK 的重试/类型；建议保留 SDK
  仅作类型/请求形状参考，运行时用手写 REST。
- **R4（远程 terminal 语义）**：Python 的 `_confine_source_images`（ssh/docker 下把本地路径
  转 data URL）与 `agent_visible_image` 同步面向远程后端；Desktop standalone 无该场景，
  初始不移植，仅保留「本地路径 → 读取字节 → 缓存」的等价物（`readImageBytesFromPath`）。
- **R5（Nous 托管网关）**：`_ManagedFalSyncClient`（Portal fal-queue）与 managed Krea 路由
  是否在 Desktop 支持未定；设计上 `fal-queue-client` 预留 `queueOrigin` 参数，接入与否
  作为 open question 留给桌面订阅模式决定。
- **R6（upscale 成本/延迟）**：默认对 <2MP 模型跑 Clarity 2× 会显著增加费用与延迟；TS 必须
  复刻「catalog 默认 + `upscale` 显式覆盖 + edit 默认跳过」的三态逻辑，避免行为漂移。
- **R7（动态 catalog）**：DeepInfra 与（Python 侧）OpenRouter 依赖运行时 catalog fetch；
  Desktop 离线/无网时 `list_models` 应优雅降级为空并允许配置固定 model。

## 10. Test strategy

- **vitest 单元**（`packages/image-gen/__tests__/`）：
  - `payload.test.ts`：三尺寸族翻译、`supports`/`edit_supports` 过滤、mandatory 键保留、
    GPT-Image-2 4:3 映射、edit 尺寸自动推断（对齐 `tests/tools/test_image_generation.py`、
    `test_image_generation_image_to_image.py` 的 `TestFalEditPayload` /
    `TestMandatoryKeysSurviveWhitelist` / `TestImageSizePresetFamily` 等）。
  - `registry.test.ts`：显式配置优先（即使 unavailable）、唯一可用回退、fal 回退、
    空注册表返回 undefined（对齐 `tests/agent/test_image_gen_registry.py`）。
  - `providers/*.test.ts`：mock `external_request`/fetch，覆盖 openai b64 落盘与 edit、
    codex SSE 解析与 MIME 门禁、xai `xai-tmp-*` 本地化与 3 图上限、deepinfra 动态 catalog
    与「key 未选不触发」语义（对齐 `tests/plugins/image_gen/` 与
    `test_image_generation_plugin_dispatch.py`）。
  - `cache.test.ts`：b64/URL 落盘、扩展名推断、20MiB 上限（对齐 `save_b64_image` /
    `save_url_image` 行为）。
- **组件/集成**：`message-adapter` 对 `ImageGenResult` 的提取（复用现有
  `message-images.test.ts` 断言风格）；`MessageImage` 渲染本地缓存路径。
- **Playwright E2E**：mock provider 服务下，prompt 触发 `image_generate` → 时间线出现图片
  part → 打开原图；切换 provider/model 后 schema 文案变化；无凭据时显示精确错误。
- **Parity 对照**：Phase F 双跑（Python vs TS）对同一 mock 输入断言输出 JSON 键集合一致
  （类似 `tests/plugins/image_gen/check_parity_vs_main.py` 的思路，vitest 侧实现）。

## 11. Reference links

- Python 主实现：`D:/hermes-agent-cn/tools/image_generation_tool.py`、
  `D:/hermes-agent-cn/tools/fal_common.py`
- Provider/注册：`D:/hermes-agent-cn/agent/image_gen_provider.py`、
  `D:/hermes-agent-cn/agent/image_gen_registry.py`
- 插件：`D:/hermes-agent-cn/plugins/image_gen/{fal,openai,openai-codex,xai,deepinfra,krea,openrouter}/__init__.py`
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/image-generation.md`、
  `D:/hermes-agent-cn/website/docs/developer-guide/image-gen-provider-plugin.md`
- Python 测试：`D:/hermes-agent-cn/tests/tools/test_image_generation*.py`、
  `D:/hermes-agent-cn/tests/agent/test_image_gen_registry.py`、
  `D:/hermes-agent-cn/tests/plugins/image_gen/`
- kimi-code（TS 参考，无图像生成实现）：`D:/kimi-code/apps/kimi-code/src/utils/image/image-mime.ts`、
  `D:/kimi-code/packages/kosong/src/provider/bases/openai/openai-common.ts`、
  `D:/kimi-code/packages/kosong/package.json`（`openai ^6.34.0`）、`D:/kimi-code/packages/oauth`
- Desktop 复用点：`D:/Hermes-CN-Desktop/web/src/lib/message-images.ts`、
  `web/src/components/chat/message-image.tsx`、`web/src/components/chat/message-adapter.ts`、
  `web/src/lib/transport.ts`、`packages/protocol/src/hermes-api.ts`、
  `src/commands/api_proxy.rs`、`web/src/hooks/use-config.ts`、`web/src/routes/models.tsx`
