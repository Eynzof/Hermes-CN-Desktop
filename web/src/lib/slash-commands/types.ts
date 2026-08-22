/**
 * Shared types for the central slash-command engine.
 *
 * Mirrors Python `hermes_cli/commands.py` `CommandDef` and the frozen WS
 * `command.dispatch` result contract from `packages/protocol/src/hermes-api.ts`.
 */

export type BusyPolicy = "dispatch" | "reject" | "interrupt_then_dispatch";

export type CommandCategory =
  | "Session"
  | "Configuration"
  | "Tools & Skills"
  | "Info"
  | "Exit"
  | "lifecycle"
  | "control";

/** Desktop-native handler keys. */
export type LocalHandlerKey =
  | "new"
  | "clear"
  | "history"
  | "save"
  | "resume"
  | "sessions"
  | "title"
  | "branch"
  | "retry"
  | "undo"
  | "stop"
  | "queue"
  | "steer"
  | "background"
  | "compress"
  | "version"
  | "profile"
  | "egress"
  | "help"
  | "commands"
  | "navigate"
  | "model"
  | "reasoning"
  | "fast"
  | "yolo"
  | "approvals"
  | "context"
  | "status"
  | "usage"
  | "insights"
  | "memory"
  | "personality"
  | "rollback"
  | "snapshot"
  | "diff"
  | "skin"
  | "tools"
  | "moa"
  | "council"
  | "journey"
  | "memory-graph"
  | "skills"
  | "skill"
  | "plugins"
  | "refine"
  | "learn"
  | "pet"
  | "hatch"
  | "heartbeat"
  | "goal"
  | "subgoal"
  | "delegate"
  | "cron"
  | "suggestions"
  | "blueprint"
  | "curator"
  | "kanban";

/** Executor keys ported from `hermes_cli/slash_exec.EXECUTORS`. */
export type ExecutorKey =
  | "version"
  | "egress"
  | "profile"
  | "bundles"
  | "gateway_help"
  | "gateway_commands";

/** Busy handler keys for mid-run special cases. */
export type BusyHandlerKey = "none" | "queue" | "steer" | "stop" | "new";

export interface CommandDef {
  /** Canonical command name without the leading slash. */
  name: string;
  description: string;
  category: CommandCategory;
  /** Alternative names (no slash). */
  aliases?: readonly string[];
  /** Human-readable argument hint, e.g. "[name] [now]". */
  argsHint?: string;
  /** Explicit subcommand names. */
  subcommands?: readonly string[];
  /** CLI-only commands are hidden from desktop composer/palette. */
  cliOnly?: boolean;
  /** Messaging-only commands are hidden on the desktop standalone surface. */
  gatewayOnly?: boolean;
  /** How the command behaves when the agent is busy. */
  busyPolicy?: BusyPolicy;
  /** Optional mid-run handler key. */
  busyHandler?: BusyHandlerKey;
  /** Executor key for thin-slice local execution. */
  execute?: ExecutorKey;
  /** Desktop-native local handler key. */
  local?: LocalHandlerKey;
  /** Feature-plan slug that owns migration of this command to local. */
  backendUntil?: string;
}

/**
 * Result shape consumed by composer + submit paths.
 *
 * This is a superset of the frozen `command.dispatch` WS contract; extra fields
 * are desktop-local extensions (e.g. `activeSessionId`, `pendingPrompt`).
 */
export interface CommandResult {
  type:
    | "exec"
    | "send"
    | "skill"
    | "plugin"
    | "alias"
    | "notice"
    | "navigate"
    | "error";
  message?: string;
  output?: string;
  name?: string;
  target?: string;
  notice?: string;
  display?: string;
  /** Desktop-local: new active session id when the command switched/created one. */
  activeSessionId?: string | null;
  /** Desktop-local: prompt that the caller should send after the command. */
  pendingPrompt?: string;
  /** Desktop-local: request a transcript view reset. */
  clearView?: boolean;
  /** Desktop-local: exported content from /save. */
  export?: { format: string; content: string };
  error?: { code: number; message: string };
}

export type SlashIntentType =
  | "builtin"
  | "skill"
  | "bundle"
  | "plugin"
  | "local"
  | "backend"
  | "blocked"
  | "invalid"
  | "message";

export interface SlashIntent {
  type: SlashIntentType;
  /** Canonical command/skill/bundle/plugin name. */
  name?: string;
  /** Raw argument string. */
  args?: string;
  /** When ambiguous, the candidate list. */
  candidates?: string[];
  /** When blocked, a human-readable reason. */
  reason?: string;
  /** Source command definition for builtin intents. */
  command?: CommandDef;
  /** Whether the intent came from an alias. */
  alias?: boolean;
}

/** Runtime context passed to local handlers. */
export interface LocalHandlerContext {
  /** The canonical command name being dispatched. */
  name: string;
  /** Raw argument string after the command. */
  args: string;
  /** Active persistent session id, if any. */
  activeSessionId: string | null;
  /** Resolve the next model/provider for /model etc. */
  getModelOptions?: () => { models?: Array<{ id: string; provider?: string }> } | undefined;
  /** Current build/version/profile/bundle metadata. */
  getBuildInfo?: () =>
    | {
        version?: string;
        commit?: string;
        backendVersion?: string;
        activeProfile?: string;
        profiles?: string[];
        bundles?: string[];
      }
    | undefined;
  /** Current status metadata for /egress etc. */
  getStatus?: () => { gateway_running?: boolean; active_sessions?: number } | undefined;
  /** Navigation callback for /navigate results. */
  navigate?: (to: string) => void;
}
