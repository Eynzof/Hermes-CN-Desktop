const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED = new Set(["default", "new", "list", "use", "create", "delete", "show", "alias", "rename", "export", "import", "install", "update", "info"]);

export function normalizeProfileName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "default") return "default";
  return lower;
}

export function validateProfileName(name: string): { ok: boolean; error?: string } {
  if (name === "default") return { ok: true };
  if (!NAME_RE.test(name)) {
    return { ok: false, error: "name must be lowercase alphanumerics, dashes or underscores, 1-64 chars" };
  }
  if (RESERVED.has(name)) {
    return { ok: false, error: "reserved name" };
  }
  return { ok: true };
}
