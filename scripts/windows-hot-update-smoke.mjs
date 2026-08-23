#!/usr/bin/env node

import { chromium } from "playwright";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cdp = option("cdp", "http://127.0.0.1:9222");
const expectedVersion = option("expected-version");
const expectedCoreVersion = option("expected-core-version");
if (!expectedVersion) throw new Error("缺少 --expected-version");
if (!expectedCoreVersion) throw new Error("缺少 --expected-core-version");

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

const first = await connect();
const check = await bridge(first.page, "appUpdateCheck");
if (!check.ok || !check.updateAvailable || check.latestVersion !== expectedVersion) {
  throw new Error(`nightly check 未授权目标版本：${JSON.stringify(check)}`);
}
const download = await bridge(first.page, "appUpdateDownload");
if (!download.ok || !download.ready) {
  throw new Error(`nightly download 失败：${JSON.stringify(download)}`);
}
if (!new Set(["cloudflare-cache", "github-release"]).has(download.downloadSource)) {
  throw new Error(`下载源诊断无效：${download.downloadSource}`);
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

// The detached updater exits the old shell, installs, and relaunches it. A new
// CDP connection proves the process boundary was crossed.
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

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: after.currentVersion,
    releaseId: check.releaseId,
    manifestSource: check.manifestSource,
    downloadSource: download.downloadSource,
    fallbackUsed: download.fallbackUsed,
    runtime: runtimeInfo.current,
    core: coreVersion,
  }, null, 2)}\n`,
);
await second.browser.close();
