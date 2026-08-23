import { describe, expect, it } from "vitest";
import {
  Project,
  ProjectCreateInput,
  ProjectFolder,
  ProjectForCwdResponse,
  ProjectSessionsResponse,
  ProjectTreeNode,
  ProjectTreeRepo,
  ProjectUpdateInput,
  ProjectsListResponse,
  ProjectsTreeResponse,
  RepoDiscoveryItem,
  RepoDiscoveryResponse,
} from "./projects";

const fullProject = {
  id: "p1",
  slug: "my-project",
  name: "My Project",
  description: "desc",
  icon: "🚀",
  color: "#ff0000",
  board_slug: "board",
  primary_path: "/workspace/my-project",
  created_at: "2026-01-01T00:00:00Z",
  archived: false,
  folders: [
    { path: "/workspace/my-project", label: "root", is_primary: true, added_at: "2026-01-01T00:00:00Z" },
  ],
};

describe("ProjectFolder / Project", () => {
  it("parses a full project", () => {
    const parsed = Project.parse(fullProject);
    expect(parsed.id).toBe("p1");
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders?.[0]?.is_primary).toBe(true);
    expect(parsed.archived).toBe(false);
  });

  it("parses a minimal project with optional fields absent", () => {
    const parsed = Project.parse({
      id: "p2",
      slug: "min",
      name: "Min",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(parsed.description).toBeUndefined();
    expect(parsed.folders).toBeUndefined();
    expect(parsed.archived).toBeUndefined();
  });

  it("rejects projects missing required fields", () => {
    expect(Project.safeParse({ id: "p", slug: "s", name: "n" }).success).toBe(false);
    expect(Project.safeParse({ slug: "s", name: "n", created_at: "x" }).success).toBe(false);
  });
});

describe("ProjectsListResponse", () => {
  it("parses a list with nullable active_id", () => {
    const parsed = ProjectsListResponse.parse({
      projects: [fullProject],
      active_id: null,
    });
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.active_id).toBeNull();
    expect(ProjectsListResponse.parse({ projects: [], active_id: "p1" }).active_id).toBe("p1");
  });

  it("rejects a missing projects array", () => {
    expect(ProjectsListResponse.safeParse({}).success).toBe(false);
  });
});

describe("ProjectCreateInput / ProjectUpdateInput", () => {
  it("parses a create input", () => {
    const parsed = ProjectCreateInput.parse({
      name: "New",
      folders: ["/a", "/b"],
      primary_path: "/a",
      use: true,
    });
    expect(parsed.folders).toEqual(["/a", "/b"]);
    expect(parsed.use).toBe(true);
  });

  it("rejects a create input without a name", () => {
    expect(ProjectCreateInput.safeParse({ folders: [] }).success).toBe(false);
  });

  it("parses a partial update input (all optional)", () => {
    const parsed = ProjectUpdateInput.parse({ name: "Renamed" });
    expect(parsed.name).toBe("Renamed");
    expect(ProjectUpdateInput.parse({}).name).toBeUndefined();
    expect(ProjectUpdateInput.safeParse({ name: 42 }).success).toBe(false);
  });
});

describe("ProjectsTreeResponse", () => {
  it("parses a tree with optional limits", () => {
    const parsed = ProjectsTreeResponse.parse({
      tree: [
        {
          project: fullProject,
          repos: [
            {
              root: "/workspace/my-project",
              label: "my-project",
              lanes: [{ name: "main", sessions: [{ session_id: "s1", title: "Fix", cwd: "/workspace", branch: "main" }] }],
            },
          ],
          no_project_sessions: [{ session_id: "s0" }],
        },
      ],
      preview_limit: 5,
      session_limit: 20,
    });
    expect(parsed.tree[0]?.repos?.[0]?.lanes?.[0]?.sessions?.[0]?.session_id).toBe("s1");
    expect(parsed.preview_limit).toBe(5);
  });

  it("parses an empty tree", () => {
    const parsed = ProjectsTreeResponse.parse({ tree: [] });
    expect(parsed.tree).toEqual([]);
    expect(parsed.preview_limit).toBeUndefined();
  });

  it("rejects a tree missing the tree field", () => {
    expect(ProjectsTreeResponse.safeParse({}).success).toBe(false);
  });
});

describe("ProjectSessionsResponse / ProjectForCwdResponse", () => {
  it("parses a nullable project for sessions", () => {
    const withProject = ProjectSessionsResponse.parse({ project: ProjectTreeNode.parse({ project: fullProject }) });
    expect(withProject.project?.project.name).toBe("My Project");
    expect(ProjectSessionsResponse.parse({ project: null }).project).toBeNull();
    expect(ProjectSessionsResponse.safeParse({}).success).toBe(false);
  });

  it("parses a cwd lookup with nullable project", () => {
    const parsed = ProjectForCwdResponse.parse({
      project: null,
      cwd: "/workspace",
      branch: "main",
    });
    expect(parsed.cwd).toBe("/workspace");
    expect(parsed.branch).toBe("main");
    expect(ProjectForCwdResponse.safeParse({ project: null }).success).toBe(false);
  });
});

describe("RepoDiscoveryItem / RepoDiscoveryResponse", () => {
  it("parses discovery items and response", () => {
    expect(RepoDiscoveryItem.parse({ root: "/repo" }).label).toBeUndefined();
    expect(RepoDiscoveryItem.parse({ root: "/repo", label: "repo" }).label).toBe("repo");
    expect(RepoDiscoveryItem.safeParse({}).success).toBe(false);
    expect(RepoDiscoveryResponse.parse({ recorded: 3 }).recorded).toBe(3);
    expect(RepoDiscoveryResponse.safeParse({}).success).toBe(false);
  });
});
