// stdio 服务的 args / env 解析，行为对齐官方 McpPage：
// args 按空白或逗号切分；env 每行一个 KEY=VALUE（取第一个 = 之前为 key）。

export function parseArgs(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
