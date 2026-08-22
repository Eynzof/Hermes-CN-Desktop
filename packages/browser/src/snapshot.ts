/**
 * Accessibility-tree snapshot formatting for browser tools.
 *
 * Python emits element refs as `@e1`, `@e2`, etc. This module normalizes raw
 * accessibility nodes into that shape and handles oversized snapshots by
 * truncating/summarizing and writing the full copy to an overflow store.
 */

export const SNAPSHOT_SUMMARIZE_THRESHOLD = 15_000;
export const MAX_STORED_SNAPSHOT_CHARS = 1_000_000;

export interface AccessibilityNode {
  role?: string;
  name?: string;
  value?: string;
  children?: AccessibilityNode[];
  ref?: string;
}

export interface FormattedSnapshot {
  /** Human-readable snapshot text with @e1 refs. */
  text: string;
  /** Total number of interactive elements discovered. */
  elementCount: number;
  /** True if the snapshot was truncated. */
  truncated: boolean;
  /** If truncated, the full snapshot stored for paging. */
  overflowPath?: string;
}

function nextRef(index: number): string {
  return `@e${index}`;
}

function isInterestingNode(node: AccessibilityNode): boolean {
  const role = (node.role ?? "").toLowerCase();
  if (!role) return false;
  const ignored = new Set(["none", "generic", "presentation", "separator", "scrollbar"]);
  if (ignored.has(role)) return false;
  return true;
}

function formatNode(node: AccessibilityNode, depth: number, refCounter: { value: number }): string {
  const lines: string[] = [];
  const interesting = isInterestingNode(node);
  const indent = "  ".repeat(depth);

  let ref = "";
  if (interesting) {
    refCounter.value += 1;
    ref = nextRef(refCounter.value);
    node.ref = ref;
  }

  const role = node.role ?? "Unknown";
  const name = node.name?.trim() ?? "";
  const value = node.value?.trim() ?? "";
  const label = [role, name, value].filter(Boolean).join(" ").trim();

  if (interesting && label) {
    lines.push(`${indent}${ref} ${label}`);
  }

  for (const child of node.children ?? []) {
    lines.push(formatNode(child, depth + 1, refCounter));
  }

  return lines.join("\n");
}

/**
 * Build a Python-compatible accessibility-tree snapshot string.
 */
export function formatSnapshot(root: AccessibilityNode): string {
  return formatNode(root, 0, { value: 0 }).trim();
}

function countInteractiveElements(node: AccessibilityNode): number {
  const interactive = isInterestingNode(node) ? 1 : 0;
  return interactive + (node.children ?? []).reduce((sum, child) => sum + countInteractiveElements(child), 0);
}

/**
 * Format a snapshot and, if it exceeds the threshold, produce a summary while
 * optionally persisting the full copy. `storeOverflow` is optional and should
 * return a cache-relative path (e.g. `cache/web/snapshot-<id>.txt`).
 */
export async function prepareSnapshot(
  root: AccessibilityNode,
  options?: {
    maxChars?: number;
    storeOverflow?: (full: string) => Promise<string> | string;
  },
): Promise<FormattedSnapshot> {
  const full = formatSnapshot(root);
  const elementCount = countInteractiveElements(root);
  const maxChars = options?.maxChars ?? SNAPSHOT_SUMMARIZE_THRESHOLD;

  if (full.length <= maxChars) {
    return { text: full, elementCount, truncated: false };
  }

  let overflowPath: string | undefined;
  const truncated = full.slice(0, maxChars);
  const summary = `${truncated}\n\n... snapshot truncated (${full.length} chars, ${elementCount} elements)`;

  if (options?.storeOverflow && full.length <= MAX_STORED_SNAPSHOT_CHARS) {
    overflowPath = await options.storeOverflow(full);
  }

  return {
    text: summary,
    elementCount,
    truncated: true,
    overflowPath,
  };
}
