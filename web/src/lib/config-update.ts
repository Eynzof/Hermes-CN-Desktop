function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildNestedConfigUpdate(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { [parts[0]!]: value };
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const next: Record<string, unknown> = {};
    cur[part] = next;
    cur = next;
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}

export function mergeConfigUpdate<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const merge = (base: unknown, next: unknown): unknown => {
    if (!isPlainObject(base) || !isPlainObject(next)) return next;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(next)) {
      out[key] = key in out ? merge(out[key], value) : value;
    }
    return out;
  };

  return merge(current, patch) as T;
}
