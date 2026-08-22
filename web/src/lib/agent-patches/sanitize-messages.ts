/**
 * Python `sanitize_api_messages` parity layer.
 *
 * Runs before every LLM request:
 *  - drops messages whose role is not accepted by chat-completions APIs
 *  - drops empty-content assistant/user/function turns with no payload
 *  - normalizes empty/malformed `tool_calls` arrays on assistant turns
 *  - repairs blank tool-call function names to a sentinel
 *  - drops orphaned tool results and injects stub results for missing ones
 *  - deduplicates repeated `tool_call_id` references
 */

import type { ApiMessage, SanitizeResult } from "./types";

export const VALID_API_ROLES = new Set([
  "system",
  "user",
  "assistant",
  "tool",
  "function",
  "developer",
]);

export const EMPTY_CONTENT_ROLES = new Set(["assistant", "user", "function"]);

export const ASSISTANT_PAYLOAD_FIELDS = [
  "tool_calls",
  "codex_reasoning_items",
  "codex_message_items",
  "reasoning_content",
] as const;

export const EMPTY_NAME_SENTINEL = "invalid_tool_call";
export const STUB_RESULT_CONTENT =
  "[Result unavailable — see context summary above]";

function getToolCallFunctionAndId(tc: unknown): {
  fn: Record<string, unknown> | undefined;
  name: unknown;
  id: string;
} {
  if (tc && typeof tc === "object") {
    const tcd = tc as Record<string, unknown>;
    let fn: Record<string, unknown> | undefined;
    let name: unknown;
    if (typeof tcd.function === "object" && tcd.function !== null) {
      fn = tcd.function as Record<string, unknown>;
      name = fn.name;
    }
    const id =
      String(tcd.call_id ?? "").trim() || String(tcd.id ?? "").trim();
    return { fn, name, id };
  }
  return { fn: undefined, name: undefined, id: "" };
}

function isBlankName(name: unknown): boolean {
  return typeof name !== "string" || name.trim() === "";
}

function getToolCallName(tc: unknown): string {
  const { name, id } = getToolCallFunctionAndId(tc);
  if (typeof name === "string" && name.trim()) return name.trim();
  return id ? "" : EMPTY_NAME_SENTINEL;
}

export function assistantHasPayload(msg: ApiMessage): boolean {
  for (const field of ASSISTANT_PAYLOAD_FIELDS) {
    const value = msg[field];
    if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
      return true;
    }
  }
  return false;
}

export function isEmptyContentDroppable(
  msg: ApiMessage,
  role?: string,
): boolean {
  if (role === undefined) role = msg.role;
  if (!role || !EMPTY_CONTENT_ROLES.has(role)) return false;
  if (msg.content !== "") return false;
  if (role === "assistant" && assistantHasPayload(msg)) return false;
  return true;
}

function repairBlankName(tc: unknown): boolean {
  const { fn, name } = getToolCallFunctionAndId(tc);
  if (!isBlankName(name)) return false;
  if (fn) {
    fn.name = EMPTY_NAME_SENTINEL;
    return true;
  }
  // No function container: synthesize one so the call keeps its pairing.
  if (tc && typeof tc === "object") {
    (tc as Record<string, unknown>).function = {
      name: EMPTY_NAME_SENTINEL,
      arguments: "{}",
    };
    return true;
  }
  return false;
}

/**
 * Sanitize a list of API-bound messages.
 *
 * The function never mutates the input list, but may mutate tool-call objects
 * nested inside shallow copies of assistant messages (same strategy as Python:
 * repair in place to keep call/result pairing).
 */
export function sanitizeApiMessages(messages: ApiMessage[]): SanitizeResult {
  let dropped = 0;
  let droppedEmptyToolCalls = 0;
  let repairedBlankNames = 0;

  const filtered: ApiMessage[] = [];
  const survivingCallIds = new Set<string>();
  const resultCallIds = new Set<string>();

  for (const rawMsg of messages) {
    const role = rawMsg.role;
    // (a) Drop invalid roles.
    if (!role || !VALID_API_ROLES.has(role)) {
      dropped += 1;
      continue;
    }

    // (b) Drop empty-content messages with no payload.
    if (isEmptyContentDroppable(rawMsg, role)) {
      dropped += 1;
      continue;
    }

    // Work on a shallow copy so normalization does not mutate stored history.
    let msg: ApiMessage = { ...rawMsg };

    // (b2) Normalize empty/malformed `tool_calls` on assistant turns.
    if (role === "assistant" && "tool_calls" in msg) {
      const tcs = msg.tool_calls;
      if (!Array.isArray(tcs) || tcs.length === 0) {
        const { tool_calls: _, ...rest } = msg;
        msg = rest;
        droppedEmptyToolCalls += 1;
      }
    }

    // (c) Repair blank tool-call names and record surviving ids.
    if (role === "assistant") {
      const tcs = msg.tool_calls;
      if (Array.isArray(tcs) && tcs.length > 0) {
        for (const tc of tcs) {
          if (repairBlankName(tc)) {
            repairedBlankNames += 1;
          }
          const { id } = getToolCallFunctionAndId(tc);
          if (id) survivingCallIds.add(id);
        }
      }
    } else if (role === "tool") {
      const cid = String(msg.tool_call_id ?? "").trim();
      if (cid) resultCallIds.add(cid);
    }

    filtered.push(msg);
  }

  // Fast exit: nothing to reconcile.
  if (survivingCallIds.size === 0 && resultCallIds.size === 0) {
    return {
      messages: filtered,
      dropped,
      droppedEmptyToolCalls,
      repairedBlankNames,
      orphanedResults: 0,
      missingResultStubs: 0,
      duplicateToolCallIds: 0,
    };
  }

  // 1. Drop tool results with no matching assistant call.
  const orphaned = new Set(resultCallIds);
  for (const id of survivingCallIds) orphaned.delete(id);
  let messages2: ApiMessage[] = filtered;
  if (orphaned.size > 0) {
    messages2 = filtered.filter(
      (m) =>
        !(
          m.role === "tool" &&
          orphaned.has(String(m.tool_call_id ?? "").trim())
        ),
    );
  }

  // 2. Inject stub results for calls whose result was dropped.
  const missing = new Set<string>();
  for (const id of survivingCallIds) {
    if (!resultCallIds.has(id)) missing.add(id);
  }
  let messages3 = messages2;
  if (missing.size > 0) {
    const patched: ApiMessage[] = [];
    for (const msg of messages2) {
      patched.push(msg);
      if (msg.role === "assistant") {
        const tcs = msg.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const cid = getToolCallFunctionAndId(tc).id;
            if (cid && missing.has(cid)) {
              patched.push({
                role: "tool",
                name: getToolCallName(tc),
                content: STUB_RESULT_CONTENT,
                tool_call_id: cid,
              });
            }
          }
        }
      }
    }
    messages3 = patched;
  }

  // 3. Deduplicate tool_call_ids.
  const seenAssistantCallIds = new Set<string>();
  const seenResultCallIds = new Set<string>();
  const deduped: ApiMessage[] = [];
  let duplicateToolCallIds = 0;
  for (const msg of messages3) {
    if (msg.role === "assistant") {
      const tcs = msg.tool_calls;
      if (Array.isArray(tcs) && tcs.length > 0) {
        const kept: unknown[] = [];
        for (const tc of tcs) {
          const cid = getToolCallFunctionAndId(tc).id;
          if (cid && seenAssistantCallIds.has(cid)) {
            duplicateToolCallIds += 1;
            continue;
          }
          if (cid) seenAssistantCallIds.add(cid);
          kept.push(tc);
        }
        if (kept.length !== tcs.length) {
          deduped.push({ ...msg, tool_calls: kept });
          continue;
        }
      }
      deduped.push(msg);
    } else if (msg.role === "tool") {
      const cid = String(msg.tool_call_id ?? "").trim();
      if (cid && seenResultCallIds.has(cid)) {
        duplicateToolCallIds += 1;
        continue;
      }
      if (cid) seenResultCallIds.add(cid);
      deduped.push(msg);
    } else {
      deduped.push(msg);
    }
  }

  return {
    messages: deduped,
    dropped,
    droppedEmptyToolCalls,
    repairedBlankNames,
    orphanedResults: orphaned.size,
    missingResultStubs: missing.size,
    duplicateToolCallIds,
  };
}
