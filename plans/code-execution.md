# Code Execution (`execute_code`) — Python → TypeScript Rewrite Plan

> Feature slug: `code-execution` · Design-only plan (no implementation).
> 目标：把 `execute_code`（Python 脚本 + 经 RPC 调用 Hermes 工具的 PTC 能力）从
> Python 后端 `D:/hermes-agent-cn` 迁入 TS 前端 agent runtime（Tauri webview），
> 最终去掉 Dashboard `/api/ws` + REST 上的该工具调用路径。

## 1. Summary

`execute_code` 让 LLM 写一段 Python 脚本，脚本通过自动生成的 `hermes_tools.py`
RPC stub 调用 7 个 Hermes 工具（`web_search`, `web_extract`, `read_file`,
`write_file`, `search_files`, `patch`, `terminal`），把多步工具链折叠成一次推理；
中间工具结果不进上下文，只回传脚本 stdout。

本计划的关键设计决策：**保留一个薄 Python 运行时 sidecar 执行 LLM 生成的 Python
代码，不把执行器重写为纯 TS**。原因：(a) 该工具的输入契约本身就是 Python 源码，
Node `vm` / Web Worker / WASM（Pyodide）都无法运行带原生依赖的项目级 Python；
(b) `project` 模式要求复用用户 venv（pandas/torch/项目包），WASM 解释器不可行；
(c) 纯 TS 重写会改变模型已学会的工具语义与 `website/docs/user-guide/features/code-execution.md`
契约。TS 侧负责：工具注册、RPC 分发（file-based RPC，参考 Core 远程后端）、
资源限制、env 清理、审批、结果组装；Rust 侧负责 spawn/杀进程树（沿用
`src/commands/terminal.rs` 模式）。Python 侧需要随 managed runtime 捆绑一个独立
解释器——当前 PyInstaller 冻结运行时（`tools/runtime_compat.py`）下 `execute_code`
被 `SANDBOX_AVAILABLE=False` 禁用，这是迁移前必须先解决的打包缺口。

## 2. Current Python implementation

源文件（均在 `D:/hermes-agent-cn`）：

- **`tools/code_execution_tool.py`**（~2000 行）——主实现：
  - `SANDBOX_ALLOWED_TOOLS`：7 个工具白名单；`execute_code`/`delegate_task`/MCP 工具不可递归调用。
  - 资源限制：`DEFAULT_TIMEOUT=300`（300s）、`DEFAULT_MAX_TOOL_CALLS=50`（50 次）、
    `MAX_STDOUT_BYTES=50_000`（50KB）、`MAX_STDERR_BYTES=10_000`（10KB），
    可经 `config.yaml → code_execution.*` 覆盖（`_load_config`）。
  - `generate_hermes_tools_module(enabled_tools, transport)`：生成 `hermes_tools.py`
    （`uds` 头 / `file` 头 + 公共助手 `json_parse` / `shell_quote` / `retry`）；
    `_TOOL_STUBS` 保存 7 个工具的签名/文档/args 表达式，与
    `tools/registry.py` 的 schema 有防漂移测试。
  - 本地执行路径：staging 目录写 `script.py` + `hermes_tools.py`（UTF-8）→
    RPC server 线程（POSIX `AF_UNIX`，Windows loopback TCP，`secrets.token_urlsafe`
    token + `secrets.compare_digest` 鉴权）→ 子进程（`subprocess.Popen`，
    `start_new_session=True`，Windows `CREATE_NO_WINDOW`）→ 轮询循环（超时/中断/
    活动 touch）→ head+tail stdout 排水、stderr head 排水 → ANSI strip →
    `agent.redact.redact_sensitive_text(code_file=True)` → JSON 结果。
  - `_rpc_server_loop`：按连接串行分发；校验 allowlist、tool-call 计数、
    `_TERMINAL_BLOCKED_PARAMS`（terminal 只允许前台参数），经
    `model_tools.handle_function_call` 在 `thread_scoped_silence()` 下分发；
    线程用 `tools.thread_context.propagate_context_to_thread` 包裹以继承审批回调（#33057）。
  - `_execute_remote`：Docker/SSH/Modal 等远端后端用 file-based RPC（`req_*`/`res_*`
    文件 + base64 传输 + 自适应轮询），复用 `tools/terminal_tool` 的 env。
  - `_scrub_child_env`：env 清理规则（见 §5）——安全前缀、密钥子串黑名单、
    `_HERMES_CHILD_ALLOWED` 操作变量精确名单、Windows 必需变量名单、skill/config
    passthrough 优先、delegate 子任务 kanban scrub。
  - 执行模式：`EXECUTION_MODES=("project","strict")`，默认 `project`；
    `_resolve_child_python`（strict=`sys.executable`；project=VIRTUAL_ENV/CONDA_PREFIX
    下 python.exe/python，3.8+ probe，失败回退 sys.executable，结果带缓存）；
    `_resolve_child_cwd`（strict=staging；project=session CWD/TERMINAL_CWD/override）。
  - 审批：`tools.approval.check_execute_code_guard(code, env_type, has_host_access)`
    决策矩阵（隔离后端放行、headless-local 放行、cron deny、gateway pending/
    approve/deny、smart 模式、session yolo、一次性审批）；用户批准后清中断位。
  - 中断：`tools.interrupt.is_interrupted` 合作取消；超时先 SIGTERM 后 5s SIGKILL
    （`_kill_process_group`，psutil 递归杀子树）。
  - 失败提示：`_sandbox_failure_hint` 把常见错误（import 白名单外工具、helper 误 import、
    缺模块、把结果当字符串）映射为可操作修复提示。
  - 冻结运行时：`is_frozen_runtime()` → `SANDBOX_AVAILABLE=False`，CN 桌面打包态当前禁用。
- **`tools/daemon_pool.py`**——`DaemonThreadPoolExecutor`（daemon worker、不进
  `_threads_queues`，atexit 不 join）。用于 Python 父进程侧并发工具批次；execute_code
  本身用单连接串行 RPC，不直接依赖它。
- **`mini_swe_runner.py`**（Core 根目录）——SWE bench runner：用 Hermes 的
  local/docker/modal env + `terminal` 工具跑任务、输出 Hermes 轨迹格式；CLI 入口
  （`fire`）。桌面 standalone 无对应消费场景，计划标记为 out-of-scope（见 §8）。
- 文档：`website/docs/user-guide/features/code-execution.md`（模式/限制/安全模型/平台支持）。

数据流（本地）：LLM `code` → `execute_code()` → 审批 guard → staging 写文件 →
RPC server 线程（UDS/TCP）→ spawn 子进程（scrubbed env、PYTHONPATH=staging+hermes root）→
脚本内 `from hermes_tools import …` 调用 `_call()` → 父线程 `handle_function_call`
→ 回 JSON → 脚本 print → 父进程 head+tail 截断 + redact → `{status, output,
exit_code, tool_calls_made, duration_seconds, stdout_*}` JSON。

## 3. Target TypeScript design

运行位置：Tauri webview 内的 TS agent runtime（与 README 的 end-state 一致）；
Rust 保留 OS 级能力。模块布局（`D:/Hermes-CN-Desktop`）：

```
web/src/tools/execute-code/
  tool.ts              # execute_code ExecutableTool（kimi-code ToolManager 形状）
  runner.ts            # CodeExecutionRunner：编排 spawn→RPC→limits→result
  stub-generator.ts    # 生成 hermes_tools.py 源码（模板字符串，逐字对齐 Core）
  env-scrub.ts         # _scrub_child_env 纯函数移植 + 共享 fixtures
  rpc-dispatcher.ts    # file-based RPC 分发：轮询 req_* → handleToolCall → res_*
  result.ts            # head+tail 截断、ANSI strip、redact、result JSON 组装
  approval.ts          # check_execute_code_guard 决策矩阵移植（复用 approval-mode.ts）
  config.ts            # 读 code_execution.{mode,timeout,max_tool_calls}
src/commands/execute_code.rs   # spawn/kill/读写 staging 的 Tauri command
```

核心接口（伪代码）：

```ts
interface CodeExecutionRunner {
  run(input: {
    code: string; taskId: string; enabledTools: string[];
    signal: AbortSignal;  // 用户新消息/取消
  }): Promise<CodeExecutionResult>;
}
interface CodeExecutionResult {
  status: "success" | "error" | "timeout" | "interrupted";
  output: string; exit_code: number;
  tool_calls_made: number; duration_seconds: number;
  stdout_truncated: boolean; stdout_bytes_captured: number;
  stdout_bytes_total: number; stdout_bytes_omitted: number;
  error?: string; hint?: string;
}
```

流程（与 Python 本地路径 1:1）：
1. 审批：`approval.ts` 复用 `web/src/lib/approval-mode.ts` 的 mode 读取 + Rust
   `connection_mode`；决策矩阵逐项移植（见 §9 风险）。
2. Rust `execute_code_spawn`（新 command）：建 staging 目录、写 `script.py` +
   `hermes_tools.py`（UTF-8）、按 `env-scrub.ts` 计算 child env、解析解释器与 CWD
   （`project`/`strict` 同 §2 规则）、spawn 子进程（Windows 用
   `CREATE_NO_WINDOW` + 独立进程组）、返回 `{runId, pid}`；stdout/stderr 由 Rust
   按 head+tail / head 预算排水（或管道到 TS 由 TS 计数——推荐 Rust 端只做原始字节
   滚动缓冲，TS 端做截断与 redact，保持逻辑单一来源在 TS）。
3. RPC：**file-based transport**（复用 Core `_FILE_TRANSPORT_HEADER` 的 Python 端
   逻辑）：子进程把 `{tool,args,token}` 写成 `req_000001`；TS `rpc-dispatcher.ts`
   每 50–250ms 经 Tauri IPC（`read_dir`/`read_file`/`write_file`/`remove_file` 或新增
   `execute_code_rpc_poll` 一条命令）轮询，调用 in-process 的 TS 工具 handler
   （同一个 `handleToolCall`，与 agent loop 共用），写回 `res_000001`；计数
   `tool_calls_made`，达 50 返回错误；terminal 剥离 `_TERMINAL_BLOCKED_PARAMS`。
   无需 webview 绑定 socket——这是跨平台且已被 Core 远程后端证明的通道。
4. 生命周期：TS 持有 deadline（300s）+ AbortSignal；超时/中断时调 Rust
   `execute_code_kill(runId, escalate)`（POSIX killpg、Windows `taskkill /T`，
   参考 `_kill_process_group` 的 SIGTERM→5s→SIGKILL 两阶段）。
5. 结果：`result.ts` 做 50KB head+tail（40%/60%，与 `_assemble_stdout_result`
   逐字一致）、ANSI strip、`redact_sensitive_text(code_file=True)`（复用/移植
   `web/src/lib/debug-redact.ts`），输出与 Python 相同的 JSON 字段。

不用 TCP/UDS RPC server 在 webview 的替代方案（记录在案）：
- **Option B（备选/后续优化）**：Rust 线程起 loopback TCP 或 UDS RPC server，
  每请求经 Tauri event（`execute-code.rpc-request` + promise map）回 webview 分发。
  延迟更低，但 Rust↔webview 往返握手复杂，v1 不采用。
- **Node sidecar**：若 agent loop 迁到 Node 进程（而非 webview），可把 file-RPC
  换成 TCP RPC server（Node `net`）；脚本仍必须用 Python sidecar。

## 4. Data models & persistence

- `execute_code` 本身无状态：不新增 SQLite/IndexedDB 表、不迁移 schema。
- 配置持久化：`~/.hermes/config.yaml` 的 `code_execution.{mode,timeout,max_tool_calls}`
  与 `terminal.env_passthrough`。TS 侧经现有 config 读取层
  （`web/src/lib/config-update.ts` / `config-migration-assistant.ts`）读取；键名与
  Python `_load_config` 完全一致，无 schema 迁移。
- 运行期产物：staging 目录（`script.py`/`hermes_tools.py`/`rpc/`）由 Rust 建/删，
  等价 Python 的 `shutil.rmtree` + socket unlink；不留持久文件。
- 会话内观察：`tool_call_log`（每次 RPC 的工具名/参数预览/耗时）保持内存级，
  随会话 transcript（现有 chat store）记录，不单独落盘。
- `mini_swe_runner` 的 JSONL 轨迹：桌面 standalone 无此消费方，不移植（见 §8）。

## 5. Third-party library strategy（最重要）

| Python 依赖/能力 | TS 等价 | kimi-code 证据 / 说明 |
|---|---|---|
| `subprocess.Popen` + psutil 进程树杀 | Rust `std::process` + 平台杀进程（POSIX `killpg` / Windows `taskkill /T /F`）经 Tauri command；不用 npm 库 | `apps/kimi-code/src/native`（node-pty）；`packages/agent-core/src/tools/builtin/shell/bash.ts` 的 `killSpawnedProcess`/`disposeProcess` 展示 SIGTERM→grace→SIGKILL 两阶段 + 关 stdin |
| `threading.Thread` RPC server（UDS/TCP） | **无直接等价**——webview 不能 bind socket；改用 file-based RPC（TS 轮询 + Tauri IPC），或 Option B Rust socket | kimi-code 无工具间 socket 模式；file RPC 逻辑直接移植 Core `_FILE_TRANSPORT_HEADER`（已是字符串模板） |
| `secrets.compare_digest` | `node:crypto.timingSafeEqual` | 标准库，kimi-code 未用到；TS 实现字符串转 Buffer 后比较 |
| `orjson` / `json` | `JSON.stringify/parse` + `zod`（v4）schema 校验 | `packages/agent-core` 全面用 `zod`（package.json: `zod ^4.3.6`） |
| `shlex.quote`（stub 内 `shell_quote`） | 自实现（同 kimi-code） | `bash.ts` 内已有 `shellQuote(s)`（`'` 转义 `'\''`），直接复用同一逻辑 |
| `tempfile.mkdtemp` / staging | Rust `std::env::temp_dir` + 随机子目录（经 command），或 Node `os.tmpdir` | kimi-code native 用 `os.tmpdir`；Tauri 侧沿用 terminal.rs 的路径解析 |
| venv/CONDA 解释器探测（3.8+ probe + 缓存） | Node `fs.access` + spawn `-c` probe（5s 超时、失败不缓存、FIFO 缓存） | `apps/kimi-code/src/utils/process/resolve-command.ts` 的 PATH/PATHEXT 探测模式；无 Python 解释器管理等价物 → 自实现 |
| env 清理 `_scrub_child_env` | 纯 TS 函数，逐字移植名单（`_SAFE_ENV_PREFIXES`、`_SECRET_SUBSTRINGS`、`_HERMES_CHILD_ALLOWED`、`_WINDOWS_ESSENTIAL_ENV_VARS`、passthrough 优先） | 无 npm 依赖；测试 fixtures 从 `tests/tools/test_code_execution_windows_env.py` 复制，与 `cli-delegation.ts` 双仓共享 fixture 的做法一致 |
| `agent.redact.redact_sensitive_text(code_file=True)` | 复用/移植 `web/src/lib/debug-redact.ts`（桌面已有 redact 模块） | 需加 `code_file=True` 语义（跳过 ENV/JSON/f-string 误报，仍遮真实凭据） |
| `tools.ansi_strip.strip_ansi` | 小模块或 `strip-ansi`（实现时确认依赖）；kimi-code 未显式使用 | 可选：直接移植 Core `tools/ansi_strip.py` 的 ANSI 正则到 TS |
| `web_search`/`web_extract` handler | `packages/agent-core/src/tools/builtin/web/web-search.ts`、`fetch-url.ts`（in-process TS handler，RPC dispatcher 直接调用） | 已有 TS 等价工具实现 |
| `read_file`/`write_file`/`search_files`/`patch` handler | `packages/agent-core/src/tools/builtin/file/read.ts`、`write.ts`、`grep.ts`、`glob.ts`、`edit.ts` | 已有 TS 等价；注意参数名/返回结构与 Python stub 对齐（`pattern/target/path/file_glob/…`） |
| `terminal` handler（前台） | `BashTool`（kaos/BackgroundManager）+ 桌面 `src/commands/terminal.rs` | kimi-code BashTool 是权威参考；execute_code 内只允许前台参数 |
| `daemon_pool.py`（DaemonThreadPoolExecutor） | 不需要直接移植：TS 侧 RPC 单连接串行（Python 端同样加 `_call_lock`）；若未来并发批处理需 worker 池，用 `worker_threads` | kimi-code 用 `BackgroundManager`/`ProcessBackgroundTask` 管理任务生命周期，无 atexit-join 问题 |
| 审批矩阵 `check_execute_code_guard` | `approval.ts` 移植 + 复用 `web/src/lib/approval-mode.ts`（mode/yolo/永久-会话审批） | 无 kimi-code 等价（kimi-code 有 permission/approval，`src/agent/permission/`），决策矩阵以 Core 测试为准 |

### “No TS equivalent” 风险（本计划最核心结论）

1. **Python 执行本身无 TS 等价**：Node `vm`/Web Worker 只能跑 JS；Pyodide/
   pythonmonkey 是 WASM Python，无原生扩展、体积大（>10MB）、且无法进入用户 venv，
   `project` 模式（`import pandas`、`from my_project import foo`）在 WASM 下不可能。
   → 必须保留 Python sidecar。这是设计决策，不是可选项。
2. **捆绑 Python 解释器**：PyInstaller 冻结运行时（CN 桌面打包态）没有独立
   python.exe，`SANDBOX_AVAILABLE=False`。TS 版 strict 模式必须随 managed runtime
   捆绑 standalone Python（python-build-standalone / embeddable zip），涉及打包、
   体积与镜像源（cnb.cool vs GitHub Actions，见 desktop-release-preflight）决策。
3. **webview 无 socket/进程能力**：UDS/TCP RPC server 与进程组杀都不能在 webview
   直接做 → file-based RPC + Rust spawn/kill command；与 Python 的 UDS 低延迟
   体验有差异（每次工具调用 +50–250ms）。

## 6. Integration with existing Hermes-CN-Desktop frontend

复用：
- `src/commands/terminal.rs`——spawn/PTY/env 构建（`apply_terminal_env`、
  `build_terminal_env`、effective PATH、node bin dir P-032、`hermes.cmd`/`hermes`
  shim）作为 `execute_code.rs` 的 spawn/环境模板；`portable_pty` 仅终端需要，
  execute_code 用 `std::process` 管道即可。
- `web/src/lib/tauri-bridge.ts`——新增 `executeCodeSpawn`/`executeCodeKill`/
  `executeCodeRpc*` IPC shim。
- `web/src/lib/approval-mode.ts` + `web/src/lib/config-update.ts`——审批 mode 与
  `code_execution.*` 配置读取。
- `web/src/lib/debug-redact.ts`——输出 redaction（补 `code_file=True` 语义）。
- `web/src/stores/chat.ts` / `components/chat/message-adapter.ts`——已渲染
  `execute_code` 工具 part（`toolCallId`/`tool_id` 流），无需改动 UI。
- `web/src/lib/gateway-client.ts`——仅迁移期使用（WS 里 execute_code 事件照常消费），
  迁移完成后删除该工具的 WS 消费分支。
- `web/src/routes/console.tsx` + `EmbeddedTerminal`——不直接相关，但审批弹窗/运行状态
  可复用它的事件流模式。

新增：
- `web/src/tools/execute-code/*`（§3 模块）注册进 TS ToolManager，形状对齐 kimi-code
  `ExecutableTool`（`resolveExecution(args) → {description, approvalRule, execute({signal})}`，
  证据：`packages/agent-core/src/agent/tool/index.ts`）。
- `src/commands/execute_code.rs` 及其在 `src/state.rs`/invoke_handler 的注册。

## 7. Removing the WebSocket dependency (migration path)

冻结的 API 面（迁移期间不变）：
- `execute_code` 结果 JSON schema（`status/output/exit_code/tool_calls_made/
  duration_seconds/stdout_*` + `error/hint`）。
- 7 个 stub 的函数签名与返回结构（`_TOOL_STUBS` 与 registry schema 防漂移测试保持）。
- 配置键 `code_execution.{mode,timeout,max_tool_calls}`、`terminal.env_passthrough`。
- terminal 前台-only 参数白名单（`_TERMINAL_BLOCKED_PARAMS`）。

阶段：
- **P0/影子期**：TS `CodeExecutionRunner` 与 Python `execute_code` 并存；同一脚本
  corpus 双跑对比（parity harness），结果差异作为 bug 而非允许偏差；TS 侧不接 agent loop。
- **P1**：TS runner 接入 in-process agent loop 的 ToolManager，作为唯一执行路径
  （webview 本地模式）；WS 上的 execute_code 消费保留为 fallback（远端 backend 仍走 Python）。
- **P2**：桌面只支持本地终端后端；远端（docker/ssh/modal）execute_code 标记
  out-of-scope（terminal 工具远程能力保留在其他计划的迁移里），删除
  `_execute_remote` 的 WS/REST 路径。
- **P3**：删除 Python `tools/code_execution_tool.py` 中本地+远程路径与 WS 事件源；
  `gateway-client.ts` 中 execute_code 分支移除；文档更新。

## 8. Migration phases & task breakdown

| Phase | 内容 | 验收 |
|---|---|---|
| P0 基础移植 | `env-scrub.ts`、`stub-generator.ts`、`result.ts`（截断/ANSI/redact）、`config.ts` + vitest 单元测试（fixtures 复制自 Core 测试） | 与 Python 逐位一致（含 Windows 名单、`_assemble_stdout_result` 文案） |
| P1 运行时 | `src/commands/execute_code.rs`（spawn/kill/staging）+ `rpc-dispatcher.ts`（file RPC）+ `runner.ts`（deadline/计数/中断）+ 集成测试（mock dispatcher） | 真实 bundled python 跑通 `print`/单工具/并发锁/超时杀 |
| P2 接入 | 注册 `execute_code` 进 ToolManager（ExecutableTool 形状）、`approval.ts` 接入、审批 UI 复用、config 接入；影子 parity 关闭 | chat 里 execute_code 结果渲染正确；审批矩阵 15+ 用例通过 |
| P3 打包 | managed runtime 捆绑 standalone Python（strict 模式）；project 模式解释器探测；Windows CI（`windows_only` 用例） | 打包态可用（当前 `SANDBOX_AVAILABLE=False` 缺口关闭）；`test_code_execution_windows_env` 对应用例通过 |
| P4 收尾 | 删除 Python 路径 + WS 分支；`mini_swe_runner` 决策记录（out-of-scope）；文档更新 | 无 WS 依赖；Playwright E2E 通过 |

`mini_swe_runner`：纯 CLI/bench harness（`fire` 入口、JSONL 轨迹），桌面 standalone
无消费场景——按 README 规则标记 **out-of-scope for desktop standalone**，保留本文件
决策记录，不做 TS 移植。

## 9. Risks & open questions

1. **无 TS 等价：Python 执行**（§5）——唯一可行路径是 Python sidecar + 捆绑解释器；
   若未来希望去掉 Python 依赖，只能改变工具契约（改跑 JS/Deno），属产品决策，不在本计划内。
2. **捆绑 Python 的体积/镜像**：python-build-standalone 每平台 30–50MB；需过
   `desktop-release-preflight`（China 镜像 artifactUrl-before-signing、cnb.cool vs
   GitHub Actions 构建位点）与安装器升级回归（现有用户 v0.3.2 原地覆盖升级）。
3. **file RPC 延迟与并发**：+50–250ms/次 vs UDS；stub 内 `_call` 必须串行（锁）；
   轮询线程必须随 kill 停止并清理 staging。
4. **webview CSP/无 eval**：LLM 代码只在子进程跑；webview 内严禁 `eval`/`new Function`。
5. **审批矩阵 parity**：`check_execute_code_guard` 的 cron deny、gateway
   pending/approve/deny、smart 模式、一次性 vs 会话审批、yolo 短路——必须与
   `tests/tools/test_execute_code_approval_cluster.py` 逐用例对齐；桌面 approval-mode
   若与 Core 有语义差，以 Core 为基准。
6. **Windows 进程树杀**：`psutil` 递归杀 → Rust `taskkill /T /F`；需处理
   CREATE_NO_WINDOW、PATH/PATHEXT、SYSTEMROOT 依赖（Winsock 10106 类问题）。
7. **project 模式解释器解析**：venv probe 的 3.8+ 门槛、失败不缓存、外部解释器
   从 PYTHONPATH 剔除 hermes root 的规则，需逐字保留。
8. **redaction parity**：`code_file=True` 语义（跳过 ENV/JSON/f-string 误报）必须
   与 Core `agent/redact.py` 一致，否则会泄漏或误伤输出。
9. 开放问题：是否接受 Option B（Rust TCP RPC）以降低延迟？捆绑解释器放 managed
   runtime 还是独立 `python-bin/` 目录？远端 backend execute_code 是否要保留（本计划
   默认 out-of-scope）？`tests/test_resource_limits.py` 实际是 RLIMIT_NOFILE 启动逻辑
   （与 execute_code 无直接关系，feature report 引用有误）——是否在 Core 侧补真正
   的 execute_code limits 测试待确认。

## 10. Test strategy

- **Vitest 单元**（`web/src/tools/execute-code/*.test.ts`）：
  - `env-scrub.test.ts`：从 `tests/tools/test_code_execution_windows_env.py` 复制
    fixtures（含 `_legacy_posix_scrubber` oracle 等价物）逐字对比；passthrough 优先；
    Windows 名单大小写归一。
  - `stub-generator.test.ts`：生成 `hermes_tools.py` 源码与 Core `generate_hermes_tools_module`
    的 fixture 逐字 diff（双仓共享 fixture，同 `cli-delegation.test.ts` 模式）；
    空工具集、file transport 头、并发锁存在性。
  - `result.test.ts`：50KB head+tail 截断文案/字节元数据、stderr 拼接、超时/中断文案、
    ANSI strip、redact。
  - `approval.test.ts`：决策矩阵（docker 放行、headless-local、cron deny、gateway
    pending/approve/deny、smart、session yolo、一次性）→ 对齐
    `test_execute_code_approval_cluster.py`。
  - schema/mode 描述：`build_execute_code_schema` 的 “no sandbox language” 回归
    （`test_code_execution_modes.py` 的 39b83f34 守卫）。
- **集成**（vitest + Rust 端或 CI 脚本）：真实 bundled python 跑 `print`、单工具、
  并发 10 线程 RPC 应答匹配（对齐 `test_code_execution.py` 的 race 回归）、超时杀、
  工具调用数达 50 报错、terminal 阻塞参数剥离。
- **Windows CI**：复用 `windows_only` marker 的 socket smoke 用例 → 等价 TS/Rust
  用例（scrubbed env 下 spawn 子进程 + AF_INET socket）。
- **Parity harness**（P2 影子期）：同一脚本 corpus 双跑 Python vs TS runner，
  比较 `status/output/exit_code/tool_calls_made`；差异视为 bug。
- **Playwright E2E**：chat 中 execute_code 运行 → 结果卡片渲染；审批弹窗 approve/
  deny 流；Console 路由不受影响。
- `mini_swe_runner`：不移植，无测试。

## 11. Reference links

- Core 实现：`D:/hermes-agent-cn/tools/code_execution_tool.py`、
  `tools/daemon_pool.py`、`mini_swe_runner.py`、`tools/runtime_compat.py`、
  `tools/approval.py`（`check_execute_code_guard`）、`tools/env_passthrough.py`、
  `tools/thread_context.py`、`tools/interrupt.py`、`agent/redact.py`、`tools/ansi_strip.py`
- Core 文档：`D:/hermes-agent-cn/website/docs/user-guide/features/code-execution.md`
- Core 测试：`tests/tools/test_code_execution.py`、`test_code_execution_modes.py`、
  `test_code_execution_windows_env.py`、`tests/tools/test_execute_code_approval_cluster.py`、
  `tests/test_resource_limits.py`（RLIMIT_NOFILE，注意误引用）、`tests/test_mini_swe_runner.py`
- TS 参考（kimi-code）：`packages/agent-core/src/agent/tool/index.ts`（ToolManager/
  ExecutableTool）、`packages/agent-core/src/tools/builtin/shell/bash.ts`（BashTool/
  Kaos/BackgroundManager 两阶段杀）、`packages/agent-core/src/tools/builtin/index.ts`
  （工具清单，无 Python 执行等价）、`apps/kimi-code/src/utils/process/resolve-command.ts`
  （PATH/PATHEXT 解析）、`apps/kimi-code/src/utils/process/shell-env.ts`
- 桌面：`D:/Hermes-CN-Desktop/src/commands/terminal.rs`、
  `web/src/routes/console.tsx`、`web/src/lib/cli-delegation.ts`（双仓共享 fixture 先例）、
  `web/src/lib/gateway-client.ts`、`web/src/lib/approval-mode.ts`、
  `web/src/lib/debug-redact.ts`、`scripts/tauri-dev-managed.mjs`、`.codex/skills/desktop-release-preflight`
