/**
 * `/skills` and `/skill <name>` slash-command handlers.
 *
 * Progressive disclosure: `/skills` lists skills at L0, `/skill <name>` loads a
 * skill to L1 and shows its content + linked files.
 */

import {
  buildBundleInvocationMessage,
  resolveBundle,
  type SkillRegistry,
  type SkillHubEntry,
} from "@hermes/agent-core";
import type { CommandResult } from "../types";

export interface SkillsHandlerContext {
  /** In-process skill registry. */
  registry: SkillRegistry;
  /** Optional navigation callback to open the Skills page. */
  navigate?: (to: string) => void;
  /** Install a skill from the hub (identifier or URL). */
  installSkill?: (identifier: string) => Promise<{ ok: boolean; message?: string }>;
  /** Uninstall a hub-installed skill by local name. */
  uninstallSkill?: (name: string) => Promise<{ ok: boolean; message?: string }>;
  /** Search the skills hub. */
  searchHub?: (query: string) => Promise<SkillHubEntry[]>;
}

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

/** `/skills [list|search <query>|install <identifier>|uninstall <name>|hub|bundle <name>|status]` */
export async function handleSkills(
  args: string,
  ctx: SkillsHandlerContext,
): Promise<CommandResult> {
  const trimmed = args.trim();
  const lowered = trimmed.toLowerCase();
  const [sub, ...rest] = lowered.split(/\s+/);
  const restArgs = rest.join(" ").trim();

  if (lowered === "" || lowered === "list") {
    const entries = ctx.registry.list();
    if (entries.length === 0) {
      return ok("No skills loaded yet. Use the Skills page or load a skill bundle.");
    }
    const lines = ["**Skills**", ""];
    for (const entry of entries) {
      lines.push(`- **${entry.name}** (${entry.origin}) — ${entry.description || "no description"}`);
    }
    return ok(lines.join("\n"));
  }

  if (lowered.startsWith("search ")) {
    const query = args.slice(7).trim().toLowerCase();

    // Prefer hub search when available and the query looks like a remote lookup.
    if (ctx.searchHub && query.length > 0) {
      try {
        const hubResults = await ctx.searchHub(query);
        if (hubResults.length > 0) {
          const lines = [
            `**Skills Hub results for "${query}"**`,
            "",
            ...hubResults.map((r) => `- **${r.name}** \`${r.identifier}\` (${r.trust_level}) — ${r.description || "no description"}`),
          ];
          return ok(lines.join("\n"));
        }
      } catch {
        // Fall through to local search if the hub is unreachable.
      }
    }

    const entries = ctx.registry.list().filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query) ||
        s.category.toLowerCase().includes(query),
    );
    if (entries.length === 0) {
      return ok(`No skills match "${query}".`);
    }
    const lines = [`**Skills matching "${query}"**`, "", ...entries.map((s) => `- **${s.name}** — ${s.description}`)];
    return ok(lines.join("\n"));
  }

  if (sub === "install") {
    if (!ctx.installSkill) {
      return err("Skills Hub install is not available in this surface.");
    }
    if (!restArgs) {
      return err("Usage: /skills install <identifier|url>");
    }
    const result = await ctx.installSkill(trimmed.slice(7).trim());
    if (!result.ok) {
      return err(result.message || `Failed to install ${restArgs}`);
    }
    return ok(result.message || `Installed **${restArgs}**.`);
  }

  if (sub === "uninstall") {
    if (!ctx.uninstallSkill) {
      return err("Skills Hub uninstall is not available in this surface.");
    }
    if (!restArgs) {
      return err("Usage: /skills uninstall <name>");
    }
    const result = await ctx.uninstallSkill(restArgs);
    if (!result.ok) {
      return err(result.message || `Failed to uninstall ${restArgs}`);
    }
    return ok(result.message || `Uninstalled **${restArgs}**.`);
  }

  if (sub === "hub") {
    ctx.navigate?.("skills");
    return ok("Opening Skills Hub…");
  }

  if (lowered === "status") {
    const entries = ctx.registry.list();
    return ok(`Loaded skills: ${entries.length}`);
  }

  if (lowered.startsWith("bundle ")) {
    const bundleName = args.slice(7).trim();
    const resolved = resolveBundle(bundleName, ctx.registry);
    if (!resolved.bundle) {
      return err(`Bundle not found: ${bundleName}`);
    }
    const { message } = buildBundleInvocationMessage(resolved.bundle, "");
    const lines = [
      `**${resolved.bundle.name}** — ${resolved.bundle.description}`,
      "",
      `Loaded skills: ${resolved.bundle.skills.map((s) => s.name).join(", ")}`,
      "",
      "Invocation preview:",
      "```",
      message.slice(0, 400) + (message.length > 400 ? "…" : ""),
      "```",
    ];
    return ok(lines.join("\n"));
  }

  return err(
    `Unknown /skills subcommand: ${args}. Try /skills list, /skills search <query>, /skills install <identifier|url>, /skills uninstall <name>, /skills hub, or /skills bundle <name>.`,
  );
}

/** `/skill <name>` — load a skill to L1 and display it, or run a management subcommand. */
export async function handleSkill(args: string, ctx: SkillsHandlerContext): Promise<CommandResult> {
  const trimmed = args.trim();
  const [sub, ...rest] = trimmed.split(/\s+/);
  const restArgs = rest.join(" ").trim();

  if (sub) {
    switch (sub.toLowerCase()) {
      case "enable":
        return toggleSkill(ctx, restArgs, true);
      case "disable":
        return toggleSkill(ctx, restArgs, false);
      case "stack":
        return stackSkill(ctx, restArgs);
      case "unstack":
        return unstackSkill(ctx, restArgs);
    }
  }

  return loadSkill(ctx, trimmed);
}

function toggleSkill(ctx: SkillsHandlerContext, name: string, enabled: boolean): CommandResult {
  const skill = findSkill(ctx.registry, name);
  if (!skill) {
    return err(`Skill not found: ${name}`);
  }
  ctx.registry.setEnabled(skill.id, enabled);
  return ok(`${enabled ? "Enabled" : "Disabled"} skill **${skill.name}**.`);
}

async function stackSkill(ctx: SkillsHandlerContext, name: string): Promise<CommandResult> {
  const skill = findSkill(ctx.registry, name);
  if (!skill) {
    return err(`Skill not found: ${name}`);
  }
  const loaded = await ctx.registry.loadLevel(skill.id, "L1");
  if (!loaded) {
    return err(`Could not load skill: ${skill.name}`);
  }
  if (!ctx.registry.stack.push(loaded)) {
    return err(`Skill stack is full (${ctx.registry.stack.size} skills). Remove one before adding more.`);
  }
  return ok(ctx.registry.stack.describe());
}

function unstackSkill(ctx: SkillsHandlerContext, name: string): CommandResult {
  if (name) {
    const removed = ctx.registry.stack.remove(name);
    return removed
      ? ok(`Removed **${name}** from the active stack.\n\n${ctx.registry.stack.describe()}`)
      : err(`Skill **${name}** is not in the active stack.`);
  }
  const popped = ctx.registry.stack.pop();
  if (!popped) {
    return err("No skills are stacked.");
  }
  return ok(`Removed **${popped.name}** from the top of the stack.\n\n${ctx.registry.stack.describe()}`);
}

async function loadSkill(ctx: SkillsHandlerContext, name: string): Promise<CommandResult> {
  if (!name) {
    return err("Usage: /skill <name> or /skill enable|disable|stack|unstack <name>");
  }

  const skill = findSkill(ctx.registry, name);
  if (!skill) {
    return err(`Skill not found: ${name}`);
  }

  const loaded = await ctx.registry.loadLevel(skill.id, "L1");
  if (!loaded) {
    return err(`Could not load skill: ${skill.name}`);
  }

  const lines = [
    `**${loaded.name}**`,
    `Category: ${loaded.category} · Origin: ${loaded.origin}`,
    "",
    loaded.description,
    "",
  ];

  if (loaded.content) {
    lines.push(loaded.content);
  }

  const linked = [
    ...loaded.references?.map((r) => `reference: ${r.name}`) ?? [],
    ...loaded.templates?.map((t) => `template: ${t.name}`) ?? [],
    ...loaded.scripts?.map((s) => `script: ${s.name}`) ?? [],
  ];
  if (linked.length) {
    lines.push("", "**Linked files**", ...linked.map((l) => `- ${l}`));
  }

  ctx.navigate?.("skills");
  return ok(lines.join("\n"));
}

function findSkill(registry: SkillRegistry, name: string) {
  const byId = registry.resolve(name);
  if (byId) return byId;
  const byName = registry.list().find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (byName) return registry.resolve(byName.id);
  return undefined;
}
