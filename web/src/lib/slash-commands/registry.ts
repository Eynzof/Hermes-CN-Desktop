import type {
  BusyHandlerKey,
  BusyPolicy,
  CommandCategory,
  CommandDef,
  ExecutorKey,
  LocalHandlerKey,
} from "./types";

export type {
  BusyHandlerKey,
  BusyPolicy,
  CommandCategory,
  CommandDef,
  ExecutorKey,
  LocalHandlerKey,
} from "./types";

/**
 * Central slash-command registry.
 *
 * Hand-ported from `hermes_cli/commands.py` `COMMAND_REGISTRY`, filtered to
 * desktop-relevant commands. `gatewayOnly` commands are hidden on desktop;
 * `cliOnly` commands are hidden from the composer palette but kept in the
 * registry for CLI parity. Commands that have not yet been migrated to local
 * desktop handlers carry a `backendUntil` feature-plan slug and fall back to
 * the frozen WS `command.dispatch` RPC.
 */
export const COMMAND_REGISTRY: readonly CommandDef[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Session / lifecycle
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "new",
    description: "Start a fresh session",
    category: "Session",
    aliases: ["reset"],
    argsHint: "[name] [now]",
    busyPolicy: "interrupt_then_dispatch",
    busyHandler: "new",
    local: "new",
  },
  {
    name: "clear",
    description: "Clear the current view and start a new session",
    category: "Session",
    busyPolicy: "dispatch",
    local: "clear",
    cliOnly: true,
  },
  {
    name: "history",
    description: "Show the current session transcript",
    category: "Session",
    busyPolicy: "dispatch",
    local: "history",
    cliOnly: true,
  },
  {
    name: "save",
    description: "Export the current conversation",
    category: "Session",
    argsHint: "[format]",
    busyPolicy: "dispatch",
    local: "save",
    cliOnly: true,
  },
  {
    name: "resume",
    description: "Resume a previous session",
    category: "Session",
    argsHint: "<number|title|id>",
    busyPolicy: "interrupt_then_dispatch",
    local: "resume",
  },
  {
    name: "sessions",
    description: "List sessions or switch to one",
    category: "Session",
    argsHint: "[target]",
    aliases: ["switch"],
    busyPolicy: "dispatch",
    local: "sessions",
  },
  {
    name: "title",
    description: "Rename the current session",
    category: "Session",
    argsHint: "[name]",
    busyPolicy: "dispatch",
    local: "title",
  },
  {
    name: "branch",
    description: "Fork the current session into a new branch",
    category: "Session",
    argsHint: "[name]",
    aliases: ["fork"],
    busyPolicy: "dispatch",
    local: "branch",
  },
  {
    name: "retry",
    description: "Resend the last user message",
    category: "Session",
    busyPolicy: "dispatch",
    local: "retry",
  },
  {
    name: "undo",
    description: "Remove the last N exchanges",
    category: "Session",
    argsHint: "[N]",
    busyPolicy: "dispatch",
    local: "undo",
  },
  {
    name: "stop",
    description: "Cancel the running turn and background tasks",
    category: "Session",
    busyPolicy: "dispatch",
    busyHandler: "stop",
    local: "stop",
  },
  {
    name: "queue",
    description: "Queue a prompt to run when the agent is free",
    category: "Session",
    argsHint: "<prompt>",
    aliases: ["q"],
    busyPolicy: "dispatch",
    busyHandler: "queue",
    local: "queue",
  },
  {
    name: "steer",
    description: "Inject instructions after the next tool call",
    category: "Session",
    argsHint: "<prompt>",
    busyPolicy: "dispatch",
    busyHandler: "steer",
    local: "steer",
  },
  {
    name: "background",
    description: "Run a prompt in a detached background session",
    category: "Session",
    argsHint: "<prompt>",
    aliases: ["bg", "btw"],
    busyPolicy: "dispatch",
    local: "background",
  },
  {
    name: "handoff",
    description: "Re-bind the session to a messaging platform",
    category: "Session",
    argsHint: "<platform>",
    busyPolicy: "dispatch",
    cliOnly: true,
  },
  {
    name: "compress",
    description: "Compress the current session context",
    category: "Session",
    argsHint: "[here N|topic]",
    aliases: ["compact"],
    busyPolicy: "reject",
    local: "compress",
    backendUntil: "context-compression-prompt-caching",
  },
  {
    name: "heartbeat",
    description: "Set a session-scoped recurring prompt",
    category: "Session",
    argsHint: "<interval> <prompt>|off",
    busyPolicy: "dispatch",
    local: "heartbeat",
    backendUntil: "session-heartbeat",
  },
  {
    name: "rollback",
    description: "List checkpoints or roll back to a checkpoint",
    category: "Session",
    argsHint: "[checkpointId]",
    busyPolicy: "reject",
    local: "rollback",
    backendUntil: "checkpoints-rollback",
  },
  {
    name: "snapshot",
    description: "Create a named session snapshot",
    category: "Session",
    argsHint: "[label]",
    busyPolicy: "reject",
    local: "snapshot",
    backendUntil: "checkpoints-rollback",
  },
  {
    name: "diff",
    description: "Show current or checkpoint diff",
    category: "Session",
    argsHint: "[checkpointId]",
    busyPolicy: "reject",
    local: "diff",
    backendUntil: "checkpoints-rollback",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Configuration
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "model",
    description: "Switch the active model (per-session, global, or once)",
    category: "Configuration",
    argsHint: "<model> [--global|--session|--once] [--provider <p>]",
    busyPolicy: "reject",
    busyHandler: "none",
    local: "model",
    backendUntil: "model-switching",
  },
  {
    name: "personality",
    description: "Apply or manage a personality overlay",
    category: "Configuration",
    argsHint: "[name] [--list]",
    busyPolicy: "reject",
    local: "personality",
    backendUntil: "personality-soul",
  },
  {
    name: "skin",
    description: "Apply or list UI skin presets",
    category: "Configuration",
    argsHint: "[name] [--list]",
    busyPolicy: "reject",
    local: "skin",
    backendUntil: "skins-themes",
  },
  {
    name: "yolo",
    description: "Toggle YOLO approval-less execution mode",
    category: "Configuration",
    argsHint: "[on|off]",
    busyPolicy: "dispatch",
    local: "yolo",
  },
  {
    name: "approvals",
    description: "Show or configure approval settings",
    category: "Configuration",
    argsHint: "[manual|smart|off]",
    busyPolicy: "dispatch",
    local: "approvals",
  },
  {
    name: "reasoning",
    description: "Set reasoning effort and display for the session",
    category: "Configuration",
    argsHint: "[level|show|hide|full|clamp] [--global]",
    busyPolicy: "dispatch",
    local: "reasoning",
  },
  {
    name: "fast",
    description: "Toggle fast mode (priority service tier)",
    category: "Configuration",
    argsHint: "[on|off|normal] [--global]",
    busyPolicy: "dispatch",
    local: "fast",
  },
  {
    name: "profile",
    description: "Show or switch the active Hermes profile",
    category: "Configuration",
    argsHint: "[profile-name]",
    aliases: ["profiles"],
    busyPolicy: "dispatch",
    execute: "profile",
  },
  {
    name: "verbose",
    description: "Toggle verbose tool output",
    category: "Configuration",
    argsHint: "[on|off]",
    busyPolicy: "dispatch",
    cliOnly: true,
  },
  {
    name: "focus",
    description: "Focus on a specific tool or skill for the next turn",
    category: "Configuration",
    argsHint: "<target>|off",
    busyPolicy: "dispatch",
    cliOnly: true,
  },
  {
    name: "footer",
    description: "Show or hide the command footer",
    category: "Configuration",
    argsHint: "[on|off]",
    busyPolicy: "dispatch",
    cliOnly: true,
  },
  {
    name: "busy",
    description: "Configure busy input mode",
    category: "Configuration",
    argsHint: "[queue|steer|interrupt|status]",
    busyPolicy: "dispatch",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Tools & Skills
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "skills",
    description: "Search, install, or manage skills",
    category: "Tools & Skills",
    argsHint: "[search|install|uninstall|list|status|hub|bundle] [query]",
    subcommands: ["search", "install", "uninstall", "list", "status", "hub", "bundle"],
    busyPolicy: "dispatch",
    local: "skills",
  },
  {
    name: "skill",
    description: "Load or manage an active skill",
    category: "Tools & Skills",
    argsHint: "<name>|enable|disable|stack|unstack",
    subcommands: ["enable", "disable", "stack", "unstack"],
    busyPolicy: "dispatch",
    local: "skill",
  },
  {
    name: "refine",
    description: "Run a self-improvement review on recent turns",
    category: "Tools & Skills",
    argsHint: "[focus]",
    busyPolicy: "dispatch",
    local: "refine",
    backendUntil: "self-improvement-loop",
  },
  {
    name: "learn",
    description: "Turn a request into a SKILL.md authoring prompt",
    category: "Tools & Skills",
    argsHint: "<what>",
    busyPolicy: "dispatch",
    local: "learn",
    backendUntil: "self-improvement-loop",
  },
  {
    name: "pet",
    description: "Toggle the desktop pet mascot",
    category: "Tools & Skills",
    busyPolicy: "dispatch",
    local: "pet",
    backendUntil: "pets-petdex",
  },
  {
    name: "hatch",
    description: "Generate and adopt a new pet",
    category: "Tools & Skills",
    argsHint: "[concept]",
    aliases: ["generate-pet"],
    busyPolicy: "dispatch",
    local: "hatch",
    backendUntil: "pets-petdex",
  },
  {
    name: "plugins",
    description: "List or manage plugins",
    category: "Tools & Skills",
    argsHint: "[list|status|enable <id>|disable <id>|reload <id>|open|help]",
    subcommands: ["list", "status", "enable", "disable", "reload", "open", "help"],
    busyPolicy: "dispatch",
    local: "plugins",
    cliOnly: true,
    backendUntil: "plugins",
  },
  {
    name: "reload-mcp",
    description: "Reload MCP servers from config",
    category: "Tools & Skills",
    argsHint: "[server-name]",
    busyPolicy: "dispatch",
    backendUntil: "mcp",
  },
  {
    name: "tools",
    description: "List available tools grouped by category",
    category: "Tools & Skills",
    argsHint: "[category <name>]",
    subcommands: ["category"],
    busyPolicy: "dispatch",
    local: "tools",
  },
  {
    name: "toolsets",
    description: "Show configured toolsets",
    category: "Tools & Skills",
    argsHint: "[list|enable|disable]",
    busyPolicy: "dispatch",
    cliOnly: true,
  },
  {
    name: "cron",
    description: "List or manage cron jobs",
    category: "Tools & Skills",
    argsHint: "[list|add|remove]",
    subcommands: ["list", "add", "remove"],
    busyPolicy: "dispatch",
    cliOnly: true,
    local: "cron",
    backendUntil: "cron-scheduled-tasks",
  },
  {
    name: "browser",
    description: "Control a browser automation session",
    category: "Tools & Skills",
    argsHint: "<url>|close|status",
    busyPolicy: "dispatch",
    cliOnly: true,
    backendUntil: "browser-automation",
  },
  {
    name: "terminal",
    description: "Open or send input to a persistent terminal",
    category: "Tools & Skills",
    argsHint: "[command]",
    busyPolicy: "dispatch",
    cliOnly: true,
    backendUntil: "terminal-backends",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Agent orchestration (Session category in Core, grouped here)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "goal",
    description: "Set or manage a persistent goal loop",
    category: "Session",
    argsHint: "<goal>|off|status",
    busyPolicy: "dispatch",
    busyHandler: "none",
    local: "goal",
    backendUntil: "goals-ralph-loop",
  },
  {
    name: "subgoal",
    description: "Add a sub-goal to the active goal",
    category: "Session",
    argsHint: "<sub-goal>",
    busyPolicy: "dispatch",
    local: "subgoal",
    backendUntil: "goals-ralph-loop",
  },
  {
    name: "moa",
    description: "Run a one-shot mixture-of-agents ensemble",
    category: "Session",
    argsHint: "<prompt>",
    busyPolicy: "reject",
    local: "moa",
    backendUntil: "mixture-of-agents",
  },
  {
    name: "council",
    description: "Run a one-shot model council",
    category: "Session",
    argsHint: "<prompt>",
    busyPolicy: "reject",
    local: "council",
    backendUntil: "mixture-of-agents",
  },
  {
    name: "delegate",
    description: "Delegate a task to a subagent",
    category: "Session",
    argsHint: "<agent> <task>",
    busyPolicy: "dispatch",
    local: "delegate",
    backendUntil: "subagent-delegation",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Info / status
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "version",
    description: "Show Hermes desktop and backend version information",
    category: "Info",
    busyPolicy: "dispatch",
    execute: "version",
  },
  {
    name: "egress",
    description: "Show Docker egress proxy status",
    category: "Info",
    argsHint: "[status|restart|stop]",
    busyPolicy: "dispatch",
    execute: "egress",
    backendUntil: "egress-proxy-secrets-import",
  },
  {
    name: "help",
    description: "Show help for slash commands",
    category: "Info",
    argsHint: "[command]",
    busyPolicy: "dispatch",
    execute: "gateway_help",
  },
  {
    name: "commands",
    description: "List available slash commands",
    category: "Info",
    busyPolicy: "dispatch",
    execute: "gateway_commands",
  },
  {
    name: "context",
    description: "Show the current context window breakdown",
    category: "Info",
    argsHint: "[all]",
    aliases: ["ctx"],
    busyPolicy: "dispatch",
    local: "context",
  },
  {
    name: "status",
    description: "Show runtime status summary",
    category: "Info",
    busyPolicy: "dispatch",
    local: "status",
  },
  {
    name: "usage",
    description: "Show session usage and cost statistics",
    category: "Info",
    argsHint: "[session]",
    busyPolicy: "dispatch",
    local: "usage",
  },
  {
    name: "insights",
    description: "Show analytics and insight cards",
    category: "Info",
    argsHint: "[topic]",
    busyPolicy: "dispatch",
    local: "insights",
  },
  {
    name: "journey",
    description: "Show your learning journey and due reviews",
    category: "Info",
    argsHint: "[graph]",
    aliases: ["learning"],
    busyPolicy: "dispatch",
    local: "journey",
    backendUntil: "learning-journey",
  },
  {
    name: "memory-graph",
    description: "Show the memory graph built from sessions and memories",
    category: "Info",
    busyPolicy: "dispatch",
    local: "memory-graph",
    backendUntil: "learning-journey",
  },
  {
    name: "memory",
    description: "Manage memory write approvals and pending writes",
    category: "Configuration",
    argsHint: "pending|approve <id>|all|reject <id>|all|approval on|off",
    subcommands: ["pending", "approve", "reject", "approval"],
    busyPolicy: "dispatch",
    local: "memory",
    backendUntil: "built-in-bounded-memory",
  },
  {
    name: "suggestions",
    description: "Generate automation suggestions",
    category: "Info",
    argsHint: "[topic]",
    busyPolicy: "dispatch",
    local: "suggestions",
    backendUntil: "automation-helpers",
  },
  {
    name: "blueprint",
    description: "Create or inspect an automation blueprint",
    category: "Info",
    argsHint: "[name]",
    busyPolicy: "dispatch",
    local: "blueprint",
    backendUntil: "automation-helpers",
  },
  {
    name: "curator",
    description: "Inspect or trigger the background curator",
    category: "Info",
    argsHint: "[status|run]",
    busyPolicy: "dispatch",
    local: "curator",
    backendUntil: "curator",
  },
  {
    name: "kanban",
    description: "Show the multi-agent kanban board",
    category: "Info",
    argsHint: "[board]",
    busyPolicy: "dispatch",
    local: "kanban",
    backendUntil: "kanban-multi-agent-board",
  },
  {
    name: "whoami",
    description: "Show current user and platform information",
    category: "Info",
    busyPolicy: "dispatch",
  },
  {
    name: "config",
    description: "Show or edit configuration keys",
    category: "Info",
    argsHint: "[key] [value]",
    busyPolicy: "dispatch",
    cliOnly: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Input / media (CLI-only until their feature plans land)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "paste",
    description: "Paste clipboard content into the session",
    category: "Info",
    argsHint: "[image|text]",
    busyPolicy: "dispatch",
    cliOnly: true,
    backendUntil: "vision-image-paste",
  },
  {
    name: "voice",
    description: "Record and transcribe voice input",
    category: "Info",
    busyPolicy: "dispatch",
    cliOnly: true,
    backendUntil: "voice-mode",
  },
  {
    name: "wake",
    description: "Configure or test the wake word",
    category: "Configuration",
    argsHint: "[on|off|test]",
    busyPolicy: "dispatch",
    cliOnly: true,
    backendUntil: "wake-word",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Gateway-only (messaging surface) — hidden on desktop but kept for parity
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "kick",
    description: "Restart the gateway worker thread",
    category: "Configuration",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "platforms",
    description: "List configured messaging platforms",
    category: "Configuration",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "platform",
    description: "Configure a messaging platform",
    category: "Configuration",
    argsHint: "<platform> [action]",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "copy",
    description: "Copy the last assistant message to clipboard",
    category: "Info",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "image",
    description: "Generate or describe an image",
    category: "Info",
    argsHint: "<prompt>",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "debug",
    description: "Dump gateway debug information",
    category: "Info",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "export",
    description: "Export session data",
    category: "Session",
    argsHint: "[format]",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },
  {
    name: "import",
    description: "Import session data",
    category: "Session",
    argsHint: "<path>",
    busyPolicy: "dispatch",
    gatewayOnly: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Exit
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "quit",
    description: "Exit the application",
    category: "Exit",
    aliases: ["exit"],
    busyPolicy: "dispatch",
    cliOnly: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived lookups (rebuilt at module load)
// ─────────────────────────────────────────────────────────────────────────────

const _COMMAND_LOOKUP = new Map<string, CommandDef>();
const _SUBCOMMANDS = new Map<string, Set<string>>();

function _extractPipeHints(argsHint: string): string[] {
  // Normalize bracket wrappers so "[queue|steer|interrupt|status]" splits into
  // the four subcommand words.
  const normalized = argsHint.replace(/[()\[\]]/g, " ");
  return normalized
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("<") && !s.includes(" "));
}

function _registerCommand(cmd: CommandDef): void {
  const key = cmd.name.toLowerCase();
  _COMMAND_LOOKUP.set(key, cmd);
  for (const alias of cmd.aliases ?? []) {
    _COMMAND_LOOKUP.set(alias.toLowerCase(), cmd);
  }

  const subs = new Set(cmd.subcommands ?? []);
  if (cmd.argsHint) {
    for (const sub of _extractPipeHints(cmd.argsHint)) {
      subs.add(sub);
    }
  }
  if (subs.size > 0) {
    _SUBCOMMANDS.set(key, subs);
  }
}

for (const cmd of COMMAND_REGISTRY) {
  _registerCommand(cmd);
}

/** Resolve a command by canonical name or alias (case-insensitive, strips `/`). */
export function resolveCommand(name: string): CommandDef | undefined {
  const cleaned = name.trim().toLowerCase().replace(/^\/+/, "");
  return _COMMAND_LOOKUP.get(cleaned);
}

/** Resolve a canonical name from an alias, returning the input when it is already canonical. */
export function resolveAlias(name: string): string | undefined {
  const def = resolveCommand(name);
  return def?.name;
}

/** Return all registered commands. */
export function listCommands(): CommandDef[] {
  return COMMAND_REGISTRY.slice();
}

/** Return all canonical names and aliases suitable for prefix matching. */
export function commandNames(): string[] {
  return COMMAND_REGISTRY.flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]);
}

/** Subcommands per canonical command name. */
export function getSubcommands(name: string): readonly string[] | undefined {
  const subs = _SUBCOMMANDS.get(name.toLowerCase());
  return subs ? Array.from(subs) : undefined;
}

/** All extracted subcommands across the registry. */
export function allSubcommands(): string[] {
  const all = new Set<string>();
  for (const subs of _SUBCOMMANDS.values()) {
    for (const sub of subs) all.add(sub);
  }
  return Array.from(all);
}

/**
 * Build gateway-style help lines for `command.dispatch` `gateway_help` parity.
 *
 * Hidden commands (`gatewayOnly`, `cliOnly`) are omitted from the default
 * desktop help surface.
 */
export function gatewayHelpLines(
  options: { includeHidden?: boolean } = {},
): Array<{ name: string; description: string; category: string }> {
  return COMMAND_REGISTRY
    .filter((cmd) => options.includeHidden || (!cmd.gatewayOnly && !cmd.cliOnly))
    .map((cmd) => ({
      name: `/${cmd.name}`,
      description: cmd.description,
      category: cmd.category,
    }));
}

/** Categories in registry order, de-duplicated. */
export function commandCategories(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cmd of COMMAND_REGISTRY) {
    if (!seen.has(cmd.category)) {
      seen.add(cmd.category);
      out.push(cmd.category);
    }
  }
  return out;
}

/** True if the command is visible on the desktop composer/palette surface. */
export function isDesktopVisible(cmd: CommandDef): boolean {
  return !cmd.gatewayOnly && !cmd.cliOnly;
}
