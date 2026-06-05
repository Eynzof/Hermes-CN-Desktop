import type { MemoryInfo } from "@/lib/runtime";

export interface MemoryPageStat {
  label: string;
  value: number;
}

export function memoryPageStats(data: MemoryInfo): MemoryPageStat[] {
  return [
    { label: "记忆", value: data.memory.entries.length },
    { label: "记忆字符", value: data.memory.charCount },
    { label: "画像字符", value: data.user.charCount },
  ];
}

export function formatMemoryPageStat(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Math.floor(value).toLocaleString();
}
