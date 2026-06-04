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
