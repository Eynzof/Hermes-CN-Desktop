import type { ConnectionMode } from "@hermes/protocol";

/**
 * External Hermes instances can have expensive user-specific MCP and memory
 * providers. Prewarming them merely by opening the desktop can starve the
 * target Dashboard's Python event loop before the user submits anything.
 */
export function shouldPrewarmDraftSession(mode: ConnectionMode | undefined): boolean {
  // Fail closed while the runtime config is still unavailable. Treating an
  // unknown mode as managed can create a session on an attached backend during
  // startup, before the desktop has exposed that it is actually local/remote.
  return mode === "managed";
}
