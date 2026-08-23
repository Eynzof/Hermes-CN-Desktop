# Discord Messaging Platform Adapter — Python → TypeScript Rewrite Plan

## 1. Summary

Discord 接入是 Hermes 的 messaging gateway 平台适配器之一（`Platform.DISCORD`）：以
Discord bot 身份连接 Discord Gateway WebSocket + REST，接收/发送消息，注册原生
slash commands（Application Commands），维护线程参与持久化，并支持语音频道
（voice mixer：ambient 底噪 + ducked speech）与自动语音回复（`/voice on|tts`）。

**核心决策（recorded port decision）**：本功能属于 **gateway-side 平台适配器**，
桌面 standalone 是 React webview 内进程式 agent runtime（TS），**不托管 messaging
gateway**；因此 Discord adapter **out of scope for desktop standalone**——与
`plans/voice-mode.md`（§9）、`plans/cron-scheduled-tasks.md`（§7）以及
`plans/automation-helpers.md` 中 Telegram/Discord/Slack 平台的处理保持一致：保留
plan 文件记录 port 决策与未来若桌面自托管 gateway 时的 TS 设计，但不在桌面内实现
bot 长连接。

桌面端今天的真实关系是：桌面通过 `transport.ts`（HTTP REST）+ `gateway-client.ts`
（WS JSON-RPC）连接**托管 Python runtime** 中的 gateway；Discord 平台的状态
（`gateway_platforms.discord`）和 `discord.*` 配置已经通过 settings 页透传
（`web/src/lib/config-translations.ts`）。WS 移除后，这一平台状态/配置通道需要重新
定义（见 §7）。

## 2. Current Python implementation

源文件（全部实测存在）：

| 路径 | 规模 | 职责 |
|---|---|---|
| `D:/hermes-agent-cn/plugins/platforms/discord/adapter.py` | 10,421 行 | 主适配器 `DiscordAdapter(BasePlatformAdapter)`：connect/disconnect、事件分发 `_handle_message`、权限门（allowlist/roles/channels）、slash 注册与同步、线程创建/参与跟踪、语音收发、`send_*` 媒体路径、`_standalone_send`（cron 无 gateway 直发）、`register(ctx)` 插件入口 |
| `.../discord/voice_mixer.py` | 387 行 | 纯 PCM 连续混音器（`VoiceMixer(discord.AudioSource)`）：ambient 循环 bed + speech 叠加 + duck/release；ffmpeg `decode_to_pcm`、`synth_ambient_pcm` |
| `.../discord/recovery.py` | 112 行 | `DiscordRecoveryStore`：profile 级 SQLite 账本（`discord_message_recovery.db`），重启后 missed-message backfill 去重/游标 |
| `.../discord/ffmpeg_utils.py` | 43 行 | `resolve_ffmpeg_executable()`：`FFMPEG_PATH` override + `tools.transcription_tools._find_ffmpeg_binary` + Windows winget fallback |
| `.../discord/plugin.yaml` | 34 行 | 插件元数据：`DISCORD_BOT_TOKEN` required；`DISCORD_ALLOWED_USERS` 等 optional env |
| `.../discord/__init__.py` | 3 行 | `from .adapter import register` |

依赖的 gateway 侧实现（Discord 专属之外）：
- `D:/hermes-agent-cn/gateway/platforms/base.py` — `BasePlatformAdapter`、`MessageEvent`、`SendResult`、自动 TTS 判定（`_auto_tts_default` / `_auto_tts_enabled_chats` / `_auto_tts_disabled_chats`，L3085-3098、L3414-3418）
- `D:/hermes-agent-cn/gateway/platforms/helpers.py` — `MessageDeduplicator`、`ThreadParticipationTracker`（adapter.py L146-150 导入；`self._threads = ThreadParticipationTracker("discord")` L1067）
- `D:/hermes-agent-cn/gateway/run.py` — `/voice on|tts|off|status` 模式持久化 `~/.hermes/gateway_voice_mode.json`（`_load_voice_modes` L6501、`_save_voice_modes` L6527、`_sync_voice_mode_state_to_adapter` L6568），voice join/leave/input 回调绑定
- `D:/hermes-agent-cn/gateway/slash_commands.py` — `/voice` 文本命令（L3081-3136）
- `D:/hermes-agent-cn/tools/transcription_tools.py` / `tools/tts_tool.py` — ffmpeg 发现、STT/TTS（voice 路径）

功能面（来自 docs `D:/hermes-agent-cn/website/docs/user-guide/messaging/discord.md`，925 行）：
- **Bot 连接**：Intents（`message_content`、`dm_messages`、`guild_messages`、按需 `members`、`voice_states`），opus 加载（Windows bundled/Homebrew fallback），WebSocket 级 liveness 探针（REST 200 ≠ gateway 健康；`websocket_*` 配置键）
- **Slash commands**：原生 App Commands（`/new /reset /model /reasoning /personality /retry /undo /status /sethome /stop /steer /compress /title /resume /usage /help /insights /reload-mcp /reload-skills /voice /update /restart /approve /deny /thread /queue /background` + `/skill` group + 从 `COMMAND_REGISTRY`/plugin 自动注册）；100 命令硬上限（`_DISCORD_MAX_APP_COMMANDS = 100`，adapter.py L86）；命令同步走 rate-limit 感知的 `safe|bulk|off` 策略 + `discord_command_sync_state.json`；`allow_admin_from` / `user_allowed_commands` 分权
- **Thread persistence**：`_auto_create_thread`（L7088）、`/thread` slash（`_handle_thread_create_slash` L6302）、`ThreadParticipationTracker` 持久化 `~/.hermes/discord_threads.json`（test_discord_thread_persistence.py 验证重启存活）
- **Voice mixer**：`_install_voice_mixer`（L4305）每 guild 安装一次连续 mixer；`play_ack_in_voice`（L4356，工具前口头 ack）、`play_tts`/`play_in_voice_channel`（L4027/L4511）；`voice_fx.*` 配置（enabled/ambient_gain/duck_gain/speech_gain/ack_*）
- **Auto voice replies**：`/voice` 模式（`off|voice_only|all`）→ `send_voice`（Discord native voice bubble flags=8192，附件 fallback）；由 run.py + base.py 驱动（与 `plans/voice-mode.md` 重叠）
- 另有：权限门（allowed users/roles/channels/free-response/require-mention）、媒体上传（MEDIA: tag、forum channels type 15 自动建 thread）、reactions、clarify/approval/model-picker 按钮视图、missed-message backfill、文本批处理

文档：`website/docs/user-guide/messaging/discord.md`（Setup/Config Reference/Slash Access Control/Model Picker/Skills/Media/Voice Messages/Forum/Troubleshooting/Security）。

## 3. Target TypeScript design

推荐：**不移植**（out of scope，理由见 §1/§9）。为记录“若桌面未来自托管 gateway
时应如何设计”，给出如下模块布局（design only）：

```
web/src/platforms/discord/
  client.ts        # DiscordClient：REST (fetch) + Gateway WS，事件→MessageEvent
  slash.ts         # SlashCommandRegistry：注册/同步/100 上限/授权检查
  threads.ts       # ThreadParticipationStore + 自动建 thread
  voice/
    mixer.ts       # PCM mixer（Float32Array 累加/限幅，替代 numpy）
    player.ts      # @discordjs/voice 连接/播放封装（替代 discord.py VoiceClient）
    receiver.ts    # 入站 SSRC 解码（替代 VoiceReceiver）
  recovery.ts      # SQLite/JSON missed-message 账本 + backfill 游标
  config.ts        # 环境/配置读取（DISCORD_* 等价物）
```

关键接口签名（示意，非实现）：
```ts
interface DiscordPlatformAdapter {
  connect(cfg: DiscordConfig): Promise<void>;        // intents, opus, liveness probe
  onMessage(ev: MessageEvent): Promise<void>;        // 与 gateway 核心解耦的入站回调
  registerSlash(cmds: SlashCommandDef[]): Promise<SyncResult>; // 100-cap + rate limit
  createThread(req: ThreadCreateReq): Promise<ThreadResult>;
  joinVoice(guildId: string, channelId: string): Promise<void>; // mixer 安装
  playTtsInVoice(guildId: string, pcm: Float32Array): Promise<void>;
  sendVoice(chatId: string, audioPath: string, opts): Promise<SendResult>; // bubble/fallback
}
```
运行形态：若 port，则 adapter 在 Tauri 渲染进程或 Rust 侧 child 中作为长连接任务
运行，事件经 `web/src/lib/transport.ts` 同接口（`MessageEvent`）送入 agent loop，
无需 Python backend。voice 路径的 Opus 编解码依赖 `@discordjs/voice`（Node 侧），
渲染进程内建议放 Rust/Tauri sidecar，理由见 §5。

## 4. Data models & persistence

Python 侧持久化（TS 若移植需等价物）：

| 数据 | Python 位置 | 结构 | TS 策略 |
|---|---|---|---|
| 线程参与集合 | `~/.hermes/discord_threads.json`（`ThreadParticipationTracker("discord")`） | `string[]`（thread_id） | 纯 TS 实现（JSON 文件或 minidb），接口 `mark(id)` / `has(id)` / `load()/save()` |
| 消息恢复账本 | `~/.hermes/gateway/discord_message_recovery.db`（SQLite，`recovery.py`） | `discord_messages` / `discord_recovery_scans` / `discord_recovery_cursors`，30 天保留 | kimi-code `packages/minidb` 或 `better-sqlite3`；保留 `message_id` PK、`status`、`attempts`、`replied`、`emoji_ack` 等列 |
| slash 同步状态 | `~/.hermes/gateway/discord_command_sync_state.json`（`_read/_write_command_sync_state`） | per-app_id: fingerprint/attempts/rate-limit | JSON 文件 + 指纹哈希（SHA-256） |
| 语音模式 | `~/.hermes/gateway_voice_mode.json`（run.py `_load_voice_modes`） | `{ "discord:<chat_id>": "off|voice_only|all" }` | 已属 `plans/voice-mode.md` 范围；桌面不移植 |
| 非会话消息去重 | `discord_nonconversational_messages.json`（`_DiscordNonConversationalMessageTracker`） | `string[]`（上限追踪） | JSON + LRU 上限 |
| 会话本身 | gateway session store（`~/.hermes/sessions/`） | 通用 gateway 会话 | 由 `plans/messaging-gateway-core.md`（#68）与 session-lifecycle plan 覆盖 |

schema migration 策略：与 Python 保持字段级兼容（消息 ID 为 TEXT 主键；时间 UTC
ISO-8601）；TS 侧若用 minidb 首次启动自动建表，不做跨版本破坏性迁移。

## 5. Third-party library strategy

**kimi-code 验证结果（本轮实测）**：
- `D:/kimi-code` 全树 grep `discord`（`--include=*.ts --include=*.tsx --include=*.js --include=*.json`）：仅命中 `node_modules` 内图标集（`@iconify-json/simple-icons`、`@tabler/icons`）、`tldts`、`mocha`、`binaryextensions` 等第三方数据，**无任何 kimi-code 源码引用**。
- `kimi-code/pnpm-lock.yaml` 无 `discord`；`node_modules/.pnpm` 下无 `discord*` 目录。
- 结论：**kimi-code 没有 discord.js 或其他 Discord TS 实现可作证据**。推荐自行引入 `discord.js`（社区事实标准，见下）。

| Python 依赖 | TS 等价 | 证据 / 设计 |
|---|---|---|
| `discord.py`（Rapptz，Gateway WS + REST + app commands + views） | **推荐 `discord.js` v14**（`discord.js` + `@discordjs/rest` + `@discordjs/ws` + `@discordjs/core`）。不存在的备选：自研薄 REST+WS shim（工作量≈重复 discord.js）。 | kimi-code：**无**。rationale：discord.js 是官方推荐的 JS SDK，覆盖 bot 登录/Intents/Interaction/Application Command/Thread/Forum/REST；`slash.ts` 直接映射 `REST.put(applicationCommands)` 与 `Interaction` 事件。 |
| `PyNaCl` + Opus（voice） | `@discordjs/voice`（依赖 `@discordjs/opus` 或 `opusscript`） | kimi-code：无 voice 先例。`@discordjs/voice` 提供 `VoiceConnection` / `AudioPlayer` / `createAudioResource`；但 Python 的连续 mixer 是自定义 `AudioSource`，TS 侧需用 `AudioPlayer` 播放资源流或自写 PCM 源 |
| `numpy`（mixer 累加/限幅） | **无需第三方**：`Float32Array`/`Int16Array` 逐样本加 + `Math.clamp`（20ms@48k stereo = 3840 字节帧） | kimi-code：无 numpy 类依赖先例。移植 `voice_mixer.py` 的 `MixerChild`/duck/release 状态机为纯 TS class |
| `ffmpeg`（`ffmpeg_utils.py` decode/探测） | `ffmpeg-static` + `child_process`，或 Rust `ffprobe`/`ffmpeg` sidecar；渲染进程内建议 Rust sidecar | kimi-code：无 ffmpeg 包装先例（`apps/kimi-code/src/native` 有 node-pty/child process 模式可循）。Tauri `src/commands/` 已有子进程惯例 |
| `aiohttp`/`aiofiles`（REST、图片重定向） | Node 内置 `fetch`/`undici` + `fs/promises` | kimi-code：`apps/kimi-code` 大量 `fetch` 用法 |
| `orjson` / `json` | 内置 `JSON`（或 `fast-json-stable-stringify` 做指纹） | — |
| `sqlite3`（recovery 账本） | `better-sqlite3` 或 kimi-code `packages/minidb` | kimi-code：`packages/minidb` 是内嵌 DB 先例；桌面 Rust 侧 README 也提到“SQLite if needed” |
| `tools/tts_tool.py` / STT（voice 输入转写） | 已在 `plans/tts-voice-messages.md`、`plans/voice-mode.md` 中设计（TTS/STT 模块、Web Audio） | 本 plan 只引用，不重复 |
| `websockets`（Discord Gateway） | `ws`（discord.js 内部使用）或 `@discordjs/ws` | kimi-code：`packages/kap-server` 使用 WS 传输，但非 Discord 协议 |

**“no TS equivalent found” 风险清单**（详见 §9）：
1. **discord.js 整体缺席 kimi-code**——桌面首次引入大型外部 SDK，需依赖评审/锁版本。
2. **Voice mixer 无现成 TS 等价物**——Python 的“单 stream 上软件混音 + ducking”没有
   npm 包，必须从零移植（状态机+线程安全在 Node 侧为单线程，反而更简单）。
3. **命令同步的 Discord 服务端限流逻辑**（4.5s mutation 间隔、30s rate-limit sleep、
   `safe|bulk|off` 策略）无现成库，需按 adapter.py L2106-2300 移植。
4. **ThreadParticipationTracker / recovery SQLite / non-conversational tracker** 均为
   Hermes 私有逻辑，无 TS 等价，需从零实现（小而直接）。

## 6. Integration with existing Hermes-CN-Desktop frontend

现状（桌面不 port 时的集成点）：
- `web/src/routes/settings.tsx` — 通用配置编辑器；`web/src/lib/config-translations.ts`
  L242-254 已含 `discord.*` 中文翻译（allow_any_attachment / allowed_channels /
  auto_thread / dm_role_auth_guild / free_response_channels / history_backfill /
  max_attachment_bytes / reactions / require_mention / server_actions /
  thread_require_mention），说明 Discord 配置已在桌面对托管 runtime 透传，无需新增。
- `web/src/lib/im-onboarding-diagnostics.ts` + `web/src/routes/im-onboarding.tsx` —
  **仅 CN IM**：protocol `ImPlatform = "feishu" | "weixin"`
  （`D:/Hermes-CN-Desktop/packages/protocol/src/channels.ts` L491），route 层
  `ImSection = "feishu" | "weixin" | "dingtalk"`；**没有 Discord onboarding**，也
  不需要加（Discord 是 gateway 侧 bot token 配置，走 settings 通用 env 编辑即可）。
- 若未来 port：复用 `web/src/lib/transport.ts`（HTTP 路由）仅剩 REST 直连 Discord
  的场景；`gateway-client.ts`（WS JSON-RPC）与 Rust `src/commands/ws_proxy.rs`、
  `src/commands/api_proxy.rs`、`src/commands/gateway.rs` 是移除对象（见 §7）。
- Rust 侧无需新 Tauri 命令（除非走 sidecar 语音）。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API surface（今日由 Python `hermes_cli/web_server.py` 暴露，桌面
`transport.ts`/`gateway-client.ts` 消费）：
- `GET /api/status` → `gateway_platforms.discord`（连接状态/错误码）——桌面
  `useStatus` 已消费；
- `GET/POST /api/config` + env 保存/重启（`DISCORD_BOT_TOKEN`、`discord.*`）——settings
  页已消费；
- `POST /api/platforms/:name/test`、`/api/im-onboarding/*`——**仅 feishu/weixin**，Discord
  无对应 onboarding。

迁移路径：
1. **今天（Bridge）**：桌面继续通过 REST 管理 Discord 配置、读取平台状态；adapter 只
   在托管 Python runtime 中运行。无变化。
2. **WS 移除对 Discord 的影响**：移除 `/api/ws` JSON-RPC 后，桌面不再实时推送
   `gateway_platforms.discord` 状态，需要把平台状态改为**轮询 REST**
   （`useStatus` 已具备轮询能力）或删除该展示；Discord 消息收发本身从不经过桌面 WS，
   因此不受影响。
3. **如果桌面未来自托管 gateway（in-process TS agent）**：Discord adapter 才需要
   port（§3 设计）；届时删除 `ws_proxy.rs`/`api_proxy.rs` 中 Discord 相关转发，改为
   `web/src/platforms/discord/*` 直接调用。本 plan 记录该 future-work，不在当前桌面
   路线图内。
4. **推荐**：Discord adapter 保持 gateway-side out of scope；WS 移除只影响状态
   展示，不影响功能归属。

## 8. Migration phases & task breakdown

- **Phase 0 — 记录决策（本 plan）**：标注 out of scope；更新 `_INDEX.md`（#70 已占位，
  本文件即交付物）。无代码。
- **Phase 1 — 维持现状（桌面侧）**：确认 settings 的 `discord.*` 配置翻译与
  `gateway_platforms.discord` 状态读取继续工作；补 `useStatus` 轮询降级（若 WS 先行移除）。
- **Phase 2（条件性 future work）— TS client + slash**：仅当桌面自托管 gateway 立项时
  启动。`web/src/platforms/discord/client.ts`（discord.js 登录/Intents/事件）、
  `slash.ts`（注册+100 上限+授权）、`config.ts`；parity 对 `test_discord_connect.py`、
  `test_discord_slash_commands.py`。
- **Phase 3（条件性）— thread persistence + recovery**：`threads.ts`、
  `recovery.ts`（minidb 账本）；parity 对 `test_discord_thread_persistence.py`、
  `test_discord_missed_message_backfill.py` 等。
- **Phase 4（条件性）— voice mixer + auto voice replies**：`voice/mixer.ts` +
  `player.ts` + `receiver.ts`；与 `plans/voice-mode.md` 的 TS TTS/STT 模块对接；
  parity 对 `test_discord_voice_mixer.py`、`test_auto_voice_reply_format.py`、
  `tests/e2e/test_discord_adapter.py`。
- 每个 phase 结束跑 `pnpm test` / vitest 全量，确保无回归。

## 9. Risks & open questions

- **风险 R1 — 无 TS 先例**：kimi-code 无 discord.js（已验证 pnpm-lock / node_modules /
  源码）。新增大型外部 SDK 需依赖评审；版本升级（v14→v15）可能破坏事件/命令 API。
- **风险 R2 — voice 复杂度**：Discord voice 需要 UDP + Opus + 入站 SSRC 解码；
  `@discordjs/voice` 覆盖大部分，但 Python 的连续 mixer/ducking 无现成等价，必须
  从零移植；渲染进程内跑 Node 语音栈有平台差异（Windows 打包 libopus）。
- **风险 R3 — 100 命令上限**：Discord 硬性 100 个 application commands；Python 侧
  已有 slot 排序+跳过逻辑，TS 移植必须复刻，否则整个 sync 失败（error 30032）。
- **风险 R4 — 命令同步限流**：服务端限流（retry-after、4.5s mutation 间隔）是 Python
  私有实现，无库可抄。
- **风险 R5 — 线程持久化格式**：`discord_threads.json` 是 Hermes 私有格式；若未来
  与 Python gateway 并存，需保持文件兼容或接受迁移。
- **风险 R6 — 桌面 standalone 语义**：桌面“没有 gateway”意味着 bot 必须 7×24 常驻
  才能回消息；这违背桌面 standalone 的定位（本地 agent 交互），是 out of scope 的
  核心理由——由“桌面自托管 gateway”或“远程 gateway 部署”解决，不在本 feature 内。
- **Open question Q1**：是否需要在桌面增加 Discord 的“仅配置管理”页（bot token +
  allowed users），还是继续用通用 env 编辑器？当前建议后者（零新 UI）。
- **Open question Q2**：移除 WS 后 `gateway_platforms.discord` 状态轮询频率与降级
  策略（沿用 `useStatus` 即可，待 messaging-gateway-core plan 确认）。
- **Open question Q3**：若未来 port，voice mixer 的 ambient 资产（`synth_ambient_pcm`
  合成 vs 静态文件）是否沿用合成方案（无资产、可循环）？建议沿用。

## 10. Test strategy

Python parity 源（`D:/hermes-agent-cn/tests/`）：
- `tests/gateway/` 共 **42 个 `test_discord_*.py`**（实测 count=42；task 简述“~43”
  即 42 + e2e 1 个），关键：`test_discord_connect.py`、`test_discord_slash_commands.py`、
  `test_discord_thread_persistence.py`、`test_discord_voice_mixer.py`、`test_discord_send.py`、
  `test_discord_allowed_channels.py`、`test_discord_component_auth.py`、
  `test_discord_missed_message_backfill.py` 等。
- `tests/e2e/test_discord_adapter.py` — mention-strip + `/command` 分发的 e2e（fake
  channel/thread fixtures）。

TS 测试策略（若 port）：
- **vitest unit**：`voice/mixer.ts` 直接移植 `TestVoiceMixerCore`（帧几何 3840 字节、
  空 mixer 静音帧、ambient 循环、duck/release 峰值断言——Python 用 numpy 断言，TS
  用 Int16Array 峰值）；`threads.ts` 复刻 `test_discord_thread_persistence.py`
  （空状态、mark 落盘、重启存活）；`slash.ts` 复刻 100-cap 与授权矩阵。
- **integration**：用 `vi.mock("discord.js")` 模拟 Gateway/REST（对应 Python
  `MagicMock` 风格），覆盖 `test_discord_connect.py` 的 connect/ready/liveness、
  `test_discord_slash_commands.py` 的 defer/cleanup 快路径。
- **Playwright E2E**：桌面 standalone 不包含 Discord，E2E 仅验证 settings 页
  `discord.*` 配置项可编辑保存（沿用现有 settings e2e），不模拟 bot。
- parity 判定：TS 行为与 Python `test_discord_*` 断言一一对应（命令名/上限/线程
  文件路径/帧字节数）。

## 11. Reference links

- Core 实现：`D:/hermes-agent-cn/plugins/platforms/discord/{adapter.py,voice_mixer.py,recovery.py,ffmpeg_utils.py,plugin.yaml}`
- Core gateway：`D:/hermes-agent-cn/gateway/run.py`（voice modes）、`D:/hermes-agent-cn/gateway/platforms/base.py`（auto-TTS/事件）、`D:/hermes-agent-cn/gateway/platforms/helpers.py`（ThreadParticipationTracker）
- 文档：`D:/hermes-agent-cn/website/docs/user-guide/messaging/discord.md`
- 测试：`D:/hermes-agent-cn/tests/gateway/test_discord_*.py`（42）、`D:/hermes-agent-cn/tests/e2e/test_discord_adapter.py`
- TS 参考（无 Discord 证据）：`D:/kimi-code`（pnpm-lock.yaml / node_modules / packages / apps）
- 桌面现状：`D:/Hermes-CN-Desktop/web/src/routes/settings.tsx`、`web/src/lib/config-translations.ts`、`web/src/routes/im-onboarding.tsx`、`web/src/lib/im-onboarding-diagnostics.ts`、`packages/protocol/src/channels.ts`
- 相关 plan：`D:/Hermes-CN-Desktop/plans/voice-mode.md`、`plans/tts-voice-messages.md`、`plans/cron-scheduled-tasks.md`、`plans/automation-helpers.md`、`plans/_INDEX.md`（#68 messaging-gateway-core、#70 discord-platform）
