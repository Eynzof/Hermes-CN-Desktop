import { describe, expect, it } from "vitest";
import type { RuntimeInfo } from "@hermes/protocol";
import { DESKTOP_VERSION, versionLabel } from "@/lib/build-info";
import { buildSidebarVersionRows } from "./sidebar-version-tag";

const DESKTOP_VERSION_LABEL = versionLabel(DESKTOP_VERSION);

function runtimeInfo(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    mode: "managed",
    packaged: false,
    platform: "darwin",
    arch: "arm64",
    runtimeRoot: "/runtime",
    currentRecordPath: "/runtime/current.json",
    versionsDir: "/runtime/versions",
    downloadsDir: "/runtime/downloads",
    gatewayRuntimeDir: "/runtime/gateway-runtime",
    updatesConfigured: false,
    current: {
      schemaVersion: 2,
      runtimeVersion: "dev-local-0.15.2-882062c24a18",
      kernelVersion: "0.15.2",
      runtimeFlavor: "cn-local",
      runtimeRevision: 0,
      platform: "darwin",
      arch: "arm64",
      path: "/runtime/versions/dev-local-0.15.2-882062c24a18",
      executablePath: "/runtime/versions/dev-local-0.15.2-882062c24a18/venv/bin/hermes",
      source: "local-source",
      installedAt: "2026-06-03T16:49:00.133Z",
      sourceRepo: "/Users/enzo/Documents/GithubProjects/hermes/hermes-agent-cn",
      sourceCommit: "882062c24a189e63db7ab27e22825b6939c77938",
      localDirtyHash: null,
    },
    source: {
      repo: "/Users/enzo/Documents/GithubProjects/hermes/hermes-agent-cn",
      headCommit: "882062c24a189e63db7ab27e22825b6939c77938",
      headShortCommit: "882062c24a18",
      dirty: false,
      recentCommits: [
        {
          hash: "882062c24a189e63db7ab27e22825b6939c77938",
          shortHash: "882062c",
          author: "Hermes",
          date: "2026-05-29T02:03:04+08:00",
          subject: "Tool key arguments repair",
        },
      ],
    },
    ...overrides,
  };
}

describe("buildSidebarVersionRows", () => {
  it("shows kernel and UI versions with short commits only", () => {
    const rows = buildSidebarVersionRows({
      runtimeInfo: runtimeInfo(),
      status: { version: "0.14.0", release_date: "2026.5.29.2" },
      buildCommit: "80157e462c630803571eef1ba17c2a01edfe240f",
      desktopVersion: DESKTOP_VERSION,
    });

    expect(rows.kernel).toBe("内核 v0.15.2 · 8820");
    expect(rows.ui).toBe(`界面 ${DESKTOP_VERSION_LABEL} · 8015`);
    expect(rows.title).toBe(`内核 v0.15.2 · 8820\n界面 ${DESKTOP_VERSION_LABEL} · 8015`);
    expect(rows.kernel).not.toContain("2026.5.29.2");
    expect(rows.title.split("\n")).toHaveLength(2);
    expect(rows.title).not.toContain("2026-");
  });

  it("falls back to status version and unknown kernel metadata without runtime bridge", () => {
    const rows = buildSidebarVersionRows({
      status: { version: "0.15.2", release_date: "2026.5.29.2" },
      buildCommit: "80157e462c630803571eef1ba17c2a01edfe240f",
      desktopVersion: DESKTOP_VERSION,
    });

    expect(rows.kernel).toBe("内核 v0.15.2 · —");
    expect(rows.ui).toBe(`界面 ${DESKTOP_VERSION_LABEL} · 8015`);
    expect(rows.kernel).not.toContain("2026.5.29.2");
  });

  it("does not depend on recent commit dates", () => {
    const rows = buildSidebarVersionRows({
      runtimeInfo: runtimeInfo({
        source: {
          repo: "/Users/enzo/Documents/GithubProjects/hermes/hermes-agent-cn",
          headCommit: "882062c24a189e63db7ab27e22825b6939c77938",
          headShortCommit: "882062c24a18",
          dirty: false,
          recentCommits: [],
        },
      }),
      buildCommit: "80157e462c630803571eef1ba17c2a01edfe240f",
      desktopVersion: DESKTOP_VERSION,
    });

    expect(rows.kernel).toBe("内核 v0.15.2 · 8820");
  });

  it("shows a dash instead of a hard-coded kernel version when status is unavailable", () => {
    const rows = buildSidebarVersionRows({
      buildCommit: "unknown",
      desktopVersion: DESKTOP_VERSION,
    });

    expect(rows.kernel).toBe("内核 v— · —");
  });

  it("shows a dash when the UI build commit is unknown", () => {
    const rows = buildSidebarVersionRows({
      runtimeInfo: runtimeInfo(),
      buildCommit: "unknown",
      desktopVersion: DESKTOP_VERSION,
    });

    expect(rows.ui).toBe(`界面 ${DESKTOP_VERSION_LABEL} · —`);
  });
});
