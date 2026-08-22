import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { resolveCliCommand } from "@/lib/commands/catalog";
import { dispatchCommand, type HookRegistry } from "@/lib/commands/dispatch";
import type { CommandSpec, CommandResult } from "@/lib/commands/types";

export interface UseCliCommandOptions {
  /** Optional hook registry for `hook` actions. */
  hooks?: HookRegistry;
}

export interface UseCliCommandResult {
  /** Resolve a raw command name (or alias) to its canonical spec. */
  resolve: (name: string) => CommandSpec | null;
  /** Dispatch a spec to its desktop surface. */
  dispatch: (spec: CommandSpec, args?: Record<string, unknown>) => Promise<CommandResult>;
  /** Resolve and dispatch by name. */
  run: (name: string, args?: Record<string, unknown>) => Promise<CommandResult>;
}

/**
 * Hook that binds the CLI command catalog to the React Router navigate function.
 */
export function useCliCommand(options: UseCliCommandOptions = {}): UseCliCommandResult {
  const navigate = useNavigate();

  const resolve = useCallback((name: string) => resolveCliCommand(name), []);

  const dispatch = useCallback(
    async (spec: CommandSpec, args?: Record<string, unknown>): Promise<CommandResult> => {
      return dispatchCommand(spec, { navigate, hooks: options.hooks, args });
    },
    [navigate, options.hooks],
  );

  const run = useCallback(
    async (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
      const spec = resolveCliCommand(name);
      if (!spec) {
        return { ok: false, message: `unknown command: ${name}` };
      }
      return dispatchCommand(spec, { navigate, hooks: options.hooks, args });
    },
    [navigate, options.hooks],
  );

  return { resolve, dispatch, run };
}

/**
 * Resolve a raw `hermes` argv through the Rust side `cli_resolve_command` IPC.
 * Useful for deep links and Console quick-actions that need exact parity with
 * the managed-runtime parser.
 */
export async function resolveCliArgv(argv: string[]): Promise<{
  command: string;
  positional: string[];
  flags: Record<string, unknown>;
  oneShotPrompt?: string;
  usageFile?: string;
}> {
  return invoke("cli_resolve_command", { argv });
}
