// CLI 委派分类器与输出解析的表驱动单测。
//
// FIXTURES 与后端共用同一份字面用例
// （Hermes-CN-Core: tests/tui_gateway/test_cli_delegation_classifier.py），
// 改动任意一侧必须同步另一侧——两边的分类语义必须一致，否则旧内核回退
// 模式下前端会与新内核事件判定不一致。
import { describe, expect, it } from "vitest";

import {
  classifyCliDelegation,
  classifyFromContext,
  extractClaudeResult,
  extractCodexResult,
  parseClaudeStreamJsonLine,
  parseCodexJsonlLine,
  subEventFromWire,
  timelineFromOutput,
} from "./cli-delegation";

interface FixtureExpect {
  agent: "claude-code" | "codex";
  mode: string;
  prompt: string;
  workdir?: string;
  flags?: Record<string, unknown>;
}

interface Fixture {
  name: string;
  command: string;
  args: Record<string, unknown>;
  expect: FixtureExpect | null;
}

const FIXTURES: Fixture[] = [
  {
    name: "claude-print-basic",
    command:
      "claude -p 'Add error handling to all API calls in src/' --allowedTools 'Read,Edit' --max-turns 10",
    args: { workdir: "/proj" },
    expect: {
      agent: "claude-code",
      mode: "print",
      prompt: "Add error handling to all API calls in src/",
      workdir: "/proj",
      flags: { print: true, max_turns: 10 },
    },
  },
  {
    name: "claude-output-json",
    command: "claude -p 'Analyze auth.py for security issues' --output-format json --max-turns 5",
    args: {},
    expect: {
      agent: "claude-code",
      mode: "print",
      prompt: "Analyze auth.py for security issues",
      flags: { output_format: "json", max_turns: 5 },
    },
  },
  {
    name: "claude-stream-json",
    command:
      "claude -p 'Write a summary' --output-format stream-json --verbose --include-partial-messages",
    args: { background: true },
    expect: {
      agent: "claude-code",
      mode: "print",
      prompt: "Write a summary",
      flags: {
        output_format: "stream-json",
        verbose: true,
        include_partial_messages: true,
        background: true,
      },
    },
  },
  {
    name: "claude-pipe-tail",
    command: 'cat notes.md | claude -p "Summarize this document"',
    args: {},
    expect: { agent: "claude-code", mode: "print", prompt: "Summarize this document" },
  },
  {
    name: "claude-pipe-head",
    command: "claude -p 'Explain X' --output-format stream-json --verbose | jq -rj '.text'",
    args: {},
    expect: {
      agent: "claude-code",
      mode: "print",
      prompt: "Explain X",
      flags: { output_format: "stream-json" },
    },
  },
  {
    name: "claude-cd-workdir",
    command: "cd /repo && claude -p 'fix tests'",
    args: {},
    expect: { agent: "claude-code", mode: "print", prompt: "fix tests", workdir: "/repo" },
  },
  {
    name: "claude-env-prefix",
    command: "ANTHROPIC_MODEL=opus claude -p hi",
    args: {},
    expect: { agent: "claude-code", mode: "print", prompt: "hi" },
  },
  {
    name: "claude-timeout-wrapper",
    command: "timeout 300 claude -p 'long task'",
    args: {},
    expect: { agent: "claude-code", mode: "print", prompt: "long task" },
  },
  {
    name: "claude-bash-lc",
    command: "bash -lc \"claude -p 'quoted task' --output-format json\"",
    args: {},
    expect: {
      agent: "claude-code",
      mode: "print",
      prompt: "quoted task",
      flags: { output_format: "json" },
    },
  },
  {
    name: "claude-resume",
    command: "claude -p 'Continue the refactor' --resume abc-123 --max-turns 5",
    args: {},
    expect: {
      agent: "claude-code",
      mode: "resume",
      prompt: "Continue the refactor",
      flags: { resume_session: "abc-123" },
    },
  },
  {
    name: "claude-continue",
    command: "claude --continue -p 'keep going'",
    args: {},
    expect: { agent: "claude-code", mode: "resume", prompt: "keep going", flags: { continue: true } },
  },
  {
    name: "claude-interactive-bare",
    command: "claude",
    args: { pty: true },
    expect: { agent: "claude-code", mode: "interactive", prompt: "", flags: { pty: true } },
  },
  {
    name: "claude-redirect",
    command: "claude -p 'Start refactor' --output-format json > /tmp/session.json",
    args: {},
    expect: {
      agent: "claude-code",
      mode: "print",
      prompt: "Start refactor",
      flags: { output_format: "json" },
    },
  },
  {
    name: "chained-after-build",
    command: "echo done && claude -p 'after build'",
    args: {},
    expect: { agent: "claude-code", mode: "print", prompt: "after build" },
  },
  {
    name: "codex-exec",
    command: "codex exec 'Add dark mode toggle to settings'",
    args: { pty: true },
    expect: {
      agent: "codex",
      mode: "exec",
      prompt: "Add dark mode toggle to settings",
      flags: { pty: true },
    },
  },
  {
    name: "codex-exec-background",
    command: "codex exec --full-auto 'Refactor the auth module'",
    args: { background: true, pty: true },
    expect: {
      agent: "codex",
      mode: "exec",
      prompt: "Refactor the auth module",
      flags: { full_auto: true, background: true, pty: true },
    },
  },
  {
    name: "codex-exec-json",
    command: "codex exec --json --full-auto 'task'",
    args: {},
    expect: { agent: "codex", mode: "exec", prompt: "task", flags: { json: true, full_auto: true } },
  },
  {
    name: "codex-review",
    command: "codex review --base origin/main",
    args: {},
    expect: { agent: "codex", mode: "review", prompt: "" },
  },
  {
    name: "codex-cd-flag-before-subcommand",
    command: "codex -C /work exec 'task'",
    args: {},
    expect: { agent: "codex", mode: "exec", prompt: "task", workdir: "/work" },
  },
  {
    name: "codex-resume",
    command: "codex resume 019a-xyz 'continue the task'",
    args: {},
    expect: {
      agent: "codex",
      mode: "resume",
      prompt: "continue the task",
      flags: { resume_session: "019a-xyz" },
    },
  },
  { name: "codex-login-utility", command: "codex login", args: {}, expect: null },
  { name: "claude-version-utility", command: "claude --version", args: {}, expect: null },
  { name: "claude-mcp-utility", command: "claude mcp list", args: {}, expect: null },
  {
    name: "tmux-wrapped-excluded",
    command: "tmux send-keys -t claude-work 'cd /p && claude' Enter",
    args: {},
    expect: null,
  },
  { name: "ssh-remote-excluded", command: "ssh host claude -p x", args: {}, expect: null },
  { name: "which-claude-not-delegation", command: "which claude", args: {}, expect: null },
  {
    name: "npm-install-not-delegation",
    command: "npm install -g @anthropic-ai/claude-code",
    args: {},
    expect: null,
  },
  { name: "unrelated-command", command: "ls -la /tmp", args: {}, expect: null },
];

describe("classifyCliDelegation（与 Core 共享 fixture）", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      const spec = classifyCliDelegation(fixture.command, fixture.args);
      if (fixture.expect === null) {
        expect(spec).toBeNull();
        return;
      }
      expect(spec).not.toBeNull();
      expect(spec!.agent).toBe(fixture.expect.agent);
      expect(spec!.mode).toBe(fixture.expect.mode);
      expect(spec!.promptExcerpt).toBe(fixture.expect.prompt);
      if (fixture.expect.workdir !== undefined) {
        expect(spec!.workdir).toBe(fixture.expect.workdir);
      }
      for (const [key, value] of Object.entries(fixture.expect.flags ?? {})) {
        expect(spec!.flags[key], `flags.${key}`).toEqual(value);
      }
    });
  }

  it("prompt 摘录单行化且截断到 200", () => {
    const prompt = `line one\nline two   with   spaces${"x".repeat(400)}`;
    const spec = classifyCliDelegation(`claude -p '${prompt}'`, {});
    expect(spec).not.toBeNull();
    expect(spec!.promptExcerpt).not.toContain("\n");
    expect(spec!.promptExcerpt.length).toBeLessThanOrEqual(200);
  });
});

describe("classifyFromContext（tool.start 截断预览的临时判定）", () => {
  it("剥掉 friendly 动词前缀 Running", () => {
    const spec = classifyFromContext("Running claude -p 'Analyze auth.py' --output-form");
    expect(spec?.agent).toBe("claude-code");
    expect(spec?.mode).toBe("print");
  });

  it("兼容旧版 terminal: 前缀与裸命令", () => {
    expect(classifyFromContext("terminal: codex exec 'task'")?.agent).toBe("codex");
    expect(classifyFromContext("codex exec 'task'")?.agent).toBe("codex");
  });

  it("非委派 context 返回 null", () => {
    expect(classifyFromContext("Running ls -la /tmp")).toBeNull();
    expect(classifyFromContext(undefined)).toBeNull();
  });
});

describe("输出归一化", () => {
  it("解析 claude stream-json 行", () => {
    expect(
      parseClaudeStreamJsonLine('{"type":"system","subtype":"init","session_id":"s-1","model":"opus"}'),
    ).toEqual([{ kind: "init", sessionId: "s-1", model: "opus" }]);

    const tool = parseClaudeStreamJsonLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}},{"type":"text","text":"running"}]}}',
    );
    expect(tool).toContainEqual({ kind: "tool_use", toolName: "Bash" });
    expect(tool).toContainEqual({ kind: "text", text: "running" });

    const result = parseClaudeStreamJsonLine(
      '{"type":"result","subtype":"success","session_id":"s-1","num_turns":3,"total_cost_usd":0.01,"is_error":false}',
    );
    expect(result[0]).toMatchObject({ kind: "result", sessionId: "s-1", numTurns: 3 });

    expect(
      parseClaudeStreamJsonLine('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"h"}}}'),
    ).toEqual([]);
    expect(parseClaudeStreamJsonLine("plain text, not json")).toEqual([]);
  });

  it("解析 codex 两代 JSONL 形态", () => {
    expect(parseCodexJsonlLine('{"id":"1","msg":{"type":"agent_message","message":"done"}}')).toEqual([
      { kind: "text", text: "done" },
    ]);
    const begin = parseCodexJsonlLine(
      '{"id":"2","msg":{"type":"exec_command_begin","command":["git","status"]}}',
    );
    expect(begin[0]).toMatchObject({ kind: "tool_use", toolName: "shell", text: "git status" });

    expect(parseCodexJsonlLine('{"type":"thread.started","thread_id":"t-1"}')).toEqual([
      { kind: "init", sessionId: "t-1" },
    ]);
    const turn = parseCodexJsonlLine('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}');
    expect(turn[0]).toMatchObject({ kind: "result", inputTokens: 10, outputTokens: 5 });
    expect(parseCodexJsonlLine('{"type":"turn.failed"}')[0]).toMatchObject({ kind: "result", isError: true });
    expect(parseCodexJsonlLine("garbage {not json")).toEqual([]);
  });

  it("extractClaudeResult 兼容单对象与 stream 末行", () => {
    const whole = extractClaudeResult(
      '{"type":"result","subtype":"success","session_id":"s-9","num_turns":2,"total_cost_usd":0.02,"is_error":false}',
    );
    expect(whole?.sessionId).toBe("s-9");

    const stream = [
      '{"type":"system","subtype":"init","session_id":"s-9","model":"opus"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","session_id":"s-9","num_turns":1,"total_cost_usd":0.005,"is_error":false}',
    ].join("\n");
    expect(extractClaudeResult(stream)?.numTurns).toBe(1);
    expect(extractClaudeResult("plain text output")).toBeUndefined();
  });

  it("extractCodexResult 从 JSONL 尾部提取", () => {
    const output = [
      '{"type":"thread.started","thread_id":"t-2"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
    ].join("\n");
    expect(extractCodexResult(output)?.outputTokens).toBe(4);
    expect(extractCodexResult("no json here")).toBeUndefined();
  });

  it("timelineFromOutput 整段解析并 cap", () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"t"}]}}';
    const timeline = timelineFromOutput("claude-code", Array(300).fill(line).join("\n"), 200);
    expect(timeline.length).toBeLessThanOrEqual(200);
    expect(timeline[0]).toMatchObject({ kind: "text" });
  });

  it("subEventFromWire 转换 snake_case 线上事件", () => {
    expect(
      subEventFromWire({ kind: "result", session_id: "s", num_turns: 2, total_cost_usd: 0.1 }),
    ).toMatchObject({ kind: "result", sessionId: "s", numTurns: 2, totalCostUsd: 0.1 });
    expect(subEventFromWire({ kind: "nope" })).toBeNull();
    expect(subEventFromWire("str")).toBeNull();
  });
});
