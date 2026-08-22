import type { NousToken } from "./types.js";

export function peekNousAccessToken(tokens: NousToken[]): string | null {
  for (const t of tokens) {
    if (t.accessToken) return t.accessToken;
  }
  return null;
}

export function readNousAccessToken(tokens: NousToken[], now = Date.now() / 1000): string | null {
  const candidate = tokens.find((t) => !t.expiresAt || t.expiresAt > now + 120);
  return candidate?.accessToken ?? null;
}
