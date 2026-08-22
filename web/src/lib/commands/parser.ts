import { tokenizeShellCommand } from "@/lib/cli-delegation";
import type { GlobalFlag } from "./types";

export interface ParsedArgv {
  command: string;
  args: readonly string[];
  flags: Record<GlobalFlag, string | boolean | undefined>;
  positional: readonly string[];
}

const GLOBAL_FLAG_ALIASES: Record<string, GlobalFlag> = {
  m: "model",
  t: "toolsets",
  r: "resume",
  s: "skills",
  p: "profile",
  w: "worktree",
  q: "oneshot",
  z: "oneshot",
  c: "continue",
  in: "input",
};

const LONG_FLAG_MAP: Record<string, GlobalFlag> = {
  model: "model",
  provider: "provider",
  reasoning: "reasoning",
  toolsets: "toolsets",
  tools: "toolsets",
  resume: "resume",
  skills: "skills",
  profile: "profile",
  worktree: "worktree",
  yolo: "yolo",
  continue: "continue",
  input: "input",
  "usage-file": "usageFile",
  usagefile: "usageFile",
  oneshot: "oneshot",
};

function normalizeFlagName(raw: string): GlobalFlag | null {
  if (raw.startsWith("--")) {
    const name = raw.slice(2).toLowerCase();
    const split = name.indexOf("=");
    const key = split >= 0 ? name.slice(0, split) : name;
    return LONG_FLAG_MAP[key] ?? null;
  }
  if (raw.startsWith("-")) {
    const name = raw.slice(1).toLowerCase();
    const split = name.indexOf("=");
    const key = split >= 0 ? name.slice(0, split) : name;
    return GLOBAL_FLAG_ALIASES[key] ?? null;
  }
  return null;
}

/**
 * Parse a CLI-style command line into a structured argv object.
 *
 * The first token is treated as the command; all remaining tokens are split
 * into flags and positional arguments. Supports POSIX-style `-f value`,
 * `--flag value`, and `--flag=value` forms.
 */
export function parseCliArgv(input: string): ParsedArgv {
  const tokens = tokenizeShellCommand(input.trim());
  const command = tokens[0]?.trim() ?? "";
  const args = tokens.slice(1);
  const flags: Record<GlobalFlag, string | boolean | undefined> = {
    model: undefined,
    provider: undefined,
    reasoning: undefined,
    toolsets: undefined,
    resume: undefined,
    skills: undefined,
    profile: undefined,
    worktree: undefined,
    yolo: undefined,
    continue: undefined,
    input: undefined,
    oneshot: undefined,
    usageFile: undefined,
  };
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;
    const flag = normalizeFlagName(tok);

    if (flag) {
      // --flag=value form
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        flags[flag] = tok.slice(eq + 1);
        i += 1;
        continue;
      }
      // boolean flag or value-consuming flag
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[flag] = next;
        i += 2;
        continue;
      }
      flags[flag] = true;
      i += 1;
      continue;
    }

    positional.push(tok);
    i += 1;
  }

  return { command, args, flags, positional };
}

/** Extract the trailing prompt from a one-shot invocation (`hermes -z <prompt>`). */
export function extractOneShotPrompt(args: readonly string[]): string {
  const idx = args.findIndex((a) => a === "-z" || a === "--oneshot");
  if (idx < 0) return "";
  return args.slice(idx + 1).join(" ").trim();
}

export { tokenizeShellCommand };
