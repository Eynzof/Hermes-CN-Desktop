/**
 * Home Assistant tool handlers.
 *
 * Implements the four LLM-callable tools:
 * - ha_list_entities
 * - ha_get_state
 * - ha_list_services
 * - ha_call_service
 *
 * Result envelopes match the Python implementation: `{ result: ... }` on success
 * and `{ error: ... }` on failure.
 */

import { HassClient } from "./client.js";
import { parseStringData } from "./security.js";
import type { ToolContext, ToolResult } from "../types.js";

function toolError(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function toolSuccess(value: unknown): ToolResult {
  return { content: JSON.stringify({ result: value }) };
}

function getClient(ctx: ToolContext): HassClient {
  const env = ctx.env ?? {};
  const url = env.HASS_URL ?? env.HOME_ASSISTANT_URL ?? "http://homeassistant.local:8123";
  const token = env.HASS_TOKEN ?? env.HOME_ASSISTANT_TOKEN;
  if (!token) {
    throw new Error("HASS_TOKEN is not configured");
  }
  return new HassClient({ url, token, haRequest: ctx.haRequest, invoke: ctx.invoke });
}

export async function haListEntities(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const a = args as { domain?: string; area?: string };
  try {
    const client = getClient(ctx);
    const result = await client.listStates({ domain: a.domain, area: a.area });
    return toolSuccess(result);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function haGetState(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const a = args as { entity_id?: string };
  try {
    if (!a.entity_id) {
      return toolError("entity_id is required");
    }
    const client = getClient(ctx);
    const result = await client.getState(a.entity_id);
    return toolSuccess(result);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function haListServices(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const a = args as { domain?: string };
  try {
    const client = getClient(ctx);
    const result = await client.listServices(a.domain);
    return toolSuccess(result);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function haCallService(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const a = args as { domain?: string; service?: string; entity_id?: string; data?: unknown };
  try {
    if (!a.domain) {
      return toolError("domain is required");
    }
    if (!a.service) {
      return toolError("service is required");
    }
    const data = parseStringData(a.data);
    const client = getClient(ctx);
    const result = await client.callService(a.domain, a.service, a.entity_id, data);
    return toolSuccess(result);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}
