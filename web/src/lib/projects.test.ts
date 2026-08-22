import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectSlug,
  getProjectsClient,
  isValidProjectSlug,
  RpcProjectsClient,
  setProjectsClient,
  type ProjectsClient,
} from "./projects";
import { GatewayClient, type GatewayClientLike } from "./gateway-client";

type MockedGateway = GatewayClientLike & { request: ReturnType<typeof vi.fn> };

function createMockGateway(): MockedGateway {
  return Object.assign(new GatewayClient(), { request: vi.fn() }) as unknown as MockedGateway;
}

describe("createProjectSlug", () => {
  it("lowercases and collapses non-alphanumeric chars", () => {
    expect(createProjectSlug("Hello World!")).toBe("hello-world");
  });

  it("trims leading separators", () => {
    expect(createProjectSlug("-leading")).toBe("leading");
  });

  it("uses project fallback for empty names", () => {
    expect(createProjectSlug("!!!")).toBe("project");
  });

  it("appends a counter on collision", () => {
    const existing = new Set(["my-project"]);
    expect(createProjectSlug("My Project", existing)).toBe("my-project-2");
  });
});

describe("isValidProjectSlug", () => {
  it("accepts valid slugs", () => {
    expect(isValidProjectSlug("my-project")).toBe(true);
    expect(isValidProjectSlug("a")).toBe(true);
    expect(isValidProjectSlug("my_project-2")).toBe(true);
  });

  it("rejects invalid slugs", () => {
    expect(isValidProjectSlug("")).toBe(false);
    expect(isValidProjectSlug("MyProject")).toBe(false);
    expect(isValidProjectSlug("my project")).toBe(false);
    expect(isValidProjectSlug("-start")).toBe(false);
  });
});

describe("RpcProjectsClient", () => {
  let gateway: MockedGateway;
  let client: RpcProjectsClient;

  beforeEach(() => {
    gateway = createMockGateway();
    client = new RpcProjectsClient(gateway);
  });

  it("list calls projects.list", async () => {
    gateway.request.mockResolvedValueOnce({ projects: [] });
    await client.list();
    expect(gateway.request).toHaveBeenCalledWith("projects.list", {});
  });

  it("create normalizes folders and primary_path", async () => {
    gateway.request.mockResolvedValueOnce({ id: "1", slug: "demo" });
    await client.create({ name: "Demo", folders: ["C:\\dev\\demo\\"] });
    expect(gateway.request).toHaveBeenCalledWith("projects.create", {
      name: "Demo",
      folders: ["C:/dev/demo"],
      primary_path: "C:/dev/demo",
      use: true,
    });
  });

  it("create infers primary_path when omitted", async () => {
    gateway.request.mockResolvedValueOnce({ id: "1", slug: "demo" });
    await client.create({ name: "Demo", folders: ["/a", "/b"], use: false });
    expect(gateway.request).toHaveBeenCalledWith(
      expect.stringContaining("projects.create"),
      expect.objectContaining({ primary_path: "/a", use: false }),
    );
  });

  it("addFolder passes normalized path and options", async () => {
    gateway.request.mockResolvedValueOnce({ id: "1" });
    await client.addFolder("p1", "C:\\dev", { label: "work", isPrimary: true });
    expect(gateway.request).toHaveBeenCalledWith("projects.add_folder", {
      project_id: "p1",
      path: "C:/dev",
      label: "work",
      is_primary: true,
    });
  });

  it("setActive sends null project_id for clearing", async () => {
    gateway.request.mockResolvedValueOnce({ activeId: null });
    await client.setActive(null);
    expect(gateway.request).toHaveBeenCalledWith("projects.set_active", { project_id: null });
  });

  it("tree passes limits", async () => {
    gateway.request.mockResolvedValueOnce({ tree: [] });
    await client.tree(5, 10);
    expect(gateway.request).toHaveBeenCalledWith("projects.tree", { preview_limit: 5, session_limit: 10 });
  });
});

describe("projects client singleton", () => {
  it("getProjectsClient returns the same client by default", () => {
    const a = getProjectsClient();
    const b = getProjectsClient();
    expect(a).toBe(b);
  });

  it("setProjectsClient swaps the singleton", () => {
    const original = getProjectsClient();
    const stub: ProjectsClient = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      addFolder: vi.fn(),
      removeFolder: vi.fn(),
      setPrimary: vi.fn(),
      archive: vi.fn(),
      delete: vi.fn(),
      setActive: vi.fn(),
      forCwd: vi.fn(),
      tree: vi.fn(),
      projectSessions: vi.fn(),
      recordRepos: vi.fn(),
    };
    setProjectsClient(stub);
    expect(getProjectsClient()).toBe(stub);
    setProjectsClient(original);
  });
});
