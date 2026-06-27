// Browserless end-to-end proof of the backend closed loop. Speaks the gateway
// JSON-RPC-over-WebSocket protocol directly against a running Core dashboard +
// fake model, exercising exactly what the UI does:
//
//   session.create -> prompt.submit -> stream message.delta -> message.complete
//   image.attach   -> prompt.submit -> reply embeds decoded image byte count
//
// This validates the whole stack minus the browser, so it can gate CI even
// where a headless browser is unavailable, and it's how we debug the harness.
//
// Assumes the backend is already up (start-backend.mjs). Exit 0 = loop works.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  DASHBOARD_PORT,
  DASHBOARD_TOKEN,
  UPLOAD_DIR,
} from "./config.mjs";
import { PNG_BASE64, PNG_BYTE_LENGTH } from "../fixtures/red-square.mjs";

const WS_URL = `ws://127.0.0.1:${DASHBOARD_PORT}/api/ws?token=${DASHBOARD_TOKEN}`;

function connect() {
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(WS_URL);
    const events = [];
    const waiters = [];
    let nextId = 1;
    const pending = new Map();

    const pump = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const ev = events.find(w.match);
        if (ev) {
          waiters.splice(i, 1);
          w.resolve(ev);
        }
      }
    };

    ws.onopen = () => resolveConn(api);
    ws.onerror = () => reject(new Error("WebSocket error"));
    ws.onclose = () => reject(new Error("WebSocket closed early"));
    ws.onmessage = (msg) => {
      const frame = JSON.parse(msg.data);
      if (frame.id != null && pending.has(String(frame.id))) {
        const p = pending.get(String(frame.id));
        pending.delete(String(frame.id));
        frame.error ? p.reject(new Error(frame.error.message)) : p.resolve(frame.result);
        return;
      }
      if (frame.method === "event" && frame.params) {
        events.push(frame.params); // { type, session_id, payload }
        pump();
      }
    };

    const api = {
      // The agent stays "busy" briefly after message.complete; the real UI
      // gates this with a disabled send button. A raw client just retries.
      async submit(params) {
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            return await api.request("prompt.submit", params);
          } catch (err) {
            if (String(err.message).includes("busy")) {
              await new Promise((r) => setTimeout(r, 250));
              continue;
            }
            throw err;
          }
        }
        throw new Error("session stayed busy too long");
      },
      request(method, params = {}) {
        const id = `s${nextId++}`;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`RPC timeout: ${method}`));
          }, 30_000);
        });
      },
      // Collect streamed text for a turn until message.complete.
      waitForTurn(timeoutMs = 30_000) {
        return new Promise((res, rej) => {
          const start = events.length;
          const timer = setTimeout(() => rej(new Error("turn timeout")), timeoutMs);
          const tick = () => {
            const since = events.slice(start);
            if (since.some((e) => e.type === "error")) {
              clearTimeout(timer);
              const e = since.find((x) => x.type === "error");
              return rej(new Error(`gateway error: ${JSON.stringify(e.payload)}`));
            }
            if (since.some((e) => e.type === "message.complete")) {
              clearTimeout(timer);
              const text = since
                .filter((e) => e.type === "message.delta")
                .map((e) => e.payload?.text ?? "")
                .join("");
              return res(text);
            }
            setTimeout(tick, 100);
          };
          tick();
        });
      },
      close: () => ws.close(),
    };
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  const api = await connect();
  console.log("connected to gateway");

  // --- Loop 1: text turn ---
  const { session_id } = await api.request("session.create", {});
  assert(session_id, "session.create returned a session_id");
  console.log("session:", session_id);

  await api.submit({ session_id, text: "ping" });
  const reply1 = await api.waitForTurn();
  console.log("text reply:", JSON.stringify(reply1));
  assert(reply1.includes("PONG"), `text reply should contain PONG, got: ${reply1}`);

  // --- Loop 2: continue in same session ---
  await api.submit({ session_id, text: "again" });
  const reply2 = await api.waitForTurn();
  assert(reply2.includes("PONG"), `follow-up reply should contain PONG, got: ${reply2}`);
  console.log("continue-conversation reply OK");

  // --- Loop 3: vision (image bytes must reach the fake model) ---
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const imgPath = resolve(UPLOAD_DIR, "smoke.png");
  writeFileSync(imgPath, Buffer.from(PNG_BASE64, "base64"));
  const attach = await api.request("image.attach", { session_id, path: imgPath });
  console.log("image.attach:", JSON.stringify(attach));
  assert(attach.attached !== false, "image.attach should succeed");

  await api.submit({ session_id, text: "图里是什么？" });
  const reply3 = await api.waitForTurn(40_000);
  console.log("vision reply:", JSON.stringify(reply3));
  assert(
    reply3.includes("我看到一张图片"),
    `vision reply should acknowledge the image, got: ${reply3}`,
  );
  assert(
    reply3.includes(String(PNG_BYTE_LENGTH)),
    `vision reply should report ${PNG_BYTE_LENGTH} decoded bytes (proves bytes reached the model), got: ${reply3}`,
  );
  console.log("vision round-trip OK — model received", PNG_BYTE_LENGTH, "bytes");

  api.close();
  console.log("\n✅ ALL THREE LOOPS PASSED at the protocol level");
}

main().catch((err) => {
  console.error("\n❌ smoke failed:", err.message);
  process.exit(1);
});
