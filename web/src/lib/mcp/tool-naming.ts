export function sanitizeMcpNameComponent(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export function qualifyMcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpNameComponent(server)}__${sanitizeMcpNameComponent(tool)}`;
}

export function parseQualifiedMcpToolName(qualified: string): { server: string; tool: string } | null {
  const m = qualified.match(/^mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}
