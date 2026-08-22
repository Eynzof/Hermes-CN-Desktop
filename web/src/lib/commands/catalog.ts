import type { CommandSpec, GlobalFlag } from "./types";

type SpecInput = Omit<CommandSpec, "aliases" | "flags"> & {
  aliases?: readonly string[];
  flags?: readonly GlobalFlag[];
};

function cmd(input: SpecInput): CommandSpec {
  return {
    aliases: [],
    flags: [],
    ...input,
  };
}

/**
 * Static registry mapping the `hermes` CLI surface to the desktop equivalent.
 *
 * - `route` commands navigate to existing React routes.
 * - `hook` commands call named hooks (e.g. session create).
 * - `rpc` commands invoke Rust Tauri commands.
 * - `palette-only` entries add discoverability without a dedicated action.
 * - `thin-wrapper` commands spawn the managed `hermes` binary.
 * - `dropped` commands are terminal/Python-only and have no desktop UI value.
 */
export const CLI_COMMAND_CATALOG: readonly CommandSpec[] = [
  // Chat / one-shot
  cmd({
    name: "chat",
    aliases: ["c"],
    summary: "Start or continue an interactive chat session.",
    kind: "route",
    action: { type: "navigate", to: "/" },
    flags: ["model", "provider", "reasoning", "toolsets", "resume", "skills", "profile", "worktree", "yolo", "continue", "input"],
    desktopRelevant: true,
  }),

  // Model / provider / reasoning
  cmd({
    name: "model",
    aliases: ["models"],
    summary: "Configure providers, models, aliases and routing.",
    kind: "route",
    action: { type: "navigate", to: "/models" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "moa",
    aliases: ["council"],
    summary: "Mixture of Agents configuration.",
    kind: "route",
    action: { type: "navigate", to: "/models" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "fallback",
    summary: "Fallback provider routing.",
    kind: "route",
    action: { type: "navigate", to: "/models" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Session management
  cmd({
    name: "sessions",
    aliases: ["history", "hist"],
    summary: "List, search, rename and manage sessions.",
    kind: "route",
    action: { type: "navigate", to: "/history" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Config / env
  cmd({
    name: "config",
    summary: "View or edit Hermes configuration.",
    kind: "route",
    action: { type: "navigate", to: "/common" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "env",
    aliases: ["auth"],
    summary: "Manage API keys and environment variables.",
    kind: "route",
    action: { type: "navigate", to: "/env" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Tools / toolsets / approvals
  cmd({
    name: "tools",
    summary: "Toolsets and tool configuration.",
    kind: "route",
    action: { type: "navigate", to: "/mcp" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "mcp",
    summary: "Manage MCP servers.",
    kind: "route",
    action: { type: "navigate", to: "/mcp" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "approvals",
    aliases: ["yolo"],
    summary: "Approval mode and YOLO settings.",
    kind: "route",
    action: { type: "navigate", to: "/advanced" },
    flags: ["profile", "yolo"],
    desktopRelevant: true,
  }),

  // Memory / soul / personality
  cmd({
    name: "memory",
    summary: "Built-in memory (MEMORY.md / USER.md).",
    kind: "route",
    action: { type: "navigate", to: "/memory" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "soul",
    summary: "Personality / SOUL.md market.",
    kind: "route",
    action: { type: "navigate", to: "/soul" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Automation
  cmd({
    name: "cron",
    summary: "Scheduled tasks and cron jobs.",
    kind: "route",
    action: { type: "navigate", to: "/cron" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "kanban",
    summary: "Kanban multi-agent board.",
    kind: "route",
    action: { type: "navigate", to: "/kanban" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Projects
  cmd({
    name: "project",
    aliases: ["projects"],
    summary: "Multi-folder project workspaces.",
    kind: "route",
    action: { type: "navigate", to: "/projects" },
    flags: ["profile", "worktree"],
    desktopRelevant: true,
  }),

  // Profiles
  cmd({
    name: "profile",
    aliases: ["profiles"],
    summary: "Switch and manage isolated profiles.",
    kind: "route",
    action: { type: "navigate", to: "/profiles" },
    flags: [],
    desktopRelevant: true,
  }),

  // Logs / analytics / status
  cmd({
    name: "status",
    summary: "Dashboard and runtime status.",
    kind: "route",
    action: { type: "navigate", to: "/health" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "logs",
    summary: "View runtime logs.",
    kind: "route",
    action: { type: "navigate", to: "/logs" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "analytics",
    aliases: ["insights", "usage"],
    summary: "Token usage and model analytics.",
    kind: "route",
    action: { type: "navigate", to: "/analytics" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Backup / import / export
  cmd({
    name: "backup",
    summary: "Backup and restore profile configuration.",
    kind: "route",
    action: { type: "navigate", to: "/backup" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "import",
    summary: "Import a profile bundle.",
    kind: "route",
    action: { type: "navigate", to: "/backup" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Debugging / diagnostics
  cmd({
    name: "debug",
    summary: "Debug bundle and diagnostics.",
    kind: "route",
    action: { type: "navigate", to: "/debug" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "doctor",
    summary: "Run environment diagnostics.",
    kind: "route",
    action: { type: "navigate", to: "/debug" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "dump",
    summary: "Dump runtime state.",
    kind: "route",
    action: { type: "navigate", to: "/debug" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "prompt-size",
    aliases: ["prompt_size"],
    summary: "Inspect prompt token counts.",
    kind: "palette-only",
    action: { type: "none" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Checkpoints
  cmd({
    name: "checkpoints",
    aliases: ["rollback", "snapshot", "diff"],
    summary: "Checkpoint rollback and snapshots.",
    kind: "route",
    action: { type: "navigate", to: "/history" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Console / TUI
  cmd({
    name: "console",
    summary: "Hermes Console terminal.",
    kind: "route",
    action: { type: "navigate", to: "/console" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Skills / plugins / bundles
  cmd({
    name: "skills",
    summary: "Skill registry and hub.",
    kind: "route",
    action: { type: "navigate", to: "/skills" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "bundles",
    summary: "Skill bundles.",
    kind: "route",
    action: { type: "navigate", to: "/skills" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "plugins",
    summary: "Plugin management.",
    kind: "route",
    action: { type: "navigate", to: "/skills" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Update / version / install-level (thin wrapper)
  cmd({
    name: "update",
    summary: "Update the Hermes runtime.",
    kind: "thin-wrapper",
    action: { type: "thin-wrapper", argv: ["update"] },
    flags: [],
    desktopRelevant: true,
  }),
  cmd({
    name: "uninstall",
    summary: "Uninstall the Hermes runtime.",
    kind: "thin-wrapper",
    action: { type: "thin-wrapper", argv: ["uninstall"] },
    flags: [],
    desktopRelevant: true,
  }),
  cmd({
    name: "version",
    summary: "Show Hermes version.",
    kind: "thin-wrapper",
    action: { type: "thin-wrapper", argv: ["version"] },
    flags: [],
    desktopRelevant: true,
  }),
  cmd({
    name: "completion",
    summary: "Generate shell completion scripts.",
    kind: "thin-wrapper",
    action: { type: "thin-wrapper", argv: ["completion"] },
    flags: [],
    desktopRelevant: true,
  }),

  // Gateway / dashboard / headless backend
  cmd({
    name: "dashboard",
    summary: "Launch the managed dashboard.",
    kind: "rpc",
    action: { type: "rpc", cmd: "managed_runtime_start" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "serve",
    summary: "Headless JSON-RPC backend.",
    kind: "rpc",
    action: { type: "rpc", cmd: "managed_runtime_start" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "gateway",
    summary: "Gateway lifecycle.",
    kind: "rpc",
    action: { type: "rpc", cmd: "refresh_gateway_url" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Messaging adapters — backend-only / no desktop UI value
  cmd({
    name: "whatsapp",
    cliPath: ["whatsapp"],
    summary: "WhatsApp messaging bridge.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "whatsapp-cloud",
    cliPath: ["whatsapp-cloud"],
    summary: "WhatsApp Cloud messaging bridge.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "slack",
    cliPath: ["slack"],
    summary: "Slack messaging bridge.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "send",
    cliPath: ["send"],
    summary: "Send a one-off message.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "pairing",
    cliPath: ["pairing"],
    summary: "Pairing flow.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),

  // Networking / egress / proxy
  cmd({
    name: "proxy",
    aliases: ["egress"],
    cliPath: ["proxy"],
    summary: "Egress proxy / TLS intercept.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),

  // Security / curator / journey / pets / lsp / portal / claw
  cmd({
    name: "security",
    cliPath: ["security"],
    summary: "Security audit.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "curator",
    cliPath: ["curator"],
    summary: "Background skill curator.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "journey",
    aliases: ["learning", "memory-graph"],
    cliPath: ["journey"],
    summary: "Learning journey and memory graph.",
    kind: "route",
    action: { type: "navigate", to: "/memory" },
    flags: ["profile"],
    desktopRelevant: true,
  }),
  cmd({
    name: "pets",
    cliPath: ["pets"],
    summary: "Pet / mascot manager.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "lsp",
    cliPath: ["lsp"],
    summary: "LSP diagnostics.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "portal",
    cliPath: ["portal"],
    summary: "Nous Tool Gateway portal.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),
  cmd({
    name: "claw",
    cliPath: ["claw"],
    summary: "Claw integration.",
    kind: "dropped",
    action: { type: "none" },
    flags: [],
    desktopRelevant: false,
  }),

  // Setup / onboarding
  cmd({
    name: "setup",
    summary: "First-run setup and environment check.",
    kind: "route",
    action: { type: "navigate", to: "/environment" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Webhooks / channels / messaging pages
  cmd({
    name: "webhook",
    aliases: ["webhooks"],
    summary: "Webhook subscriptions.",
    kind: "route",
    action: { type: "navigate", to: "/im-onboarding" },
    flags: ["profile"],
    desktopRelevant: true,
  }),

  // Hidden / meta
  cmd({
    name: "gui",
    aliases: ["desktop"],
    summary: "Open the desktop app.",
    kind: "route",
    action: { type: "navigate", to: "/" },
    flags: [],
    desktopRelevant: true,
  }),
];

export const CLI_COMMAND_MAP: ReadonlyMap<string, CommandSpec> = buildCommandMap(CLI_COMMAND_CATALOG);

function buildCommandMap(catalog: readonly CommandSpec[]): Map<string, CommandSpec> {
  const map = new Map<string, CommandSpec>();
  for (const spec of catalog) {
    map.set(spec.name, spec);
    for (const alias of spec.aliases) {
      if (!map.has(alias)) {
        map.set(alias, spec);
      }
    }
  }
  return map;
}

/** Resolve a command name (or alias) to its canonical spec. */
export function resolveCliCommand(name: string): CommandSpec | null {
  return CLI_COMMAND_MAP.get(name.toLowerCase().trim()) ?? null;
}

/** All commands that are exposed to the desktop UI in some form. */
export function desktopRelevantCommands(): readonly CommandSpec[] {
  return CLI_COMMAND_CATALOG.filter((c) => c.desktopRelevant);
}

/** All dropped / terminal-only command names (for parity documentation). */
export function droppedCommandNames(): readonly string[] {
  return CLI_COMMAND_CATALOG.filter((c) => c.kind === "dropped").map((c) => c.name);
}
