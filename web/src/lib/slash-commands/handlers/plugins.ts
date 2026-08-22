/**
 * Local `/plugins` slash-command handler.
 *
 * Lists, enables, disables, and reloads plugins from the in-process registry.
 * This replaces the legacy Python-dashboard `/api/plugins*` route with a small,
 * safe surface built on `@hermes/agent-core`.
 */

import type { PluginRegistry, PluginSummary } from "@hermes/agent-core";
import type { CommandResult } from "../types";

export interface PluginsHandlerContext {
  /** In-process plugin registry. */
  registry: PluginRegistry;
  /** Optional navigation callback to open the Plugins page. */
  navigate?: (to: string) => void;
}

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

function parseArgs(raw: string): { subcommand: string; rest: string; tokens: string[] } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0]?.toLowerCase() ?? "";
  const rest = tokens.slice(1).join(" ");
  return { subcommand, rest, tokens };
}

function formatPluginList(summaries: PluginSummary[]): string {
  if (summaries.length === 0) {
    return "No plugins registered.";
  }

  const lines = ["**Plugins**", ""];
  for (const plugin of summaries) {
    const state = plugin.enabled ? "enabled" : "disabled";
    const badge = plugin.state === "error" ? " [error]" : "";
    lines.push(
      `- **${plugin.name}** (${plugin.kind}) — ${state}${badge}${plugin.version ? ` · v${plugin.version}` : ""}`,
    );
    if (plugin.description) {
      lines.push(`  ${plugin.description}`);
    }
  }
  return lines.join("\n");
}

function formatEnabledList(summaries: PluginSummary[]): string {
  const enabled = summaries.filter((p) => p.enabled);
  if (enabled.length === 0) return "No plugins are enabled.";
  return ["**Enabled plugins**", "", ...enabled.map((p) => `- ${p.name} (${p.kind})`)].join("\n");
}

/**
 * Handle `/plugins [list|status|enable <id>|disable <id>|reload <id>]`.
 */
export function handlePlugins(args: string, ctx: PluginsHandlerContext): CommandResult {
  const { subcommand, rest, tokens } = parseArgs(args);

  if (subcommand === "" || subcommand === "list") {
    return ok(formatPluginList(ctx.registry.summaries()));
  }

  if (subcommand === "status") {
    const summary = ctx.registry.summaries();
    return ok(
      `Registered plugins: ${summary.length}\nEnabled: ${summary.filter((p) => p.enabled).length}`,
    );
  }

  if (subcommand === "enabled" || subcommand === "on") {
    return ok(formatEnabledList(ctx.registry.summaries()));
  }

  if (subcommand === "enable") {
    const target = tokens[1]?.trim();
    if (!target) return err("Usage: /plugins enable <id>");
    const result = ctx.registry.enable(target);
    if (!result) return err(`Plugin not found: ${target}`);
    return ok(`Enabled plugin: ${result.manifest.name}`);
  }

  if (subcommand === "disable") {
    const target = tokens[1]?.trim();
    if (!target) return err("Usage: /plugins disable <id>");
    const result = ctx.registry.disable(target);
    if (!result) return err(`Plugin not found: ${target}`);
    return ok(`Disabled plugin: ${result.manifest.name}`);
  }

  if (subcommand === "reload") {
    const target = tokens[1]?.trim();
    if (!target) return err("Usage: /plugins reload <id>");
    const existing = ctx.registry.get(target);
    if (!existing) return err(`Plugin not found: ${target}`);
    const reloaded = ctx.registry.reload(target, existing.manifest);
    if (!reloaded) return err(`Failed to reload plugin: ${target}`);
    return ok(`Reloaded plugin: ${reloaded.manifest.name}`);
  }

  if (subcommand === "open" || subcommand === "ui") {
    ctx.navigate?.("plugins");
    return ok("Opening plugins page…", { target: "plugins" });
  }

  if (subcommand === "help") {
    return ok(
      [
        "**Plugins commands**",
        "",
        "- /plugins list",
        "- /plugins status",
        "- /plugins enable <id>",
        "- /plugins disable <id>",
        "- /plugins reload <id>",
        "- /plugins open",
      ].join("\n"),
    );
  }

  return err(
    `Unknown /plugins subcommand: ${subcommand}. Try: list, status, enable, disable, reload, open, help.`,
  );
}

/** `/plugins` argument parser exposed for tests. */
export { parseArgs };
