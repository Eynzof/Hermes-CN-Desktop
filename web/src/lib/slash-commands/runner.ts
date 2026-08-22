import { getAgentRuntime, startBackgroundAgent, steerAgent } from "@/lib/agent-control";
import type { SessionStore } from "@/lib/session-store/session-store";
import type { CommandDispatchResult } from "@hermes/protocol";
import { parseModelSwitchArgs } from "./handlers/model";
import { handleCompress, type CompressHandlerContext } from "./handlers/compress";
import { resolveCommand, commandNames, type CommandDef } from "./registry";
import type { BusyHandlerKey, CommandResult, LocalHandlerContext, LocalHandlerKey } from "./types";
import {
  handleBranch,
  handleClear,
  handleHistory,
  handleNew,
  handleResume,
  handleRetry,
  handleSave,
  handleSessions,
  handleTitle,
  handleUndo,
  type CommandContext as LifecycleContext,
} from "./handlers/lifecycle";
import { handleBundles, handleCommands, handleEgress, handleHelp, handleProfile, handleVersion } from "./handlers/info";
import {
  handleApprovalsCommand,
  handleFastCommand,
  handleReasoningCommand,
  handleYoloCommand,
  type ControlHandlerContext,
} from "./handlers/control";
import {
  handleContext,
  handleInsights,
  handleStatus,
  handleUsage,
  type UsageHandlerContext,
} from "./handlers/usage";
import { handleMemoryCommand, type MemoryCommandContext } from "./handlers/memory";
import { handlePersonality, type PersonalityHandlerContext } from "./handlers/personality";
import type { PersonalityConfig } from "@/lib/personality";
import {
  handleRollback,
  handleSnapshot,
  handleDiff,
  type CheckpointsHandlerContext,
} from "./handlers/checkpoints";
import { handleSkin, type SkinHandlerContext } from "./handlers/skin";
import { handleToolsCategory } from "./handlers/tools-category";
import type { SkinSlug } from "@/lib/skins";
import {
  handleJourney,
  handleMemoryGraph,
  type LearningHandlerContext,
} from "./handlers/learning";
import { handleMoa, handleCouncil } from "./handlers/moa";
import {
  handleSkill,
  handleSkills,
  type SkillsHandlerContext,
} from "./handlers/skills";
import {
  handleRefine,
  handleLearn,
  type SelfImprovementHandlerContext,
} from "./handlers/self-improvement";
import type { MoaConfig, MoaSlot, LLM } from "@hermes/agent-core";
import { handlePlugins, type PluginsHandlerContext } from "./handlers/plugins";
import { handlePet, handleHatch, type PetsHandlerContext } from "./handlers/pets";
import {
  handleHeartbeat,
  handleGoal,
  handleSubgoal,
  handleDelegate,
  handleCron,
  handleKanban,
  handleCurator,
  handleSuggestions,
  handleBlueprint,
  type HeartbeatHandlerContext,
  type GoalHandlerContext,
  type SubagentHandlerContext,
  type CronHandlerContext,
  type KanbanHandlerContext,
  type CuratorHandlerContext,
  type AutomationHandlerContext,
} from "./handlers/automation";

function controlCtx(ctx: RunnerContext): ControlHandlerContext {
  return { activeSessionId: ctx.activeSessionId };
}

export interface RunnerContext {
  store: SessionStore;
  activeSessionId: string | null;
  submitPrompt: (sessionId: string, prompt: string) => Promise<void>;
  cancelTurn: () => Promise<void>;
  notify: (message: string) => void;
  cwd?: string | null;
  /** Backend fallback for commands that have not migrated to local yet. */
  dispatchCommand: (sessionId: string, name: string, arg: string) => Promise<CommandDispatchResult>;
  /** Optional session-level model switch for /model. */
  setSessionModel?: (sessionId: string, model: string, provider?: string) => Promise<void>;
  /** Optional manual compression RPC for /compress (legacy fallback). */
  compressSession?: (sessionId: string, arg: string) => Promise<{ output?: string }>;
  /** Optional local compression dependencies. When provided, /compress runs in-process. */
  compressionContext?: CompressHandlerContext;
  /** Navigation callback for /navigate results. */
  navigate?: (to: string) => void;
  /** Current model options for /model validation. */
  getModelOptions?: () => { models?: Array<{ id: string; provider?: string }> } | undefined;
  /** Build/version/status metadata for info executors. */
  getBuildInfo?: () => {
    version?: string;
    commit?: string;
    backendVersion?: string;
    activeProfile?: string;
    profiles?: string[];
    bundles?: string[];
  } | undefined;
  getStatus?: () => { gateway_running?: boolean; active_sessions?: number } | undefined;
  /** Session usage RPC for /usage. */
  getSessionUsage?: (sessionId: string) => Promise<import("@hermes/protocol").SessionUsageResult>;
  /** Analytics fetcher for /insights. */
  getAnalytics?: (days: number, source?: string) => Promise<import("@hermes/protocol").AnalyticsResponse>;
  /** Local turn stats fallback for /usage and /insights. */
  getTurnStats?: (sessionId: string) => Promise<import("@/lib/ui-store").UiTurnStats[]>;
  /** Memory write-approval context for /memory. */
  memoryContext?: MemoryCommandContext;
  /** Personality config snapshot for /personality resolution. */
  getPersonalityConfig?: () => PersonalityConfig | undefined;
  /** Persist a personality selection to `display.personality`. */
  savePersonality?: (name: string) => Promise<void>;
  /** Apply a personality selection to the ephemeral session overlay. */
  setSessionPersonality?: (sessionId: string, name: string) => void;
  /** Local checkpoint/snapshot manager context for /rollback /snapshot /diff. */
  checkpointContext?: CheckpointsHandlerContext;
  /** Active skin slug for /skin. */
  currentSkin?: SkinSlug | null;
  /** Apply a skin preset for /skin. */
  applySkin?: (slug: SkinSlug) => Promise<void> | void;
  /** Optional MoA configuration for /moa /council. */
  moaConfig?: MoaConfig;
  /** Factory to create an LLM adapter for a MoA slot. */
  createMoaLlm?: (slot: MoaSlot) => LLM | undefined;
  /** Learning journey context for /journey /learning /memory-graph. */
  learningContext?: LearningHandlerContext;
  /** Skill registry context for /skills /skill. */
  skillsContext?: SkillsHandlerContext;
  /** Plugin registry context for /plugins. */
  pluginsContext?: PluginsHandlerContext;
  /** Self-improvement loop context for /refine /learn. */
  selfImprovementContext?: SelfImprovementHandlerContext;
  /** Pets context for /pet /hatch. */
  petsContext?: PetsHandlerContext;
  /** Heartbeat loop context for /heartbeat. */
  heartbeatContext?: HeartbeatHandlerContext;
  /** Goal store context for /goal /subgoal. */
  goalContext?: GoalHandlerContext;
  /** Subagent pool context for /delegate. */
  subagentContext?: SubagentHandlerContext;
  /** Cron scheduler context for /cron. */
  cronContext?: CronHandlerContext;
  /** Kanban store context for /kanban. */
  kanbanContext?: KanbanHandlerContext;
  /** Curator engine context for /curator. */
  curatorContext?: CuratorHandlerContext;
  /** Automation helpers context for /suggestions /blueprint. */
  automationContext?: AutomationHandlerContext;
}

export interface DispatchResult extends CommandResult {
  command: CommandDef;
}

/**
 * In-process slash-command dispatcher.
 *
 * Mirrors Python `COMMAND_REGISTRY` busy policies and routes lifecycle commands
 * to the local `SessionStore` + agent runtime instead of the gateway. Commands
 * without a local handler fall back to the frozen WS `command.dispatch` RPC.
 */
export class SlashCommandRunner {
  async dispatch(
    name: string,
    args: string,
    ctx: RunnerContext,
  ): Promise<DispatchResult> {
    const command = resolveCommand(name);
    if (!command) throw new Error(`Unknown command: /${name}`);

    const result = await this.runHandler(command, args, ctx);
    return { ...result, command };
  }

  /**
   * Dispatch with busy-mode semantics. Callers should use this when the
   * runtime is currently busy; it applies `busyPolicy` and `busyHandler` before
   * routing to `dispatch`.
   */
  async dispatchBusy(
    name: string,
    args: string,
    ctx: RunnerContext,
  ): Promise<DispatchResult> {
    const command = resolveCommand(name);
    if (!command) throw new Error(`Unknown command: /${name}`);

    if (command.busyPolicy === "reject") {
      return {
        type: "error",
        message: `/${command.name} cannot be used while the agent is busy`,
        command,
      };
    }

    if (command.busyPolicy === "interrupt_then_dispatch") {
      await ctx.cancelTurn();
    }

    const busyResult = await this.runBusyHandler(command.busyHandler ?? "none", args, ctx, command);
    if (busyResult) return { ...busyResult, command };

    return this.dispatch(name, args, ctx);
  }

  complete(input: string): string[] {
    const names = listCommandNames();
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return names.slice(0, 20);
    return names.filter((n) => n.startsWith(trimmed)).slice(0, 20);
  }

  private async runHandler(
    command: CommandDef,
    args: string,
    ctx: RunnerContext,
  ): Promise<CommandResult> {
    const local = command.local;
    if (local) {
      const handler = LOCAL_HANDLERS[local];
      if (handler) {
        return handler(args, ctx, this.lifecycleCtx(ctx));
      }
    }

    if (command.execute) {
      const infoCtx = this.infoCtx(ctx);
      switch (command.execute) {
        case "version":
          return handleVersion(args, infoCtx);
        case "egress":
          return handleEgress(args, infoCtx);
        case "gateway_help":
          return handleHelp(args);
        case "gateway_commands":
          return handleCommands(args);
        case "profile":
          return handleProfile(args, infoCtx);
        case "bundles":
          return handleBundles(args, infoCtx);
      }
    }

    return this.backendDispatch(command, args, ctx);
  }

  private async runBusyHandler(
    key: BusyHandlerKey,
    args: string,
    ctx: RunnerContext,
    command: CommandDef,
  ): Promise<CommandResult | null> {
    const handler = BUSY_HANDLERS[key];
    if (!handler) return null;
    return handler(args, ctx, command);
  }

  private lifecycleCtx(ctx: RunnerContext): LifecycleContext {
    return {
      store: ctx.store,
      activeSessionId: ctx.activeSessionId,
      submitPrompt: ctx.submitPrompt,
      cancelTurn: ctx.cancelTurn,
      notify: ctx.notify,
      cwd: ctx.cwd,
    };
  }

  private infoCtx(ctx: RunnerContext): LocalHandlerContext {
    return {
      name: "",
      args: "",
      activeSessionId: ctx.activeSessionId,
      getBuildInfo: ctx.getBuildInfo,
      getStatus: ctx.getStatus,
      getModelOptions: ctx.getModelOptions,
      navigate: ctx.navigate,
    };
  }

  private async backendDispatch(
    command: CommandDef,
    args: string,
    ctx: RunnerContext,
  ): Promise<CommandResult> {
    if (!ctx.activeSessionId) {
      return { type: "error", message: `/${command.name} requires an active session` };
    }
    const result = await ctx.dispatchCommand(ctx.activeSessionId, command.name, args);
    return normalizeBackendResult(result);
  }
}

const LOCAL_HANDLERS: Record<
  LocalHandlerKey,
  (args: string, ctx: RunnerContext, lifecycle: LifecycleContext) => Promise<CommandResult> | CommandResult
> = {
  new: (args, _ctx, lifecycle) => handleNew(args, lifecycle),
  clear: (args, _ctx, lifecycle) => handleClear(args, lifecycle),
  history: (args, _ctx, lifecycle) => handleHistory(args, lifecycle),
  save: (args, _ctx, lifecycle) => handleSave(args, lifecycle),
  resume: (args, _ctx, lifecycle) => handleResume(args, lifecycle),
  sessions: (args, _ctx, lifecycle) => handleSessions(args, lifecycle),
  title: (args, _ctx, lifecycle) => handleTitle(args, lifecycle),
  branch: (args, _ctx, lifecycle) => handleBranch(args, lifecycle),
  retry: (args, _ctx, lifecycle) => handleRetry(args, lifecycle),
  undo: (args, _ctx, lifecycle) => handleUndo(args, lifecycle),
  stop: async (_args, ctx) => {
    const ok = await getAgentRuntime().cancel(ctx.activeSessionId ?? undefined);
    return { type: "exec", output: ok ? "Stopped" : "Nothing to stop" };
  },
  queue: (args) => {
    return {
      type: "send",
      message: `Queued: ${args.trim()}`,
      pendingPrompt: args.trim(),
    };
  },
  steer: async (args, ctx) => {
    if (!ctx.activeSessionId) return { type: "error", message: "No active session" };
    const ok = await steerAgent(ctx.activeSessionId, args.trim());
    return {
      type: "exec",
      output: ok ? `Steer queued: ${args.trim()}` : "Failed to steer",
    };
  },
  background: async (args, ctx) => {
    if (!ctx.activeSessionId) return { type: "error", message: "No active session" };
    const bg = await startBackgroundAgent(ctx.activeSessionId, args.trim());
    return {
      type: "exec",
      output: bg
        ? `Background session ${bg.backgroundSessionId} started`
        : "Failed to start background",
      activeSessionId: bg?.backgroundSessionId,
    };
  },
  compress: async (args, ctx) => {
    if (!ctx.activeSessionId) return { type: "error", message: "No active session" };
    if (ctx.compressionContext) {
      return handleCompress(args, { ...ctx.compressionContext, activeSessionId: ctx.activeSessionId });
    }
    if (ctx.compressSession) {
      const result = await ctx.compressSession(ctx.activeSessionId, args);
      return { type: "exec", output: result.output ?? "Compressed" };
    }
    return { type: "error", message: "/compress not available in this surface" };
  },
  version: (args, ctx) => handleVersion(args, ctx as unknown as LocalHandlerContext),
  egress: (args, ctx) => handleEgress(args, ctx as unknown as LocalHandlerContext),
  help: (args) => handleHelp(args),
  commands: (args) => handleCommands(args),
  profile: (args, ctx) => handleProfile(args, ctx as unknown as LocalHandlerContext),
  navigate: (args, ctx) => {
    const to = args.trim();
    if (to && ctx.navigate) ctx.navigate(to);
    return { type: "navigate", target: to };
  },
  reasoning: (args, ctx) => handleReasoningCommand(args, controlCtx(ctx)),
  fast: (args, ctx) => handleFastCommand(args, controlCtx(ctx)),
  yolo: (args, ctx) => handleYoloCommand(args, controlCtx(ctx)),
  approvals: (args, ctx) => handleApprovalsCommand(args, controlCtx(ctx)),
  context: async (args, ctx) => handleContext(args, ctx as unknown as UsageHandlerContext),
  status: async (args, ctx) => handleStatus(args, ctx as unknown as UsageHandlerContext),
  usage: async (args, ctx) => handleUsage(args, ctx as unknown as UsageHandlerContext),
  insights: async (args, ctx) => handleInsights(args, ctx as unknown as UsageHandlerContext),
  memory: async (args, ctx) => {
    if (!ctx.memoryContext) {
      return { type: "error", message: "/memory not available in this surface" };
    }
    return handleMemoryCommand(args, ctx.memoryContext);
  },
  personality: async (args, ctx) => {
    const handlerCtx: PersonalityHandlerContext = {
      activeSessionId: ctx.activeSessionId,
      getConfig: ctx.getPersonalityConfig,
      savePersonality: ctx.savePersonality,
      setSessionPersonality: ctx.setSessionPersonality,
    };
    return handlePersonality(args, handlerCtx);
  },
  rollback: async (args, ctx) => {
    if (!ctx.checkpointContext) {
      return { type: "error", message: "/rollback not available in this surface" };
    }
    return handleRollback(args, ctx.checkpointContext);
  },
  snapshot: async (args, ctx) => {
    if (!ctx.checkpointContext) {
      return { type: "error", message: "/snapshot not available in this surface" };
    }
    return handleSnapshot(args, ctx.checkpointContext);
  },
  diff: async (args, ctx) => {
    if (!ctx.checkpointContext) {
      return { type: "error", message: "/diff not available in this surface" };
    }
    return handleDiff(args, ctx.checkpointContext);
  },
  skin: async (args, ctx) => {
    const handlerCtx: SkinHandlerContext = {
      currentSkin: ctx.currentSkin,
      applySkin: ctx.applySkin,
    };
    return handleSkin(args, handlerCtx);
  },
  tools: (args) => handleToolsCategory(args),
  moa: async (args, ctx) =>
    handleMoa(args, {
      activeSessionId: ctx.activeSessionId,
      moaConfig: ctx.moaConfig,
      createMoaLlm: ctx.createMoaLlm,
    }),
  council: async (args, ctx) =>
    handleCouncil(args, {
      activeSessionId: ctx.activeSessionId,
      moaConfig: ctx.moaConfig,
      createMoaLlm: ctx.createMoaLlm,
    }),
  journey: async (args, ctx) => {
    if (!ctx.learningContext) {
      return { type: "error", message: "/journey not available in this surface" };
    }
    return handleJourney(args, ctx.learningContext);
  },
  "memory-graph": async (args, ctx) => {
    if (!ctx.learningContext) {
      return { type: "error", message: "/memory-graph not available in this surface" };
    }
    return handleMemoryGraph(args, ctx.learningContext);
  },
  skills: (args, ctx) => {
    if (!ctx.skillsContext) {
      return { type: "error", message: "/skills not available in this surface" };
    }
    return handleSkills(args, ctx.skillsContext);
  },
  skill: async (args, ctx) => {
    if (!ctx.skillsContext) {
      return { type: "error", message: "/skill not available in this surface" };
    }
    return handleSkill(args, ctx.skillsContext);
  },
  plugins: (args, ctx) => {
    if (!ctx.pluginsContext) {
      return { type: "error", message: "/plugins not available in this surface" };
    }
    return handlePlugins(args, ctx.pluginsContext);
  },
  refine: (args, ctx) => {
    if (!ctx.selfImprovementContext) {
      return { type: "error", message: "/refine not available in this surface" };
    }
    return handleRefine(args, ctx.selfImprovementContext);
  },
  learn: (args, ctx) => {
    if (!ctx.selfImprovementContext) {
      return { type: "error", message: "/learn not available in this surface" };
    }
    return handleLearn(args, ctx.selfImprovementContext);
  },
  pet: (args, ctx) => {
    if (!ctx.petsContext) {
      return { type: "error", message: "/pet not available in this surface" };
    }
    return handlePet(args, ctx.petsContext);
  },
  hatch: async (args, ctx) => {
    if (!ctx.petsContext) {
      return { type: "error", message: "/hatch not available in this surface" };
    }
    return handleHatch(args, ctx.petsContext);
  },
  heartbeat: (args, ctx) => {
    if (!ctx.heartbeatContext) {
      return { type: "error", message: "/heartbeat not available in this surface" };
    }
    return handleHeartbeat(args, ctx.heartbeatContext);
  },
  goal: (args, ctx) => {
    if (!ctx.goalContext) {
      return { type: "error", message: "/goal not available in this surface" };
    }
    return handleGoal(args, ctx.goalContext);
  },
  subgoal: (args, ctx) => {
    if (!ctx.goalContext) {
      return { type: "error", message: "/subgoal not available in this surface" };
    }
    return handleSubgoal(args, ctx.goalContext);
  },
  delegate: async (args, ctx) => {
    if (!ctx.subagentContext) {
      return { type: "error", message: "/delegate not available in this surface" };
    }
    return handleDelegate(args, ctx.subagentContext);
  },
  cron: (args, ctx) => {
    if (!ctx.cronContext) {
      return { type: "error", message: "/cron not available in this surface" };
    }
    return handleCron(args, ctx.cronContext);
  },
  suggestions: (args, ctx) => {
    if (!ctx.automationContext) {
      return { type: "error", message: "/suggestions not available in this surface" };
    }
    return handleSuggestions(args, ctx.automationContext);
  },
  blueprint: (args, ctx) => {
    if (!ctx.automationContext) {
      return { type: "error", message: "/blueprint not available in this surface" };
    }
    return handleBlueprint(args, ctx.automationContext);
  },
  curator: async (args, ctx) => {
    if (!ctx.curatorContext) {
      return { type: "error", message: "/curator not available in this surface" };
    }
    return handleCurator(args, ctx.curatorContext);
  },
  kanban: (args, ctx) => {
    if (!ctx.kanbanContext) {
      return { type: "error", message: "/kanban not available in this surface" };
    }
    return handleKanban(args, ctx.kanbanContext);
  },
  model: async (args, ctx) => {
    const parsed = parseModelSwitchArgs(args);
    if (parsed.errors.length) {
      return { type: "error", message: parsed.errors.join("; ") };
    }
    if (!parsed.target) {
      return { type: "exec", output: "Current model selection unchanged" };
    }

    if (parsed.scope === "global") {
      // TODO: persist global model via config layer once model-switching plan lands.
      return {
        type: "exec",
        output: `Global model switch to ${parsed.target}${parsed.provider ? ` (${parsed.provider})` : ""} is not yet implemented`,
      };
    }

    if (ctx.activeSessionId && ctx.setSessionModel) {
      await ctx.setSessionModel(ctx.activeSessionId, parsed.target, parsed.provider);
      return {
        type: "exec",
        output: `Switched model to ${parsed.target}${parsed.provider ? ` (${parsed.provider})` : ""}`,
      };
    }

    return { type: "error", message: "/model requires an active session" };
  },
};

const BUSY_HANDLERS: Record<
  BusyHandlerKey,
  (args: string, ctx: RunnerContext, command: CommandDef) => Promise<CommandResult> | CommandResult
> = {
  none: () => null as unknown as CommandResult,
  queue: (args, ctx) => ({
    type: "send",
    message: `Queued: ${args.trim()}`,
    pendingPrompt: args.trim(),
    activeSessionId: ctx.activeSessionId,
  }),
  steer: async (args, ctx) => {
    if (!ctx.activeSessionId) return { type: "error", message: "No active session" };
    const ok = await steerAgent(ctx.activeSessionId, args.trim());
    return { type: "exec", output: ok ? `Steer queued: ${args.trim()}` : "Failed to steer" };
  },
  stop: async (_args, ctx) => {
    const ok = await getAgentRuntime().cancel(ctx.activeSessionId ?? undefined);
    return { type: "exec", output: ok ? "Stopped" : "Nothing to stop" };
  },
  new: async (_args, ctx) => {
    await ctx.cancelTurn();
    return null as unknown as CommandResult;
  },
};

function listCommandNames(): string[] {
  return commandNames();
}

function normalizeBackendResult(result: CommandDispatchResult): CommandResult {
  const type = (result.type ?? "exec") as CommandResult["type"];
  return {
    type,
    message: result.message,
    output: result.output,
    name: result.name,
    target: result.target,
  };
}
