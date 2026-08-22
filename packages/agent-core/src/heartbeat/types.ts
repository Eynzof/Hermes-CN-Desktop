export interface HeartbeatConfig {
  sessionId: string;
  intervalMs: number;
  prompt: string;
  enabled: boolean;
  nextBeat?: number;
}
