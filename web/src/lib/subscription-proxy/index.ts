import { invoke } from "@tauri-apps/api/core";
import type { ProxyProvider, ProxyStatus } from "./types.js";

export async function subscriptionProxyStart(provider: ProxyProvider): Promise<ProxyStatus> {
  return invoke<ProxyStatus>("subscription_proxy_start", { provider });
}

export async function subscriptionProxyStop(): Promise<void> {
  return invoke("subscription_proxy_stop");
}

export async function subscriptionProxyStatus(): Promise<ProxyStatus> {
  return invoke<ProxyStatus>("subscription_proxy_status");
}

export async function subscriptionProxyProviders(): Promise<ProxyProvider[]> {
  return invoke<ProxyProvider[]>("subscription_proxy_providers");
}

export * from "./types.js";
