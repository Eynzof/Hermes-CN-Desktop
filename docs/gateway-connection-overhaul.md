# 网关连接改造(Gateway Connection Overhaul)— WS-only

> 目标:把 Tauri 桌面端从自造的 **SSE+POST 代理传输(P-009)** 迁到官方运行时原生的
> **JSON-RPC over WebSocket(`/api/ws`)**,与官方桌面端(Core `apps/desktop`)架构对齐,
> 修复掉线 / 重连失败 / 延迟高 / 回复不可见 / 401 风暴,并大幅降低对 Hermes-CN-Core 的上游 sync 负担。
>
> 分支:`claude/gateway-ws-only`(worktree:`.claude/worktrees/gateway-ws-only`,基线 `origin/main` 6eda0c1 = v0.3.2+1)
> 本文件是**活文档**,每完成一步就更新「进度跟踪」表与「变更记录」。

> 📌 **决策(2026-06-09,已拍板)**:**WS-only,SSE 路径全删**。此前 v2 分支
> (`claude/gateway-connection-overhaul-v2`,已被本分支取代)的方案是 WS-first + SSE 自动回退
> (`NegotiatingGatewayClient`);现改为:打包态 webview 万一开不了原生 WS,兜底走 **Rust 侧
> `tokio-tungstenite` WS 中继**(只搬字节,线协议仍是官方 `/api/ws` JSON-RPC),而**不是**回退 SSE。
> 理由:官方桌面端(Electron,Core `apps/desktop`,v0.15.1 已发布)完全不用 SSE;保留双传输意味着
> 双客户端、双套语义、P-009 永远删不掉。Rust 中继与原生直连共用同一个 `GatewayClient` 与协议层,
> 回退只是换 socket 工厂,前端无感。

---

## 1. 背景与根因(调研结论)

官方 Electron 桌面端与我们的 Tauri 桌面端连的是**同一个运行时**——即 `hermes_cli/web_server.py`
里的 FastAPI dashboard 服务。区别只在传输:

- **官方**:渲染进程直连一条 `JSON-RPC 2.0 over WebSocket` 到 `/api/ws?token=…`,主进程只做控制面
  (spawn dashboard、REST 代理、token 注入)。协议层在 Core `apps/shared/src/json-rpc-gateway.ts`。
- **我们(现状)**:webview → Tauri IPC → 两层 Rust 代理（旧 SSE 通道 + `api_proxy.rs`）→ dashboard 的
  **SSE 事件流 + 每次 RPC 一个 POST**(`/api/v2/events` + `/api/v2/rpc`,这是 fork 补丁 **P-009**)。

**关键事实**:`/api/ws`(原生)和 `/api/v2/*`(我们的补丁)由同一个 dashboard 进程提供。官方 WS 端点
本来就在,SSE 是我们多加的,不是替代品。官方代码里**零个** EventSource / api/v2 消费者。

我们仓库里 `web/src/lib/gateway-client.ts` 已经是一个完整的 WS 客户端
(指数退避+jitter、唤醒看门狗、online/visibility 触发),线协议与官方
`JsonRpcGatewayClient` 完全一致(JSON-RPC 2.0、`{method:'event'}` 事件帧、15s 连接超时、120s 请求超时),
但 `pickTransport()` 因一句已被证伪的「WS 被 P-003 闸门挡住」注释在 Tauri 上强制走 SSE,成了死代码。
实际上:运行时原生在 `/api/ws` 提供服务、`tauri.conf.json` CSP 已放行 `ws://127.0.0.1:*`、dev 模式已在用。

### 症状 → 根因映射

| 症状 | 根因 | 处置 |
|---|---|---|
| 掉线 / 重连失败 | SSE 路径无重连恢复;上游 #177 已补退避/宽限,但属于在错误架构上打补丁 | **切 WS**(官方一致:无主动 ping,靠 close/error/RPC timeout + 指数退避) |
| 回复要切走再切回才可见 | 重连后**不重发 `session.resume`**,服务端事件只发给会话绑定的 transport | **C2**:重连后重发 `session.resume` |
| 全链路延迟高 | 每 RPC 经 Rust 代理 + `res.text()` 整包缓冲;慢 turn 再走 SSE 第二跳(异步 ack) | **切 WS**:RPC 与事件同一条 socket,一帧到达 |
| 401 风暴 | dashboard 重启即轮换 token;SSE 流建立时才发现 | WS 路径 `scheduleReconnect` 已在每次重试前 `refreshGatewayUrl()` |
| Token 泄漏 | SSE 端点在 auth 中间件外,token 写进 URL 查询串 | SSE 删除后消失;WS `?token=` 仅 loopback(与官方本地模式一致) |
| 配置侧栏冻结 (#165) | IPC 代理设计 + StrictMode race(修复 `0dd1206` 未并入 main) | 与传输无关,独立跟进 |

### 服务端语义(已核验,`tui_gateway/server.py`)

- WS 断开后,会话被重指到 `_stdio_transport`,**20s 宽限**(`_WS_ORPHAN_REAP_GRACE_S`)后回收——
  **mid-turn(`running`)的会话不回收**。
- 事件只路由给会话当前绑定的 transport;重新绑定靠 `session.resume` 或 `prompt.submit`。
- → 重连后**必须**重发 `session.resume`,这是客户端的责任(官方也这么做:
  `apps/desktop` 的 `use-route-resume.ts` 在 gateway 重新 open 时 resume)。
- 服务端**没有 `ping` RPC 方法**;客户端对齐官方桌面端,不再发 synthetic `ping`。半开连接由
  WebSocket close/error、RPC timeout、OS 唤醒后的强制重连兜住,避免本地慢推理场景误判 `Heartbeat timeout`。

---

## 2. 架构对比(官方 vs 我们现状 vs 迁移后)

| 维度 | 官方 Electron | 我们 Tauri(现状) | 迁移后(本分支) |
|---|---|---|---|
| 传输 | 1 条 WS,JSON-RPC,渲染进程直连 | SSE 事件 + POST RPC,2 层 Rust 代理 | 1 条 WS,JSON-RPC,webview 直连(兜底 Rust 中继) |
| 数据路径跳数 | 0 代理 | 2(IPC+reqwest),整包缓冲 | 0(直连)/ 1(中继,逐帧转发不缓冲) |
| RPC 结果 | 同 socket 一帧 | 异步 ack → 另走 SSE 第二跳 | 同 socket 一帧 |
| 重连退避 | `min(15s, 1s·2^min(n,4))` + 唤醒/online/visibility 触发 | #177:1→30s(SSE) | **对齐官方:15s 封顶**,触发器同官方(已内置于 `GatewayClient`) |
| 心跳/半开检测 | 无(靠 close + 连接超时) | 无 | 官方一致:无主动 ping,靠 close/error/RPC timeout + 唤醒强制重连 |
| 重连→恢复 | `session.resume` on reopen | **无** | `gateway.disconnected` arm → 下次 open 重发 `session.resume`(C2) |
| Token | spawn 时 env 注入 `HERMES_DASHBOARD_SESSION_TOKEN`,WS `?token=` | 同左(main 已实现)+ 接管外部 dashboard 时 HTML 抓取(legacy) | 不变 |
| 自造 Rust 行数 | n/a | 旧 SSE 通道约 350 行 + `api_proxy` RPC 半 | 旧 SSE Rust command **删除**；`ws_proxy.rs` ~260(仅兜底)；`api_proxy` 仅 REST |

---

## 3. 分阶段计划(WS-only 版)

### C1 docs — 本文档重写为 WS-only 决策版
### C2 fix — 断线重连后重发 `session.resume` 恢复在途回合
- 自 v2 cherry-pick `4d2b1a5` + `9c1aeed`:`gateway-reconnect.ts`(纯函数 reattach)、
  `markStreamsReconnectingAtom`(瞬态「重连中」,保留在途消息)、`use-gateway.ts` 桥接 + `needsResumeOnReopen`。
- WS-only 下的语义修正:`gateway.disconnected` 是**客户端合成事件**,每次非主动 socket 关闭都会发——
  门控退化为「除首连外每次 reopen 都 resume」,正确;重写原「#177 宽限窗」注释。
- 重连路径的 `session.resume` 加长超时(~300s,服务端重建 agent 可达分钟级,在 `_LONG_HANDLERS` 池)。
### C3 refactor — 默认直连官方 `/api/ws`
- 删 `pickTransport()`/`GatewayTransport` SSE 分支,`getGatewayClient()` 恒返回 `GatewayClient`。
- 退避对齐官方:`RECONNECT_MAX_DELAY_MS 30_000→15_000`、指数封顶 `min(attempt,4)`
  (首批重试必须落在服务端 20s 回收宽限内)。
- 修 `socketFactory` wiring(v2 未提交 diff 里 `connect()` 仍直接 `new WebSocket`)。
### C4 feat — Rust WS 中继 + 原生失败自动回退
- Rust:移植 v2 worktree **未提交**的 `src/commands/ws_proxy.rs`(260 行,connectionId 防串台、
  reader/writer 任务、token 刷新重试)+ `state.rs`/`error.rs`/`main.rs`/`Cargo.toml` 配套 diff。
- TS:`gateway-relay-socket.ts`(实现 WebSocket 接口子集,经 Tauri invoke/listen);
  `gateway-socket-path.ts`(路径选择纯模块):原生 WS 首连(~4s 探测超时)→ 失败先
  `refreshGatewayUrl()` 重试一次(排除 token 轮换误判)→ 仍失败切 relay 工厂重连。
  粘性记忆 `HERMES_WS_PATH_LEARNED`(native|relay),`?wspath=` 强制覆盖(QA);relay 也失败则清记忆重探。
### C5 refactor — 删除 SSE 路径全部残留
- 删旧 Gateway SSE 客户端与 Rust SSE command；清理 Rust state/error/main/
  debug_bundle/runtime_manager/restart/environment(`dashboard-sse` 健康项改真实 WS 探测)/
  dashboard.rs(`dashboard_supports_sse`)/gateway.rs(`transport` 字段、`HERMES_DESKTOP_TRANSPORT`);
  web 侧 gateway-result(`"sse closed"` 分支)/tauri-bridge/runtime(`transport` 类型)/health-grid 文案/
  settings 旧传输字段；CLAUDE.md「Gateway transport」章节更新。
### C6 test — 重写 transport 相关用例
- `gateway-factory.test.ts` 重写为 native/relay 选择;新增 relay socket shim、退避常量、
  resume-on-reopen 用例;删 SSE 客户端用例。

### 配套(Core 侧,另开 PR,分支 `claude/p009-sse-deprecation`)
- `FORK_NOTES.md`(+zh-CN):P-009 标 **deprecated**——新桌面端(≥0.4)用官方 `/api/ws`;
  端点**必须保留**至老外壳(≤0.3.x)EOL(外壳无自更新而 runtime 热更新,新 runtime 必须继续服务老外壳)。
- 可选:`/api/v2/events` 处理器加一行弃用使用日志,量化残留用量。
- 必须保留:P-002 上传、P-004 fs/list、P-005 mcp-servers、P-008 profiles 兼容、P-011 slug_filter/probe
  (均与传输无关,本桌面端在用);P-006/P-010 国内 provider、P-014/P-015 冻结运行时打包。

---

## 4. 进度跟踪

状态:⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ⏸ 阻塞(需用户/外部) / ❌ 放弃

| ID | 任务 | 状态 | 备注 |
|---|---|---|---|
| 设置 | worktree + `claude/gateway-ws-only` 分支(基线 origin/main 6eda0c1) | ✅ | Core 侧 `claude/p009-sse-deprecation` 同步开出 |
| C1 | 文档重写为 WS-only | ✅ | 本文件 |
| C2 | session.resume 重连恢复(P0-2 移植+语义修正) | ✅ | cherry-pick 4d2b1a5+9c1aeed,重写门控注释,resume 300s 长超时 |
| C3 | 默认直连 `/api/ws` + 退避对齐官方 | ✅ | pickTransport 删除;退避 15s 封顶+min(n,4);socketFactory 注入 |
| C4 | Rust WS 中继 + 自动回退 | ✅ | ws_proxy.rs + gateway-relay-socket.ts + gateway-socket-path.ts(9 单测) |
| C5 | 删 SSE 全部残留 | ✅ | -1837 行;环境诊断换真实 /api/ws 握手探测;CLAUDE.md/managed-runtime.md 同步 |
| C6 | 测试重写 + 全量验证 | ✅ | typecheck 3 workspace ✓;web 533 + protocol 23 vitest ✓;cargo test 245+ ✓;clippy 0 警告;fmt ✓ |
| Core | FORK_NOTES P-009 弃用标记 | ✅ | 分支 `claude/p009-sse-deprecation` 已推送,待开 PR |
| 验证 | 运行时清单(见 §5) | 🟡 | 清单 1 已过:打包态原生 WS 被拦→自动回退 Rust 中继,功能正常;清单 2-6 进行中 |

---

## 5. 运行时验证清单(发布前必过)

1. **打包态 macOS WKWebView / Windows WebView2:`tauri://` 能否开 `ws://127.0.0.1:<port>/api/ws`**
   —— 决定 native/relay 默认值的 go/no-go;结果记回本文档。
   - ✅ **2026-06-09 真机实测(平台一)**:原生 WS 被打包态 webview 拦截,自动回退 **Rust 中继**
     成功,「WS 中继=连接中(中继路径)」,聊天功能正常。即:该平台上中继是事实默认,
     符合 §6 风险 1 的预判(协议仍是官方,净胜保留)。具体平台与另一平台结果待补。
2. `?wspath=relay` 强制中继:完整对话回合、审批、打断。
3. 睡眠 ≥2min 中途唤醒:≤15s 重连,在途回合续流到同一条消息(不再「切走再切回才可见」)。
4. dashboard 重启(YOLO 切换 / kill -9):token 轮换后正常重连,无 401 风暴。
5. ≥10min 长回合流式:顺序正确、无主动心跳误杀(重 markdown 渲染时看门狗误报检查)。
6. 老外壳兼容:v0.3.2 外壳连 Core main 构建的新 runtime(P-009 SSE 端点仍可用)。

## 6. 风险与已知限制

1. **原生 WS 被打包态 webview 拦截** —— 已被 Rust 中继全兜底;最坏情况某平台 relay 成事实默认,
   协议仍是官方,仍净胜(单 socket、无异步 ack、逐帧转发)。
2. **多会话在途回合**:重连只 resume 活跃会话;其余 `running` 会话停在「重连中」,用户切入时由
   `detail.tsx` 的 `ensureGatewaySession` 懒恢复(内容不丢,转录可从历史重建)。后续增强:遍历
   `streamStatus === "connecting"` 的会话逐个 resume。
3. **`session.resume` 慢**(分钟级 agent 重建):`reattachInFlight` 防叠加 + 瞬态文案 + 长超时。
4. 无主动 heartbeat 后,极端半开 socket 会等到下一次 RPC timeout 或 OS 唤醒强制重连才暴露;这是对齐官方桌面端以避免本地慢推理误杀的取舍。
5. 接管外部已运行 dashboard 时无法 env 注入 token —— HTML 抓取保留为显式 legacy 路径。

## 7. 关键文件索引

桌面端(本仓库):
- `web/src/lib/gateway-client.ts` — WS 客户端(协议层 + 内置重连编排;C3 激活为唯一传输)
- `web/src/lib/gateway-reconnect.ts` — 重连后 `session.resume`(C2 引入)
- `web/src/lib/gateway-relay-socket.ts` / `gateway-socket-path.ts` — Rust 中继 socket + 路径选择(C4 新增)
- `src/commands/ws_proxy.rs` — Rust WS 中继(C4 新增)
- `web/src/hooks/use-gateway.ts` — 网关桥接(单例;resume-on-reopen 门控落点)
- `web/src/stores/chat.ts` — `markStreamsReconnectingAtom` / `terminateAllStreamsAtom`
- `src/process/dashboard.rs` — 运行时 spawn/探测/token(env 注入已在 main;HTML 抓取为 legacy)

官方参考(`../Hermes-CN-Core`):
- `apps/shared/src/json-rpc-gateway.ts` — 官方 WS 协议层(线协议与我方一致)
- `apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts` — 官方重连编排(退避/唤醒/resync)
- `apps/desktop/src/app/session/hooks/use-route-resume.ts` — 官方重开后 `session.resume`
- `tui_gateway/ws.py` + `hermes_cli/web_server.py:8522` — `/api/ws` 端点
- `tui_gateway/sse.py` + `web_server.py:8575-8717` — P-009 SSE 端点(Core 侧标弃用、暂保留)

## 8. 变更记录

- 2026-06-09 — v1/v2 分支调研与 P0-2/P1-1 原型(详见 v2 分支历史;v2 的 WS-first+SSE 回退方案已被本分支取代)。
- 2026-06-09 — **决策 WS-only**:保留 Tauri 壳,连接层照搬官方;SSE 全删;兜底 Rust WS 中继。
  新开 `claude/gateway-ws-only`(基线 origin/main 6eda0c1)+ Core 侧 `claude/p009-sse-deprecation`。
  本文档重写(C1)。
