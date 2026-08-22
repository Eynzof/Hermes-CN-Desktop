/**
 * Minimal crypto helpers backed by the Web Crypto API (`crypto.subtle`).
 *
 * Works in both modern browsers and Node test environments, avoiding a
 * hard dependency on `node:crypto` so the package can be imported by the
 * web bundle without polyfill gymnastics.
 */

const textEncoder = new TextEncoder();

export function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

function asBufferSource(buf: Uint8Array): BufferSource {
  return buf as unknown as BufferSource;
}

export function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    asBufferSource(encodeText(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, asBufferSource(encodeText(message)));
  return toHex(signature);
}

export async function digestSha256(message: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", asBufferSource(encodeText(message)));
  return toHex(buffer);
}
