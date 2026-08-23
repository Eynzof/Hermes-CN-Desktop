import type {
  WanderPortalAccountState,
  WanderPortalCheckoutSession,
  WanderPortalOrder,
  WanderPortalPlan,
  WanderPortalUsagePage,
} from "@hermes/protocol";

function bridge() {
  if (typeof window === "undefined") return undefined;
  return window.hermesDesktop;
}

function requireMethod<T>(method: T | undefined): T {
  if (!method) throw new Error("Wander Portal 仅支持社区桌面端");
  return method;
}

export function formatMicroCny(value: number): string {
  return `¥${(value / 1_000_000).toFixed(2)}`;
}

export function formatFen(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

export async function getWanderPortalAccountState(): Promise<WanderPortalAccountState> {
  return requireMethod(bridge()?.wanderPortalAccountState)();
}

export async function getWanderPortalPlans(): Promise<WanderPortalPlan[]> {
  return requireMethod(bridge()?.wanderPortalPlans)();
}

export async function redeemWanderInvite(code: string): Promise<{ granted: boolean }> {
  return requireMethod(bridge()?.wanderPortalRedeemInvite)(code);
}

export async function createWanderCheckout(
  kind: "subscription" | "topup",
  planSlug?: string,
): Promise<WanderPortalCheckoutSession> {
  return requireMethod(bridge()?.wanderPortalCreateCheckout)({
    kind,
    planSlug: planSlug ?? null,
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function openWanderCheckout(checkout: WanderPortalCheckoutSession): Promise<void> {
  const open = requireMethod(bridge()?.openExternalUrl);
  const result = await open({ url: checkout.checkout_url });
  if (!result.ok) throw new Error(result.message || "无法打开 Wander Portal 结算页");
}

export async function getWanderPortalOrder(orderId: string): Promise<WanderPortalOrder> {
  return requireMethod(bridge()?.wanderPortalOrder)(orderId);
}

export async function getWanderPortalUsage(cursor?: string | null): Promise<WanderPortalUsagePage> {
  return requireMethod(bridge()?.wanderPortalUsage)(cursor);
}

export async function openWanderPortal(url: string): Promise<void> {
  const open = requireMethod(bridge()?.openExternalUrl);
  const result = await open({ url });
  if (!result.ok) throw new Error(result.message || "无法打开 Wander Portal");
}
