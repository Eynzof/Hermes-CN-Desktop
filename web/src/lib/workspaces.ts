import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";
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

export function normalizeWorkspacePath(path: string | null | undefined): string {
  return (path ?? "").trim().replace(/\/+$/, "");
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
  const raw = readJSON<WorkspaceProject[]>(WORKSPACE_PROJECTS_STORAGE_KEY, []);
  const seen = new Set<string>();
  return raw.flatMap((item) => {
    const path = normalizeWorkspacePath(item?.path);
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [{
      path,
      name: item.name?.trim() || workspaceNameFromPath(path),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    }];
  });
}

export function rememberWorkspaceProject(path: string, name?: string): WorkspaceProject | null {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return null;

  const now = Date.now();
  const projects = readWorkspaceProjects();
  const existing = projects.find((item) => item.path === normalized);
  const nextProject: WorkspaceProject = existing
    ? {
        ...existing,
        name: name?.trim() || existing.name || workspaceNameFromPath(normalized),
        updatedAt: now,
      }
    : {
        path: normalized,
        name: name?.trim() || workspaceNameFromPath(normalized),
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

export function removeWorkspaceProject(path: string): void {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return;

  const projects = readWorkspaceProjects().filter((item) => item.path !== normalized);
  const sessionMap = readSessionWorkspaceMap();
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
  const raw = readJSON<Record<string, string>>(SESSION_WORKSPACE_STORAGE_KEY, {});
  return Object.fromEntries(
    Object.entries(raw).flatMap(([sessionId, path]) => {
      const normalized = normalizeWorkspacePath(path);
      return sessionId && normalized ? [[sessionId, normalized]] : [];
    }),
  );
}

export function rememberSessionWorkspace(sessionId: string | null | undefined, path: string): void {
  const normalizedSessionId = sessionId?.trim();
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedSessionId || !normalizedPath) return;

  const map = readSessionWorkspaceMap();
  map[normalizedSessionId] = normalizedPath;
  writeJSON(SESSION_WORKSPACE_STORAGE_KEY, map);
  rememberWorkspaceProject(normalizedPath);
}

export function subscribeWorkspaceChanges(listener: () => void): () => void {
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
    unsubscribe();
  };
}
