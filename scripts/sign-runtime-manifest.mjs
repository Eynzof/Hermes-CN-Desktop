#!/usr/bin/env node
// Sign a Hermes-CN runtime manifest (schema v2) with Ed25519.
// Mirrors scripts/sign_runtime_manifest.py.
//
// Usage:
//   node scripts/sign-runtime-manifest.mjs \
//     --manifest static/bundled-runtime/manifest.json \
//     --out static/bundled-runtime/manifest.json \
//     --private-key-env RUNTIME_SIGN_PRIVATE_KEY_PEM
//
// The private key may also be passed as a file path with --private-key-pem <path>.
// The signer writes the same JSON file with the `signature` field populated.

import { createHash, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    manifest: { type: "string", short: "m" },
    out: { type: "string", short: "o" },
    "private-key-env": { type: "string" },
    "private-key-pem": { type: "string" },
    "public-key-pem": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const REQUIRED_FIELDS = [
  "schemaVersion",
  "channel",
  "runtimeVersion",
  "kernelVersion",
  "runtimeFlavor",
  "runtimeRevision",
  "platform",
  "arch",
  "artifactUrl",
  "sha256",
  "sourceRepo",
  "sourceCommit",
];

function buildSignaturePayload(manifest) {
  const parts = REQUIRED_FIELDS.map((key) => {
    const value = manifest[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing manifest field: ${key}`);
    }
    return String(value);
  });
  return Buffer.from(parts.join("\n"), "utf8");
}

async function main() {
  if (!values.manifest) {
    console.error("Error: --manifest is required");
    process.exit(1);
  }
  const outPath = values.out || values.manifest;

  let privateKeyPem = "";
  if (values["private-key-env"]) {
    privateKeyPem = process.env[values["private-key-env"]] || "";
    if (!privateKeyPem) {
      console.error(`Error: env var ${values["private-key-env"]} is empty or unset`);
      process.exit(1);
    }
  } else if (values["private-key-pem"]) {
    privateKeyPem = await readFile(values["private-key-pem"], "utf8");
  } else {
    console.error("Error: either --private-key-env or --private-key-pem is required");
    process.exit(1);
  }

  const raw = await readFile(values.manifest, "utf8");
  const manifest = JSON.parse(raw);

  if (!Number.isFinite(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    console.error("Error: manifest.schemaVersion must be a positive integer");
    process.exit(1);
  }
  if (!String(manifest.artifactUrl).startsWith("https://")) {
    console.error("Error: artifactUrl must use https://");
    process.exit(1);
  }

  const payload = buildSignaturePayload(manifest);

  let signatureBuffer;
  try {
    signatureBuffer = sign(null, payload, privateKeyPem.trim());
  } catch (err) {
    console.error(`Error: signing failed: ${err.message || err}`);
    process.exit(1);
  }

  manifest.signature = signatureBuffer.toString("base64");

  await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Optional self-verify when the caller also supplies the public key.
  if (values["public-key-pem"]) {
    const publicKeyPem = await readFile(values["public-key-pem"], "utf8");
    try {
      const { verify } = await import("node:crypto");
      const ok = verify(null, payload, publicKeyPem.trim(), signatureBuffer);
      if (!ok) {
        console.error("Error: self-verification of signature failed");
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: self-verification failed: ${err.message || err}`);
      process.exit(1);
    }
  }

  console.log(`Signed ${values.manifest} → ${outPath}`);
  console.log(`SHA-256(payload): ${createHash("sha256").update(payload).digest("hex")}`);
  console.log(`Signature: ${manifest.signature.slice(0, 32)}...`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
