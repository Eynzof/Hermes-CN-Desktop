#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { chromium } from "playwright";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function booleanOption(name, fallback) {
  const value = option(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} 必须是 true 或 false`);
}

const cdp = option("cdp", "http://127.0.0.1:9222");
const mode = option("mode", "install");
const expectedVersion = option("expected-version");
const expectedCoreVersion = option("expected-core-version");
const expectedDownloadSource = option("expected-download-source");
const expectedFallbackUsed = booleanOption("expected-fallback-used");
const expectedError = option("expected-error");
const sentinel = option("sentinel");
const sentinelValue = option("sentinel-value");
const supportedModes = new Set([
  "install",
  "download-only",
  "expect-download-failure",
  "expect-check-failure",
  "expect-install-blocked",
]);
if (!supportedModes.has(mode)) throw new Error(`不支持 --mode ${mode}`);
if (!expectedVersion) throw new Error("缺少 --expected-version");
if (mode === "install" && !expectedCoreVersion) throw new Error("install 模式缺少 --expected-core-version");

const deadline = (seconds) => Date.now() + seconds * 1000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(timeoutSeconds = 300) {
  const until = deadline(timeoutSeconds);
  let lastError;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const browser = await chromium.connectOverCDP(cdp);
        const page = browser.contexts().flatMap((context) => context.pages())[0];
        if (page) return { browser, page };
        await browser.close();
      }
    } catch (error) {
      lastError = error;
    }
    await wait(1_000);
  }
  throw new Error(`等待 WebView2 CDP 超时：${lastError?.message || "unknown"}`);
}

async function bridge(page, method) {
  return page.evaluate(async (name) => {
    const api = window.hermesDesktop;
    if (!api || typeof api[name] !== "function") throw new Error(`bridge missing ${name}`);
    return api[name]();
  }, method);
}

function assertExpectedError(result, context) {
  if (!result.error) throw new Error(`${context} 没有返回错误：${JSON.stringify(result)}`);
  if (expectedError && !result.error.toLowerCase().includes(expectedError.toLowerCase())) {
    throw new Error(`${context} 错误不含 ${expectedError}：${JSON.stringify(result)}`);
  }
}

function assertDownloadSource(download) {
  if (expectedDownloadSource && download.downloadSource !== expectedDownloadSource) {
    throw new Error(`下载源不是 ${expectedDownloadSource}：${JSON.stringify(download)}`);
  }
  if (!expectedDownloadSource && !new Set(["cloudflare-cache", "github-release"]).has(download.downloadSource)) {
    throw new Error(`下载源诊断无效：${download.downloadSource}`);
  }
  if (expectedFallbackUsed !== undefined && download.fallbackUsed !== expectedFallbackUsed) {
    throw new Error(`fallbackUsed 不是 ${expectedFallbackUsed}：${JSON.stringify(download)}`);
  }
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const first = await connect();

  if (mode === "expect-install-blocked") {
    const pending = await bridge(first.page, "appUpdatePending");
    if (!pending.ready || pending.version !== expectedVersion) {
      throw new Error(`没有预期 pending 更新：${JSON.stringify(pending)}`);
    }
    const install = await bridge(first.page, "appUpdateInstall");
    if (install.ok || install.installStarted) {
      throw new Error(`pause 后仍启动了安装：${JSON.stringify(install)}`);
    }
    assertExpectedError(install, "pause 后安装");
    printResult({ ok: true, mode, pending, install });
    await first.browser.close();
    return;
  }

  const check = await bridge(first.page, "appUpdateCheck");
  if (mode === "expect-check-failure") {
    if (check.ok || check.updateAvailable) {
      throw new Error(`检查本应失败：${JSON.stringify(check)}`);
    }
    assertExpectedError(check, "更新检查");
    printResult({ ok: true, mode, check });
    await first.browser.close();
    return;
  }
  if (!check.ok || !check.updateAvailable || check.latestVersion !== expectedVersion) {
    throw new Error(`更新检查未授权目标版本：${JSON.stringify(check)}`);
  }

  const download = await bridge(first.page, "appUpdateDownload");
  if (mode === "expect-download-failure") {
    if (download.ok || download.ready || download.fallbackUsed) {
      throw new Error(`下载本应失败且不得回退：${JSON.stringify(download)}`);
    }
    assertExpectedError(download, "更新下载");
    printResult({ ok: true, mode, check, download });
    await first.browser.close();
    return;
  }
  if (!download.ok || !download.ready || download.version !== expectedVersion) {
    throw new Error(`更新下载失败：${JSON.stringify(download)}`);
  }
  assertDownloadSource(download);
  const pending = await bridge(first.page, "appUpdatePending");
  if (!pending.ready || pending.version !== expectedVersion) {
    throw new Error(`下载后 pending 状态异常：${JSON.stringify(pending)}`);
  }

  if (mode === "download-only") {
    printResult({ ok: true, mode, check, download, pending });
    await first.browser.close();
    return;
  }

  try {
    await Promise.race([
      bridge(first.page, "appUpdateInstall"),
      wait(120_000).then(() => {
        throw new Error("启动 updater 超时");
      }),
    ]);
  } catch (error) {
    if (!/closed|destroyed|Target page|context/i.test(String(error))) throw error;
  }
  await first.browser.close().catch(() => {});

  // The detached updater exits the old shell, installs, and relaunches it. A
  // new CDP connection proves the process boundary was crossed.
  await wait(5_000);
  const second = await connect(600);
  const after = await bridge(second.page, "appUpdateCheck");
  if (!after.ok || after.updateAvailable || after.currentVersion !== expectedVersion) {
    throw new Error(`安装后版本检查失败：${JSON.stringify(after)}`);
  }
  const runtimeInfo = await bridge(second.page, "getRuntimeInfo");
  if (runtimeInfo.current?.kernelVersion !== expectedCoreVersion) {
    throw new Error(`Runtime current.json 核心版本异常：${JSON.stringify(runtimeInfo.current)}`);
  }
  const coreVersion = await second.page.evaluate(async () => {
    const result = await window.hermesDesktop.request({ path: "/api/version", method: "GET" });
    return { status: result.status, body: result.body };
  });
  if (coreVersion.status !== 200 || !coreVersion.body.includes(expectedCoreVersion)) {
    throw new Error(`Core 9120 /api/version 异常：${JSON.stringify(coreVersion)}`);
  }
  let sentinelEvidence;
  if (sentinel) {
    const value = readFileSync(sentinel, "utf8");
    if (sentinelValue !== undefined && value !== sentinelValue) {
      throw new Error(`升级后 sentinel 内容变化：${JSON.stringify(value)}`);
    }
    sentinelEvidence = { path: sentinel, value };
  }

  printResult({
    ok: true,
    mode,
    version: after.currentVersion,
    releaseId: check.releaseId,
    manifestSource: check.manifestSource,
    downloadSource: download.downloadSource,
    fallbackUsed: download.fallbackUsed,
    runtime: runtimeInfo.current,
    core: coreVersion,
    sentinel: sentinelEvidence,
  });
  await second.browser.close();
}

main().catch((error) => {
  process.stderr.write(`windows-hot-update-smoke: ${error.message}\n`);
  process.exitCode = 1;
});
