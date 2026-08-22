export function sseFrame(event?: string, data?: unknown): string {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  if (data !== undefined) lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join("\n") + "\n\n";
}
