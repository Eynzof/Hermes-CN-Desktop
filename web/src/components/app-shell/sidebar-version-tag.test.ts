import { describe, expect, it } from "vitest";
import type { RuntimeInfo } from "@hermes/protocol";
import { buildSidebarVersionRows } from "./sidebar-version-tag";

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
  it("shows kernel version, kernel commit and kernel commit date", () => {
    const rows = buildSidebarVersionRows({
      runtimeInfo: runtimeInfo(),
      status: { version: "0.14.0", release_date: "2026.5.29.2" },
      buildCommit: "80157e462c630803571eef1ba17c2a01edfe240f",
      buildDate: "2026-06-03T16:00:00+08:00",
      desktopVersion: "0.2.0",
    });

    expect(rows.kernel).toBe("内核 v0.15.2 · 882062c · 05.29");
    expect(rows.ui).toBe("UI v0.2.0 · 80157e4 · 06.03");
    expect(rows.title).toContain("内核 v0.15.2 · 882062c · 2026-05-29");
    expect(rows.title).toContain("UI v0.2.0 · 80157e4 · 2026-06-03");
    expect(rows.kernel).not.toContain("2026.5.29.2");
  });

  it("falls back to status version and unknown kernel metadata without runtime bridge", () => {
    const rows = buildSidebarVersionRows({
      status: { version: "0.15.2", release_date: "2026.5.29.2" },
      buildCommit: "80157e462c630803571eef1ba17c2a01edfe240f",
      buildDate: "2026-06-03T16:00:00+08:00",
      desktopVersion: "0.2.0",
    });

    expect(rows.kernel).toBe("内核 v0.15.2 · — · 日期未知");
    expect(rows.ui).toBe("UI v0.2.0 · 80157e4 · 06.03");
    expect(rows.kernel).not.toContain("2026.5.29.2");
  });

  it("shows unknown commit date when the installed kernel commit is absent from recent commits", () => {
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
      buildDate: "2026-06-03T16:00:00+08:00",
      desktopVersion: "0.2.0",
    });

    expect(rows.kernel).toBe("内核 v0.15.2 · 882062c · 日期未知");
  });

  it("shows a dash when the UI build commit is unknown", () => {
    const rows = buildSidebarVersionRows({
      runtimeInfo: runtimeInfo(),
      buildCommit: "unknown",
      buildDate: "2026-06-03T16:00:00+08:00",
      desktopVersion: "0.2.0",
    });

    expect(rows.ui).toBe("UI v0.2.0 · — · 06.03");
  });
});
