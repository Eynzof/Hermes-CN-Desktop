// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, type QueryClientConfig } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  projectsKeys,
  useArchiveProject,
  useCreateProject,
  useDeleteProject,
  useProject,
  useProjectMutations,
  useProjects,
  useProjectTree,
  useSetActiveProject,
  useUpdateProject,
} from "./use-projects";
import type { Project, ProjectsClient, ProjectsListResponse, ProjectsTreeResponse } from "@/lib/projects";

const clientState = vi.hoisted(() => {
  let current: ProjectsClient | null = null;
  return {
    __setClient(c: ProjectsClient | null): void {
      current = c;
    },
    __getClient: vi.fn((): ProjectsClient => {
      if (!current) throw new Error("projects test client not set");
      return current;
    }),
  };
});

vi.mock("@/lib/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects")>();
  return {
    ...actual,
    getProjectsClient: clientState.__getClient,
  };
});

function createTestQueryClient(): QueryClient {
  const config: QueryClientConfig = {
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  };
  return new QueryClient(config);
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeClient(overrides: Partial<ProjectsClient> = {}): ProjectsClient {
  return {
    list: vi.fn().mockResolvedValue({ projects: [] }),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "p1", slug: "demo", name: "Demo" } as Project),
    update: vi.fn().mockResolvedValue({ id: "p1", slug: "demo", name: "Demo" } as Project),
    addFolder: vi.fn().mockResolvedValue({ id: "p1" } as Project),
    removeFolder: vi.fn().mockResolvedValue({ id: "p1" } as Project),
    setPrimary: vi.fn().mockResolvedValue({ id: "p1" } as Project),
    archive: vi.fn().mockResolvedValue({ projects: [] } as ProjectsListResponse),
    delete: vi.fn().mockResolvedValue({ projects: [] } as ProjectsListResponse),
    setActive: vi.fn().mockResolvedValue({ activeId: null }),
    forCwd: vi.fn().mockResolvedValue({ project: null, cwd: "/" }),
    tree: vi.fn().mockResolvedValue({ tree: [] } as ProjectsTreeResponse),
    projectSessions: vi.fn().mockResolvedValue({ project: null }),
    recordRepos: vi.fn().mockResolvedValue({ recorded: 0 }),
    ...overrides,
  };
}

beforeEach(() => {
  clientState.__setClient(null);
});

describe("projects query hooks", () => {
  it("useProjects queries the client and caches under projects/list", async () => {
    const response: ProjectsListResponse = { projects: [{ id: "p1", slug: "demo", name: "Demo" } as Project] };
    const client = makeClient({ list: vi.fn().mockResolvedValue(response) });
    clientState.__setClient(client);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useProjects(), { wrapper: wrapperFor(qc) });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(client.list).toHaveBeenCalled();
    expect(qc.getQueryState(projectsKeys.list())?.status).toBe("success");
  });

  it("useProject is disabled for empty ids", async () => {
    clientState.__setClient(makeClient());
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useProject(""), { wrapper: wrapperFor(qc) });

    expect(result.current.isPending).toBe(true);
    expect(qc.getQueryState(projectsKeys.detail(""))?.fetchStatus).toBe("idle");
  });

  it("useProjectTree includes limits in the query key", async () => {
    const client = makeClient({ tree: vi.fn().mockResolvedValue({ tree: [] } as ProjectsTreeResponse) });
    clientState.__setClient(client);

    const qc = createTestQueryClient();
    const { result } = renderHook(() => useProjectTree(3, 5), { wrapper: wrapperFor(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.tree).toHaveBeenCalledWith(3, 5);
  });
});

describe("projects mutation hooks", () => {
  it("useCreateProject calls create and invalidates projects cache", async () => {
    const client = makeClient();
    clientState.__setClient(client);
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useCreateProject(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      const created = await result.current.mutateAsync({ name: "New" });
      expect(created.id).toBe("p1");
    });

    expect(client.create).toHaveBeenCalledWith({ name: "New" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: projectsKeys.all });
  });

  it("useUpdateProject calls update and invalidates cache", async () => {
    const client = makeClient();
    clientState.__setClient(client);
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateProject(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: "p1", patch: { name: "Renamed" } });
    });

    expect(client.update).toHaveBeenCalledWith("p1", { name: "Renamed" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: projectsKeys.all });
  });

  it("useDeleteProject calls delete and invalidates cache", async () => {
    const client = makeClient();
    clientState.__setClient(client);
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useDeleteProject(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      await result.current.mutateAsync("p1");
    });

    expect(client.delete).toHaveBeenCalledWith("p1");
  });

  it("useSetActiveProject calls setActive with null when clearing", async () => {
    const client = makeClient();
    clientState.__setClient(client);
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useSetActiveProject(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      await result.current.mutateAsync(null);
    });

    expect(client.setActive).toHaveBeenCalledWith(null);
  });

  it("useProjectMutations exposes folder helpers", async () => {
    const client = makeClient();
    clientState.__setClient(client);
    const qc = createTestQueryClient();
    const { result } = renderHook(() => useProjectMutations(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      await result.current.addFolder.mutateAsync({ id: "p1", path: "/src", label: "source", isPrimary: true });
    });
    expect(client.addFolder).toHaveBeenCalledWith("p1", "/src", { label: "source", isPrimary: true });

    await act(async () => {
      await result.current.setPrimary.mutateAsync({ id: "p1", path: "/src" });
    });
    expect(client.setPrimary).toHaveBeenCalledWith("p1", "/src");
  });
});
