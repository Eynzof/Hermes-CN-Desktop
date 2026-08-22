import type { HeartbeatConfig } from "./types.js";

export type HeartbeatSubmit = (sessionId: string, prompt: string) => Promise<void>;

function parseInterval(input: string): number | undefined {
  const m = input.trim().match(/^(\d+)([smhd])$/i);
  if (!m) return undefined;
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return value * multipliers[unit];
}

export class HeartbeatLoop {
  private configs = new Map<string, HeartbeatConfig>();
  private submit: HeartbeatSubmit;

  constructor(submit: HeartbeatSubmit) {
    this.submit = submit;
  }

  set(sessionId: string, intervalText: string, prompt: string): string {
    const intervalMs = parseInterval(intervalText);
    if (!intervalMs) {
      throw new Error(`Invalid interval: ${intervalText}`);
    }
    const now = Date.now();
    const config: HeartbeatConfig = {
      sessionId,
      intervalMs,
      prompt,
      enabled: true,
      nextBeat: now + intervalMs,
    };
    this.configs.set(sessionId, config);
    return `Heartbeat set every ${intervalText}: ${prompt}`;
  }

  cancel(sessionId: string): string {
    const cfg = this.configs.get(sessionId);
    if (!cfg) return "No heartbeat for this session";
    cfg.enabled = false;
    return "Heartbeat cancelled";
  }

  list(): HeartbeatConfig[] {
    return Array.from(this.configs.values()).map((c) => ({ ...c }));
  }

  async tick(now = Date.now()): Promise<string[]> {
    const fired: string[] = [];
    for (const cfg of this.configs.values()) {
      if (!cfg.enabled || !cfg.nextBeat) continue;
      if (now >= cfg.nextBeat) {
        await this.submit(cfg.sessionId, cfg.prompt);
        fired.push(cfg.sessionId);
        cfg.nextBeat = now + cfg.intervalMs;
      }
    }
    return fired;
  }
}
