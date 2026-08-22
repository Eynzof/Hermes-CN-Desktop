import { z } from "zod";

export const BrowserBackendKind = z.enum([
  "local",
  "cdp",
  "browserbase",
  "browser-use",
  "firecrawl",
  "camofox",
  "lightpanda",
  "agent-browser",
]);
export type BrowserBackendKind = z.infer<typeof BrowserBackendKind>;

export const BrowserConfig = z
  .object({
    backend: BrowserBackendKind.default("local"),
    cloudProvider: z.string().optional(),
    cdpUrl: z.string().optional(),
    commandTimeout: z.number().int().min(1).default(30),
    headed: z.boolean().default(false),
    recordSessions: z.boolean().default(false),
    inactivityTimeout: z.number().int().min(0).default(300),
    engine: z.enum(["chromium", "lightpanda"]).default("chromium"),
    autoLocalForPrivateUrls: z.boolean().default(true),
    allowPrivateUrls: z.boolean().default(false),
    dialogPolicy: z.enum(["must_respond", "auto_dismiss", "auto_accept"]).default("auto_dismiss"),
    dialogTimeoutS: z.number().int().min(1).default(30),
    camofox: z
      .object({
        url: z.string().optional(),
        managedPersistence: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});
export type BrowserConfig = z.infer<typeof BrowserConfig>;

export const BrowserSessionRecord = z.object({
  taskId: z.string(),
  backend: BrowserBackendKind,
  sessionName: z.string().optional(),
  bbSessionId: z.string().optional(),
  cdpUrl: z.string().optional(),
  expiresAt: z.string().optional(),
  features: z.record(z.unknown()).default({}),
  externalCallId: z.string().optional(),
  lastActiveAt: z.number().default(() => Date.now()),
});
export type BrowserSessionRecord = z.infer<typeof BrowserSessionRecord>;

export const BrowserNavigateInput = z.object({
  url: z.string().describe("URL to navigate to"),
  timeout: z.number().int().min(1).optional().describe("Navigation timeout in seconds"),
});
export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInput>;

export const BrowserSnapshotInput = z.object({
  full: z.boolean().optional().describe("Include the full accessibility tree"),
  maxChars: z.number().int().min(1).optional().describe("Max snapshot characters"),
});
export type BrowserSnapshotInput = z.infer<typeof BrowserSnapshotInput>;

export const BrowserClickInput = z.object({
  ref: z.string().describe("Element reference such as @e1"),
});
export type BrowserClickInput = z.infer<typeof BrowserClickInput>;

export const BrowserTypeInput = z.object({
  ref: z.string().describe("Element reference such as @e1"),
  text: z.string().describe("Text to type"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
});
export type BrowserTypeInput = z.infer<typeof BrowserTypeInput>;

export const BrowserScrollInput = z.object({
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.number().int().min(1).optional().describe("Pixels to scroll"),
});
export type BrowserScrollInput = z.infer<typeof BrowserScrollInput>;

export const BrowserPressInput = z.object({
  key: z.string().describe("Key to press (e.g. Enter, Tab)"),
});
export type BrowserPressInput = z.infer<typeof BrowserPressInput>;

export const BrowserConsoleInput = z.object({
  expression: z.string().optional().describe("Optional JavaScript expression to evaluate"),
  clear: z.boolean().optional().describe("Clear console history after reading"),
});
export type BrowserConsoleInput = z.infer<typeof BrowserConsoleInput>;

export const BrowserDialogAction = z.enum(["accept", "dismiss", "respond"]);
export const BrowserDialogInput = z.object({
  action: BrowserDialogAction.describe("Dialog action"),
  promptText: z.string().optional().describe("Text for respond action"),
  dialogId: z.string().optional().describe("Specific dialog id"),
});
export type BrowserDialogInput = z.infer<typeof BrowserDialogInput>;

export const BrowserExecInput = z.object({
  code: z.string().describe("Python or browser-use CLI code"),
  session: z.string().optional().describe("Session identifier"),
  timeoutS: z.number().int().min(1).optional().describe("Timeout in seconds"),
});
export type BrowserExecInput = z.infer<typeof BrowserExecInput>;

export const BrowserCdpInput = z.object({
  method: z.string().describe("CDP method name"),
  params: z.record(z.unknown()).optional().describe("CDP parameters"),
  targetId: z.string().optional(),
  frameId: z.string().optional(),
});
export type BrowserCdpInput = z.infer<typeof BrowserCdpInput>;

export const BrowserToolResult = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  backend: BrowserBackendKind.optional(),
  sessionName: z.string().optional(),
  snapshot: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  console: z.array(z.unknown()).optional(),
  pendingDialogs: z.array(z.unknown()).optional(),
  frameTree: z.unknown().optional(),
});
export type BrowserToolResult = z.infer<typeof BrowserToolResult>;
