/**
 * Thin-slice executors ported from `hermes_cli/slash_exec.EXECUTORS`.
 *
 * Invariant (tested): output depends only on `args`/`options`, never on the
 * UI surface. These emit plain canonical text; the desktop composer renders
 * markdown when appropriate.
 */

export interface ExecutorContext {
  args: string;
  /** Parsed option flags if the executor supports them. */
  options?: Record<string, string | boolean | undefined>;
  /** Read a config key. */
  configGet?: (key: string) => string | undefined;
  /** Runtime status snapshot for /egress and /status. */
  status?: { gateway_running?: boolean; active_sessions?: number };
  /** Build/version snapshot for /version. */
  buildInfo?: {
    version?: string;
    commit?: string;
    backendVersion?: string;
    releaseDate?: string;
  };
  /** Active profile name for /profile. */
  activeProfile?: string;
  /** Available profile names for /profile. */
  profiles?: string[];
  /** Bundle keys for /bundles. */
  bundles?: string[];
  /** Full command registry metadata for /commands. */
  commands?: Array<{
    name: string;
    description: string;
    category: string;
    argsHint?: string;
  }>;
}

export interface ExecutorReply {
  text: string;
  format: "plain" | "markdown";
  data?: unknown;
}

export type Executor = (ctx: ExecutorContext) => ExecutorReply;

function markdown(text: string, data?: unknown): ExecutorReply {
  return { text, format: "markdown", data };
}

function plain(text: string, data?: unknown): ExecutorReply {
  return { text, format: "plain", data };
}

export const EXECUTORS: Record<
  "version" | "egress" | "profile" | "bundles" | "gateway_help" | "gateway_commands",
  Executor
> = {
  version(ctx) {
    const { version = "unknown", commit = "unknown", backendVersion = "unknown" } = ctx.buildInfo ?? {};
    return plain(
      [
        `Desktop version: ${version}`,
        `Desktop commit: ${commit}`,
        `Backend version: ${backendVersion}`,
      ].join("\n"),
      { version, commit, backendVersion },
    );
  },

  egress(ctx) {
    const { gateway_running = false, active_sessions = 0 } = ctx.status ?? {};
    const text = gateway_running
      ? `Egress proxy active (${active_sessions} active session(s)).`
      : "Egress proxy is not running.";
    return plain(text, { gateway_running, active_sessions });
  },

  profile(ctx) {
    const args = ctx.args.trim();
    const { activeProfile = "default", profiles = [] } = ctx;
    if (!args) {
      const list = profiles.length ? profiles.map((p) => (p === activeProfile ? `* ${p}` : `  ${p}`)).join("\n") : "  default";
      return plain(`Active profile: ${activeProfile}\nAvailable profiles:\n${list}`, {
        activeProfile,
        profiles,
      });
    }
    const target = args.toLowerCase();
    const exists = profiles.some((p) => p.toLowerCase() === target);
    if (!exists) {
      return plain(`Unknown profile: ${args}`, { error: "unknown_profile" });
    }
    return plain(`Switched to profile: ${args}`, { activeProfile: args });
  },

  bundles(ctx) {
    const bundles = ctx.bundles ?? [];
    if (bundles.length === 0) {
      return plain("No skill bundles installed.");
    }
    return plain(
      `Installed bundles:\n${bundles.map((b) => `- ${b}`).join("\n")}`,
      { bundles },
    );
  },

  gateway_help(ctx) {
    const args = ctx.args.trim().toLowerCase();
    const commands = ctx.commands ?? [];
    if (!args) {
      const lines = commands
        .filter((c) => !c.category.toLowerCase().includes("exit"))
        .map((c) => `/${c.name}${c.argsHint ? ` ${c.argsHint}` : ""} — ${c.description}`);
      return markdown(["**Available slash commands**", "", ...lines].join("\n"));
    }
    const match = commands.find((c) => c.name.toLowerCase() === args);
    if (!match) {
      return plain(`No help found for /${args}`);
    }
    return markdown(
      `**/${match.name}**${match.argsHint ? ` ${match.argsHint}` : ""}\n\n${match.description}`,
    );
  },

  gateway_commands(ctx) {
    const commands = ctx.commands ?? [];
    const categories = new Map<string, string[]>();
    for (const cmd of commands) {
      const list = categories.get(cmd.category) ?? [];
      list.push(`/${cmd.name}`);
      categories.set(cmd.category, list);
    }
    const lines: string[] = [];
    for (const [category, names] of categories) {
      lines.push(`**${category}**`, names.join(", "), "");
    }
    return markdown(lines.join("\n").trim(), { commands });
  },
};

export function runExecutor(key: keyof typeof EXECUTORS, ctx: ExecutorContext): ExecutorReply {
  return EXECUTORS[key](ctx);
}
