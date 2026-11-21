import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./stage-bundled-runtime.mjs", import.meta.url));

test("staging a signed local runtime and selecting the release download URLs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-stage-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = join(dir, "payload.zip");
  const json = join(dir, "manifest.json");
  const out = join(dir, "staged");
  const bytes = Buffer.from("a local staging fixture");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = {
    schemaVersion: 2, channel: "stable", runtimeVersion: "0.21.0-cn.19",
    kernelVersion: "0.21.0", runtimeFlavor: "cn", runtimeRevision: 19,
    platform: "win32", arch: "x64", artifactUrl: "https://example.invalid/runtime.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceRepo: "Eynzof/Hermes-CN-Core", sourceCommit: "a".repeat(40),
  };
  manifest.signature = sign(null, Buffer.from(Object.values(manifest).join("\n")), privateKey).toString("base64");
  writeFileSync(zip, bytes);
  writeFileSync(json, JSON.stringify(manifest));
  const env = { HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM_DEFAULT: publicKey.export({ format: "pem", type: "spki" }) };
  const local = (...args) => spawnSync(process.execPath, [script, "--out", out, "--local-manifest", json,
    "--local-artifact", zip, ...args], { env, encoding: "utf8" });

  await t.test("uses the original default release URLs", () => {
    const urls = join(dir, "urls");
    const hook = join(dir, "fetch.mjs");
    writeFileSync(hook, `
      import { appendFileSync, readFileSync } from "node:fs";
      globalThis.fetch = async (url) => {
        appendFileSync(${JSON.stringify(urls)}, url + "\\n");
        return new Response(readFileSync(url.endsWith(".json") ? ${JSON.stringify(json)} : ${JSON.stringify(zip)}));
      };
    `);
    const result = spawnSync(process.execPath, ["--import", hook, script, "--out", out], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const base = "https://github.com/Eynzof/Hermes-CN-Core/releases/latest/download";
    assert.deepEqual(readFileSync(urls, "utf8").trim().split("\n"), [
      `${base}/stable-win32-x64.json`, `${base}/hermes-agent-cn-runtime-win32-x64.zip`,
    ]);
  });
  await t.test("preserves the signed manifest bytes and artifact", () => {
    const result = local("--tag", "runtime-v0.21.0-cn.19");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(out, "stable-win32-x64.json")), readFileSync(json));
    assert.deepEqual(readFileSync(join(out, "hermes-agent-cn-runtime-win32-x64.zip")), bytes);
  });
  await t.test("rejects a tampered artifact", () => {
    writeFileSync(zip, "changed");
    const result = local();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256 mismatch/);
    writeFileSync(zip, bytes);
  });
  await t.test("rejects an invalid signature", () => {
    writeFileSync(json, JSON.stringify({ ...manifest, signature: Buffer.alloc(64).toString("base64") }));
    const result = local();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid local runtime signature/);
  });
});
