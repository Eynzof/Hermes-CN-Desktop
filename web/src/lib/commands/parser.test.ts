import { describe, expect, it } from "vitest";
import { extractOneShotPrompt, parseCliArgv, tokenizeShellCommand } from "./parser";

describe("parseCliArgv", () => {
  it("parses command and positional args", () => {
    const parsed = parseCliArgv("chat hello world");
    expect(parsed.command).toBe("chat");
    expect(parsed.positional).toEqual(["hello", "world"]);
  });

  it("parses long and short flags", () => {
    const parsed = parseCliArgv("chat -m gpt-4 --provider openai --yolo");
    expect(parsed.flags.model).toBe("gpt-4");
    expect(parsed.flags.provider).toBe("openai");
    expect(parsed.flags.yolo).toBe(true);
    expect(parsed.positional).toEqual([]);
  });

  it("supports --flag=value form", () => {
    const parsed = parseCliArgv("chat --model=claude-sonnet-4 --profile=work");
    expect(parsed.flags.model).toBe("claude-sonnet-4");
    expect(parsed.flags.profile).toBe("work");
  });

  it("supports one-shot -z", () => {
    const parsed = parseCliArgv("hermes -z write a test");
    expect(parsed.command).toBe("hermes");
    // `-z` is value-consuming: the next token becomes the flag value.
    expect(parsed.flags.oneshot).toBe("write");
    expect(extractOneShotPrompt(parsed.args)).toBe("write a test");
  });

  it("tokenizes quoted strings", () => {
    expect(tokenizeShellCommand('chat "hello world"')).toEqual(["chat", "hello world"]);
    expect(tokenizeShellCommand("chat 'hello world'")).toEqual(["chat", "hello world"]);
  });
});
