/**
 * Python `model_tools.repair_tool_arg_keys` parity layer.
 *
 * Repairs LLM tool-call argument keys to match a tool's JSON Schema using:
 *  1. per-tool override aliases
 *  2. global field aliases
 *  3. fuzzy matching against the expected schema properties
 *  4. recursive repair for nested objects and arrays of objects
 */

import type { JSONSchema, RepairRecord, RepairResult } from "./types";

const GENERAL_ALIASES: Record<string, string> = {
  operation: "action",
  op: "action",
  instruction: "prompt",
  task: "prompt",
  request: "prompt",
  objective: "goal",
  options: "choices",
  answers: "choices",
  n: "limit",
  max: "limit",
  max_results: "limit",
  top_n: "limit",
  num: "limit",
  skip: "offset",
  lines: "limit",
  title: "name",
};

const FILE_ALIASES: Record<string, string> = {
  file: "path",
  filepath: "path",
  file_path: "path",
  filename: "path",
  file_name: "path",
  dir: "path",
  directory: "path",
  folder: "path",
  location: "path",
  body: "content",
  source: "content",
  value: "content",
  write_mode: "mode",
  out: "output_path",
  output: "output_path",
  destination: "output_path",
  dest: "output_path",
  paths: "file_path",
  file_list: "file_path",
  filter: "file_glob",
  file_pattern: "file_glob",
  glob: "file_glob",
  regex: "pattern",
  expr: "pattern",
  expression: "pattern",
  match: "pattern",
  original: "old_string",
  old_str: "old_string",
  old_content: "old_string",
  replace_with: "new_string",
  new_str: "new_string",
  new_content: "new_string",
  replacement: "new_string",
  all: "replace_all",
  cross_profile_guard: "cross_profile",
};

const SHELL_ALIASES: Record<string, string> = {
  cmd: "command",
  script: "command",
  shell_command: "command",
  program: "code",
  snippet: "code",
  python: "code",
  wait: "timeout",
  delay: "timeout",
  time_limit: "timeout",
  duration: "timeout",
  bg: "background",
  async: "background",
  detach: "background",
  arguments: "acp_args",
  params: "acp_args",
  arg: "acp_args",
  parameters: "acp_args",
  working_dir: "workdir",
  work_dir: "workdir",
  cwd: "workdir",
  interactive: "pty",
  terminal_mode: "pty",
  notify: "notify_on_complete",
  patterns: "watch_patterns",
  watch: "watch_patterns",
  stdin: "data",
  process_id: "session_id",
  pid: "session_id",
};

const WEB_ALIASES: Record<string, string> = {
  link: "image_url",
  href: "image_url",
  address: "image_url",
  uri: "image_url",
  site: "image_url",
  image: "image_url",
  img: "image_url",
  src: "image_url",
  photo: "image_url",
  picture: "image_url",
  q: "query",
  keyword: "query",
  keywords: "query",
  term: "query",
  search: "query",
  query: "question",
};

const TASK_ALIASES: Record<string, string> = {
  tools: "toolsets",
  jobs: "tasks",
  batch: "tasks",
  background: "context",
  instructions: "goal",
  role_type: "role",
  command: "acp_command",
  args: "acp_args",
};

const TODO_ALIASES: Record<string, string> = {
  items: "todos",
  list: "todos",
  tasks: "todos",
  entries: "todos",
  update: "merge",
};

const INPUT_ALIASES: Record<string, string> = {
  input: "text",
};

const SEARCH_ALIASES: Record<string, string> = {
  search_type: "target",
  format: "output_mode",
  order: "sort",
  message_id: "around_message_id",
  around: "around_message_id",
  msg_id: "around_message_id",
  window_size: "window",
  roles: "role_filter",
  context_lines: "context",
  queries: "question",
};

const MEMORY_ALIASES: Record<string, string> = {
  old: "old_text",
  previous: "old_text",
};

const CRONJOB_ALIASES: Record<string, string> = {
  cron: "schedule",
  repeat_count: "repeat",
  delivery: "deliver",
  disable_agent: "no_agent",
  without_agent: "no_agent",
  toolsets: "enabled_toolsets",
  profile_name: "profile",
};

const SKILL_ALIASES: Record<string, string> = {
  type: "category",
  group: "category",
  tag: "category",
  umbrella: "absorbed_into",
  merge_into: "absorbed_into",
};

export const TOOL_FIELD_ALIASES: Record<string, string> = {
  ...GENERAL_ALIASES,
  ...FILE_ALIASES,
  ...SHELL_ALIASES,
  ...WEB_ALIASES,
  ...TASK_ALIASES,
  ...TODO_ALIASES,
  ...INPUT_ALIASES,
  ...SEARCH_ALIASES,
  ...MEMORY_ALIASES,
  ...CRONJOB_ALIASES,
  ...SKILL_ALIASES,
};

/** Per-tool aliases take precedence over globals when they disagree. */
export const TOOL_SPECIFIC_ALIASES: Record<string, Record<string, string>> = {
  delegate_task: {
    task: "goal",
    prompt: "goal",
    description: "goal",
  },
  cronjob: {
    command: "action",
    background: "no_agent",
    message: "prompt",
  },
  process: {
    wait: "block",
  },
};

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return curr[n];
}

function similarityRatio(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

function fuzzyMatch(
  miss: string,
  candidates: string[],
): { key: string; ratio: number } | undefined {
  if (miss.length < 4) return undefined;
  const cutoff = miss.length >= 8 ? 0.75 : 0.8;
  let bestKey: string | undefined;
  let bestRatio = 0;
  for (const key of candidates) {
    if (key.length < 4) continue;
    const ratio = similarityRatio(miss, key);
    if (ratio > bestRatio && ratio >= cutoff) {
      bestRatio = ratio;
      bestKey = key;
    }
  }
  return bestKey ? { key: bestKey, ratio: bestRatio } : undefined;
}

function schemaProperties(schema: JSONSchema): Record<string, JSONSchema> | undefined {
  const params = schema?.parameters ?? schema;
  if (
    params &&
    typeof params === "object" &&
    "properties" in params &&
    params.properties
  ) {
    return params.properties as Record<string, JSONSchema>;
  }
  return undefined;
}

function hasNestedProperties(properties: Record<string, JSONSchema>): boolean {
  for (const p of Object.values(properties)) {
    if (p?.type === "object" && p.properties) return true;
    if (
      p?.type === "array" &&
      p.items &&
      typeof p.items === "object" &&
      p.items.type === "object" &&
      p.items.properties
    ) {
      return true;
    }
  }
  return false;
}

export function repairToolArgKeys(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  schema: JSONSchema,
): RepairResult {
  if (!args || typeof args !== "object") {
    return { args: (args ?? {}) as Record<string, unknown>, repaired: [] };
  }

  const properties = schemaProperties(schema);
  if (!properties) {
    return { args: { ...args }, repaired: [] };
  }

  const expected = new Set(Object.keys(properties));
  if (expected.size === 0) {
    return { args: { ...args }, repaired: [] };
  }

  const result: Record<string, unknown> = { ...args };
  const repaired: RepairRecord[] = [];

  // 1. Per-tool aliases and global aliases.
  const toolAliases = TOOL_SPECIFIC_ALIASES[toolName] ?? {};
  for (const badKey of Object.keys(result)) {
    if (expected.has(badKey)) continue;
    const canonical = toolAliases[badKey] ?? TOOL_FIELD_ALIASES[badKey];
    if (canonical && expected.has(canonical) && !(canonical in result)) {
      result[canonical] = result[badKey];
      delete result[badKey];
      repaired.push({
        from: badKey,
        to: canonical,
        kind: toolAliases[badKey] ? "tool-specific" : "alias",
      });
    }
  }

  // 2. Fuzzy matching for remaining bad keys.
  const remainingBad = Object.keys(result).filter((k) => !expected.has(k));
  const missing = Array.from(expected).filter((k) => !(k in result));
  const usedFuzzy = new Set<string>();
  const candidates: { ratio: number; miss: string; matched: string }[] = [];
  for (const miss of missing) {
    if (miss.length < 4) continue;
    const match = fuzzyMatch(
      miss,
      remainingBad.filter((k) => !usedFuzzy.has(k)),
    );
    if (match) {
      candidates.push({ ratio: match.ratio, miss, matched: match.key });
    }
  }
  candidates.sort((a, b) => b.ratio - a.ratio);
  for (const { miss, matched } of candidates) {
    if (usedFuzzy.has(matched)) continue;
    if (miss in result) continue;
    usedFuzzy.add(matched);
    result[miss] = result[matched];
    delete result[matched];
    repaired.push({ from: matched, to: miss, kind: "fuzzy" });
  }

  // 3. Recursive repair for nested objects / arrays of objects.
  for (const [key, value] of Object.entries(result)) {
    const propSchema = properties[key];
    if (!propSchema) continue;

    if (
      propSchema.type === "object" &&
      propSchema.properties &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const nested = value as Record<string, unknown>;
      const { args: repairedNested, repaired: nestedRecords } =
        repairToolArgKeys(toolName, nested, propSchema);
      result[key] = repairedNested;
      for (const r of nestedRecords) {
        repaired.push({ ...r, from: `${key}.${r.from}`, to: `${key}.${r.to}` });
      }
    } else if (
      propSchema.type === "array" &&
      propSchema.items &&
      typeof propSchema.items === "object" &&
      propSchema.items.type === "object" &&
      propSchema.items.properties &&
      Array.isArray(value)
    ) {
      const newList: unknown[] = [];
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const { args: repairedItem, repaired: itemRecords } =
            repairToolArgKeys(
              toolName,
              item as Record<string, unknown>,
              propSchema.items,
            );
          newList.push(repairedItem);
          for (const r of itemRecords) {
            repaired.push({
              ...r,
              from: `${key}[].${r.from}`,
              to: `${key}[].${r.to}`,
            });
          }
        } else {
          newList.push(item);
        }
      }
      result[key] = newList;
    }
  }

  return { args: result, repaired };
}

/** Determine whether a schema has any nested object properties worth recursing. */
export function needsNestedRepair(schema: JSONSchema): boolean {
  const properties = schemaProperties(schema);
  if (!properties) return false;
  return hasNestedProperties(properties);
}
