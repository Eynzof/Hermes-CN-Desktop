/**
 * Parse leading slash-command input.
 *
 * Mirrors `composer-skills.parseLeadingSlashCommand` with an additional path
 * guard: a command name containing `/` is rejected unless it is namespaced as
 * `plugin:name` (or `skill:name`, which the resolver treats as a skill intent).
 */

export interface ParsedSlashInput {
  /** Canonical command name without leading slash. */
  name: string;
  /** Raw argument string after the command token. */
  args: string;
  /** Whether the name was namespaced (contains `:`). */
  namespaced: boolean;
  /** Namespace prefix when namespaced, e.g. `plugin`. */
  namespace?: string;
}

/**
 * Parse a line as a slash command.
 *
 * Returns `null` when:
 * - the text does not start with `/` after optional leading whitespace;
 * - the command token contains `/` and is not namespaced `plugin:name`;
 * - the command token is empty.
 */
export function parseSlashInput(text: string): ParsedSlashInput | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;

  // Match: optional leading slash, non-whitespace command token, optional rest.
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;

  const rawName = match[1];
  const args = (match[2] ?? "").trim();

  // Path guard: `/Users/foo.md` should be a prompt, not a command.
  // Allowed exceptions: namespaced forms like `plugin:name` or `skill:name`.
  const colonIndex = rawName.indexOf(":");
  if (colonIndex >= 0) {
    const namespace = rawName.slice(0, colonIndex).toLowerCase();
    const name = rawName.slice(colonIndex + 1);
    if (!namespace || !name || name.includes("/")) return null;
    return { name, args, namespaced: true, namespace };
  }

  if (rawName.includes("/")) return null;

  return { name: rawName.toLowerCase(), args, namespaced: false };
}
