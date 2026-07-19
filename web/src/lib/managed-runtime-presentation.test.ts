import { describe, expect, it } from "vitest";
import { resolveManagedRuntimePresentation } from "./managed-runtime-presentation";

describe("resolveManagedRuntimePresentation", () => {
  it("makes an explicitly uninstalled runtime prominent and install-only", () => {
    expect(
      resolveManagedRuntimePresentation({
        installed: false,
        running: false,
        attached: true,
        lifecycleState: "uninstalled",
        desiredState: "uninstalled",
      }),
    ).toMatchObject({
      statusLabel: "已卸载",
      explicitlyUninstalled: true,
      installLabel: "重新安装内核",
      showInstall: true,
      showStart: false,
      showSwitch: false,
      showReinstall: false,
      showUninstall: false,
    });
  });

  it("calls a never-installed runtime not installed", () => {
    expect(
      resolveManagedRuntimePresentation({
        installed: false,
        running: false,
        attached: false,
        lifecycleState: "uninstalled",
        desiredState: "stopped",
      }),
    ).toMatchObject({
      statusLabel: "未安装",
      explicitlyUninstalled: false,
      installLabel: "安装内核",
      showInstall: true,
      showStart: false,
      showUninstall: false,
    });
  });

  it("shows switch and uninstall actions only for an installed external target", () => {
    expect(
      resolveManagedRuntimePresentation({
        installed: true,
        running: false,
        attached: true,
        lifecycleState: "stopped",
        desiredState: "stopped",
      }),
    ).toMatchObject({
      showInstall: false,
      showStart: false,
      showSwitch: true,
      showReinstall: true,
      showUninstall: true,
    });
  });

  it("fails safe when installed and lifecycle fields disagree", () => {
    expect(
      resolveManagedRuntimePresentation({
        installed: true,
        running: false,
        attached: true,
        lifecycleState: "uninstalled",
        desiredState: "uninstalled",
      }),
    ).toMatchObject({
      unavailable: true,
      showInstall: true,
      showSwitch: false,
      showUninstall: false,
    });
  });
});
