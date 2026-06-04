import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeWorkspacePath,
  mirrorSessionWorkspaceMapping,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  removeWorkspaceProject,
  workspaceNameFromPath,
} from "./workspaces";
import { rememberSessionMapping } from "./session-map";
import { __resetUiStoreForTests, writeUiValue } from "./ui-store";

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

  it("resolves workspace links across gateway and persistent session ids", () => {
    rememberSessionMapping("gw-1", "20260426_000000_abcd");
    rememberSessionWorkspace("gw-1", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "gw-1": "/Users/claw/Project",
      "20260426_000000_abcd": "/Users/claw/Project",
    });
  });

  it("keeps historical workspace links after session id mappings become stale", () => {
    writeUiValue("hermes:gateway-session-map", {
      "gw-old": {
        persistentId: "20260426_000000_abcd",
        ts: Date.now() - 25 * 60 * 60 * 1000,
      },
    });
    rememberSessionWorkspace("gw-old", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "gw-old": "/Users/claw/Project",
      "20260426_000000_abcd": "/Users/claw/Project",
    });
  });

  it("mirrors an existing gateway workspace when the persistent id becomes known", () => {
    rememberSessionWorkspace("gw-1", "/Users/claw/Project");
    mirrorSessionWorkspaceMapping("gw-1", "20260426_000000_abcd");

    expect(readSessionWorkspaceMap()).toEqual({
      "gw-1": "/Users/claw/Project",
      "20260426_000000_abcd": "/Users/claw/Project",
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
