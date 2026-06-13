import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";
import { resolveSessionIdAliases } from "@/lib/session-map";
export interface WorkspaceProject {
  path: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export const WORKSPACE_STORAGE_KEY = "hermes-cn-ui.workspacePath";

const WORKSPACE_PROJECTS_STORAGE_KEY = "hermes-cn-ui.workspaceProjects";
const SESSION_WORKSPACE_STORAGE_KEY = "hermes-cn-ui.sessionWorkspaces";
const PINNED_WORKSPACE_PROJECTS_STORAGE_KEY = "hermes-cn-ui.pinnedWorkspaceProjects";
const WORKSPACE_CHANGED_EVENT = "hermes-cn-ui.workspaces.changed";

export function normalizeWorkspacePath(path: unknown): string {
  return typeof path === "string" ? path.trim().replace(/\/+$/, "") : "";
}

export function workspaceNameFromPath(path: string): string {
  const normalized = normalizeWorkspacePath(path).replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized || "NewProject";
}

function emitWorkspaceChange(): void {
  try {
    window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
  } catch {}
}

function readJSON<T>(key: string, fallback: T): T {
  return readUiValue<T>(key, fallback);
}

function writeJSON(key: string, value: unknown): void {
  writeUiValue(key, value);
  emitWorkspaceChange();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkspacePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const path = normalizeWorkspacePath(item);
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [path];
  });
}

export function readWorkspacePath(): string {
  return normalizeWorkspacePath(readUiValue(WORKSPACE_STORAGE_KEY, ""));
}

export function writeWorkspacePath(path: string): void {
  const normalized = normalizeWorkspacePath(path);
  if (normalized) {
    writeUiValue(WORKSPACE_STORAGE_KEY, normalized);
  } else {
    removeUiValue(WORKSPACE_STORAGE_KEY);
  }
  emitWorkspaceChange();
}

export function readWorkspaceProjects(): WorkspaceProject[] {
  const rawValue = readJSON<unknown>(WORKSPACE_PROJECTS_STORAGE_KEY, []);
  const raw = Array.isArray(rawValue) ? rawValue : [];
  const seen = new Set<string>();
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const path = normalizeWorkspacePath(item.path);
    if (!path || seen.has(path)) return [];
    seen.add(path);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
    const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now();
    return [{
      path,
      name: name || workspaceNameFromPath(path),
      createdAt,
      updatedAt,
    }];
  });
}

export function rememberWorkspaceProject(path: string, name?: string): WorkspaceProject | null {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return null;

  const now = Date.now();
  const projects = readWorkspaceProjects();
  const existing = projects.find((item) => item.path === normalized);
  const displayName = typeof name === "string" ? name.trim() : "";
  const nextProject: WorkspaceProject = existing
    ? {
        ...existing,
        name: displayName || existing.name || workspaceNameFromPath(normalized),
        updatedAt: now,
      }
    : {
        path: normalized,
        name: displayName || workspaceNameFromPath(normalized),
        createdAt: now,
        updatedAt: now,
      };

  const next = [
    nextProject,
    ...projects.filter((item) => item.path !== normalized),
  ];
  writeJSON(WORKSPACE_PROJECTS_STORAGE_KEY, next);
  return nextProject;
}

export function readPinnedWorkspaceProjectPaths(): Set<string> {
  return new Set(
    normalizeWorkspacePathList(readJSON<unknown>(PINNED_WORKSPACE_PROJECTS_STORAGE_KEY, [])),
  );
}

export function writePinnedWorkspaceProjectPaths(paths: Iterable<string>): Set<string> {
  const cleanPaths = normalizeWorkspacePathList(Array.from(paths));
  writeJSON(PINNED_WORKSPACE_PROJECTS_STORAGE_KEY, cleanPaths);
  return new Set(cleanPaths);
}

export function isWorkspaceProjectPinned(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized ? readPinnedWorkspaceProjectPaths().has(normalized) : false;
}

export function togglePinnedWorkspaceProject(path: string): Set<string> {
  const normalized = normalizeWorkspacePath(path);
  const paths = readPinnedWorkspaceProjectPaths();
  if (!normalized) return paths;
  if (paths.has(normalized)) paths.delete(normalized);
  else paths.add(normalized);
  return writePinnedWorkspaceProjectPaths(paths);
}

export function unpinWorkspaceProjects(pathsToUnpin: Iterable<string>): Set<string> {
  const paths = readPinnedWorkspaceProjectPaths();
  let changed = false;
  for (const path of pathsToUnpin) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized && paths.delete(normalized)) changed = true;
  }
  return changed ? writePinnedWorkspaceProjectPaths(paths) : paths;
}

function readRawSessionWorkspaceMap(): Record<string, string> {
  const raw = readJSON<unknown>(SESSION_WORKSPACE_STORAGE_KEY, {});
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([sessionId, path]) => {
      const normalizedSessionId = sessionId.trim();
      const normalized = normalizeWorkspacePath(path);
      return normalizedSessionId && normalized ? [[normalizedSessionId, normalized]] : [];
    }),
  );
}

function withSessionIdAliases(map: Record<string, string>): Record<string, string> {
  const expanded = { ...map };
  for (const [sessionId, workspacePath] of Object.entries(map)) {
    for (const alias of resolveSessionIdAliases(sessionId, { includeExpired: true })) {
      if (!expanded[alias]) {
        expanded[alias] = workspacePath;
      }
    }
  }
  return expanded;
}

export function removeWorkspaceProject(path: string): void {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return;

  const projects = readWorkspaceProjects().filter((item) => item.path !== normalized);
  const sessionMap = readRawSessionWorkspaceMap();
  const nextSessionMap = Object.fromEntries(
    Object.entries(sessionMap).filter(([, workspacePath]) => workspacePath !== normalized),
  );

  writeJSON(WORKSPACE_PROJECTS_STORAGE_KEY, projects);
  writeJSON(SESSION_WORKSPACE_STORAGE_KEY, nextSessionMap);

  if (readWorkspacePath() === normalized) {
    writeWorkspacePath("");
  }

  unpinWorkspaceProjects([normalized]);
}

export function readSessionWorkspaceMap(): Record<string, string> {
  return withSessionIdAliases(readRawSessionWorkspaceMap());
}

export function rememberSessionWorkspace(sessionId: string | null | undefined, path: string): void {
  const normalizedSessionId = sessionId?.trim();
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedSessionId || !normalizedPath) return;

  const map = readRawSessionWorkspaceMap();
  const aliases = resolveSessionIdAliases(normalizedSessionId, { includeExpired: true });
  for (const alias of aliases.length > 0 ? aliases : [normalizedSessionId]) {
    map[alias] = normalizedPath;
  }
  writeJSON(SESSION_WORKSPACE_STORAGE_KEY, map);
  rememberWorkspaceProject(normalizedPath);
}

/**
 * Resolve the workspace that should be shown for a session.
 *
 * Precedence:
 *   1. The backend's stored `cwd` for the session (source of truth — survives
 *      across devices, storage clears, and sessions created before this build).
 *   2. The client-side session→workspace map, keyed by any of the session's ids
 *      (gateway / persistent), for sessions the backend has no explicit cwd for
 *      (legacy sessions, or ones where the user never picked a folder).
 *
 * Returns "" when no workspace is known for the session, so the caller can fall
 * back to its own default (e.g. the last-used global workspace).
 */
export function resolveSessionWorkspace(
  backendCwd: string | null | undefined,
  sessionIds: Array<string | null | undefined>,
): string {
  const fromBackend = normalizeWorkspacePath(backendCwd);
  if (fromBackend) return fromBackend;

  const map = readSessionWorkspaceMap();
  for (const sessionId of sessionIds) {
    const key = sessionId?.trim();
    if (!key) continue;
    const fromMap = normalizeWorkspacePath(map[key]);
    if (fromMap) return fromMap;
  }
  return "";
}

export function mirrorSessionWorkspaceMapping(
  gatewaySessionId: string | null | undefined,
  persistentSessionId: string | null | undefined,
): void {
  const gatewayId = gatewaySessionId?.trim();
  const persistentId = persistentSessionId?.trim();
  if (!gatewayId || !persistentId || gatewayId === persistentId) return;

  const map = readRawSessionWorkspaceMap();
  const workspacePath = normalizeWorkspacePath(map[gatewayId] ?? map[persistentId]);
  if (!workspacePath) return;

  if (map[gatewayId] === workspacePath && map[persistentId] === workspacePath) {
    return;
  }
  map[gatewayId] = workspacePath;
  map[persistentId] = workspacePath;
  writeJSON(SESSION_WORKSPACE_STORAGE_KEY, map);
  rememberWorkspaceProject(workspacePath);
}

export function subscribeWorkspaceChanges(listener: () => void): () => void {
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
    unsubscribe();
  };
}
