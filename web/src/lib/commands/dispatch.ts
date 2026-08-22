import { invoke } from "@tauri-apps/api/core";
import type { CommandResult, CommandSpec } from "./types";

export type HookRegistry = Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;

export interface DispatchOptions {
  /** React Router navigate function for route actions. */
  navigate?: (to: string) => void;
  /** Named hook registry for `hook` actions. */
  hooks?: HookRegistry;
  /** Extra arguments to pass to RPC/thin-wrapper commands. */
  args?: Record<string, unknown>;
}

function buildThinWrapperArgv(spec: CommandSpec, extraArgs: Record<string, unknown>): string[] {
  if (spec.action.type !== "thin-wrapper") return [];
  const argv = [...spec.action.argv];
  for (const [key, value] of Object.entries(extraArgs)) {
    if (value === undefined || value === null) continue;
    if (value === true) {
      argv.push(`--${key}`);
    } else {
      argv.push(`--${key}`, String(value));
    }
  }
  return argv;
}

/**
 * Dispatch a CLI command spec to the appropriate desktop surface.
 *
 * - `route` -> navigate
 * - `hook` -> call named hook from registry
 * - `rpc` -> invoke Tauri command
 * - `thin-wrapper` -> spawn hermes via Rust `cli_spawn`
 * - `palette-only` / `dropped` -> no-op result
 */
export async function dispatchCommand(
  spec: CommandSpec,
  options: DispatchOptions = {},
): Promise<CommandResult> {
  switch (spec.action.type) {
    case "navigate": {
      if (!options.navigate) {
        return { ok: false, message: "navigate not available" };
      }
      options.navigate(spec.action.to);
      return { ok: true, message: `navigate:${spec.action.to}` };
    }
    case "hook": {
      const hook = options.hooks?.[spec.action.hook];
      if (!hook) {
        return { ok: false, message: `hook not registered: ${spec.action.hook}` };
      }
      const result = await hook(options.args ?? {});
      return { ok: true, result };
    }
    case "rpc": {
      const result = await invoke(spec.action.cmd, options.args ?? {});
      return { ok: true, result };
    }
    case "thin-wrapper": {
      const argv = buildThinWrapperArgv(spec, options.args ?? {});
      const result = await invoke("cli_spawn", { argv });
      return { ok: true, result };
    }
    case "none":
    default:
      return { ok: true, message: `no-op:${spec.name}` };
  }
}

/** Convenience dispatcher that resolves a command by name first. */
export async function dispatchCliCommand(
  name: string,
  options: DispatchOptions & { resolve: (name: string) => CommandSpec | null },
): Promise<CommandResult> {
  const spec = options.resolve(name);
  if (!spec) {
    return { ok: false, message: `unknown command: ${name}` };
  }
  return dispatchCommand(spec, options);
}
