/**
 * Desktop browser-tool bridge.
 *
 * Wires the in-process @hermes/browser handlers to Tauri invoke so the TS agent
 * loop can drive the Rust sidecar without the webview opening CDP sockets.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ToolContext } from "@hermes/agent-tools";

const browserCommands = [
  "browser_sidecar_start",
  "browser_sidecar_stop",
  "browser_cdp_probe",
  "browser_launch_chrome_debug",
  "browser_event_subscribe",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_press",
  "browser_console",
  "browser_get_images",
  "browser_vision",
  "browser_cdp",
  "browser_dialog",
  "browser_exec",
] as const;

export type BrowserCommand = (typeof browserCommands)[number];

export function browserInvoker(command: BrowserCommand, args: Record<string, unknown>): Promise<unknown> {
  return invoke(command, args);
}

/**
 * Build a ToolContext whose `invoke` is bound to the Rust browser commands.
 */
export function withBrowserInvoker(ctx: ToolContext): ToolContext {
  return {
    ...ctx,
    invoke: (command: string, args: Record<string, unknown>) => browserInvoker(command as BrowserCommand, args),
  };
}
