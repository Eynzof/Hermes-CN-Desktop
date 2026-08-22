/**
 * In-process `x_search` tool registration.
 */

import { register, type ToolContext, type ToolResult, type ToolParameterSchema } from "@hermes/agent-tools";
import { normalizeHandles, validateDateRange } from "./validation.js";
import { resolveXaiCredentials, hasXaiCredentials } from "./credentials.js";
import { loadXaiConfig, resetXaiConfigCache } from "./config.js";
import { postXSearch, type XaiResponse } from "./responses-client.js";
import { buildXSearchResult } from "./result.js";
import type { XSearchArgs, XSearchResult } from "./types.js";

const xSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Natural-language X/Twitter search query" },
    allowed_x_handles: {
      type: "array",
      items: { type: "string" },
      description: "Restrict results to these X handles (max 10). Mutually exclusive with excluded_x_handles.",
    },
    excluded_x_handles: {
      type: "array",
      items: { type: "string" },
      description: "Exclude these X handles from results (max 10).",
    },
    from_date: { type: "string", description: "Start date YYYY-MM-DD (UTC). Must not be in the future." },
    to_date: { type: "string", description: "End date YYYY-MM-DD (UTC). May be in the future." },
    enable_image_understanding: { type: "boolean", description: "Allow Grok to analyze linked images." },
    enable_video_understanding: { type: "boolean", description: "Allow Grok to analyze linked videos." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseArgs(raw: unknown): { args?: XSearchArgs; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "x_search args must be an object" };
  const r = raw as Record<string, unknown>;
  const query = typeof r.query === "string" ? r.query : "";
  if (!query.trim()) return { error: "query is required" };

  const allowed = isStringArray(r.allowed_x_handles) ? r.allowed_x_handles : undefined;
  const excluded = isStringArray(r.excluded_x_handles) ? r.excluded_x_handles : undefined;

  if (allowed?.length && excluded?.length) {
    return { error: "allowed_x_handles and excluded_x_handles are mutually exclusive" };
  }

  const args: XSearchArgs = { query };
  if (allowed) args.allowed_x_handles = allowed;
  if (excluded) args.excluded_x_handles = excluded;
  if (typeof r.from_date === "string") args.from_date = r.from_date;
  if (typeof r.to_date === "string") args.to_date = r.to_date;
  if (r.enable_image_understanding === true) args.enable_image_understanding = true;
  if (r.enable_video_understanding === true) args.enable_video_understanding = true;
  return { args };
}

export function buildXSearchError(
  error: string,
  errorType?: string,
  partial?: Partial<XSearchResult>,
): XSearchResult {
  return {
    success: false,
    provider: "xai",
    credential_source: "xai",
    tool: "x_search",
    model: partial?.model ?? "",
    query: partial?.query ?? "",
    answer: "",
    citations: [],
    inline_citations: [],
    degraded: false,
    degraded_reason: null,
    error,
    error_type: errorType,
  };
}

register({
  name: "x_search",
  toolset: "x_search",
  description:
    "Search public X (Twitter) posts and profiles. Returns a synthesized answer with citations. " +
    "Read-only: this tool cannot post, like, or log in to X.",
  emoji: "🐦",
  maxResultSizeChars: 100_000,
  requiresEnv: ["XAI_API_KEY"],
  schema: xSearchSchema as ToolParameterSchema,
  checkFn: (ctx?: ToolContext) => hasXaiCredentials(ctx),
  handler: async (raw: unknown, ctx: ToolContext): Promise<ToolResult> => {
    resetXaiConfigCache();

    const parsed = parseArgs(raw);
    if (parsed.error || !parsed.args) {
      return { content: JSON.stringify(buildXSearchError(parsed.error ?? "invalid args")), isError: true };
    }
    const args = parsed.args;

    const allowed = normalizeHandles(args.allowed_x_handles, "allowed_x_handles");
    if (allowed.error) {
      return { content: JSON.stringify(buildXSearchError(allowed.error)), isError: true };
    }
    const excluded = normalizeHandles(args.excluded_x_handles, "excluded_x_handles");
    if (excluded.error) {
      return { content: JSON.stringify(buildXSearchError(excluded.error)), isError: true };
    }

    if (allowed.handles) args.allowed_x_handles = allowed.handles;
    if (excluded.handles) args.excluded_x_handles = excluded.handles;

    const dateCheck = validateDateRange(args.from_date, args.to_date);
    if (!dateCheck.ok) {
      return { content: JSON.stringify(buildXSearchError(dateCheck.error)), isError: true };
    }

    const creds = resolveXaiCredentials(ctx);
    if (!creds) {
      return {
        content: JSON.stringify(buildXSearchError("No xAI credentials configured. Set XAI_API_KEY.")),
        isError: true,
      };
    }

    const config = await loadXaiConfig();
    const model = config.model || "grok-4.5";

    try {
      const response = await postXSearch(args, creds, config);
      const result = buildXSearchResult(args, response, creds, model);
      return { content: JSON.stringify(result) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorType = message.includes("code:") ? "xai_error" : "request_error";
      return { content: JSON.stringify(buildXSearchError(message, errorType, { query: args.query, model })), isError: true };
    }
  },
});
export { xSearchSchema };
export { resetXaiConfigCache, setXaiConfigForTest } from "./config.js";