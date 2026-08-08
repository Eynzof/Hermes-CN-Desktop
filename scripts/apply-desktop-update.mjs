#!/usr/bin/env node
// Detached desktop-shell updater for the unified self-update flow.
//
// The desktop main process stages the new installer, writes a
// `pending-app-update.json` marker, spawns THIS script detached (via the
// bundled runtime node, or the system node as a dev fallback), then exits.
// The updater waits for the main process to exit, silently installs the new
// shell (NSIS /S on Windows, `hdiutil`+`ditto` on macOS), then relaunches the
// app with `HERMES_APP_UPDATED=1` so the fresh UI can toast "已更新".
//
// Usage:
//   node apply-desktop-update.mjs <markerPath> [--dry-run]
//
// `--dry-run` prints the commands it WOULD run and exits — used by unit tests
// and the release preflight, never touches the system.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

function log(message) {
  console.log(`[updater] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (platform() === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], {
        windowsHide: true,
        encoding: "utf8",
      });
      return Boolean(result.stdout && result.stdout.includes(String(pid)));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** On macOS, the executable lives inside `<name>.app/Contents/MacOS/`; the
 * app is launched via `open` on the `.app` bundle. */
function appBundlePath(exePath) {
  if (platform() !== "darwin") return null;
  const parts = String(exePath).split("/");
  const idx = parts.findIndex((part) => part.endsWith(".app"));
  if (idx === -1) return null;
  return parts.slice(0, idx + 1).join("/");
}

async function waitForMainProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      log(`main process ${pid} exited`);
      return true;
    }
    await sleep(500);
  }
  log(`main process ${pid} still alive after ${timeoutMs}ms; proceeding anyway`);
  return false;
}

function installShell(marker, dryRun) {
  const { installerPath, kind } = marker;
  if (!existsSync(installerPath)) {
    throw new Error(`installer not found: ${installerPath}`);
  }

  if (dryRun) {
    log(`[dry-run] install kind=${kind} installer=${installerPath}`);
    return;
  }

  if (kind === "nsis" && platform() === "win32") {
    // NSIS replaces the locked .exe after the main process exits. `/currentuser`
    // avoids UAC elevation; `--updated` tells the fresh app it just upgraded.
    log(`running silent install: ${installerPath} /S /currentuser --updated`);
    const result = spawnSync(installerPath, ["/S", "/currentuser", "--updated"], {
      stdio: "inherit",
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
    if (result.error) throw new Error(`installer spawn failed: ${result.error.message}`);
    if (typeof result.status === "number" && result.status !== 0) {
      throw new Error(`installer exited with code ${result.status}`);
    }
    log("installer finished");
    return;
  }

  if (kind === "dmg" && platform() === "darwin") {
    log(`attaching ${installerPath}`);
    const attach = spawnSync("hdiutil", ["attach", "-nobrowse", installerPath], {
      stdio: "pipe",
      timeout: 5 * 60 * 1000,
    });
    if (attach.error || attach.status !== 0) {
      throw new Error(`hdiutil attach failed: ${attach.error?.message ?? attach.status}`);
    }
    const mountPoint = String(attach.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("/Volumes/") && !line.startsWith("/dev/"));
    if (!mountPoint) throw new Error("cannot locate mounted DMG volume");
    const volume = mountPoint.replace(/^.*\/Volumes\//, "/Volumes/").trim();
    const apps = readdirSync(volume).filter((entry) => entry.endsWith(".app"));
    if (apps.length === 0) throw new Error(`no .app found inside ${volume}`);
    const target = `/Applications/${apps[0]}`;
    log(`copying ${volume}/${apps[0]} -> ${target}`);
    const copy = spawnSync("ditto", [`${volume}/${apps[0]}`, target], {
      stdio: "inherit",
      timeout: 10 * 60 * 1000,
    });
    if (copy.error || copy.status !== 0) {
      throw new Error(`ditto failed: ${copy.error?.message ?? copy.status}`);
    }
    const detach = spawnSync("hdiutil", ["detach", volume], { stdio: "ignore" });
    if (detach.error) log(`hdiutil detach warning: ${detach.error.message}`);
    log("macOS app replaced");
    return;
  }

  if (kind === "zip") {
    log(`extracting ${installerPath} over the install dir`);
    const extract = spawnSync("tar", ["-xf", installerPath, "-C", "/"], {
      stdio: "inherit",
      timeout: 10 * 60 * 1000,
    });
    if (extract.error || extract.status !== 0) {
      throw new Error(`extract failed: ${extract.error?.message ?? extract.status}`);
    }
    log("portable archive extracted");
    return;
  }

  throw new Error(`unsupported kind/platform: ${kind}/${platform()}`);
}

function relaunchApp(marker, dryRun) {
  const { exePath } = marker;
  if (dryRun) {
    log(`[dry-run] relaunch exe=${exePath} env=HERMES_APP_UPDATED=1`);
    return;
  }
  const bundle = appBundlePath(exePath);
  if (platform() === "darwin" && bundle) {
    log(`relaunching via open: ${bundle}`);
    spawn("open", [bundle], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HERMES_APP_UPDATED: "1" },
    }).unref();
    return;
  }
  log(`relaunching ${exePath}`);
  spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HERMES_APP_UPDATED: "1" },
  }).unref();
}

async function main() {
  const markerPath = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!markerPath) {
    console.error("[updater] missing marker path argument");
    process.exit(2);
  }
  if (!existsSync(markerPath)) {
    console.error(`[updater] marker not found: ${markerPath}`);
    process.exit(2);
  }

  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const { pid, targetVersion, kind, timeoutMs = 120000 } = marker;
  log(`marker loaded: version=${targetVersion} kind=${kind} pid=${pid}`);

  await waitForMainProcessExit(pid, timeoutMs);
  installShell(marker, dryRun);
  relaunchApp(marker, dryRun);
  log("APP_UPDATE_DONE");
}

main().catch((error) => {
  console.error(`[updater] fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
