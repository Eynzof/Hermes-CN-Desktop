/**
 * Home Assistant security primitives.
 *
 * Mirrors the Python `homeassistant_tool.py` validation layer verbatim:
 * entity_id/service regexes, blocked domains, and JSON-string `data` parsing.
 */

/** Matches valid Home Assistant entity ids (`domain.object_id`). */
export const ENTITY_ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;

/** Matches valid Home Assistant service names (`service`). */
export const SERVICE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Domains blocked from service calls.
 * HA has no service-level ACL; this safety gate prevents arbitrary code execution
 * through powerful built-in integrations.
 */
export const BLOCKED_DOMAINS = new Set([
  "shell_command",
  "command_line",
  "python_script",
  "pyscript",
  "hassio",
  "rest_command",
]);

/** Validate an entity id. Rejects path-traversal attempts. */
export function isValidEntityId(entityId: string): boolean {
  return ENTITY_ID_RE.test(entityId);
}

/** Validate a service name. Must be checked before the blocklist. */
export function isValidServiceName(serviceName: string): boolean {
  return SERVICE_NAME_RE.test(serviceName);
}

/** True if the domain is in the blocked service-call list. */
export function isBlockedDomain(domain: string): boolean {
  return BLOCKED_DOMAINS.has(domain);
}

/**
 * Parse the `data` parameter when it arrives as a JSON string.
 * Empty string is treated as `undefined` to match Python's `orjson` behavior.
 */
export function parseStringData(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data !== "string") {
    if (typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return undefined;
  }
  const trimmed = data.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
