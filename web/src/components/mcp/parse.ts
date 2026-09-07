// Arguments use whitespace/comma separators outside quotes. Backslashes are
// literal so Windows paths are preserved; quotes group a single argument.
export function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let value = "";
  let quote = "";
  let started = false;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/[\s,]/.test(char)) {
      if (started) args.push(value);
      value = "";
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error("参数中的引号未闭合");
  if (started) args.push(value);
  return args;
}

export function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const idx = line.indexOf("=");
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) env[key] = value;
    });
  return env;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : "操作失败";
}

import type { BadgeTone } from "@hermes/shared-ui";

export function transportTone(transport: string): BadgeTone {
  if (transport === "http") return "success";
  if (transport === "stdio") return "warning";
  return "neutral";
}
