/**
 * Thin OpenAI-Responses-style client for xAI's built-in `x_search` tool.
 */

import { webRequest, webRequestJSON } from "@/lib/web-search/http.js";
import type { XSearchArgs, XaiConfig } from "./types.js";
import type { XaiCredentials } from "./credentials.js";

const DEFAULT_TIMEOUT_SECONDS = 180;
const DEFAULT_RETRIES = 2;

function buildPayload(args: XSearchArgs, config: XaiConfig): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "x_search" };
  if (args.allowed_x_handles?.length) tool.allowed_x_handles = args.allowed_x_handles;
  if (args.excluded_x_handles?.length) tool.excluded_x_handles = args.excluded_x_handles;
  if (args.from_date) tool.from_date = args.from_date;
  if (args.to_date) tool.to_date = args.to_date;
  if (args.enable_image_understanding) tool.enable_image_understanding = true;
  if (args.enable_video_understanding) tool.enable_video_understanding = true;

  const payload: Record<string, unknown> = {
    model: config.model ?? "grok-4.5",
    input: [{ role: "user", content: args.query }],
    tools: [tool],
    store: false,
  };

  if (config.reasoning_effort) {
    payload.reasoning = { effort: config.reasoning_effort };
  }

  return payload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface XaiResponse {
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        start_index?: number;
        end_index?: number;
        url_citation?: { url?: string; title?: string };
      }>;
    }>;
  }>;
  error?: { message?: string; code?: string };
}

export async function postXSearch(
  args: XSearchArgs,
  creds: XaiCredentials,
  config: XaiConfig,
): Promise<XaiResponse> {
  const payload = buildPayload(args, config);
  const timeoutSeconds = Math.max(30, config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
  const retries = Math.max(0, config.retries ?? DEFAULT_RETRIES);
  const url = `${creds.baseUrl.replace(/\/$/, "")}/responses`;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await webRequest({
        url,
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        timeoutMs: timeoutSeconds * 1000,
      });

      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        let body: { error?: { message?: string; code?: string } } = {};
        try {
          body = JSON.parse(response.body);
        } catch {
          // ignore
        }
        const message = body.error?.message || `HTTP ${response.status}`;
        if (attempt < retries) {
          lastError = new Error(message);
          await sleep(Math.min(5000, 1500 * (attempt + 1)));
          continue;
        }
        throw new Error(message);
      }

      if (!response.ok) {
        let body: { error?: { message?: string; code?: string } } = {};
        try {
          body = JSON.parse(response.body);
        } catch {
          // ignore
        }
        const code = body.error?.code ? `code: ${body.error.code}` : "";
        throw new Error(`${code} ${body.error?.message || `HTTP ${response.status}: ${response.body.slice(0, 200)}`}`.trim());
      }

      return JSON.parse(response.body) as XaiResponse;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt >= retries) break;
      await sleep(Math.min(5000, 1500 * (attempt + 1)));
    }
  }

  throw lastError ?? new Error("xAI request failed");
}