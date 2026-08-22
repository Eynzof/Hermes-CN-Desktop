import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ProjectCreateInput,
  ProjectUpdateInput,
  type Project,
  type ProjectsListResponse,
  type ProjectsTreeResponse,
} from "@hermes/protocol";
import { getProjectsClient } from "@/lib/projects";

const projectsKeys = {
  all: ["projects"] as const,
  list: () => [...projectsKeys.all, "list"] as const,
  detail: (id: string) => [...projectsKeys.all, "detail", id] as const,
  tree: () => [...projectsKeys.all, "tree"] as const,
};

export function useProjects() {
  return useQuery<ProjectsListResponse, Error>({
    queryKey: projectsKeys.list(),
    queryFn: () => getProjectsClient().list(),
  });
}

export function useProject(id: string) {
  return useQuery<Project | null, Error>({
    queryKey: projectsKeys.detail(id),
    queryFn: () => getProjectsClient().get(id),
    enabled: Boolean(id),
  });
}

export function useProjectTree(previewLimit?: number, sessionLimit?: number) {
  return useQuery<ProjectsTreeResponse, Error>({
    queryKey: [...projectsKeys.tree(), previewLimit ?? "default", sessionLimit ?? "default"],
    queryFn: () => getProjectsClient().tree(previewLimit, sessionLimit),
  });
}

function invalidateProjects(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: projectsKeys.all });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation<Project, Error, ProjectCreateInput>({
    mutationFn: (input) => getProjectsClient().create(input),
    onSuccess: () => invalidateProjects(qc),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation<Project, Error, { id: string; patch: ProjectUpdateInput }>({
    mutationFn: ({ id, patch }) => getProjectsClient().update(id, patch),
    onSuccess: () => invalidateProjects(qc),
  });
}

export function useArchiveProject() {
  const qc = useQueryClient();
  return useMutation<ProjectsListResponse, Error, { id: string; restore?: boolean }>({
    mutationFn: ({ id, restore }) => getProjectsClient().archive(id, restore),
    onSuccess: () => invalidateProjects(qc),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation<ProjectsListResponse, Error, string>({
    mutationFn: (id) => getProjectsClient().delete(id),
    onSuccess: () => invalidateProjects(qc),
  });
}

export function useSetActiveProject() {
  const qc = useQueryClient();
  return useMutation<{ activeId: string | null }, Error, string | null>({
    mutationFn: (id) => getProjectsClient().setActive(id),
    onSuccess: () => invalidateProjects(qc),
  });
}

export function useProjectMutations() {
  const qc = useQueryClient();
  const addFolder = useMutation<Project, Error, { id: string; path: string; label?: string; isPrimary?: boolean }>({
    mutationFn: ({ id, path, label, isPrimary }) => getProjectsClient().addFolder(id, path, { label, isPrimary }),
    onSuccess: () => invalidateProjects(qc),
  });
  const removeFolder = useMutation<Project, Error, { id: string; path: string }>({
    mutationFn: ({ id, path }) => getProjectsClient().removeFolder(id, path),
    onSuccess: () => invalidateProjects(qc),
  });
  const setPrimary = useMutation<Project, Error, { id: string; path: string }>({
    mutationFn: ({ id, path }) => getProjectsClient().setPrimary(id, path),
    onSuccess: () => invalidateProjects(qc),
  });
  return { addFolder, removeFolder, setPrimary };
}

export { projectsKeys };
