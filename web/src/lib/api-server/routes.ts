import { handleChatCompletion } from "./chat-completions.js";
import type { ChatCompletionRequest } from "./schemas.js";

export interface ApiRouteContext {
  path: string;
  method: string;
  body: unknown;
}

export type ApiRouteHandler = (ctx: ApiRouteContext) => unknown;

export const API_ROUTES: Array<{ method: string; path: string; handler: ApiRouteHandler }> = [
  { method: "GET", path: "/health", handler: () => ({ status: "ok" }) },
  { method: "GET", path: "/v1/models", handler: () => ({ object: "list", data: [] }) },
  { method: "GET", path: "/v1/capabilities", handler: () => ({ capabilities: [] }) },
  { method: "GET", path: "/v1/skills", handler: () => ({ skills: [] }) },
  { method: "GET", path: "/v1/toolsets", handler: () => ({ toolsets: [] }) },
  {
    method: "POST",
    path: "/v1/chat/completions",
    handler: (ctx) => handleChatCompletion(ctx.body as ChatCompletionRequest),
  },
  {
    method: "POST",
    path: "/v1/responses",
    handler: (ctx) => ({ id: `resp-${Date.now()}`, output: [{ type: "message", content: ctx.body }] }),
  },
  {
    method: "POST",
    path: "/v1/runs",
    handler: (ctx) => ({ run_id: `run-${Date.now()}`, status: "queued", input: ctx.body }),
  },
  { method: "GET", path: "/v1/sessions", handler: () => ({ sessions: [] }) },
  { method: "GET", path: "/v1/jobs", handler: () => ({ jobs: [] }) },
];

export function matchApiRoute(method: string, path: string) {
  return API_ROUTES.find((r) => r.method === method && r.path === path);
}
