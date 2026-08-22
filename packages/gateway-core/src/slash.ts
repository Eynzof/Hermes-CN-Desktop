/**
 * Slash-command registry and dispatcher parity with Python gateway/slash_*.py.
 *
 * v1 registers the most common gateway slash commands and performs admin/user
 * tier checking before dispatch.
 */

export type SlashHandler = (ctx: SlashContext) => Promise<string>;

export interface SlashContext {
  platform: string;
  chatId: string;
  userId: string;
  command: string;
  args: string;
  isAdmin: boolean;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  adminOnly?: boolean;
  description: string;
  handler: SlashHandler;
}

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    description: "Start a new session.",
    handler: async () => "Started a new session.",
  },
  {
    name: "reset",
    description: "Reset the current session.",
    handler: async () => "Session reset.",
  },
  {
    name: "status",
    description: "Show runtime status.",
    handler: async (ctx) => `Status for ${ctx.platform}: ok`,
  },
  {
    name: "whoami",
    description: "Show user identity.",
    handler: async (ctx) => `You are ${ctx.userId} on ${ctx.platform}.`,
  },
  {
    name: "stop",
    description: "Stop the current turn.",
    handler: async () => "Stopped.",
  },
  {
    name: "help",
    description: "List available commands.",
    handler: async () => "Available: /new /reset /status /whoami /stop /help",
  },
  {
    name: "approve",
    adminOnly: true,
    description: "Approve a pending request.",
    handler: async () => "Approved.",
  },
  {
    name: "deny",
    adminOnly: true,
    description: "Deny a pending request.",
    handler: async () => "Denied.",
  },
];

export class SlashDispatcher {
  private commands = new Map<string, SlashCommand>();

  constructor(commands: SlashCommand[] = DEFAULT_SLASH_COMMANDS) {
    for (const cmd of commands) {
      this.register(cmd);
    }
  }

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.commands.set(alias, cmd);
    }
  }

  dispatch(ctx: SlashContext): Promise<string> {
    const cmd = this.commands.get(ctx.command);
    if (!cmd) return Promise.resolve(`Unknown command: /${ctx.command}`);
    if (cmd.adminOnly && !ctx.isAdmin) return Promise.resolve("Admin only.");
    return cmd.handler(ctx);
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }
}
