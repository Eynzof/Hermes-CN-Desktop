/**
 * Public facade for the central slash-command engine.
 */

export { SlashCommandRunner, type RunnerContext, type DispatchResult } from "./runner";
export { parseSlashInput, type ParsedSlashInput } from "./parse";
export { resolveSlashInput, type ResolveSlashOptions } from "./resolve";
export { completeSlash, completeSubcommands, type SlashCompletionItem, type CompletionKind } from "./completions";
export {
  COMMAND_REGISTRY,
  resolveCommand,
  resolveAlias,
  listCommands,
  commandNames,
  commandCategories,
  gatewayHelpLines,
  getSubcommands,
  allSubcommands,
  isDesktopVisible,
  type CommandDef,
  type CommandCategory,
  type BusyPolicy,
  type BusyHandlerKey,
  type ExecutorKey,
  type LocalHandlerKey,
} from "./registry";
export {
  runExecutor,
  EXECUTORS,
  type ExecutorContext,
  type ExecutorReply,
  type Executor,
} from "./executors";
export type {
  SlashIntent,
  SlashIntentType,
  CommandResult,
  LocalHandlerContext,
} from "./types";
