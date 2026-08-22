/**
 * CLI command registry types.
 *
 * Mirrors the `hermes` CLI surface documented in Core's
 * `website/docs/reference/cli-commands.md` and maps each command to the
 * desktop equivalent: a React route, a hook, a Rust Tauri command, a command
 * palette entry, a thin wrapper that shells out to `hermes`, or a dropped
 * terminal-only command.
 */

export type CommandKind =
  | "route" // existing React route
  | "hook" // data/action hook
  | "rpc" // Rust Tauri command
  | "palette-only" // discoverable in command palette only
  | "thin-wrapper" // spawn `hermes <cmd>` via Rust
  | "dropped"; // pure terminal / Python-venv concern with no UI value

export type GlobalFlag =
  | "model"
  | "provider"
  | "reasoning"
  | "toolsets"
  | "resume"
  | "skills"
  | "profile"
  | "worktree"
  | "yolo"
  | "continue"
  | "input"
  | "oneshot"
  | "usageFile";

export type CommandAction =
  | { type: "navigate"; to: string }
  | { type: "hook"; hook: string }
  | { type: "rpc"; cmd: string }
  | { type: "thin-wrapper"; argv: string[] }
  | { type: "none" };

export interface CommandSpec {
  name: string;
  aliases: readonly string[];
  summary: string;
  kind: CommandKind;
  action: CommandAction;
  flags: readonly GlobalFlag[];
  /** True when the command has a desktop UI equivalent. */
  desktopRelevant: boolean;
  /** Optional CLI subcommand path for thin-wrapper / dropped documentation. */
  cliPath?: readonly string[];
}

/** Result returned by the one-shot runner (`hermes -z`). */
export interface OneShotResult {
  text: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

/** Structured result of dispatching any CLI command through the desktop. */
export interface CommandResult {
  ok: boolean;
  message?: string;
  result?: unknown;
}
