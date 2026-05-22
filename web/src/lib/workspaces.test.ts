import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWorkspacePath,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  removeWorkspaceProject,
  workspaceNameFromPath,
} from "./workspaces";
import { __resetUiStoreForTests } from "./ui-store";

describe("workspace persistence helpers", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("normalizes paths and derives project names", () => {
    expect(normalizeWorkspacePath(" /Users/claw/Project/ ")).toBe("/Users/claw/Project");
    expect(workspaceNameFromPath("/Users/claw/Project")).toBe("Project");
  });


  it("ignores malformed persisted workspace values from older builds", () => {
    __resetUiStoreForTests({
      "hermes-cn-ui.workspaceProjects": [
        { path: ["/Users/claw/OldA", "/Users/claw/OldB"], name: { label: "old" } },
        { path: "/Users/claw/Project", name: 42, createdAt: "bad", updatedAt: null },
      ],
      "hermes-cn-ui.sessionWorkspaces": {
        "session-1": ["/Users/claw/OldA"],
        "session-2": "/Users/claw/Project",
      },
    });

    expect(normalizeWorkspacePath(["/Users/claw/OldA"])).toBe("");
    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({
        path: "/Users/claw/Project",
        name: "Project",
      }),
    ]);
    expect(readSessionWorkspaceMap()).toEqual({
      "session-2": "/Users/claw/Project",
    });
  });

  it("stores workspace projects without duplicating equivalent paths", () => {
    rememberWorkspaceProject("/Users/claw/Project/");
    rememberWorkspaceProject("/Users/claw/Project", "Renamed");

    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({
        path: "/Users/claw/Project",
        name: "Renamed",
      }),
    ]);
  });

  it("links sessions to workspaces and registers the project", () => {
    rememberSessionWorkspace("session-1", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "session-1": "/Users/claw/Project",
    });
    expect(readWorkspaceProjects()[0]).toMatchObject({
      path: "/Users/claw/Project",
      name: "Project",
    });
  });

  it("removes a workspace project and unlinks its sessions", () => {
    rememberSessionWorkspace("session-1", "/Users/claw/Project");
    rememberSessionWorkspace("session-2", "/Users/claw/Other");

    removeWorkspaceProject("/Users/claw/Project/");

    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({ path: "/Users/claw/Other" }),
    ]);
    expect(readSessionWorkspaceMap()).toEqual({
      "session-2": "/Users/claw/Other",
    });
  });
});
