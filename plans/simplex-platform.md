# SimpleX Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

SimpleX Chat 是隐私优先（无手机号/邮箱，联系人只有不透明内部 ID）的去中心化 messenger。
Hermes 的适配器是一个 **gateway-side 平台插件**（`plugins/platforms/simplex/`）：它连接
**simplex-chat CLI 守护进程**的本地 WebSocket（默认 `ws://127.0.0.1:5225`），入站走守护进程
推送的 JSON 事件，出站走 `/_send @<id> json [...]` / `#<group> json [...]` 结构化命令。

**核心决策（recorded port decision）**：与 `plans/signal-platform.md`、`plans/discord-platform.md`、
`plans/slack-platform.md` 以及 `plans/messaging-gateway-core.md`（§1/§9）一致——messaging 平台适配器
属于 **gateway-side**，桌面 standalone（React webview 内进程式 TS agent runtime）**不托管 messaging
gateway**，因此 SimpleX adapter **out of scope for desktop standalone**。本 plan 仅记录 port 决策，
并给出「若桌面未来自托管 gateway」时的 TS 设计，供后续参考。

**WS-removal 含义（重点记录）**：存在**两条完全独立**的 WebSocket 链路：
(A) 桌面 webview ↔ Python runtime Dashboard `/api/ws`（本仓库正在移除的目标）；
(B) SimpleX adapter ↔ 本地 `simplex-chat` 守护进程 `ws://127.0.0.1:5225`（平台协议链路）。
移除 (A) **不触碰** (B)；SimpleX 集成继续留在 Python gateway 上，桌面仅通过 `status.gateway_platforms`
（`settings.tsx` DebugCard）只读展示其状态。除非桌面未来自托管 gateway，否则无需任何 TS 实现。

**TS 方案研究结论**：`D:/kimi-code` 全树 **无任何 SimpleX messenger 实现**——
`package.json`/`pnpm-lock.yaml` 中 `simplex` 0 命中；`node_modules` 无 `simplex-chat`/`@simplex-chat`/
`simplexmq` 包（`ls` 与 pnpm store 均确认）；全树 grep `simplex` 仅命中 `dist-web` 打包产物里的无关
第三方库（mermaid venn diagram 的 “simplex” 布局算法、PHP/Blade/Hack 语法高亮 grammar 中的
“Simplex” 字样）。TS 生态存在官方 `simplex-chat`（SimpleX Chat Node.js library, AGPL-3.0）与
`@simplex-chat/types`（bots API 自动生成类型），另有已废弃的 `@simplex-chat/webrtc-client` 与社区
`@reply2future/simplex-chat`——但 kimi-code 无先例，推荐走「thin WebSocket client + 手写/自带 zod 类型」，
详见 §5。

## 2. Current Python implementation

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/plugins/platforms/simplex/adapter.py` | 1,378 行 | 全部逻辑：`SimplexAdapter(BasePlatformAdapter)`、连接/重连/健康监控、事件解析、出站 send 全媒体、channel 目录、`_standalone_send`、`interactive_setup`、`register` |
| `D:/hermes-agent-cn/plugins/platforms/simplex/__init__.py` | 3 行 | `from .adapter import register`，插件发现入口 |
| `D:/hermes-agent-cn/website/docs/user-guide/messaging/simplex.md` | 151 行 | 安装/启动 daemon、`SIMPLEX_*` 环境变量表、DM 配对、群 allowlist、附件、cron 投递、troubleshooting |
| `D:/hermes-agent-cn/tests/gateway/test_simplex_plugin.py` | 390 行 | 平台枚举/requirements/config/初始化/helper/发送 payload 形状/list_channels/standalone send/健康监控/入站分类/echo 过滤（详见 §10） |

依赖（Python）：`websockets`（**lazy import**，缺包时插件仍可发现、`check_requirements()` 返回 False）、
`orjson`（JSON 编解码）、`pybase64`（缩略图 data-uri）、可选 `Pillow`/ImageMagick `convert`
（图片转 PNG + 128px JPEG 缩略图）。gateway 侧复用：`gateway/platforms/base.py` 的
`BasePlatformAdapter`/`MessageEvent`/`MessageType`/`SendResult`/`build_source`、
`gateway/config.py` 的 `Platform`/`PlatformConfig`。

数据流：
```
simplex-chat daemon (ws://127.0.0.1:5225)
   └─ inbound:  {corrId, resp:{type:"newChatItems"|"newChatItem"|"contactRequest"|"rcvFileDescrReady"|"rcvFileComplete",...}}
        → _ws_listener（指数退避 2s→60s + jitter；ping 20s；health monitor 30s 巡检、300s 闲置容忍）
        → _handle_event（resp 顶层归一化、corrId 响应 Future 匹配、corrId 回声过滤、auto-accept /accept、
          XFTP /freceive 启动、文件完成延迟投递）
        → _handle_chat_item（direct/group 解析、sender/chat 提取、群 allowlist、方向过滤 directSnd/groupSnd、
          文本/文件/图片/语音分类 → MessageEvent）
        → 文本批处理（HERMES_SIMPLEX_TEXT_BATCH_DELAY 默认 0.8s 静默期聚合）→ handle_message → agent
   └─ outbound: send() → MEDIA: 标签剥离 → /_send @id json [{"msgContent":{"type":"text"}}]
        send_image/image_file/voice/document/video → /_send @id/#gid json [{filePath,msgContent,fileSource}]
        list_channels() → /contacts + /groups（10s 超时，None 而非 [] 以保留旧目录）
        _standalone_send() → 一次性 WS 连接发文本（cron 独立进程场景，close_timeout=5）
```

功能面：环境变量 `SIMPLEX_WS_URL`（必填）、`SIMPLEX_ALLOWED_USERS`（contactId 或显示名）、
`SIMPLEX_ALLOW_ALL_USERS`、`SIMPLEX_AUTO_ACCEPT`（默认 true）、`SIMPLEX_GROUP_ALLOWED`
（`*`=全部，缺省=禁群）、`SIMPLEX_HOME_CHANNEL[_NAME]`、`HERMES_SIMPLEX_TEXT_BATCH_DELAY`；
`register()` 注册元数据：`pii_safe=True`、`emoji="🔒"`、`max_message_length=8000`、
`allow_update_command=True`、`standalone_sender_fn=_standalone_send`、`cron_deliver_env_var`、
`interactive_setup()` 向导。SimpleX 无 typing indicator（`send_typing` no-op）、无消息编辑。

## 3. Target TypeScript design

推荐：**不移植**（out of scope，理由见 §1/§9）。为记录「若桌面未来自托管 gateway」时的设计，给出模块布局
（design only，不实现）：

```
web/src/platforms/simplex/
  config.ts        # SimpleXConfig：wsUrl/autoAccept/groupAllowed/homeChannel/textBatchDelayMs
                   # （envLookup 注入，与 messaging-gateway-core plan 的 PlatformConfig 对齐）
  ws-client.ts     # 持久 WebSocket 客户端：connect/指数退避重连/ping、corrId→Future 映射、
                   #   回声过滤（hermes- 前缀）、fire-and-forget 发送
  events.ts        # 事件归一化（resp 顶层兼容）+ 分发：contactRequest/rcvFileDescrReady/
                   #   newChatItems|newChatItem/rcvFileComplete
  chat-item.ts     # chat item 解析 → ChatMessage（direct/group、sender、媒体分类、时间戳）
  send.ts          # send / sendImage / sendImageFile / sendVoice / sendDocument / sendVideo
                   #   （/_send 结构化命令，group: 前缀拆分；MEDIA: 标签处理）
  channels.ts      # listChannels()：/contacts + /groups；超时返回 null
  batch.ts         # 文本批处理（静默期聚合，替代 asyncio task）
  standalone-send.ts # 一次性 WS 文本发送（cron/deliver 独立进程路径）
```

关键接口（示意签名，非实现）：
```ts
interface SimplexConfig {
  wsUrl: string;                  // 默认 ws://127.0.0.1:5225
  autoAccept: boolean;            // 默认 true
  groupAllowed: string[];         // [] = 禁群；["*"] = 全部
  homeChannel?: { chatId: string; name?: string };
  textBatchDelayMs: number;       // 默认 800
}
interface SimplexPlatformAdapter {
  connect(cfg: SimplexConfig): Promise<boolean>;      // 快速连通性检查 + listener 启动
  disconnect(): Promise<void>;
  onMessage(evt: ChatMessage): Promise<void>;         // 与 gateway 核心解耦的入站回调
  send(chatId: string, content: string, opts?: SendOpts): Promise<SendResult>;
  listChannels(): Promise<Array<{ id: string; name: string; type: "dm" | "group" }> | null>;
}
```

运行方式：内进程 TS 模块仍通过 WebSocket 连接**外部** `simplex-chat` 守护进程（Haskell CLI，无法进
webview；由 Rust `src/commands/*` child-process 能力负责拉起/守护，类似现有 terminal pty/child process
IPC 模式）。Python backend 不存在时，agent loop 直接调用 `SimplexPlatformAdapter` 接口（冻结自
`messaging-gateway-core.md` 的 `PlatformAdapter` 接口面）。

## 4. Data models & persistence

- **desktop standalone 现状**：无新增持久化——SimpleX 配置在 Python 侧 `~/.hermes/.env`（`SIMPLEX_*`），
  桌面只读 `status.gateway_platforms` 展示（见 §6）。
- **若未来内进程 gateway**：
  - 配置：`SimpleXConfig` 存入现有 config store / env 持久化（`web/src/stores/` + `packages/protocol`
    zod schema 扩展）；`SIMPLEX_WS_URL` 非敏感，`SIMPLEX_ALLOWED_USERS` 视为策略配置（可明文，非密钥）。
  - 联系人与群目录：`channels.ts` 枚举结果缓存（JSON 文件或 SQLite；kimi-code `packages/minidb` 为嵌入式
    DB 先例）。`listChannels()` 返回 `null` 的语义必须保留（WS 断开时不清空缓存）。
  - 消息/会话：入站 `ChatMessage` 是瞬时事件，进 agent 会话；会话历史沿用桌面已有 session store
    （`session-lifecycle.md`/`session-search-recall.md` 方案），**不**为 SimpleX 建独立消息表。
  - schema migration：无需（纯配置 + 缓存，无固定 schema）。

## 5. Third-party library strategy

| Python 依赖 | TS 等价 | kimi-code 证据 | 备注 |
|---|---|---|---|
| `websockets`（Python WS 客户端） | `ws`（Node/webview WS 客户端）或内建 `WebSocket` | **有**：`packages/kap-server/package.json:40` 与 `packages/klient/package.json:53` 直接依赖 `ws@^8.18.0`；`node_modules/.pnpm/ws@8.20.0` 存在 | 推荐 `ws`（服务端/测试端）+ 内建 WebSocket（webview 端），与 Python 行为一一对应 |
| `orjson` | 原生 `JSON.parse/JSON.stringify` | 无特殊依赖（TS 标准） | payload 序列化性能足够 |
| `pybase64` | 原生 `base64` / `Buffer.toString("base64")` | 无特殊依赖 | 仅缩略图 data-uri 用到 |
| `Pillow` / ImageMagick（图片转 PNG + 128px JPEG 缩略图） | `sharp`（npm 生态标准）或 Rust Image crate | **无**：kimi-code 无直接 `sharp` 依赖（仅 `lightningcss` 的可选 peer）；无先例 | 若实现，推荐 `sharp`；或用 Tauri Rust 侧 `image` crate 做转换 |
| `simplex-chat` CLI daemon（外部进程） | 同一个外部 daemon，TS 只写 WS 客户端 | **无**：kimi-code 0 命中 | 协议是简单 JSON over WS，无需 SDK |
| `simplex-chat` / `@simplex-chat/types`（官方 TS bot SDK） | **不推荐引入**（见下） | **无**：kimi-code 无这些包 | AGPL-3.0 许可 + 内嵌 native core，webview 不适用；仅可参考其 payload 类型 |

**推荐路线（rationale）**：Python 适配器的本质是「simplex-chat daemon 的 JSON WebSocket 客户端」，
TS 端用 `ws`（或内建 WebSocket）+ 手写/zod 类型即可 1:1 复刻，**不需要** SimpleX 官方 SDK。
官方 `simplex-chat` npm 包（SimpleX Chat Node.js library，v6.5.x/7.x，AGPL-3.0）内嵌 core（SQLite/
native 二进制、Windows/Mac 首次运行校验），在 Tauri webview 沙箱内不可行，且 AGPL 传染风险；
`@simplex-chat/webrtc-client` 官方已标记 DEPRECATED；`@reply2future/simplex-chat` 是低活跃社区 fork
（0.3.2，2022 后未更新）。因此：**若实现，用 `ws` + 自写类型**，这是最贴近 Python 行为、依赖面最小的方案。

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/routes/settings.tsx`（DebugCard “Dashboard / Gateway”，约 L1467–1488）：已遍历
  `status.gateway_platforms` 渲染 `{name, state, error_message}`——Python gateway 配置 SimpleX 后，
  **无需任何改动**即显示 `simplex` 状态。这是 desktop 对 SimpleX 的唯一现有集成点。
- `web/src/routes/im-onboarding.tsx` + `web/src/lib/im-onboarding-diagnostics.ts`：仅面向
  feishu/weixin（本地 `ImSection` 含 dingtalk）的扫码/凭据 onboarding 流程，**不适用** SimpleX
  （SimpleX 无 app secret/QR，采用 `SIMPLEX_ALLOWED_USERS` allowlist + DM pairing code）。若未来加
  SimpleX onboarding，应新增「env 表单 + pairing code」流程，复用 `MessagingPlatformInfo`/
  `MessagingPlatformTestResponse`（`packages/protocol/src/hermes-api.ts:127–160`）与
  `useMessagingPlatform` hooks，但需扩展 `ImPlatform` 联合类型（当前
  `packages/protocol/src/channels.ts:491` 仅 `"feishu" | "weixin"`）。
- `web/src/lib/transport.ts` / `gateway-client.ts` / `tauri-bridge.ts`：对 SimpleX 无改动——状态经现有
  status 接口流动；不新建 Rust Tauri command（除非未来内进程 gateway 需拉起 daemon，届时走既有
  child-process/pty 命令模式）。
- Rust 侧：无新增。若未来内进程实现，`src/commands/*` 可加 `simplex_spawn_daemon` 类命令管理外部
  `simplex-chat` 进程生命周期，并解决接收文件路径（daemon `~/.simplex` 目录）与 Tauri FS 权限映射。

## 7. Removing the WebSocket dependency (migration path)

**两条 WS 必须区分**：
- (A) 桌面 ↔ Python runtime Dashboard `/api/ws` + REST —— 本仓库删除目标（`plans/README.md` 终态）。
- (B) SimpleX adapter ↔ 本地 daemon `ws://127.0.0.1:5225` —— 平台协议链路，**保留**。

分阶段（API 冻结面）：
1. **Phase 0（现状）**：adapter 留在 Python gateway；桌面无代码改动，`settings.tsx` 只读展示
   `status.gateway_platforms.simplex`。冻结面：`SIMPLEX_*` 环境变量名、`status.gateway_platforms`
   条目形状 `{state, error_message}`、`MessageEvent` 形状（source/text/message_type/media_urls/
   media_types/timestamp/raw_message）、`SendResult`、`list_channels` 条目 `{id,name,type}`。
2. **Phase 1（可选，仅当桌面自托管 gateway）**：实现 §3 TS 模块，挂在 `messaging-gateway-core.md`
   冻结的 `PlatformAdapter` 接口后；此时 (B) 仍指向外部 daemon，接口形状与 Python 逐一对应，保证
   A/B 双实现可共存。
3. **Phase 2（删除 (A)）**：删除 `gateway-client.ts` 的 `/api/ws` 泵与 REST 直连。SimpleX **不受影响**
   ——(B) 是 daemon↔adapter 的本地连接，与桌面↔Python 链路无关；删除后 SimpleX 仅失去「Python gateway
   作为中介」的路径，若桌面未自托管 gateway 则 SimpleX 集成整体随 Python gateway 迁出桌面。
4. **Phase 3（收尾）**：确认 settings DebugCard 的 `gateway_platforms` 展示改由内进程 gateway 状态源
   提供（或移除），Playwright E2E 覆盖不回归。

## 8. Migration phases & task breakdown

- **P0 — 记录（本次完成）**：本 plan 落盘，记录 port 决策与 WS-removal 含义。验收：文件存在且 ≥150 行。
- **P1 — 验证现状（无需改动）**：在配置了 `SIMPLEX_WS_URL` 的 Python gateway 上启动，确认
  `settings.tsx` DebugCard 显示 `simplex` 平台状态；确认 `im-onboarding` 路由不误报 SimpleX。
- **P2 — 冻结接口（若启动桌面自托管 gateway 前）**：在 `packages/protocol` 补充
  `SimplexConfig`/`ChatMessage` zod schema 草案；扩展 `ImPlatform`（如未来做 SimpleX onboarding）。
- **P3 — 可选内进程实现**：实现 §3 `web/src/platforms/simplex/*`（vitest 单测，见 §10）；Rust 侧 daemon
  生命周期命令；与内进程 gateway 核心接线。
- **P4 — WS (A) 下线**：删除 dashboard WS 链路，回归 settings/状态展示；SimpleX 保持 Python gateway
  侧或随内进程实现迁移。

## 9. Risks & open questions

- **无 kimi-code TS 等价物（核心风险）**：kimi-code 全树 0 命中 SimpleX；官方 `simplex-chat` npm 包为
  AGPL-3.0 且内嵌 native core（webview 不可行），`@simplex-chat/webrtc-client` 已废弃。任何 TS 实现都必须
  新增依赖（`ws`/`sharp`）或纯手写，**无先例可循**。
- **daemon 协议版本漂移**：事件/命令存在多形态（`resp` 顶层 vs `{corrId,resp}`；`newChatItems` vs
  `newChatItem`；`/groups` 返回 dict 或 `[groupInfo, groupSummary]` pair），Python 端做了归一化，
  TS 移植必须 1:1 复刻，否则丢消息——parity 测试是关键。
- **XFTP 文件依赖 daemon 文件系统**：`media_urls` 指向 daemon 本地目录（`~/.simplex`）；桌面内进程场景
  需 Tauri 文件权限映射，否则图片/语音/文档无法交给 agent 工具读取。
- **图片转换依赖**：Pillow/ImageMagick 无 kimi-code 先例；TS 用 `sharp` 需评估包体与平台二进制。
- **许可与分发**：SimpleX daemon 与官方 TS lib 均为 AGPL-3.0；走 thin WS 客户端可规避 SDK 传染，但
  daemon 本身仍为外部 AGPL 进程（桌面仅连接，不内嵌）。
- **桌面是否应自托管 gateway**：仍为开放问题（`messaging-gateway-core.md` §9）；本 plan 默认
  out of scope，接口冻结以备将来。
- **Windows 上 daemon 分发**：文档当前给 Linux/macOS 下载链接；桌面 standalone（Windows 为主）若内进程
  化需解决 `simplex-chat.exe` 的打包/升级/路径问题。

## 10. Test strategy

- **Python parity 基准**（现有，`D:/hermes-agent-cn/tests/gateway/test_simplex_plugin.py`，390 行）：
  平台枚举幂等；`check_requirements`（缺 env/缺 websockets）；`validate_config`（env 或 extra）；
  `is_connected`；`_env_enablement` home_channel 种子；初始化自定义 URL；`_guess_extension` 魔数检测；
  corrId set 自裁剪（≤ cap+1）；**发送 payload 形状**：DM `/_send @<id> json [...]`、group
  `/_send #<id> json [...]`（msgContent 类型/文本断言）；`list_channels`（contacts/groups 两种形态、
  断线返回 None、超时返回 None）；`_standalone_send`（缺 websockets 报错、默认 URL/参数、payload 形状）；
  health monitor 不重连健康静默 WS；入站附件分类（`_make_file_chat_item` 辅助构造 direct rcvMsgContent
  file 项，见文件 L366–390）。
- **TS 单测（仅当实现 §3 时，vitest）**：用 `ws` 起本地假 daemon，逐条镜像上述 Python 用例：payload
  字符串精确断言、corrId 回声过滤（`hermes-` 前缀）、`resp`/顶层事件归一化、文本批处理静默期 flush、
  `listChannels` 超时返回 null、standalone send 一次性连接。文件位置建议
  `web/src/platforms/simplex/__tests__/*.test.ts`。
- **集成/E2E**：Python 侧 `pytest tests/gateway/test_simplex_plugin.py -q` 通过；desktop 侧如加
  onboarding UI 才需要 Playwright（当前 out of scope，无需 E2E）。
- **验收命令（设计期不执行）**：Core `pytest tests/gateway/test_simplex_plugin.py -q`；desktop
  `pnpm vitest run`（如有 TS 模块）。

## 11. Reference links

- Core 源码：`D:/hermes-agent-cn/plugins/platforms/simplex/adapter.py`、`__init__.py`
- Core 文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/simplex.md`
- Core 测试：`D:/hermes-agent-cn/tests/gateway/test_simplex_plugin.py`
- 计划规范：`D:/Hermes-CN-Desktop/plans/README.md`、`_PROMPT_TEMPLATE.md`
- 同决策先例：`D:/Hermes-CN-Desktop/plans/signal-platform.md`、`discord-platform.md`、
  `slack-platform.md`、`messaging-gateway-core.md`（§1/§9、§7 WS 移除路径）
- Desktop 集成点：`D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`（L1467–1488）、
  `web/src/routes/im-onboarding.tsx`、`web/src/lib/im-onboarding-diagnostics.ts`、
  `D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts`（L491 `ImPlatform`）、
  `packages/protocol/src/hermes-api.ts`（L127–160 `MessagingPlatformInfo`/`MessagingPlatformTestResponse`）
- kimi-code 证据：`D:/kimi-code/packages/kap-server/package.json`（`ws@^8.18.0`）、
  `packages/klient/package.json`（`ws@^8.18.0`）；全树 `simplex` 0 命中（源码/package.json/pnpm-lock）
- TS 生态：npm `simplex-chat`（SimpleX Chat Node.js library，AGPL-3.0）、`@simplex-chat/types`、
  `@simplex-chat/webrtc-client`（DEPRECATED）、`@reply2future/simplex-chat`（社区 fork）；
  `https://github.com/simplex-chat/simplex-chat`、`https://simplex.chat/`
