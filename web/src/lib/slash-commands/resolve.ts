import { resolveCommand, listCommands, type CommandDef } from "./registry";
import { parseSlashInput } from "./parse";
import type { SlashIntent } from "./types";

export interface ResolveSlashOptions {
  /** Raw composer input line. */
  input: string;
  /** Known skill canonical names from the skill store/catalog. */
  skillNames?: readonly string[] | null;
  /** Known skill bundle keys. */
  bundleKeys?: readonly string[] | null;
  /** Skill command names → parent skill name. Commands declared in SKILL.md frontmatter resolve as their owning skill. */
  skillCommandMap?: ReadonlyMap<string, string> | null;
  /** Plugin commands keyed by `pluginId:name` or quick alias. */
  pluginCommands?: ReadonlyMap<string, { body: string; description?: string }> | null;
  /** Whether the agent currently has an in-flight turn. */
  isBusy?: boolean;
  /** Whether a compression is currently running. */
  isCompacting?: boolean;
}

const SKILL_NAMESPACE = "skill";
const BUNDLE_NAMESPACE = "bundle";

/**
 * Resolve a slash command line into a `SlashIntent`.
 *
 * Algorithm:
 * 1. Parse the leading token; reject path-like names (`/Users/foo.md`).
 * 2. Skill namespace `/skill <name>`: if `<name>` is a known skill, return a
 *    skill intent before the exact `/skill` management command can match.
 * 3. Exact registry match (name or alias) → local/backend intent.
 * 4. Namespaced forms:
 *    - `skill:name` or `/skill name` → skill intent.
 *    - `bundle:name` → bundle intent.
 *    - `pluginId:name` or known quick alias → plugin intent.
 * 5. Bare skill/bundle keys and skill commands.
 * 6. Prefix matching.
 *    Prefer exact match, then unique shortest match, then ambiguous.
 * 7. Apply busy policy:
 *    - `reject` while busy → blocked.
 *    - `interrupt_then_dispatch` → backend/local intent (caller must cancel first).
 *    - `dispatch` → backend/local intent.
 * 8. Unrecognized slash-like input that passed the parser → message intent
 *    (Core semantics: recognized commands bypass the message queue; unknowns
 *    can be sent as a plain message on Desktop).
 */
export function resolveSlashInput(options: ResolveSlashOptions): SlashIntent {
  const parsed = parseSlashInput(options.input);
  if (!parsed) {
    return { type: "message" };
  }

  const { name, args, namespaced, namespace } = parsed;
  const skillNames = new Set(options.skillNames ?? []);
  const bundleKeys = new Set(options.bundleKeys ?? []);
  const skillCommandMap = options.skillCommandMap ?? null;

  // 1. Skill namespace `/skill <name>`: prefer skill invocation over the
  //    `/skill` management command when <name> is a known skill.
  const skillNamespaceMatch = options.input
    .trimStart()
    .match(/^\/skill\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (skillNamespaceMatch?.[1]) {
    const skillName = skillNamespaceMatch[1];
    const skillArgs = skillNamespaceMatch[2]?.trim() ?? "";
    if (skillNames.size === 0 || skillNames.has(skillName)) {
      return { type: "skill", name: skillName, args: skillArgs };
    }
  }

  // 2. Exact registry match.
  const exact = resolveCommand(name);
  if (exact) {
    return applyBusyPolicy(
      {
        type: commandIntentType(exact),
        name: exact.name,
        args,
        command: exact,
        alias: name.toLowerCase() !== exact.name.toLowerCase(),
      },
      exact,
      options,
    );
  }

  // 3. Namespaced intents.
  if (namespaced && namespace) {
    if (namespace === SKILL_NAMESPACE) {
      return { type: "skill", name, args };
    }
    if (namespace === BUNDLE_NAMESPACE) {
      return { type: "bundle", name, args };
    }
    const plugin = options.pluginCommands?.get(`${namespace}:${name}`);
    if (plugin) {
      return { type: "plugin", name: `${namespace}:${name}`, args };
    }
    // Unknown namespace falls through to prefix matching / message.
  }

  // 4. Bare skill/bundle keys and skill commands.
  if (skillNames.has(name)) {
    return { type: "skill", name, args };
  }
  if (bundleKeys.has(name)) {
    return { type: "bundle", name, args };
  }
  const parentSkill = skillCommandMap?.get(name);
  if (parentSkill) {
    return { type: "skill", name: parentSkill, args };
  }

  // 5. Prefix matching.
  const prefixMatch = resolveByPrefix(name, args, options);
  if (prefixMatch) {
    return prefixMatch;
  }

  // 6. Unknown slash token — let caller treat it as a message.
  return { type: "message", name, args };
}

function resolveByPrefix(
  query: string,
  args: string,
  options: ResolveSlashOptions,
): SlashIntent | null {
  const q = query.toLowerCase();

  // Collect all registry candidates (including cli-only/gateway-only for prefix parity).
  const registryCandidates: { name: string; def: CommandDef; alias: boolean }[] = [];
  for (const cmd of collectRegistryCommands()) {
    registryCandidates.push({ name: cmd.name, def: cmd, alias: false });
    for (const alias of cmd.aliases ?? []) {
      registryCandidates.push({ name: alias, def: cmd, alias: true });
    }
  }

  const matches = registryCandidates.filter((c) => c.name.toLowerCase().startsWith(q));
  const skillMatches = (options.skillNames ?? []).filter((s) => s.toLowerCase().startsWith(q));
  const bundleMatches = (options.bundleKeys ?? []).filter((b) => b.toLowerCase().startsWith(q));
  const skillCommandMatches: string[] = [];
  for (const [cmdName, skillName] of options.skillCommandMap ?? []) {
    if (cmdName.toLowerCase().startsWith(q)) {
      skillCommandMatches.push(skillName);
    }
  }

  // Prefer exact match first.
  const exactRegistry = matches.find((m) => m.name.toLowerCase() === q);
  if (exactRegistry) {
    return applyBusyPolicy(
      {
        type: commandIntentType(exactRegistry.def),
        name: exactRegistry.def.name,
        args,
        command: exactRegistry.def,
        alias: exactRegistry.alias,
      },
      exactRegistry.def,
      options,
    );
  }

  // Unique shortest match: prefer the candidate with the shortest name among
  // all matches; if there is exactly one at that minimum length, expand to it.
  const allMatches = [
    ...matches.map((m) => ({ kind: "builtin" as const, name: m.name, def: m.def, alias: m.alias })),
    ...skillMatches.map((s) => ({ kind: "skill" as const, name: s })),
    ...bundleMatches.map((b) => ({ kind: "bundle" as const, name: b })),
    ...skillCommandMatches.map((s) => ({ kind: "skill" as const, name: s })),
  ].sort((a, b) => a.name.length - b.name.length);

  if (allMatches.length === 0) return null;

  const minLen = allMatches[0].name.length;
  const shortest = allMatches.filter((m) => m.name.length === minLen);

  if (shortest.length === 1) {
    const winner = allMatches[0];
    if (winner.kind === "skill") return { type: "skill", name: winner.name, args: "" };
    if (winner.kind === "bundle") return { type: "bundle", name: winner.name, args: "" };
    return applyBusyPolicy(
      {
        type: commandIntentType(winner.def),
        name: winner.def.name,
        args: "",
        command: winner.def,
        alias: winner.alias,
      },
      winner.def,
      options,
    );
  }

  // Ambiguous.
  return {
    type: "invalid",
    name: query,
    reason: `Ambiguous command /${query}`,
    candidates: shortest.map((m) => m.name),
  };
}

function collectRegistryCommands(): CommandDef[] {
  return listCommands();
}

function commandIntentType(cmd: CommandDef): SlashIntent["type"] {
  if (cmd.local) return "local";
  if (cmd.execute) return "local"; // thin-slice executors run in-process
  return "backend";
}

function applyBusyPolicy(intent: SlashIntent, cmd: CommandDef, options: ResolveSlashOptions): SlashIntent {
  if (!options.isBusy) return intent;

  const policy = cmd.busyPolicy ?? "reject";
  if (policy === "reject") {
    return {
      type: "blocked",
      name: cmd.name,
      reason: `/${cmd.name} cannot be used while the agent is busy`,
    };
  }

  // dispatch / interrupt_then_dispatch: the command is recognized and bypasses
  // the message queue; the caller/runner applies cancellation when needed.
  return intent;
}
