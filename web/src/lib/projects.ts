/**
 * Desktop Projects client — transport-agnostic interface.
 *
 * Phase A (managed runtime) uses the gateway JSON-RPC methods
 * (projects.list / projects.get / ...). Phase B swaps the transport to
 * Tauri IPC via `IpcProjectsClient` without changing consumers.
 */
import {
  Project,
  ProjectCreateInput,
  ProjectForCwdResponse,
  ProjectsListResponse,
  ProjectSessionsResponse,
  ProjectsTreeResponse,
  ProjectUpdateInput,
  RepoDiscoveryItem,
  RepoDiscoveryResponse,
} from "@hermes/protocol";
import { getGatewayClient, type GatewayClientLike } from "./gateway-client";

export type { Project, ProjectFolder, ProjectTreeNode, ProjectTreeRepo, ProjectTreeLane, ProjectTreeSession, ProjectsListResponse, ProjectsTreeResponse } from "@hermes/protocol";

export interface ProjectsClient {
  list(): Promise<ProjectsListResponse>;
  get(id: string): Promise<Project | null>;
  create(input: ProjectCreateInput): Promise<Project>;
  update(id: string, patch: ProjectUpdateInput): Promise<Project>;
  addFolder(id: string, path: string, opts?: { label?: string; isPrimary?: boolean }): Promise<Project>;
  removeFolder(id: string, path: string): Promise<Project>;
  setPrimary(id: string, path: string): Promise<Project>;
  archive(id: string, restore?: boolean): Promise<ProjectsListResponse>;
  delete(id: string): Promise<ProjectsListResponse>;
  setActive(id: string | null): Promise<{ activeId: string | null }>;
  forCwd(cwd: string): Promise<ProjectForCwdResponse>;
  tree(previewLimit?: number, sessionLimit?: number): Promise<ProjectsTreeResponse>;
  projectSessions(projectId: string): Promise<ProjectSessionsResponse>;
  recordRepos(repos: RepoDiscoveryItem[], policy?: unknown): Promise<RepoDiscoveryResponse>;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "");
}

export function createProjectSlug(name: string, existing: Set<string> = new Set()): string {
  let base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63);
  if (!base) base = "project";
  if (/^[^a-z0-9]/.test(base)) base = `p${base}`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function isValidProjectSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9\-_]{0,63}$/.test(slug);
}

export class RpcProjectsClient implements ProjectsClient {
  constructor(private readonly client: GatewayClientLike = getGatewayClient()) {}

  async list(): Promise<ProjectsListResponse> {
    return this.client.request("projects.list", {});
  }

  async get(id: string): Promise<Project | null> {
    return this.client.request("projects.get", { project_id: id });
  }

  async create(input: ProjectCreateInput): Promise<Project> {
    const folders = input.folders ?? (input.primary_path ? [input.primary_path] : []);
    const primary = input.primary_path ?? folders[0];
    return this.client.request("projects.create", {
      name: input.name,
      folders: folders.map((p) => normalizePath(p)),
      primary_path: primary ? normalizePath(primary) : undefined,
      use: input.use ?? true,
    });
  }

  async update(id: string, patch: ProjectUpdateInput): Promise<Project> {
    return this.client.request("projects.update", { project_id: id, ...patch });
  }

  async addFolder(id: string, path: string, opts?: { label?: string; isPrimary?: boolean }): Promise<Project> {
    return this.client.request("projects.add_folder", {
      project_id: id,
      path: normalizePath(path),
      label: opts?.label,
      is_primary: opts?.isPrimary,
    });
  }

  async removeFolder(id: string, path: string): Promise<Project> {
    return this.client.request("projects.remove_folder", { project_id: id, path: normalizePath(path) });
  }

  async setPrimary(id: string, path: string): Promise<Project> {
    return this.client.request("projects.set_primary", { project_id: id, path: normalizePath(path) });
  }

  async archive(id: string, restore = false): Promise<ProjectsListResponse> {
    return this.client.request("projects.archive", { project_id: id, restore });
  }

  async delete(id: string): Promise<ProjectsListResponse> {
    return this.client.request("projects.delete", { project_id: id });
  }

  async setActive(id: string | null): Promise<{ activeId: string | null }> {
    return this.client.request("projects.set_active", { project_id: id });
  }

  async forCwd(cwd: string): Promise<ProjectForCwdResponse> {
    return this.client.request("projects.for_cwd", { cwd: normalizePath(cwd) });
  }

  async tree(previewLimit?: number, sessionLimit?: number): Promise<ProjectsTreeResponse> {
    return this.client.request("projects.tree", {
      preview_limit: previewLimit,
      session_limit: sessionLimit,
    });
  }

  async projectSessions(projectId: string): Promise<ProjectSessionsResponse> {
    return this.client.request("projects.project_sessions", { project_id: projectId });
  }

  async recordRepos(repos: RepoDiscoveryItem[], policy?: unknown): Promise<RepoDiscoveryResponse> {
    return this.client.request("projects.record_repos", {
      repos: repos.map((r) => ({ root: normalizePath(r.root), label: r.label })),
      policy,
    });
  }
}

let sharedClient: ProjectsClient | null = null;

export function getProjectsClient(): ProjectsClient {
  if (!sharedClient) {
    sharedClient = new RpcProjectsClient();
  }
  return sharedClient;
}

export function setProjectsClient(client: ProjectsClient): void {
  sharedClient = client;
}
