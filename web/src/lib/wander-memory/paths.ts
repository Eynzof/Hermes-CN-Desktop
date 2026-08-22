// ─────────────────────────────────────────────────────────────────────────────
// wander-memory/paths.ts — canonical route paths for the MemOS (WanderMemory)
// surface. Single source of truth shared by app.tsx route registration, the
// Wander 记忆 top-tab, the sidebar and the command palette, so a rename never
// drifts across consumers.
// ─────────────────────────────────────────────────────────────────────────────

export const WANDER_MEMORY_PATHS = {
  root: "/wander-memory",
  memories: "/wander-memory/memories",
  files: "/wander-memory/files",
  dialogue: "/wander-memory/dialogue",
  chat: "/wander-memory/chat",
  context: "/wander-memory/context",
  status: "/wander-memory/status",
  api: "/wander-memory/api",
} as const;
