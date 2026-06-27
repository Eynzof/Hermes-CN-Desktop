// Small async helpers for the harness: poll an HTTP URL and watch a child's
// stdout for a readiness line. No external deps.

export async function waitForHttp(url, { timeoutMs = 60_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr?.message ?? "unknown"}`);
}

// Resolve when `child`'s stdout/stderr emits a line containing `needle`.
export function waitForLine(child, needle, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for "${needle}"`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(needle)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`process exited (code ${code}) before "${needle}"`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
