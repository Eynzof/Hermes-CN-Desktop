import { z } from "zod";

export const ProjectFolder = z.object({
  path: z.string(),
  label: z.string().optional(),
  is_primary: z.boolean().optional(),
  added_at: z.string().optional(),
});
export type ProjectFolder = z.infer<typeof ProjectFolder>;

export const Project = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  board_slug: z.string().optional(),
  primary_path: z.string().optional(),
  created_at: z.string(),
  archived: z.boolean().optional(),
  folders: z.array(ProjectFolder).optional(),
});
export type Project = z.infer<typeof Project>;

export const ProjectsListResponse = z.object({
  projects: z.array(Project),
  active_id: z.string().nullable().optional(),
});
export type ProjectsListResponse = z.infer<typeof ProjectsListResponse>;

export const ProjectCreateInput = z.object({
  name: z.string(),
  folders: z.array(z.string()).optional(),
  primary_path: z.string().optional(),
  use: z.boolean().optional(),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

export const ProjectUpdateInput = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;

export const ProjectTreeSession = z.object({
  session_id: z.string(),
  title: z.string().optional(),
  started_at: z.number().optional(),
  cwd: z.string().optional(),
  branch: z.string().optional(),
});
export type ProjectTreeSession = z.infer<typeof ProjectTreeSession>;

export const ProjectTreeLane = z.object({
  name: z.string(),
  sessions: z.array(ProjectTreeSession).optional(),
});
export type ProjectTreeLane = z.infer<typeof ProjectTreeLane>;

export const ProjectTreeRepo = z.object({
  root: z.string(),
  label: z.string().optional(),
  lanes: z.array(ProjectTreeLane).optional(),
});
export type ProjectTreeRepo = z.infer<typeof ProjectTreeRepo>;

export const ProjectTreeNode = z.object({
  project: Project,
  repos: z.array(ProjectTreeRepo).optional(),
  no_project_sessions: z.array(ProjectTreeSession).optional(),
});
export type ProjectTreeNode = z.infer<typeof ProjectTreeNode>;

export const ProjectsTreeResponse = z.object({
  tree: z.array(ProjectTreeNode),
  preview_limit: z.number().optional(),
  session_limit: z.number().optional(),
});
export type ProjectsTreeResponse = z.infer<typeof ProjectsTreeResponse>;

export const ProjectSessionsResponse = z.object({
  project: ProjectTreeNode.nullable(),
});
export type ProjectSessionsResponse = z.infer<typeof ProjectSessionsResponse>;

export const RepoDiscoveryItem = z.object({
  root: z.string(),
  label: z.string().optional(),
});
export type RepoDiscoveryItem = z.infer<typeof RepoDiscoveryItem>;

export const RepoDiscoveryResponse = z.object({
  recorded: z.number(),
});
export type RepoDiscoveryResponse = z.infer<typeof RepoDiscoveryResponse>;

export const ProjectForCwdResponse = z.object({
  project: Project.nullable(),
  cwd: z.string(),
  branch: z.string().optional(),
});
export type ProjectForCwdResponse = z.infer<typeof ProjectForCwdResponse>;
