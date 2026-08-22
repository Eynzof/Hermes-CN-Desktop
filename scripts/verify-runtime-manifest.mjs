#!/usr/bin/env node
// Verify a Hermes-CN runtime manifest (schema v2) signature and SHA-256.
// Mirrors Rust verify_signature_with_key + runtime artifact checks.
//
// Usage:
//   node scripts/verify-runtime-manifest.mjs \
//     --manifest static/bundled-runtime/manifest.json \
//     --public-key-env RUNTIME_SIGN_PUBLIC_KEY_PEM \
//     [--artifact path/to/runtime.zip]
//
// Exits 0 on success, 1 on failure.

import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    manifest: { type: "string", short: "m" },
    "public-key-env": { type: "string" },
    "public-key-pem": { type: "string" },
    artifact: { type: "string", short: "a" },
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
  "signature",
];

function buildSignaturePayload(manifest) {
  const keys = [
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
  const parts = keys.map((key) => {
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

  let publicKeyPem = "";
  if (values["public-key-env"]) {
    publicKeyPem = process.env[values["public-key-env"]] || "";
    if (!publicKeyPem) {
      console.error(`Error: env var ${values["public-key-env"]} is empty or unset`);
      process.exit(1);
    }
  } else if (values["public-key-pem"]) {
    publicKeyPem = await readFile(values["public-key-pem"], "utf8");
  } else {
    console.error("Error: either --public-key-env or --public-key-pem is required");
    process.exit(1);
  }

  const raw = await readFile(values.manifest, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: manifest is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === "") {
      console.error(`Error: manifest.${field} is missing or empty`);
      process.exit(1);
    }
  }

  if (!String(manifest.artifactUrl).startsWith("https://")) {
    console.error("Error: artifactUrl must use https://");
    process.exit(1);
  }

  const payload = buildSignaturePayload(manifest);
  const signature = Buffer.from(manifest.signature, "base64");

  let ok;
  try {
    ok = verify(null, payload, publicKeyPem.trim(), signature);
  } catch (err) {
    console.error(`Error: verification threw: ${err.message || err}`);
    process.exit(1);
  }

  if (!ok) {
    console.error("Error: signature verification failed");
    process.exit(1);
  }

  if (values.artifact) {
    const artifactBytes = await readFile(values.artifact);
    const hash = createHash("sha256").update(artifactBytes).digest("hex");
    if (hash !== manifest.sha256) {
      console.error(
        `Error: artifact SHA-256 mismatch: expected ${manifest.sha256}, got ${hash}`,
      );
      process.exit(1);
    }
  }

  console.log(`Verified ${values.manifest}`);
  console.log(`  schemaVersion: ${manifest.schemaVersion}`);
  console.log(`  runtimeVersion: ${manifest.runtimeVersion}`);
  console.log(`  kernelVersion: ${manifest.kernelVersion}`);
  console.log(`  runtimeFlavor: ${manifest.runtimeFlavor}`);
  console.log(`  platform/arch: ${manifest.platform}/${manifest.arch}`);
  console.log(`  artifactUrl: ${manifest.artifactUrl}`);
  if (values.artifact) {
    console.log(`  artifact SHA-256 OK`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
