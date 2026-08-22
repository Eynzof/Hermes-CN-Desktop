/**
 * Google Meet artifact parsing/formatting helpers.
 *
 * The Rust side owns the filesystem; this module provides pure functions for
 * working with status.json, transcript.txt, and caption deduplication.
 */

import type { MeetBotStatus, MeetTranscriptLine } from "@hermes/protocol";

export const TRANSCRIPT_LINE_RE = /^\[(\d{2}:\d{2}:\d{2})]\s*([^:]+):\s*(.+)$/;

export function parseTranscript(raw: string): MeetTranscriptLine[] {
  const lines: MeetTranscriptLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(TRANSCRIPT_LINE_RE);
    if (match) {
      lines.push({ ts: match[1], speaker: match[2].trim(), text: match[3].trim() });
    }
  }
  return lines;
}

export function formatTranscriptLine(line: MeetTranscriptLine): string {
  return `[${line.ts}] ${line.speaker}: ${line.text}`;
}

export function formatTranscript(lines: MeetTranscriptLine[]): string {
  return lines.map(formatTranscriptLine).join("\n");
}

export function transcriptTail(raw: string, last?: number): MeetTranscriptLine[] {
  const all = parseTranscript(raw);
  if (last === undefined || last <= 0) return all;
  return all.slice(-last);
}

export function dedupeKey(speaker: string, text: string): string {
  return `${speaker.trim().toLowerCase()}|${text.trim().toLowerCase()}`;
}

/** In-memory caption dedupe store matching Python `_BotState`. */
export class CaptionStore {
  private keys = new Set<string>();
  private lines: MeetTranscriptLine[] = [];

  add(line: MeetTranscriptLine): boolean {
    const key = dedupeKey(line.speaker, line.text);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.lines.push(line);
    return true;
  }

  getLines(): MeetTranscriptLine[] {
    return [...this.lines];
  }

  count(): number {
    return this.lines.length;
  }

  clear(): void {
    this.keys.clear();
    this.lines = [];
  }
}

export function parseStatus(raw: string): MeetBotStatus | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as MeetBotStatus;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function mergeStatus(
  active?: MeetBotStatus,
  bot?: MeetBotStatus,
): MeetBotStatus | undefined {
  if (!active && !bot) return undefined;
  return { ...(active ?? {}), ...(bot ?? {}) } as MeetBotStatus;
}

export function botStatusSummary(status?: MeetBotStatus): string {
  if (!status) return "No meeting status available.";
  const parts: string[] = [];
  if (status.meetingId) parts.push(`meeting: ${status.meetingId}`);
  if (status.inCall) parts.push("in call");
  else if (status.lobbyWaiting) parts.push("waiting in lobby");
  else if (status.exited) parts.push("exited");
  else parts.push("not in call");
  if (status.captioning) parts.push("captions on");
  if (typeof status.transcriptLines === "number") parts.push(`lines: ${status.transcriptLines}`);
  if (status.error) parts.push(`error: ${status.error}`);
  if (status.leaveReason) parts.push(`reason: ${status.leaveReason}`);
  return parts.join(", ");
}
