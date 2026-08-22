/**
 * Local `/memory` slash-command handler.
 *
 * Mirrors the Python `hermes_cli/write_approval_commands.py` surface:
 *   /memory pending
 *   /memory approve <id>|all
 *   /memory reject <id>|all
 *   /memory approval on|off
 */

import type { CommandResult } from "../types";

export interface MemoryPendingRecord {
  id: string;
  subsystem: string;
  action: string;
  summary: string;
  origin: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface MemoryCommandContext {
  /** Whether the memory write-approval gate is currently enabled. */
  isApprovalEnabled: () => boolean;
  /** Toggle the write-approval gate. */
  setApprovalEnabled: (enabled: boolean) => Promise<void>;
  /** List staged pending memory writes, oldest first. */
  listPending: () => Promise<MemoryPendingRecord[]>;
  /** Approve a pending write by id. */
  approvePending: (id: string) => Promise<boolean>;
  /** Reject a pending write by id. */
  rejectPending: (id: string) => Promise<boolean>;
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

function formatPending(records: MemoryPendingRecord[]): string {
  if (records.length === 0) return "No pending memory writes.";
  const lines = ["Pending memory writes:", ""];
  for (const record of records) {
    const autoTag = record.origin === "background" ? " [auto]" : "";
    lines.push(`- ${record.id}${autoTag} ${record.action}: ${record.summary}`);
  }
  return lines.join("\n");
}

/**
 * Handle `/memory pending|approve <id|all>|reject <id|all>|approval <on|off>`.
 */
export async function handleMemoryCommand(
  args: string,
  ctx: MemoryCommandContext,
): Promise<CommandResult> {
  const { subcommand, rest, tokens } = parseArgs(args);

  if (!subcommand || subcommand === "pending" || subcommand === "status") {
    const records = await ctx.listPending();
    return ok(formatPending(records));
  }

  if (subcommand === "approve") {
    const target = rest.trim();
    if (!target) return err("Usage: /memory approve <id>|all");

    if (target === "all") {
      const records = await ctx.listPending();
      let approved = 0;
      for (const record of records) {
        if (await ctx.approvePending(record.id)) approved++;
      }
      return ok(`Approved ${approved} pending memory write${approved === 1 ? "" : "s"}.`);
    }

    const ok_ = await ctx.approvePending(target);
    return ok_ ? ok(`Approved pending write ${target}.`) : err(`Pending write ${target} not found.`);
  }

  if (subcommand === "reject") {
    const target = rest.trim();
    if (!target) return err("Usage: /memory reject <id>|all");

    if (target === "all") {
      const records = await ctx.listPending();
      let rejected = 0;
      for (const record of records) {
        if (await ctx.rejectPending(record.id)) rejected++;
      }
      return ok(`Rejected ${rejected} pending memory write${rejected === 1 ? "" : "s"}.`);
    }

    const ok_ = await ctx.rejectPending(target);
    return ok_ ? ok(`Rejected pending write ${target}.`) : err(`Pending write ${target} not found.`);
  }

  if (subcommand === "approval") {
    const value = tokens[1]?.toLowerCase();
    if (value === "on" || value === "true" || value === "1") {
      await ctx.setApprovalEnabled(true);
      return ok("Memory write approval: enabled. Future writes will be staged for review.");
    }
    if (value === "off" || value === "false" || value === "0") {
      await ctx.setApprovalEnabled(false);
      return ok("Memory write approval: disabled. Writes will be applied immediately.");
    }
    return ok(`Memory write approval: ${ctx.isApprovalEnabled() ? "enabled" : "disabled"}`);
  }

  return err(
    `Unknown /memory subcommand: ${subcommand}. Try: pending, approve, reject, approval`,
  );
}
