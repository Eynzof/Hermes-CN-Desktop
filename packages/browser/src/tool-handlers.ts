import { z } from "zod";
import { BrowserProviderRegistry } from "./registry.js";
import { BrowserSessionManager } from "./session-manager.js";
import {
  BrowserConfig,
  BrowserNavigateInput,
  BrowserSnapshotInput,
  BrowserClickInput,
  BrowserTypeInput,
  BrowserScrollInput,
  BrowserPressInput,
  BrowserConsoleInput,
  BrowserDialogInput,
  BrowserExecInput,
  BrowserCdpInput,
  BrowserBackendKind,
  BrowserSessionRecord,
} from "./schemas.js";
import type { BrowserProvider } from "./provider.js";
import type { BrowserSessionRecord as BrowserSessionRecordType } from "./schemas.js";
import {
  LocalBrowserProvider,
  BrowserbaseProvider,
  BrowserUseCloudProvider,
  FirecrawlProvider,
  CamofoxProvider,
} from "./backends/index.js";

export interface BrowserInvoker {
  (command: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface BrowserToolContext {
  sessionId?: string;
  invoke?: BrowserInvoker;
  env?: Record<string, string | undefined>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

function browserRegistryForContext(ctx: BrowserToolContext): BrowserProviderRegistry {
  const registry = new BrowserProviderRegistry();
  const env = ctx.env ?? {};
  registry.register(new LocalBrowserProvider({ invoke: ctx.invoke }));
  registry.register(new BrowserbaseProvider(env));
  registry.register(new BrowserUseCloudProvider(env));
  registry.register(new FirecrawlProvider(env));
  registry.register(new CamofoxProvider(env));
  return registry;
}

const sessionManager = new BrowserSessionManager({ inactivityTimeoutMs: 300_000 });

function makeSessionRecord(taskId: string, backend: BrowserBackendKind): BrowserSessionRecordType {
  return BrowserSessionRecord.parse({ taskId, backend });
}

async function getOrCreateSession(ctx: BrowserToolContext): Promise<{ provider: BrowserProvider; sessionId: string }> {
  const taskId = ctx.sessionId ?? "default";
  let record = sessionManager.get(taskId);
  const config = BrowserConfig.parse({});
  if (!record) {
    const resolved = await browserRegistryForContext(ctx).resolve(config, { env: ctx.env });
    const created = await resolved.provider.createSession(taskId, config);
    record = sessionManager.set(BrowserSessionRecord.parse({ ...created, backend: resolved.kind }));
  }
  const registry = browserRegistryForContext(ctx);
  const provider = registry.get(record.backend);
  if (!provider) {
    throw new Error(`Browser backend ${record.backend} is not registered`);
  }
  sessionManager.touch(taskId);
  return { provider, sessionId: record.taskId };
}

function resultToToolResult(result: { success: boolean; error?: string; snapshot?: string; [key: string]: unknown }): ToolResult {
  if (!result.success) {
    return { content: result.error ?? "Browser operation failed", isError: true };
  }
  const { success, ...rest } = result;
  const text = typeof rest.snapshot === "string"
    ? rest.snapshot
    : JSON.stringify(rest, null, 2);
  return { content: text };
}

export async function browserNavigate(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserNavigateInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.navigate) {
    return { content: "Backend does not support navigate", isError: true };
  }
  const result = await provider.navigate(
    makeSessionRecord(sessionId, BrowserBackendKind.Enum.local),
    input.url,
    input.timeout,
  );
  return resultToToolResult(result);
}

export async function browserSnapshot(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserSnapshotInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.snapshot) {
    return { content: "Backend does not support snapshot", isError: true };
  }
  const result = await provider.snapshot(makeSessionRecord(sessionId, BrowserBackendKind.Enum.local), input.full);
  return resultToToolResult(result);
}

export async function browserClick(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserClickInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.click) {
    return { content: "Backend does not support click", isError: true };
  }
  const result = await provider.click(makeSessionRecord(sessionId, BrowserBackendKind.Enum.local), input.ref);
  return resultToToolResult(result);
}

export async function browserType(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserTypeInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.type) {
    return { content: "Backend does not support type", isError: true };
  }
  const result = await provider.type(
    makeSessionRecord(sessionId, BrowserBackendKind.Enum.local),
    input.ref,
    input.text,
    input.submit,
  );
  return resultToToolResult(result);
}

export async function browserScroll(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserScrollInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.scroll) {
    return { content: "Backend does not support scroll", isError: true };
  }
  const result = await provider.scroll(
    makeSessionRecord(sessionId, BrowserBackendKind.Enum.local),
    input.direction,
    input.amount,
  );
  return resultToToolResult(result);
}

export async function browserBack(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.back) {
    return { content: "Backend does not support back", isError: true };
  }
  const result = await provider.back(makeSessionRecord(sessionId, BrowserBackendKind.Enum.local));
  return resultToToolResult(result);
}

export async function browserPress(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserPressInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.press) {
    return { content: "Backend does not support press", isError: true };
  }
  const result = await provider.press(makeSessionRecord(sessionId, BrowserBackendKind.Enum.local), input.key);
  return resultToToolResult(result);
}

export async function browserConsole(args: unknown, ctx: BrowserToolContext): Promise<ToolResult> {
  const input = BrowserConsoleInput.parse(args);
  const { provider, sessionId } = await getOrCreateSession(ctx);
  if (!provider.console) {
    return { content: "Backend does not support console", isError: true };
  }
  const result = await provider.console(
    makeSessionRecord(sessionId, BrowserBackendKind.Enum.local),
    input.expression,
    input.clear,
  );
  return resultToToolResult(result);
}

// Placeholders for tools that require sidecar/vision support beyond the first cut.
export async function browserGetImages(): Promise<ToolResult> {
  return { content: "browser_get_images not yet implemented in local backend" };
}

export async function browserVision(): Promise<ToolResult> {
  return { content: "browser_vision not yet implemented in local backend" };
}

export async function browserCdp(): Promise<ToolResult> {
  return { content: "browser_cdp not yet implemented in local backend" };
}

export async function browserDialog(): Promise<ToolResult> {
  return { content: "browser_dialog not yet implemented in local backend" };
}

export async function browserExec(): Promise<ToolResult> {
  return { content: "browser_exec not yet implemented in local backend" };
}

export const browserToolSchemas = {
  navigate: BrowserNavigateInput,
  snapshot: BrowserSnapshotInput,
  click: BrowserClickInput,
  type: BrowserTypeInput,
  scroll: BrowserScrollInput,
  press: BrowserPressInput,
  console: BrowserConsoleInput,
  dialog: BrowserDialogInput,
  exec: BrowserExecInput,
  cdp: BrowserCdpInput,
};

export function zodToJsonSchema(zt: z.ZodTypeAny): Record<string, unknown> {
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
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodTypeAny);
      if (!(value as z.ZodTypeAny).isOptional()) required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (def.typeName === "ZodOptional") return zodToJsonSchema(def.innerType);
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: def.values };
  }
  if (def.typeName === "ZodDefault") return zodToJsonSchema(def.innerType);
  return { type: "string" };
}

export function objectSchema(shape: Record<string, z.ZodTypeAny>, required?: string[]) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, zodToJsonSchema(v)])),
    required: required ?? Object.keys(shape),
    additionalProperties: false,
  };
}
