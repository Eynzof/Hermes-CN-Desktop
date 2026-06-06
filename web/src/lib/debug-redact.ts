const SENSITIVE_KEYS = [
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "x-hermes-session-token",
  "session_token",
  "sessiontoken",
  "session-token",
  "secret",
  "password",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "key_env",
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
const SENSITIVE_TEXT_KEYS = [...SENSITIVE_KEYS, "token"] as const;

const BEARER_RE = /(Bearer\s+)([A-Za-z0-9_.\-+/=]{8,})/gi;
const LONG_TOKEN_RE = /\b(sk-[A-Za-z0-9_\-]{16,}|gh[pous]_[A-Za-z0-9_]{20,}|xox[abprsu]-[A-Za-z0-9-]{10,})\b/g;
const SENSITIVE_TEXT_KEY_RE = new RegExp(
  `(^|[\\s,{\\[])(` +
    SENSITIVE_TEXT_KEYS.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    `)(\\s*[:=]\\s*)(["']?)([^"'\\s,;&}]+)(["']?)`,
  "gi",
);

const MASK = "***";
const MAX_DEPTH = 6;

function maskString(value: string): string {
  return value
    .replace(BEARER_RE, (_, prefix) => `${prefix}${MASK}`)
    .replace(LONG_TOKEN_RE, MASK)
    .replace(SENSITIVE_TEXT_KEY_RE, (_match, prefix, key, sep, openQuote, _secret, closeQuote) => {
      const quote = openQuote && closeQuote ? openQuote : "";
      return `${prefix}${key}${sep}${quote}${MASK}${quote}`;
    });
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_SET.has(lower)) return true;
  return SENSITIVE_KEYS.some((needle) => lower.includes(needle));
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (value == null) return value;
  if (typeof value === "string") return maskString(value) as unknown as T;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1)) as unknown as T;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const next: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    if (isSensitiveKey(key)) {
      if (typeof val === "string" && val.length > 0) next[key] = MASK;
      else if (val == null) next[key] = val;
      else next[key] = MASK;
    } else {
      next[key] = redact(val, depth + 1);
    }
  }
  return next as unknown as T;
}

export function redactSummary(summary: string): string {
  return maskString(summary);
}
