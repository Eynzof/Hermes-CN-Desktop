// CLI 委派识别与输出解析（Claude Code / Codex）。
//
// 与后端 Hermes-CN-Core `tui_gateway/cli_delegation.py`（P-047）保持同一套
// 分类语义：新内核由后端发 delegation.cli.* 事件，本模块是旧内核回退路径
// （对 tool.start 的 context / tool.complete 的 args.command 做命令识别）
// 与历史重载恢复的唯一实现。分类规则改动必须双仓同步——共享 fixture 见
// cli-delegation.test.ts（与 Core tests/tui_gateway/test_cli_delegation_classifier.py
// 字面一致）。

export type CliDelegationAgent = "claude-code" | "codex";

export interface CliDelegationSpec {
  agent: CliDelegationAgent;
  mode: string; // print | exec | review | resume | interactive
  promptExcerpt: string;
  workdir: string | null;
  flags: Record<string, unknown>;
}

export interface CliDelegationSubEvent {
  kind: "init" | "text" | "tool_use" | "result" | "raw";
  text?: string;
  toolName?: string;
  sessionId?: string;
  model?: string;
  numTurns?: number;
  totalCostUsd?: number;
  subtype?: string;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CliDelegationResult {
  sessionId?: string;
  numTurns?: number;
  totalCostUsd?: number;
  subtype?: string;
  isError?: boolean;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const PROMPT_EXCERPT_CAP = 200;
const EVENT_TEXT_CAP = 300;

const EXCLUDED_LEADERS = new Set(["tmux", "ssh", "scp", "mosh"]);
const TRANSPARENT_WRAPPERS = new Set(["nohup", "time", "caffeinate", "stdbuf", "nice", "timeout", "env"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const CLAUDE_UTILITY_SUBCOMMANDS = new Set([
  "auth", "login", "logout", "doctor", "update", "install", "uninstall",
  "config", "mcp", "migrate-installer", "setup-token", "plugin",
]);
const CODEX_DELEGATION_SUBCOMMANDS = new Set(["exec", "e", "review", "resume"]);
const CODEX_UTILITY_SUBCOMMANDS = new Set([
  "login", "logout", "auth", "mcp", "proto", "completion", "debug",
  "apply", "sandbox", "cloud", "features", "doctor", "env",
]);

const VERSION_HELP_FLAGS = new Set(["--version", "-v", "--help", "-h", "-V"]);

const CLAUDE_VALUE_FLAGS = new Set([
  "--output-format", "--input-format", "--max-turns", "--model",
  "--resume", "-r", "--session-id", "--allowedTools", "--allowed-tools",
  "--disallowedTools", "--disallowed-tools", "--append-system-prompt",
  "--system-prompt", "--json-schema", "--add-dir", "--mcp-config",
  "--permission-mode", "--permission-prompt-tool", "--settings",
  "--agents", "--fallback-model", "--betas",
]);
const CODEX_VALUE_FLAGS = new Set([
  "--model", "-m", "--sandbox", "-s", "--cd", "-C",
  "--output-last-message", "-o", "--output-schema", "--profile", "-p",
  "--image", "-i", "--base",
]);

const PUNCT = "|&;()<>";
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_SHELL_RECURSION = 3;

const oneline = (text: string, cap: number) => text.replace(/\s+/g, " ").trim().slice(0, cap);

const basename = (token: string) => {
  const parts = token.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? token;
};

/** POSIX-ish 分词：单双引号、反斜杠转义，`|&;()<>` 连续串作为独立 token。 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  const push = () => {
    if (hasCurrent) {
      tokens.push(current);
      current = "";
      hasCurrent = false;
    }
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) {
        current += command.slice(i + 1);
        hasCurrent = true;
        i = n;
        break;
      }
      current += command.slice(i + 1, end);
      hasCurrent = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        const c = command[j]!;
        if (c === "\\" && j + 1 < n && (command[j + 1] === '"' || command[j + 1] === "\\")) {
          buf += command[j + 1]!;
          j += 2;
          continue;
        }
        if (c === '"') break;
        buf += c;
        j += 1;
      }
      current += buf;
      hasCurrent = true;
      i = j < n ? j + 1 : n;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      current += command[i + 1]!;
      hasCurrent = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      i += 1;
      continue;
    }
    if (PUNCT.includes(ch)) {
      push();
      let j = i;
      while (j < n && PUNCT.includes(command[j]!)) j += 1;
      tokens.push(command.slice(i, j));
      i = j;
      continue;
    }
    current += ch;
    hasCurrent = true;
    i += 1;
  }
  push();
  return tokens;
}

const isPunctToken = (tok: string) => tok.length > 0 && [...tok].every((ch) => PUNCT.includes(ch));

function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (isPunctToken(tok)) {
      if (current.length) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(tok);
  }
  if (current.length) segments.push(current);
  return segments;
}

function stripWrappers(words: string[]): string[] {
  let i = 0;
  const n = words.length;
  while (i < n) {
    const w = words[i]!;
    if (ENV_ASSIGN_RE.test(w)) {
      i += 1;
      continue;
    }
    const base = basename(w);
    if (base === "env") {
      i += 1;
      while (i < n && ENV_ASSIGN_RE.test(words[i]!)) i += 1;
      continue;
    }
    if (base === "timeout") {
      i += 1;
      while (i < n && words[i]!.startsWith("-")) {
        i += ["-k", "--kill-after", "-s", "--signal"].includes(words[i]!) ? 2 : 1;
      }
      if (i < n) i += 1; // DURATION
      continue;
    }
    if (base === "nice") {
      i += 1;
      if (i < n && words[i] === "-n") i += 2;
      continue;
    }
    if (base === "stdbuf") {
      i += 1;
      while (i < n && words[i]!.startsWith("-")) i += 1;
      continue;
    }
    if (TRANSPARENT_WRAPPERS.has(base)) {
      i += 1;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function parseFlagWalk(
  rest: string[],
  valueFlags: ReadonlySet<string>,
): { values: Map<string, string>; positionals: string[] } {
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i]!;
    if (valueFlags.has(tok)) {
      if (i + 1 < rest.length && !rest[i + 1]!.startsWith("-")) {
        values.set(tok, rest[i + 1]!);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (tok.startsWith("--") && tok.includes("=")) {
      const eq = tok.indexOf("=");
      const name = tok.slice(0, eq);
      if (valueFlags.has(name)) values.set(name, tok.slice(eq + 1));
      i += 1;
      continue;
    }
    if (tok.startsWith("-") && tok !== "-") {
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  return { values, positionals };
}

type TerminalArgs = Record<string, unknown> | undefined;

function classifyClaude(words: string[], args: TerminalArgs): CliDelegationSpec | null {
  const rest = words.slice(1);
  const tokens = new Set(rest);
  for (const flag of VERSION_HELP_FLAGS) if (tokens.has(flag)) return null;

  const printMode = tokens.has("-p") || tokens.has("--print");
  if (!printMode) {
    // 首个位置参数若是运维子命令（claude mcp list / claude update …）→ 非委派。
    // print 模式下位置参数是 prompt（`claude -p mcp` 是提示词），不做此判定。
    let idx = 0;
    while (idx < rest.length) {
      const tok = rest[idx]!;
      if (tok.startsWith("-")) {
        idx += CLAUDE_VALUE_FLAGS.has(tok) && idx + 1 < rest.length ? 2 : 1;
        continue;
      }
      if (CLAUDE_UTILITY_SUBCOMMANDS.has(tok)) return null;
      break;
    }
  }

  const { values, positionals } = parseFlagWalk(rest, CLAUDE_VALUE_FLAGS);
  const continueMode = tokens.has("-c") || tokens.has("--continue");
  const resumeId = values.get("--resume") ?? values.get("-r");
  const resumeMode = continueMode || resumeId !== undefined || tokens.has("--resume") || tokens.has("-r");

  const flags: Record<string, unknown> = {
    background: Boolean(args?.background),
    pty: Boolean(args?.pty),
  };
  if (printMode) flags.print = true;
  const outputFormat = values.get("--output-format");
  if (outputFormat) flags.output_format = outputFormat;
  const model = values.get("--model");
  if (model) flags.model = model;
  const maxTurns = values.get("--max-turns");
  if (maxTurns !== undefined) {
    const parsed = Number.parseInt(maxTurns, 10);
    if (Number.isFinite(parsed)) flags.max_turns = parsed;
  }
  if (resumeId) flags.resume_session = resumeId;
  if (continueMode) flags.continue = true;
  if (tokens.has("--include-partial-messages")) flags.include_partial_messages = true;
  if (tokens.has("--verbose")) flags.verbose = true;
  if (tokens.has("--dangerously-skip-permissions")) flags.dangerously_skip_permissions = true;

  const prompt = positionals[0] ?? "";
  const mode = resumeMode ? "resume" : printMode ? "print" : "interactive";
  return {
    agent: "claude-code",
    mode,
    promptExcerpt: oneline(prompt, PROMPT_EXCERPT_CAP),
    workdir: null,
    flags,
  };
}

function classifyCodex(words: string[], args: TerminalArgs): CliDelegationSpec | null {
  const rest = words.slice(1);
  const tokens = new Set(rest);
  for (const flag of VERSION_HELP_FLAGS) if (tokens.has(flag)) return null;

  let subcommand = "";
  let subIndex = -1;
  let idx = 0;
  while (idx < rest.length) {
    const tok = rest[idx]!;
    if (tok.startsWith("-")) {
      idx += CODEX_VALUE_FLAGS.has(tok) && idx + 1 < rest.length ? 2 : 1;
      continue;
    }
    if (CODEX_UTILITY_SUBCOMMANDS.has(tok)) return null;
    if (CODEX_DELEGATION_SUBCOMMANDS.has(tok)) {
      subcommand = tok === "e" ? "exec" : tok;
      subIndex = idx;
    }
    break;
  }

  const scan = subIndex >= 0 ? [...rest.slice(0, subIndex), ...rest.slice(subIndex + 1)] : rest;
  const { values, positionals } = parseFlagWalk(scan, CODEX_VALUE_FLAGS);

  const flags: Record<string, unknown> = {
    background: Boolean(args?.background),
    pty: Boolean(args?.pty),
  };
  if (tokens.has("--json")) flags.json = true;
  if (tokens.has("--full-auto")) flags.full_auto = true;
  if (tokens.has("--yolo") || tokens.has("--dangerously-bypass-approvals-and-sandbox")) flags.yolo = true;
  const sandbox = values.get("--sandbox") ?? values.get("-s");
  if (sandbox) flags.sandbox = sandbox;
  const model = values.get("--model") ?? values.get("-m");
  if (model) flags.model = model;

  const workdir = values.get("--cd") ?? values.get("-C") ?? null;
  let prompt = positionals[0] ?? "";
  const mode = subcommand || "interactive";
  if (mode === "resume") {
    if (positionals.length) {
      flags.resume_session = positionals[0];
      prompt = positionals[1] ?? "";
    }
  }
  return {
    agent: "codex",
    mode,
    promptExcerpt: oneline(prompt, PROMPT_EXCERPT_CAP),
    workdir,
    flags,
  };
}

function classifySegment(words: string[], args: TerminalArgs, depth: number): CliDelegationSpec | null {
  const stripped = stripWrappers(words);
  if (!stripped.length) return null;
  const base = basename(stripped[0]!);
  if (EXCLUDED_LEADERS.has(base)) return null;
  if (SHELLS.has(base)) {
    if (depth >= MAX_SHELL_RECURSION) return null;
    for (let idx = 1; idx < stripped.length; idx += 1) {
      const tok = stripped[idx]!;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(tok) && idx + 1 < stripped.length) {
        return classifyCommand(stripped[idx + 1]!, args, depth + 1);
      }
      if (!tok.startsWith("-")) break;
    }
    return null;
  }
  if (base === "claude") return classifyClaude(stripped, args);
  if (base === "codex") return classifyCodex(stripped, args);
  return null;
}

function classifyCommand(command: string, args: TerminalArgs, depth = 0): CliDelegationSpec | null {
  const segments = splitSegments(tokenizeShellCommand(command));
  let pendingWorkdir: string | null = null;
  for (const seg of segments) {
    const stripped = stripWrappers(seg);
    if (stripped.length >= 2 && basename(stripped[0]!) === "cd") {
      pendingWorkdir = stripped[1]!;
      continue;
    }
    const spec = classifySegment(seg, args, depth);
    if (spec) {
      const argsWorkdir = typeof args?.workdir === "string" && args.workdir ? args.workdir : null;
      const workdir = argsWorkdir ?? spec.workdir ?? pendingWorkdir;
      return workdir === spec.workdir ? spec : { ...spec, workdir };
    }
  }
  return null;
}

/** 判定 terminal 命令是否为一次 Claude Code / Codex 委派；识别不到返回 null。 */
export function classifyCliDelegation(
  command: string | undefined,
  args?: Record<string, unknown>,
): CliDelegationSpec | null {
  if (!command) return null;
  if (!command.includes("claude") && !command.includes("codex")) return null;
  return classifyCommand(command, args, 0);
}

// tool.start 的 context 形态：friendly 模式 "Running <cmd…80字符>"、关闭时裸
// 命令预览、旧版 "terminal: <cmd>"。剥前缀后走同一分类器；因截断只做临时判定，
// tool.complete 的全量 args.command 才是权威。
const CONTEXT_PREFIXES = [/^Running\s+/, /^terminal:\s*/i];

export function classifyFromContext(
  context: string | undefined,
  args?: Record<string, unknown>,
): CliDelegationSpec | null {
  if (!context) return null;
  let command = context;
  for (const prefix of CONTEXT_PREFIXES) command = command.replace(prefix, "");
  return classifyCliDelegation(command.trim(), args);
}

// ── 输出归一化（镜像 Core parse_claude_stream_json_line / parse_codex_jsonl_line） ──

const clip = (value: unknown, cap = EVENT_TEXT_CAP) => oneline(String(value ?? ""), cap);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function loadJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

const numOrUndef = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strOrUndef = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function parseClaudeStreamJsonLine(line: string): CliDelegationSubEvent[] {
  const obj = loadJsonLine(line);
  if (!obj) return [];
  const type = obj.type;
  if (type === "system" && obj.subtype === "init") {
    return [{ kind: "init", sessionId: strOrUndef(obj.session_id), model: strOrUndef(obj.model) }];
  }
  if (type === "assistant") {
    const message = asRecord(obj.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: CliDelegationSubEvent[] = [];
    const texts: string[] = [];
    for (const part of content) {
      const rec = asRecord(part);
      if (!rec) continue;
      if (rec.type === "tool_use") {
        events.push({ kind: "tool_use", toolName: clip(rec.name, 80) });
      } else if (rec.type === "text" && rec.text) {
        texts.push(String(rec.text));
      }
    }
    if (texts.length) events.push({ kind: "text", text: clip(texts.join("")) });
    return events;
  }
  if (type === "result") {
    return [{
      kind: "result",
      sessionId: strOrUndef(obj.session_id),
      numTurns: numOrUndef(obj.num_turns),
      totalCostUsd: numOrUndef(obj.total_cost_usd),
      subtype: strOrUndef(obj.subtype),
      isError: obj.is_error === true ? true : undefined,
    }];
  }
  return [];
}

export function parseCodexJsonlLine(line: string): CliDelegationSubEvent[] {
  const obj = loadJsonLine(line);
  if (!obj) return [];

  const msg = asRecord(obj.msg);
  if (msg) {
    const mtype = msg.type;
    if (mtype === "session_configured") {
      return [{ kind: "init", sessionId: strOrUndef(msg.session_id) }];
    }
    if (mtype === "agent_message" && msg.message) {
      return [{ kind: "text", text: clip(msg.message) }];
    }
    if (mtype === "exec_command_begin") {
      const cmd = Array.isArray(msg.command) ? msg.command.map(String).join(" ") : msg.command;
      return [{ kind: "tool_use", toolName: "shell", text: clip(cmd) }];
    }
    if (mtype === "task_complete") {
      return [{ kind: "result", text: clip(msg.last_agent_message) }];
    }
    return [];
  }

  const otype = obj.type;
  if (otype === "thread.started") {
    return [{ kind: "init", sessionId: strOrUndef(obj.thread_id) }];
  }
  if (otype === "item.completed") {
    const item = asRecord(obj.item);
    if (!item) return [];
    const itype = item.type ?? item.item_type;
    if (itype === "agent_message" && item.text) {
      return [{ kind: "text", text: clip(item.text) }];
    }
    if (itype === "command_execution") {
      return [{ kind: "tool_use", toolName: "shell", text: clip(item.command) }];
    }
    return [];
  }
  if (otype === "turn.completed") {
    const usage = asRecord(obj.usage);
    return [{
      kind: "result",
      inputTokens: numOrUndef(usage?.input_tokens),
      outputTokens: numOrUndef(usage?.output_tokens),
    }];
  }
  if (otype === "turn.failed") return [{ kind: "result", isError: true }];
  if (otype === "error" && obj.message) {
    return [{ kind: "text", text: clip(obj.message), isError: true }];
  }
  return [];
}

export function normalizeOutputLine(agent: CliDelegationAgent, line: string): CliDelegationSubEvent[] {
  return agent === "claude-code" ? parseClaudeStreamJsonLine(line) : parseCodexJsonlLine(line);
}

/** 把整段输出（前台结果 / 历史重载）解析为时间线子事件，cap 条数。 */
export function timelineFromOutput(
  agent: CliDelegationAgent,
  output: string,
  cap = 200,
): CliDelegationSubEvent[] {
  if (!output) return [];
  const events: CliDelegationSubEvent[] = [];
  for (const line of output.split("\n")) {
    if (events.length >= cap) break;
    events.push(...normalizeOutputLine(agent, line));
  }
  return events.slice(0, cap);
}

/** Core delegation.cli.output 事件里的归一化子事件是 snake_case，转成本地形态。 */
export function subEventFromWire(raw: unknown): CliDelegationSubEvent | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const kind = rec.kind;
  if (kind !== "init" && kind !== "text" && kind !== "tool_use" && kind !== "result" && kind !== "raw") {
    return null;
  }
  return {
    kind,
    text: strOrUndef(rec.text),
    toolName: strOrUndef(rec.tool_name),
    sessionId: strOrUndef(rec.session_id),
    model: strOrUndef(rec.model),
    numTurns: numOrUndef(rec.num_turns),
    totalCostUsd: numOrUndef(rec.total_cost_usd),
    subtype: strOrUndef(rec.subtype),
    isError: rec.is_error === true ? true : undefined,
    inputTokens: numOrUndef(rec.input_tokens),
    outputTokens: numOrUndef(rec.output_tokens),
  };
}

export function resultFromWire(raw: unknown): CliDelegationResult | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const result: CliDelegationResult = {
    sessionId: strOrUndef(rec.session_id),
    numTurns: numOrUndef(rec.num_turns),
    totalCostUsd: numOrUndef(rec.total_cost_usd),
    subtype: strOrUndef(rec.subtype),
    isError: rec.is_error === true ? true : undefined,
    text: strOrUndef(rec.text),
    inputTokens: numOrUndef(rec.input_tokens),
    outputTokens: numOrUndef(rec.output_tokens),
  };
  return Object.values(result).some((v) => v !== undefined) ? result : undefined;
}

export function extractClaudeResult(output: string): CliDelegationResult | undefined {
  if (!output) return undefined;
  const text = output.trim();
  if (text.startsWith("{")) {
    try {
      const whole = asRecord(JSON.parse(text));
      if (whole && (whole.type === "result" || "session_id" in whole)) {
        return resultFromWire(whole);
      }
    } catch {
      // 不是单对象 JSON，继续按行扫描。
    }
  }
  const lines = output.split("\n").slice(-200);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    for (const event of parseClaudeStreamJsonLine(lines[i]!)) {
      if (event.kind === "result") {
        const { kind: _kind, toolName: _t, ...rest } = event;
        return rest;
      }
    }
  }
  return undefined;
}

export function extractCodexResult(output: string): CliDelegationResult | undefined {
  if (!output) return undefined;
  const lines = output.split("\n").slice(-200);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    for (const event of parseCodexJsonlLine(lines[i]!)) {
      if (event.kind === "result") {
        const { kind: _kind, toolName: _t, ...rest } = event;
        return rest;
      }
    }
  }
  return undefined;
}

export function extractResult(agent: CliDelegationAgent, output: string): CliDelegationResult | undefined {
  return agent === "claude-code" ? extractClaudeResult(output) : extractCodexResult(output);
}
