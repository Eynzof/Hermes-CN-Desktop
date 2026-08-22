export function isInsideGitWorktree(path: string): boolean {
  // v1 stub: assume true for paths containing ".git" or any path.
  return path.length > 0;
}

export function nearestRoot(path: string, markers: string[]): string | undefined {
  // v1 stub: return the directory portion.
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : undefined;
}
