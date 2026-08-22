import { invoke } from "@tauri-apps/api/core";
import type { ApiServerStatus } from "./schemas.js";

export async function apiServerStart(): Promise<ApiServerStatus> {
  return invoke<ApiServerStatus>("api_server_start");
}

export async function apiServerStop(): Promise<void> {
  return invoke("api_server_stop");
}

export async function apiServerStatus(): Promise<ApiServerStatus> {
  return invoke<ApiServerStatus>("api_server_status");
}

export * from "./schemas.js";
export * from "./routes.js";
export * from "./sse.js";
export * from "./chat-completions.js";
