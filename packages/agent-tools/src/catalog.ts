/**
 * Representative built-in tool catalog.
 *
 * The full Hermes runtime has ~83 tools; this file provides a solid scaffold
 * of ~25 core tools plus clear placeholders for the rest. Each tool defines a
 * Zod schema and a handler reference (native TS or Rust IPC fallback).
 */

import { z } from "zod";
import {
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserScroll,
  browserBack,
  browserPress,
  browserConsole,
  browserGetImages,
  browserVision,
  browserCdp,
  browserDialog,
  browserExec,
  objectSchema as browserObjectSchema,
  browserToolSchemas,
  type BrowserToolContext,
} from "@hermes/browser";
import { register, registry } from "./registry.js";
import { credentialGates, requireEnv } from "./gates.js";
import type { ToolEntry, ToolHandler } from "./types.js";
import "./spotify/catalog.js";
import "./meet/catalog.js";
import "./homeassistant/catalog.js";
import "./integrations/mcp.js";
import "./integrations/acp.js";
import "./integrations/document-extract.js";
import "./integrations/subscription-proxy.js";
import "./integrations/tool-gateway.js";
import "./integrations/codex-runtime.js";
import "./integrations/egress-proxy.js";
import "./integrations/observability.js";
import "./messaging/catalog.js";

// ---------------------------------------------------------------------------
// Schema builders (Zod → OpenAI-style JSON schema)
// ---------------------------------------------------------------------------

export function objectSchema(shape: Record<string, z.ZodTypeAny>, required?: string[]) {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(shape).map(([k, v]) => [k, zodToJsonSchema(v)]),
    ),
    required: required ?? Object.keys(shape),
    additionalProperties: false,
  };
}

function zodToJsonSchema(zt: z.ZodTypeAny): Record<string, unknown> {
  const def = zt._def;
  if (def.typeName === "ZodString") {
    const meta: Record<string, unknown> = { type: "string" };
    if (def.description) meta.description = def.description;
    return meta;
  }
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodArray") {
    return { type: "array", items: zodToJsonSchema(def.type) };
  }
  if (def.typeName === "ZodObject") {
    const shape = def.shape();
    return objectSchema(shape, Object.keys(shape));
  }
  if (def.typeName === "ZodOptional") return zodToJsonSchema(def.innerType);
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: def.values };
  }
  if (def.typeName === "ZodDefault") return zodToJsonSchema(def.innerType);
  return { type: "string" };
}

// ---------------------------------------------------------------------------
// Native handlers (pure TS; OS-level fallbacks dispatch via Rust IPC)
// ---------------------------------------------------------------------------

const echoHandler: ToolHandler = async (args) => ({
  content: JSON.stringify(args, null, 2),
});

const todoHandler: ToolHandler = async (args) => {
  const { action, content } = args as { action: string; content?: string };
  return { content: `todo ${action}: ${content ?? ""}` };
};

const clarifyHandler: ToolHandler = async (args) => {
  const { question } = args as { question: string };
  return { content: `Clarification requested: ${question}` };
};

const completeHandler: ToolHandler = async (args) => {
  const { summary } = args as { summary?: string };
  return { content: `Task complete. ${summary ?? ""}` };
};

const thinkHandler: ToolHandler = async (args) => {
  const { thought } = args as { thought: string };
  return { content: `Thinking: ${thought}` };
};

const fileReadHandler: ToolHandler = async (args, ctx) => {
  const { path } = args as { path: string };
  // Native read fallback: in the browser/webview we cannot access fs directly;
  // dispatch.ts will route this through Rust IPC when available.
  return {
    content: `Would read file: ${path} (session ${ctx.sessionId})`,
    isError: true,
  };
};

const fileWriteHandler: ToolHandler = async (args) => {
  const { path, content } = args as { path: string; content: string };
  return { content: `Would write ${path} (${content.length} chars)` };
};

const fileSearchHandler: ToolHandler = async (args) => {
  const { query, path = "." } = args as { query: string; path?: string };
  return { content: `Search ${path} for ${query}` };
};

const terminalRunHandler: ToolHandler = async (args) => {
  const { command, timeout = 30 } = args as { command: string; timeout?: number };
  return {
    content: `Would run terminal command: ${command} (timeout ${timeout}s)`,
    isError: true,
  };
};

const processStartHandler: ToolHandler = async (args) => {
  const { command } = args as { command: string };
  return { content: `Would start process: ${command}` };
};

const webSearchHandler: ToolHandler = async (args) => {
  const { query, limit = 5 } = args as { query: string; limit?: number };
  return { content: `Web search: ${query} (limit ${limit})` };
};

const webExtractHandler: ToolHandler = async (args) => {
  const { url } = args as { url: string };
  return { content: `Extract content from ${url}` };
};

const memoryReadHandler: ToolHandler = async (args) => {
  const { key } = args as { key: string };
  return { content: `Memory read: ${key}` };
};

const memoryWriteHandler: ToolHandler = async (args) => {
  const { key, value } = args as { key: string; value: string };
  return { content: `Memory write: ${key} = ${value}` };
};

const skillInvokeHandler: ToolHandler = async (args) => {
  const { skill, prompt } = args as { skill: string; prompt: string };
  return { content: `Invoke skill ${skill} with: ${prompt}` };
};

const executeCodeHandler: ToolHandler = async (args) => {
  const { code, language } = args as { code: string; language: string };
  return { content: `Would execute ${language} code (${code.length} chars)` };
};

const cronjobScheduleHandler: ToolHandler = async (args) => {
  const { schedule, prompt } = args as { schedule: string; prompt: string };
  return { content: `Scheduled cronjob: ${schedule} -> ${prompt}` };
};

const delegateTaskHandler: ToolHandler = async (args) => {
  const { agent, task } = args as { agent: string; task: string };
  return { content: `Delegated to ${agent}: ${task}` };
};

const desktopNotifyHandler: ToolHandler = async (args) => {
  const { message } = args as { message: string };
  return { content: `Desktop notification: ${message}` };
};

const projectListHandler: ToolHandler = async () => ({
  content: "Available projects: (none configured)",
});

const browserNavigateHandler: ToolHandler = async (args) => {
  const { url } = args as { url: string };
  return { content: `Browser navigate to ${url}` };
};

const xSearchHandler: ToolHandler = async (args) => {
  const { query } = args as { query: string };
  return { content: `X search: ${query}` };
};

const haCallServiceHandler: ToolHandler = async (args) => {
  const { domain, service } = args as { domain: string; service: string };
  return { content: `Home Assistant ${domain}.${service}` };
};

const spotifyPlayHandler: ToolHandler = async (args) => {
  const { uri } = args as { uri: string };
  return { content: `Spotify play ${uri}` };
};

const imageGenerateHandler: ToolHandler = async (args) => {
  const { prompt } = args as { prompt: string };
  return { content: `Generate image: ${prompt}` };
};

const kanbanCreateBoardHandler: ToolHandler = async (args) => {
  const { name } = args as { name: string };
  return { content: `Created kanban board: ${name}` };
};

const batchRunHandler: ToolHandler = async (args) => {
  const { items, concurrency = 4 } = args as { items: string[]; concurrency?: number };
  return { content: `Batch run queued: ${items.length} items (concurrency ${concurrency})` };
};

const eventHookRegisterHandler: ToolHandler = async (args) => {
  const { event, action } = args as { event: string; action: string };
  return { content: `Registered ${event} hook → ${action}` };
};

const eventHookTriggerHandler: ToolHandler = async (args) => {
  const { event, payload } = args as { event: string; payload?: Record<string, unknown> };
  return { content: `Triggered ${event}: ${JSON.stringify(payload ?? {})}` };
};

const deliverableCreateHandler: ToolHandler = async (args) => {
  const { name, format } = args as { name: string; format: string };
  return { content: `Created deliverable ${name} (${format})` };
};

const deliverableAddFileHandler: ToolHandler = async (args) => {
  const { path } = args as { path: string };
  return { content: `Added ${path} to deliverable` };
};

const agentSwarmHandler: ToolHandler = async (args) => {
  const { agents, task } = args as { agents: string[]; task: string };
  return { content: `Swarm of ${agents.length} agents delegated: ${task}` };
};

const suggestionsGetHandler: ToolHandler = async (args) => {
  const { topic } = args as { topic: string };
  return { content: `Suggestions for ${topic}: (stub)` };
};

const blueprintMatchHandler: ToolHandler = async (args) => {
  const { query } = args as { query: string };
  return { content: `Blueprints matching ${query}: (stub)` };
};

// ---------------------------------------------------------------------------
// Catalog registration
// ---------------------------------------------------------------------------

const CATALOG: ToolEntry[] = [
  {
    name: "todo",
    toolset: "core",
    description: "Manage a persistent todo list (add, list, complete, clear).",
    emoji: "✅",
    tags: ["todo"],
    schema: objectSchema({
      action: z.enum(["add", "list", "complete", "clear"]).describe("Todo action"),
      content: z.string().optional().describe("Todo text for add/complete"),
      id: z.string().optional().describe("Todo id for complete"),
    }),
    handler: todoHandler,
  },
  {
    name: "clarify",
    toolset: "core",
    description: "Ask the user a clarifying question before proceeding.",
    emoji: "❓",
    tags: ["clarify"],
    schema: objectSchema({
      question: z.string().describe("Question to ask the user"),
    }),
    handler: clarifyHandler,
  },
  {
    name: "complete",
    toolset: "core",
    description: "Signal that the task is complete and provide a summary.",
    emoji: "🏁",
    schema: objectSchema({
      summary: z.string().optional().describe("Final summary"),
    }),
    handler: completeHandler,
  },
  {
    name: "think",
    toolset: "core",
    description: "Emit a reasoning step visible only to the model.",
    emoji: "🧠",
    schema: objectSchema({
      thought: z.string().describe("Reasoning content"),
    }),
    handler: thinkHandler,
  },
  {
    name: "delegate_task",
    toolset: "core",
    description: "Delegate a sub-task to another agent / subagent.",
    emoji: "📤",
    tags: ["delegate_task"],
    schema: objectSchema({
      agent: z.string().describe("Agent identifier"),
      task: z.string().describe("Task description"),
      context: z.string().optional().describe("Additional context"),
    }),
    handler: delegateTaskHandler,
  },
  {
    name: "file_read",
    toolset: "file",
    description: "Read a file's contents.",
    emoji: "📄",
    schema: objectSchema({
      path: z.string().describe("File path"),
      offset: z.number().optional().describe("Start line"),
      limit: z.number().optional().describe("Max lines"),
    }),
    handler: fileReadHandler,
  },
  {
    name: "file_write",
    toolset: "file",
    description: "Write content to a file.",
    emoji: "📝",
    schema: objectSchema({
      path: z.string().describe("File path"),
      content: z.string().describe("Content to write"),
    }),
    handler: fileWriteHandler,
  },
  {
    name: "file_search",
    toolset: "file",
    description: "Search files by name or content pattern.",
    emoji: "🔍",
    schema: objectSchema({
      query: z.string().describe("Search pattern"),
      path: z.string().optional().describe("Directory to search"),
    }),
    handler: fileSearchHandler,
  },
  {
    name: "file_grep",
    toolset: "file",
    description: "Run a content grep across files.",
    emoji: "🔎",
    schema: objectSchema({
      pattern: z.string().describe("Regex or literal"),
      path: z.string().optional().describe("Directory to search"),
    }),
    handler: fileSearchHandler,
  },
  {
    name: "file_list",
    toolset: "file",
    description: "List files in a directory.",
    emoji: "📂",
    schema: objectSchema({
      path: z.string().describe("Directory path"),
      recursive: z.boolean().optional().describe("List recursively"),
    }),
    handler: fileSearchHandler,
  },
  {
    name: "terminal_run",
    toolset: "terminal",
    description: "Run a shell command in the local terminal.",
    emoji: "💻",
    schema: objectSchema({
      command: z.string().describe("Shell command"),
      timeout: z.number().optional().describe("Timeout in seconds"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    handler: terminalRunHandler,
  },
  {
    name: "terminal_status",
    toolset: "terminal",
    description: "Check whether a running terminal command is alive.",
    emoji: "📊",
    schema: objectSchema({
      pid: z.string().describe("Process id"),
    }),
    handler: echoHandler,
  },
  {
    name: "process_start",
    toolset: "terminal",
    description: "Start a background process.",
    emoji: "🚀",
    schema: objectSchema({
      command: z.string().describe("Command to start"),
      cwd: z.string().optional().describe("Working directory"),
    }),
    handler: processStartHandler,
  },
  {
    name: "process_stop",
    toolset: "terminal",
    description: "Stop a background process.",
    emoji: "🛑",
    schema: objectSchema({
      pid: z.string().describe("Process id"),
    }),
    handler: echoHandler,
  },
  {
    name: "web_search",
    toolset: "web",
    description: "Search the web and return a list of results.",
    emoji: "🌐",
    schema: objectSchema({
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max result count"),
    }),
    handler: webSearchHandler,
  },
  {
    name: "web_extract",
    toolset: "web",
    description: "Extract readable content from a URL.",
    emoji: "📰",
    schema: objectSchema({
      url: z.string().describe("URL to extract"),
    }),
    handler: webExtractHandler,
  },
  {
    name: "web_fetch",
    toolset: "web",
    description: "Fetch raw content from a URL.",
    emoji: "🌎",
    schema: objectSchema({
      url: z.string().describe("URL to fetch"),
      method: z.enum(["GET", "POST"]).optional().describe("HTTP method"),
    }),
    handler: webExtractHandler,
  },
  {
    name: "memory_read",
    toolset: "memory",
    description: "Read a value from built-in memory.",
    emoji: "🧠",
    schema: objectSchema({
      key: z.string().describe("Memory key"),
    }),
    handler: memoryReadHandler,
  },
  {
    name: "memory_write",
    toolset: "memory",
    description: "Write a value to built-in memory.",
    emoji: "💾",
    schema: objectSchema({
      key: z.string().describe("Memory key"),
      value: z.string().describe("Value to store"),
    }),
    handler: memoryWriteHandler,
  },
  {
    name: "memory_search",
    toolset: "memory",
    description: "Search built-in memory entries.",
    emoji: "🔎",
    schema: objectSchema({
      query: z.string().describe("Search query"),
    }),
    handler: memoryReadHandler,
  },
  {
    name: "skill_invoke",
    toolset: "skills",
    description: "Invoke an installed skill.",
    emoji: "✨",
    schema: objectSchema({
      skill: z.string().describe("Skill name"),
      prompt: z.string().describe("Input prompt"),
    }),
    handler: skillInvokeHandler,
  },
  {
    name: "skill_search",
    toolset: "skills",
    description: "Search available skills.",
    emoji: "🔎",
    schema: objectSchema({
      query: z.string().describe("Search query"),
    }),
    handler: skillInvokeHandler,
  },
  {
    name: "execute_code",
    toolset: "code_execution",
    description: "Execute code in a sandboxed environment.",
    emoji: "⚡",
    tags: ["execute_code"],
    schema: objectSchema({
      code: z.string().describe("Code to execute"),
      language: z.enum(["python", "typescript", "bash", "javascript"]).describe("Language"),
      timeout: z.number().optional().describe("Timeout in seconds"),
    }),
    handler: executeCodeHandler,
  },
  {
    name: "execute_code_status",
    toolset: "code_execution",
    description: "Check status of a code execution job.",
    emoji: "📊",
    tags: ["execute_code"],
    schema: objectSchema({
      job_id: z.string().describe("Job id"),
    }),
    handler: echoHandler,
  },
  {
    name: "cronjob_schedule",
    toolset: "cronjob",
    description: "Schedule a recurring or one-off cron job.",
    emoji: "⏰",
    tags: ["cronjob"],
    schema: objectSchema({
      schedule: z.string().describe("Cron expression or natural language"),
      prompt: z.string().describe("Prompt to run"),
    }),
    handler: cronjobScheduleHandler,
  },
  {
    name: "cronjob_list",
    toolset: "cronjob",
    description: "List scheduled cron jobs.",
    emoji: "📋",
    tags: ["cronjob"],
    schema: objectSchema({}),
    handler: echoHandler,
  },
  {
    name: "cronjob_cancel",
    toolset: "cronjob",
    description: "Cancel a scheduled cron job.",
    emoji: "🗑️",
    tags: ["cronjob"],
    schema: objectSchema({
      id: z.string().describe("Cron job id"),
    }),
    handler: echoHandler,
  },
  {
    name: "desktop_notify",
    toolset: "desktop_ui",
    description: "Show a native desktop notification.",
    emoji: "🔔",
    schema: objectSchema({
      message: z.string().describe("Notification body"),
      title: z.string().optional().describe("Notification title"),
    }),
    handler: desktopNotifyHandler,
  },
  {
    name: "desktop_pick_file",
    toolset: "desktop_ui",
    description: "Open a native file picker and return the selected path.",
    emoji: "📂",
    schema: objectSchema({
      multiple: z.boolean().optional().describe("Allow multiple selection"),
    }),
    handler: echoHandler,
  },
  {
    name: "desktop_preview",
    toolset: "desktop_ui",
    description: "Preview a file or image in the desktop UI.",
    emoji: "👁️",
    schema: objectSchema({
      path: z.string().describe("File path"),
    }),
    handler: echoHandler,
  },
  {
    name: "project_list",
    toolset: "project",
    description: "List configured projects / workspaces.",
    emoji: "📁",
    schema: objectSchema({}),
    handler: projectListHandler,
  },
  {
    name: "project_switch",
    toolset: "project",
    description: "Switch active project / workspace.",
    emoji: "🔄",
    schema: objectSchema({
      path: z.string().describe("Project path"),
    }),
    handler: echoHandler,
  },
  {
    name: "project_index",
    toolset: "project",
    description: "Index a project for search and context.",
    emoji: "🗂️",
    schema: objectSchema({
      path: z.string().describe("Project path"),
    }),
    handler: echoHandler,
  },
  {
    name: "browser_navigate",
    toolset: "browser",
    description: "Navigate a browser instance to a URL.",
    emoji: "🧭",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      url: browserToolSchemas.navigate.shape.url,
      timeout: browserToolSchemas.navigate.shape.timeout,
    }),
    handler: browserNavigate as ToolHandler,
  },
  {
    name: "browser_snapshot",
    toolset: "browser",
    description: "Return an accessibility-tree snapshot of the current page.",
    emoji: "📸",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      full: browserToolSchemas.snapshot.shape.full,
      maxChars: browserToolSchemas.snapshot.shape.maxChars,
    }),
    handler: browserSnapshot as ToolHandler,
  },
  {
    name: "browser_click",
    toolset: "browser",
    description: "Click an element referenced by @e1, @e2, etc.",
    emoji: "🖱️",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      ref: browserToolSchemas.click.shape.ref,
    }),
    handler: browserClick as ToolHandler,
  },
  {
    name: "browser_type",
    toolset: "browser",
    description: "Type text into an input or textarea element.",
    emoji: "⌨️",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      ref: browserToolSchemas.type.shape.ref,
      text: browserToolSchemas.type.shape.text,
      submit: browserToolSchemas.type.shape.submit,
    }),
    handler: browserType as ToolHandler,
  },
  {
    name: "browser_scroll",
    toolset: "browser",
    description: "Scroll the page in a direction.",
    emoji: "⬇️",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      direction: browserToolSchemas.scroll.shape.direction,
      amount: browserToolSchemas.scroll.shape.amount,
    }),
    handler: browserScroll as ToolHandler,
  },
  {
    name: "browser_back",
    toolset: "browser",
    description: "Navigate back in the browser history.",
    emoji: "🔙",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({}),
    handler: browserBack as ToolHandler,
  },
  {
    name: "browser_press",
    toolset: "browser",
    description: "Press a single key such as Enter or Tab.",
    emoji: "🔘",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      key: browserToolSchemas.press.shape.key,
    }),
    handler: browserPress as ToolHandler,
  },
  {
    name: "browser_console",
    toolset: "browser",
    description: "Read or evaluate in the browser console.",
    emoji: "🖥️",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      expression: browserToolSchemas.console.shape.expression,
      clear: browserToolSchemas.console.shape.clear,
    }),
    handler: browserConsole as ToolHandler,
  },
  {
    name: "browser_get_images",
    toolset: "browser",
    description: "List images on the current page.",
    emoji: "🖼️",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({}),
    handler: browserGetImages as ToolHandler,
  },
  {
    name: "browser_vision",
    toolset: "browser",
    description: "Ask a question about the current page screenshot.",
    emoji: "👁️",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      question: z.string().describe("Question about the page"),
      annotate: z.boolean().optional().describe("Draw annotations on the screenshot"),
    }),
    handler: browserVision as ToolHandler,
  },
  {
    name: "browser_cdp",
    toolset: "browser",
    description: "Send a raw CDP command to the browser.",
    emoji: "🧪",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      method: browserToolSchemas.cdp.shape.method,
      params: browserToolSchemas.cdp.shape.params,
      targetId: browserToolSchemas.cdp.shape.targetId,
      frameId: browserToolSchemas.cdp.shape.frameId,
    }),
    handler: browserCdp as ToolHandler,
  },
  {
    name: "browser_dialog",
    toolset: "browser",
    description: "Respond to or dismiss a browser dialog.",
    emoji: "💬",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      action: browserToolSchemas.dialog.shape.action,
      promptText: browserToolSchemas.dialog.shape.promptText,
      dialogId: browserToolSchemas.dialog.shape.dialogId,
    }),
    handler: browserDialog as ToolHandler,
  },
  {
    name: "browser_exec",
    toolset: "browser",
    description: "Execute Python browser-use CLI code (terminal-gated).",
    emoji: "🐍",
    checkFn: credentialGates.browser,
    schema: browserObjectSchema({
      code: browserToolSchemas.exec.shape.code,
      session: browserToolSchemas.exec.shape.session,
      timeoutS: browserToolSchemas.exec.shape.timeoutS,
    }),
    handler: browserExec as ToolHandler,
  },
  {
    name: "ha_call_service",
    toolset: "homeassistant",
    description: "Call a Home Assistant service.",
    emoji: "🏠",
    tags: ["ha"],
    requiresEnv: ["HOME_ASSISTANT_TOKEN"],
    checkFn: credentialGates.homeassistant,
    schema: objectSchema({
      domain: z.string().describe("Service domain"),
      service: z.string().describe("Service name"),
      entity_id: z.string().optional().describe("Entity id"),
    }),
    handler: haCallServiceHandler,
  },
  {
    name: "ha_get_state",
    toolset: "homeassistant",
    description: "Get Home Assistant entity state.",
    emoji: "🏠",
    tags: ["ha"],
    requiresEnv: ["HOME_ASSISTANT_TOKEN"],
    checkFn: credentialGates.homeassistant,
    schema: objectSchema({
      entity_id: z.string().describe("Entity id"),
    }),
    handler: echoHandler,
  },
  {
    name: "ha_list_entities",
    toolset: "homeassistant",
    description: "List Home Assistant entities.",
    emoji: "🏠",
    tags: ["ha"],
    requiresEnv: ["HOME_ASSISTANT_TOKEN"],
    checkFn: credentialGates.homeassistant,
    schema: objectSchema({
      domain: z.string().optional().describe("Filter by domain"),
    }),
    handler: echoHandler,
  },
  {
    name: "x_search",
    toolset: "x_search",
    description: "Search posts on X (Twitter).",
    emoji: "𝕏",
    requiresEnv: ["XAI_API_KEY"],
    checkFn: credentialGates.x_search,
    schema: objectSchema({
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results"),
    }),
    handler: xSearchHandler,
  },
  {
    name: "spotify_play",
    toolset: "spotify",
    description: "Start Spotify playback.",
    emoji: "🎵",
    requiresEnv: ["SPOTIFY_CLIENT_ID"],
    checkFn: credentialGates.spotify,
    schema: objectSchema({
      uri: z.string().describe("Track/playlist URI or URL"),
    }),
    handler: spotifyPlayHandler,
  },
  {
    name: "spotify_pause",
    toolset: "spotify",
    description: "Pause Spotify playback.",
    emoji: "🎵",
    checkFn: credentialGates.spotify,
    schema: objectSchema({}),
    handler: echoHandler,
  },
  {
    name: "spotify_search",
    toolset: "spotify",
    description: "Search Spotify catalog.",
    emoji: "🎵",
    checkFn: credentialGates.spotify,
    schema: objectSchema({
      query: z.string().describe("Search query"),
      type: z.enum(["track", "album", "artist", "playlist"]).optional(),
    }),
    handler: echoHandler,
  },
  {
    name: "image_generate",
    toolset: "image_gen",
    description: "Generate an image from a prompt.",
    emoji: "🖼️",
    schema: objectSchema({
      prompt: z.string().describe("Image prompt"),
      size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).optional(),
    }),
    handler: imageGenerateHandler,
  },
  {
    name: "video_generate",
    toolset: "video",
    description: "Generate a video from a prompt.",
    emoji: "🎬",
    schema: objectSchema({
      prompt: z.string().describe("Video prompt"),
      duration: z.number().optional().describe("Duration in seconds"),
    }),
    handler: echoHandler,
  },
  {
    name: "video_edit",
    toolset: "video",
    description: "Edit a video.",
    emoji: "🎬",
    schema: objectSchema({
      path: z.string().describe("Video file path"),
      prompt: z.string().describe("Edit instruction"),
    }),
    handler: echoHandler,
  },
  {
    name: "tts_speak",
    toolset: "tts",
    description: "Convert text to speech.",
    emoji: "🔊",
    schema: objectSchema({
      text: z.string().describe("Text to speak"),
      voice: z.string().optional().describe("Voice id"),
    }),
    handler: echoHandler,
  },
  {
    name: "stt_transcribe",
    toolset: "stt",
    description: "Transcribe audio to text.",
    emoji: "🎙️",
    schema: objectSchema({
      path: z.string().describe("Audio file path"),
      language: z.string().optional().describe("Language hint"),
    }),
    handler: echoHandler,
  },
  {
    name: "kanban_create_board",
    toolset: "kanban",
    description: "Create a kanban board.",
    emoji: "🗂️",
    schema: objectSchema({
      name: z.string().describe("Board name"),
    }),
    handler: kanbanCreateBoardHandler,
  },
  {
    name: "kanban_create_task",
    toolset: "kanban",
    description: "Create a task on a kanban board.",
    emoji: "🗂️",
    schema: objectSchema({
      board: z.string().describe("Board id"),
      title: z.string().describe("Task title"),
      lane: z.string().optional().describe("Lane id"),
    }),
    handler: echoHandler,
  },
  {
    name: "kanban_move_task",
    toolset: "kanban",
    description: "Move a kanban task between lanes.",
    emoji: "🗂️",
    schema: objectSchema({
      board: z.string().describe("Board id"),
      task: z.string().describe("Task id"),
      lane: z.string().describe("Destination lane id"),
    }),
    handler: echoHandler,
  },
  {
    name: "kanban_assign_worker",
    toolset: "kanban",
    description: "Assign a worker agent to a kanban task.",
    emoji: "🗂️",
    schema: objectSchema({
      board: z.string().describe("Board id"),
      task: z.string().describe("Task id"),
      worker: z.string().describe("Worker agent id"),
    }),
    handler: echoHandler,
  },
  {
    name: "kanban_board_status",
    toolset: "kanban",
    description: "Get current kanban board status.",
    emoji: "🗂️",
    schema: objectSchema({
      board: z.string().describe("Board id"),
    }),
    handler: echoHandler,
  },
  {
    name: "batch_run",
    toolset: "batch",
    description: "Run a batch of prompts or tasks with bounded concurrency.",
    emoji: "📦",
    schema: objectSchema({
      items: z.array(z.string()).describe("List of inputs"),
      concurrency: z.number().optional().describe("Max parallel tasks"),
    }),
    handler: batchRunHandler,
  },
  {
    name: "batch_status",
    toolset: "batch",
    description: "Check the status of a batch job.",
    emoji: "📊",
    schema: objectSchema({
      job_id: z.string().describe("Batch job id"),
    }),
    handler: echoHandler,
  },
  {
    name: "event_hook_register",
    toolset: "event_hooks",
    description: "Register an event hook.",
    emoji: "🪝",
    schema: objectSchema({
      event: z.enum(["message", "tool_call", "turn_complete", "session_start", "custom"]).describe("Event type"),
      pattern: z.string().optional().describe("Regex pattern to match"),
      action: z.string().describe("Action to run"),
    }),
    handler: eventHookRegisterHandler,
  },
  {
    name: "event_hook_trigger",
    toolset: "event_hooks",
    description: "Manually trigger matching event hooks.",
    emoji: "🪝",
    schema: objectSchema({
      event: z.enum(["message", "tool_call", "turn_complete", "session_start", "custom"]).describe("Event type"),
      payload: z.record(z.unknown()).optional().describe("Event payload"),
    }),
    handler: eventHookTriggerHandler,
  },
  {
    name: "event_hook_list",
    toolset: "event_hooks",
    description: "List registered event hooks.",
    emoji: "🪝",
    schema: objectSchema({}),
    handler: echoHandler,
  },
  {
    name: "deliverable_create",
    toolset: "deliverable",
    description: "Create a new deliverable package.",
    emoji: "📦",
    schema: objectSchema({
      name: z.string().describe("Deliverable name"),
      format: z.enum(["zip", "tar", "folder", "markdown"]).describe("Package format"),
    }),
    handler: deliverableCreateHandler,
  },
  {
    name: "deliverable_add_file",
    toolset: "deliverable",
    description: "Add a file to the active deliverable.",
    emoji: "📦",
    schema: objectSchema({
      path: z.string().describe("File path"),
      content: z.string().optional().describe("Optional inline content"),
    }),
    handler: deliverableAddFileHandler,
  },
  {
    name: "agent_swarm",
    toolset: "subagent",
    description: "Delegate a task to a swarm of subagents.",
    emoji: "🐝",
    schema: objectSchema({
      agents: z.array(z.string()).describe("Agent identifiers"),
      task: z.string().describe("Task description"),
    }),
    handler: agentSwarmHandler,
  },
  {
    name: "subagent_list",
    toolset: "subagent",
    description: "List registered subagents.",
    emoji: "🐝",
    schema: objectSchema({}),
    handler: echoHandler,
  },
  {
    name: "suggestions_get",
    toolset: "automation_helpers",
    description: "Get automation suggestions for a topic.",
    emoji: "💡",
    schema: objectSchema({
      topic: z.string().describe("Topic"),
    }),
    handler: suggestionsGetHandler,
  },
  {
    name: "blueprint_match",
    toolset: "automation_helpers",
    description: "Find matching automation blueprints.",
    emoji: "📐",
    schema: objectSchema({
      query: z.string().describe("Search query"),
    }),
    handler: blueprintMatchHandler,
  },
  {
    name: "blueprint_list",
    toolset: "automation_helpers",
    description: "List automation blueprints.",
    emoji: "📐",
    schema: objectSchema({}),
    handler: echoHandler,
  },
];

/** Register the built-in catalog into the global registry. */
export function registerBuiltinCatalog(): void {
  for (const entry of CATALOG) {
    register(entry);
  }
}

/** True after catalog registration. */
export function isCatalogRegistered(): boolean {
  return registry.names().length >= CATALOG.length;
}

/** Number of built-in catalog entries. */
export function builtinCatalogSize(): number {
  return CATALOG.length;
}

// Auto-register on import so downstream consumers have tools immediately.
registerBuiltinCatalog();
